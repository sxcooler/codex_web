import {readFile,writeFile,mkdir,mkdtemp,copyFile,rename,unlink,readdir,lstat,link} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {request} from 'node:http';
import {createServer} from 'node:net';
import {digest,environmentFile,appFile,safePath,checkedPath,verifyFiles,validateManifest,runtimeFingerprint,type Manifest} from './portable-manifest.ts';

type Lifecycle={prepare:()=>Promise<boolean>;stop:()=>Promise<void>;start:()=>Promise<void>};
const exists=async(path:string)=>lstat(path).then(()=>true,(e:any)=>{if(e.code==='ENOENT')return false;throw e;});
const json=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e:any){return e.code!=='ESRCH';}};
async function save(path:string,value:any){const temporary=path+'.tmp';await writeFile(temporary,JSON.stringify(value),{mode:0o600});await rename(temporary,path);}
async function localDirectory(root:string,path:string){
  let current=root;if((await lstat(root)).isSymbolicLink())throw Error('Installation root must not be a link');
  for(const part of path.split('/')){current=join(current,part);await mkdir(current).catch((e:any)=>{if(e.code!=='EEXIST')throw e;});if(!(await lstat(current)).isDirectory()||(await lstat(current)).isSymbolicLink())throw Error('Unsafe local update directory');}
  return current;
}
async function locked<T>(root:string,recover:boolean,job:(directory:string,token:string)=>Promise<T>){
  root=resolve(root);const directory=await localDirectory(root,'.local/updates'),lock=join(root,'.local/update-lock.json');
  if(recover&&await exists(lock)){const old=await json(lock);if(!Number.isInteger(old.pid)||alive(old.pid))throw Error('An updater is still running');await unlink(lock);}
  const token=randomUUID(),owner=join(directory,'owner-'+token+'.json');
  try{
    await writeFile(owner,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});
    // Publish a complete owner atomically; interruption cannot leave an empty lock.
    await link(owner,lock).catch((error:any)=>{if(error.code==='EEXIST')throw Error('Update already in progress; use --recover after an interrupted update.');throw Error('Atomic update locking requires a filesystem with hard-link support: '+error.message);});
  }finally{await unlink(owner).catch((error:any)=>{if(error.code!=='ENOENT')throw error;});}
  try{return await job(directory,token);}
  finally{if((await json(lock).catch(()=>({}))).token===token)await unlink(lock);}
}

// Only the ZIP subset emitted by our release build is accepted. No extraction tools or dependencies required.
export async function extractUpdate(archive:Buffer,destination:string){
  if(archive.length>128*1024*1024)throw Error('Update archive too large');
  let end=archive.length-22;while(end>=Math.max(0,archive.length-65557)&&archive.readUInt32LE(end)!==0x06054b50)end--;
  if(end<0||archive.readUInt32LE(end)!==0x06054b50||end+22+archive.readUInt16LE(end+20)!==archive.length)throw Error('Invalid ZIP directory');
  const count=archive.readUInt16LE(end+10),central=archive.readUInt32LE(end+16);
  if(archive.readUInt16LE(end+4)||archive.readUInt16LE(end+6)||count!==archive.readUInt16LE(end+8)||count>10000||central+archive.readUInt32LE(end+12)!==end)throw Error('Unsupported ZIP format');
  let offset=central,total=0,prefix='';const names=new Set<string>(),entries:{path:string;start:number;length:number;size:number;method:number}[]=[];
  for(let i=0;i<count;i++){
    if(offset+46>end||archive.readUInt32LE(offset)!==0x02014b50)throw Error('Invalid ZIP entry');
    const flags=archive.readUInt16LE(offset+8),method=archive.readUInt16LE(offset+10),length=archive.readUInt32LE(offset+20),size=archive.readUInt32LE(offset+24),n=archive.readUInt16LE(offset+28),extra=archive.readUInt16LE(offset+30),comment=archive.readUInt16LE(offset+32),attributes=archive.readUInt32LE(offset+38),local=archive.readUInt32LE(offset+42);
    const name=archive.subarray(offset+46,offset+46+n).toString('utf8'),directory=name.endsWith('/'),parts=name.replace(/\/$/,'').split('/');
    safePath(parts.join('/'));if(!prefix)prefix=parts[0];if(parts[0]!==prefix||flags&1||![0,8].includes(method)||((attributes>>>16)&0xf000)===0xa000)throw Error('Unsupported update entry');
    offset+=46+n+extra+comment;if(offset>end||names.has(name.toLowerCase()))throw Error('Duplicate update entry');names.add(name.toLowerCase());
    if(directory)continue;const path=parts.slice(1).join('/');if(path!=='manifest.json'&&!appFile(path))throw Error('Unexpected update file: '+path);
    if(local+30>central||archive.readUInt32LE(local)!==0x04034b50||archive.readUInt16LE(local+8)!==method||archive.readUInt16LE(local+6)!==flags)throw Error('Invalid ZIP local header');
    const localN=archive.readUInt16LE(local+26),start=local+30+localN+archive.readUInt16LE(local+28);
    if(archive.subarray(local+30,local+30+localN).toString('utf8')!==name||start+length>central||size>64*1024*1024||(total+=size)>256*1024*1024)throw Error('Invalid update size');
    entries.push({path,start,length,size,method});
  }
  if(offset!==end||!entries.some(e=>e.path==='manifest.json'))throw Error('Missing update manifest');
  for(const e of entries){const compressed=archive.subarray(e.start,e.start+e.length),bytes=e.method===0?compressed:inflateRawSync(compressed,{maxOutputLength:Math.max(1,e.size)});if(bytes.length!==e.size)throw Error('Invalid ZIP output size');const path=await checkedPath(destination,e.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes,{flag:'wx',mode:e.path.endsWith('.sh')?0o755:0o644});}
}

async function payloadFiles(root:string,prefix=''):Promise<string[]>{let paths:string[]=[];for(const e of await readdir(join(root,prefix),{withFileTypes:true})){const path=prefix?prefix+'/'+e.name:e.name;safePath(path);if(e.isSymbolicLink())throw Error('Update payload contains links');if(e.isDirectory())paths.push(...await payloadFiles(root,path));else if(e.isFile())paths.push(path);else throw Error('Unsupported update file');}return paths;}
async function prepareRecovery(directory:string){
  const runner=await mkdtemp(join(directory,'recovery-'));
  for(const file of ['update-portable.ts','portable-manifest.ts'])await copyFile(new URL(file,import.meta.url),join(runner,file));
  const entry=join(directory,'recover.mjs');
  await writeFile(entry+'.tmp',`import {fileURLToPath} from 'node:url';\nimport {recoverUpdate} from './${basename(runner)}/update-portable.ts';\nrecoverUpdate(fileURLToPath(new URL('../..',import.meta.url))).catch(error=>{console.error(error.message);process.exitCode=1;});\n`,{mode:0o600});
  await rename(entry+'.tmp',entry);
}
async function restore(root:string,directory:string,journal:any){
  if(!/^backup-[a-f0-9-]+$/.test(journal.backup))throw Error('Invalid recovery backup');
  const old=validateManifest(journal.old),next=validateManifest(journal.next),backup=join(directory,journal.backup);
  const previous=old.files.filter(e=>!environmentFile(e.path));await verifyFiles(backup,previous);
  for(const path of new Set([...previous,...next.files.filter(e=>!environmentFile(e.path))].map(e=>e.path))){const target=await checkedPath(root,path);if(previous.some(e=>e.path===path)){await mkdir(dirname(target),{recursive:true});await copyFile(await checkedPath(backup,path),target);}else await unlink(target).catch((e:any)=>{if(e.code!=='ENOENT')throw e;});}
  await save(join(root,'manifest.json'),old);
}

export async function applyUpdate(root:string,payload:string,lifecycle?:Lifecycle){
  root=resolve(root);payload=resolve(payload);
  return locked(root,false,async(directory,token)=>{
    const pending=join(directory,'pending.json');if(await exists(pending))throw Error('Interrupted update found; run --recover first');
    const old=validateManifest(await json(await checkedPath(root,'manifest.json'))),next=validateManifest(await json(await checkedPath(payload,'manifest.json')));
    if(old.platform!==process.platform+'-'+process.arch||runtimeFingerprint(old)!==runtimeFingerprint(next))throw Error('运行环境不兼容，请下载完整便携包 (runtime mismatch)');
    const application=next.files.filter(e=>!environmentFile(e.path));
    const paths=await payloadFiles(payload),expected=new Set(['manifest.json',...application.map(e=>e.path)]);if(paths.length!==expected.size||paths.some(p=>!expected.has(p)))throw Error('Update payload does not match manifest');
    await verifyFiles(payload,application);await verifyFiles(root,old.files);
    // npm bookkeeping is not executable runtime content; preserve the installed environment's exact manifest.
    next.files=[...old.files.filter(e=>environmentFile(e.path)),...application];
    for(const e of application)if(!old.files.some(old=>old.path===e.path)&&await exists(await checkedPath(root,e.path)))throw Error('Update would overwrite an unmanaged file: '+e.path);
    await prepareRecovery(directory);
    const control=lifecycle??nativeLifecycle(root,token),wasRunning=await control.prepare();
    const backup='backup-'+randomUUID(),journal={old,next,backup,wasRunning,phase:'backup'};
    try{
      await mkdir(join(directory,backup));await save(pending,journal);
      await control.stop();
      for(const e of old.files.filter(e=>!environmentFile(e.path))){const to=join(directory,backup,e.path);await mkdir(dirname(to),{recursive:true});await copyFile(await checkedPath(root,e.path),to);}
      journal.phase='applying';await save(pending,journal);
      for(const e of application){const to=await checkedPath(root,e.path);await mkdir(dirname(to),{recursive:true});await copyFile(await checkedPath(payload,e.path),to);}
      for(const e of old.files.filter(e=>!environmentFile(e.path)&&!application.some(next=>next.path===e.path)))await unlink(await checkedPath(root,e.path));
      await save(join(root,'manifest.json'),next);await verifyFiles(root,application);
      await control.start();if(!wasRunning)await control.stop();
    }catch(error){
      await control.stop();if(journal.phase==='applying')await restore(root,directory,journal);
      if(wasRunning)await control.start();await unlink(pending);throw error;
    }
    // Keep the journal if final bookkeeping fails; recovery decides from its durable phase.
    journal.phase='complete';await save(pending,journal);await rename(pending,join(directory,'last-update.json'));
    process.stdout.write('Application update verified. Previous application files retained in '+backup+'\n');
  });
}
export async function recoverUpdate(root:string,lifecycle?:Lifecycle){
  root=resolve(root);return locked(root,true,async(directory,token)=>{
    const pending=join(directory,'pending.json');if(!await exists(pending))return;
    const journal=await json(pending),control=lifecycle??nativeLifecycle(root,token);
    await control.prepare();await control.stop();if(journal.phase==='applying')await restore(root,directory,journal);else if(!['backup','complete'].includes(journal.phase))throw Error('Unknown recovery phase');
    if(journal.wasRunning)await control.start();await unlink(pending);
  });
}

function nativeLifecycle(root:string,token:string):Lifecycle{
  let state:any;
  const call=async(path:string)=>{
    const record=await json(join(root,'.local/web/server-control.json')).catch(()=>null);if(!record||record.root!==root&&resolve(record.root??'')!==root||!Number.isInteger(record.port)||!/^[a-f0-9]{64}$/.test(record.token))return null;
    return new Promise<any>((done,reject)=>{const req=request({hostname:'127.0.0.1',port:record.port,path,method:path==='/status'?'GET':'POST',headers:{Authorization:'Bearer '+record.token,Connection:'close'},timeout:3000},res=>{let body='';res.on('data',chunk=>{body+=chunk;if(body.length>4096)res.destroy();});res.on('error',reject);res.on('end',()=>{if(res.statusCode!==200)return reject(Error('Service rejected update; stop old versions manually after tasks finish.'));try{const result=JSON.parse(body);done(result.token===record.token?result:null);}catch{reject(Error('Invalid service response'));}});});req.on('error',e=>(e as any).code==='ECONNREFUSED'?done(null):reject(e));req.on('timeout',()=>req.destroy(Error('Control request timed out')));req.end();});
  };
  const stopped=async()=>{for(let i=0;i<150;i++){try{if(!await call('/status'))return;}catch(error:any){if(error.code!=='ECONNRESET')throw error;}await new Promise(r=>setTimeout(r,100));}throw Error('Service did not stop; update halted');};
  return {
    async prepare(){state=await call('/status');if(state){await call('/prepare-update');return true;}const config=await json(join(root,'.local/web/config.json')).catch(()=>null);if(config){await new Promise<void>((done,reject)=>{const socket=createServer();socket.once('error',()=>reject(Error('Web port is occupied by an unmanaged instance')));socket.listen(config.port??3000,'127.0.0.1',()=>socket.close(()=>done()));});}return false;},
    async stop(){if(await call('/status')){await call('/stop');await stopped();}},
    async start(){
      const node=join(root,'runtime',process.platform==='win32'?'node.exe':'node'),configured=await exists(join(root,'.local/web/auth.json'));
      const args=configured?['scripts/server-control.ts','--portable','--background']:['--input-type=module','-e',"await import('./src/server/app.ts'); const {default:sharp}=await import('sharp'); await sharp({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer()"];
      const result=spawnSync(node,args,{cwd:root,env:{...process.env,CODEX_WEB_UPDATE_TOKEN:token},windowsHide:true,encoding:'utf8',timeout:30000});if(result.status!==0)throw Error('Updated application failed startup: '+(result.stderr||result.error));if(configured&&!await call('/status'))throw Error('Updated service did not report ready');
    },
  };
}
async function main(){
  const args=process.argv.slice(2),rootIndex=args.indexOf('--root'),root=rootIndex>=0?resolve(args[rootIndex+1]??''):fileURLToPath(new URL('..',import.meta.url));
  if(rootIndex>=0)args.splice(rootIndex,2);
  const worker=args.indexOf('--worker');if(worker>=0)args.splice(worker,1);
  if(worker<0){
    const directory=await localDirectory(root,'.local/updates'),runner=await mkdtemp(join(directory,'runner-'));
    for(const file of ['update-portable.ts','portable-manifest.ts'])await copyFile(new URL(file,import.meta.url),join(runner,file));
    const result=spawnSync(process.execPath,[join(runner,'update-portable.ts'),'--worker','--root',root,...args],{stdio:'inherit',windowsHide:true});
    if(result.status!==0)throw Error('Update did not complete; inspect the message above.');return;
  }
  if(args.length===1&&args[0]==='--recover')return recoverUpdate(root);
  if(args.length!==2||!/^[a-f0-9]{64}$/i.test(args[1]))throw Error('Usage: Update <application-update.zip> <SHA256 from release> [--root installation] | Update --recover');
  const archive=await readFile(resolve(args[0]));if(digest(archive)!==args[1].toLowerCase())throw Error('Archive SHA256 mismatch');
  const directory=await localDirectory(root,'.local/updates'),stage=await mkdtemp(join(directory,'payload-'));await extractUpdate(archive,stage);await applyUpdate(root,stage);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
