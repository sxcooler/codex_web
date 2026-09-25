import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {applyUpdate,recoverUpdate,extractUpdate} from '../scripts/update-portable.ts';
import {runtimeFingerprint,safePath} from '../scripts/portable-manifest.ts';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
test('update replaces only managed files, removes obsolete files, preserves data and rolls back on startup failure',async()=>{
  const base=await mkdtemp(join(tmpdir(),'portable update ')),root=join(base,'installed'),payload=join(base,'payload');
  const entry=(path:string,text:string)=>({path,size:Buffer.byteLength(text),sha256:hash(text)});
  const environment=[entry('runtime/node','runtime'),entry('node_modules/example/index.js','dependency')];
  const old={platform:process.platform+'-x64',sourceCommit:'a'.repeat(40),nodeVersion:'24.20.0',files:[...environment,entry('src/server/old.ts','old'),entry('package.json','{"version":"1.0.0"}')]};
  const next={...old,sourceCommit:'b'.repeat(40),files:[...environment,entry('src/server/new.ts','new'),entry('package.json','{"version":"1.0.1"}')]};
  try{
    for(const [path,text] of [['runtime/node','runtime'],['node_modules/example/index.js','dependency'],['src/server/old.ts','old'],['package.json','{"version":"1.0.0"}'],['.local/web/config.json','private']] as const){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),text);}
    await mkdir(join(payload,'src/server'),{recursive:true});await writeFile(join(payload,'src/server/new.ts'),'new');await writeFile(join(payload,'package.json'),'{"version":"1.0.1"}');
    await writeFile(join(root,'manifest.json'),JSON.stringify(old));await writeFile(join(payload,'manifest.json'),JSON.stringify(next));
    assert.equal(runtimeFingerprint(old),runtimeFingerprint(next));
    let stops=0,starts=0;
    const lifecycle={prepare:async()=>{const lock=JSON.parse(await readFile(join(root,'.local/update-lock.json'),'utf8'));assert.equal(lock.pid,process.pid);assert.match(lock.token,/^[a-f0-9-]{36}$/);await assert.rejects(applyUpdate(root,payload),/already in progress/);return true;},stop:async()=>{stops++;},start:async()=>{starts++;if(starts===1)throw Error('startup failed');}};
    await assert.rejects(applyUpdate(root,payload,lifecycle),/startup failed/);
    assert.equal(await readFile(join(root,'src/server/old.ts'),'utf8'),'old');await assert.rejects(readFile(join(root,'src/server/new.ts')));
    assert.equal(await readFile(join(root,'.local/web/config.json'),'utf8'),'private');assert.equal(stops,2);
    await applyUpdate(root,payload,{prepare:async()=>false,stop:async()=>{},start:async()=>{}});
    assert.equal(await readFile(join(root,'src/server/new.ts'),'utf8'),'new');await assert.rejects(readFile(join(root,'src/server/old.ts')));
    assert.equal(await readFile(join(root,'node_modules/example/index.js'),'utf8'),'dependency');
    await recoverUpdate(root,{prepare:async()=>false,stop:async()=>{},start:async()=>{}});
    const backup='backup-'+crypto.randomUUID();await mkdir(join(root,'.local/updates',backup,'src/server'),{recursive:true});
    await writeFile(join(root,'.local/updates',backup,'src/server/new.ts'),'new');await writeFile(join(root,'.local/updates',backup,'package.json'),'{"version":"1.0.1"}');
    await writeFile(join(root,'.local/updates/pending.json'),JSON.stringify({phase:'applying',backup,old:next,next,wasRunning:false}));
    await writeFile(join(root,'src/server/new.ts'),'interrupted replacement');
    await writeFile(join(root,'.local/update-lock.json'),JSON.stringify({pid:2147483647,token:'dead-owner'}));
    await mkdir(join(root,'scripts'),{recursive:true});await writeFile(join(root,'scripts/update-portable.ts'),'truncated updater !');
    const recovered=spawnSync(process.execPath,[join(root,'.local/updates/recover.mjs')],{encoding:'utf8',windowsHide:true});
    assert.equal(recovered.status,0,recovered.stdout+recovered.stderr);
    assert.equal(await readFile(join(root,'src/server/new.ts'),'utf8'),'new');
    await assert.rejects(readFile(join(root,'.local/update-lock.json')),{code:'ENOENT'});
    await rm(join(root,'.local/updates/last-update.json'));await mkdir(join(root,'.local/updates/last-update.json'));
    await assert.rejects(applyUpdate(root,payload,{prepare:async()=>false,stop:async()=>{},start:async()=>{}}));
    assert.equal(JSON.parse(await readFile(join(root,'.local/updates/pending.json'),'utf8')).phase,'complete');
    await recoverUpdate(root,{prepare:async()=>false,stop:async()=>{},start:async()=>{}});
    next.files[0].sha256='c'.repeat(64);await writeFile(join(payload,'manifest.json'),JSON.stringify(next));
    await assert.rejects(applyUpdate(root,payload,{prepare:async()=>{throw Error('must not stop');},stop:async()=>{},start:async()=>{}}),/runtime|运行环境/);
  }finally{await rm(base,{recursive:true,force:true});}
});
function zip(entries:Array<[string,string,number?]>){
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [path,value,mode=0] of entries){const name=Buffer.from(path),bytes=Buffer.from(value),header=Buffer.alloc(30),index=Buffer.alloc(46);header.writeUInt32LE(0x04034b50);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);index.writeUInt32LE(0x02014b50);index.writeUInt32LE(bytes.length,20);index.writeUInt32LE(bytes.length,24);index.writeUInt16LE(name.length,28);index.writeUInt32LE(mode,38);index.writeUInt32LE(offset,42);local.push(header,name,bytes);central.push(index,name);offset+=header.length+name.length+bytes.length;}
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
test('ZIP preflight rejects traversal, symlinks, duplicate names and private files before extraction',async()=>{
  const root=await mkdtemp(join(tmpdir(),'update zip '));
  try{
    for(const bad of ['payload/../escape','payload/.local/web/auth.json','payload/src/server/CON','payload/src/server/a:stream'])await assert.rejects(extractUpdate(zip([['payload/manifest.json','{}'],[bad,'bad']]),root));
    await assert.rejects(extractUpdate(zip([['payload/manifest.json','{}'],['payload/src/a','target',0xa0000000]]),root));
    await assert.rejects(extractUpdate(zip([['payload/manifest.json','{}'],['payload/manifest.json','{}']]),root));
    await extractUpdate(zip([['payload/manifest.json','{}'],['payload/src/server/a.ts','valid']]),root);
    assert.equal(await readFile(join(root,'src/server/a.ts'),'utf8'),'valid');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('update paths exclude traversal, Windows devices, user data and aliases',()=>{
  for(const path of ['../escape','/absolute','C:/escape','src/../.local/web/auth.json','.local/web/auth.json','src/server/file:stream','src/server/CON','src/server/a.','src\\server\\a'])assert.throws(()=>safePath(path));
  assert.equal(safePath('src/server/main.ts'),'src/server/main.ts');
});
