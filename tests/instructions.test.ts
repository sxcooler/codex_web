import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Instructions} from '../src/server/instructions.ts';
import {Projects} from '../src/projects.ts';
import {Runtime} from '../src/codex/runtime.ts';
import {initializeAuth} from '../src/server/auth.ts';
import {buildServer} from '../src/server/app.ts';

const user={scope:'user'} as const;
async function fixture(t:any){
 const dir=await fs.mkdtemp(join(tmpdir(),'instructions-')),home=join(dir,'home'),root=join(dir,'work'),project=join(root,'project');
 await fs.mkdir(home);await fs.mkdir(project,{recursive:true});
 const projects=new Projects(root),projectId=(await projects.list())[0].id;
 const service=new Instructions({codexHome:async()=>home,projects}),beforeCleanup:Array<()=>Promise<void>>=[];
 t.after(async()=>{for(const close of beforeCleanup)await close();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,home,root,project,projects,service,beforeCleanup,projectTarget:{scope:'project',projectId} as const,path:join(home,'AGENTS.md')};
}

test('missing fixed targets read without creating and save with a new byte version',async t=>{
 const f=await fixture(t);
 for(const target of [user,f.projectTarget]){
  const first=await f.service.read(target);assert.equal(first.exists,false);assert.equal(first.content,'');assert.equal(first.writable,true);
  await assert.rejects(fs.stat(first.path),{code:'ENOENT'});
  const saved=await f.service.write(target,{expectedVersion:first.version,content:'hello\n世界\n'});
  assert.equal(saved.exists,true);assert.equal(saved.content,'hello\n世界\n');assert.notEqual(saved.version,first.version);
  assert.equal(await fs.readFile(first.path,'utf8'),saved.content);
 }
});

test('stale external changes and simultaneous editors cannot silently overwrite',async t=>{
 const f=await fixture(t),first=await f.service.read(user);
 const results=await Promise.allSettled(['one','two'].map(content=>f.service.write(user,{expectedVersion:first.version,content})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.statusCode,409);
 const before=await f.service.read(user);await fs.writeFile(f.path,'external');
 await assert.rejects(f.service.write(user,{expectedVersion:before.version,content:'stale'}),{statusCode:409});assert.equal(await fs.readFile(f.path,'utf8'),'external');
});

test('UTF-8 byte cap applies on read and write including preserved BOM and CRLF',async t=>{
 const f=await fixture(t),first=await f.service.read(user);
 await assert.rejects(f.service.write(user,{expectedVersion:first.version,content:'中'.repeat(87382)}),{statusCode:400});
 await assert.rejects(f.service.write(user,{expectedVersion:first.version,content:'\ud800'}),{statusCode:400});
 await fs.writeFile(f.path,Buffer.concat([Buffer.from([239,187,191]),Buffer.from('original\r\n')]));
 const bom=await f.service.read(user);
 await assert.rejects(f.service.write(user,{expectedVersion:bom.version,content:'a'.repeat(262142)}),{statusCode:400});
 const saved=await f.service.write(user,{expectedVersion:bom.version,content:'new\nline\n'});
 assert.equal(saved.content,'new\r\nline\r\n');assert.deepEqual(await fs.readFile(f.path),Buffer.concat([Buffer.from([239,187,191]),Buffer.from(saved.content)]));
 await fs.writeFile(f.path,'a'.repeat(262145));const large=await f.service.read(user);assert.equal(large.writable,false);assert.match(large.reason!,/256 KiB/);
 await assert.rejects(f.service.write(user,{expectedVersion:large.version,content:'small'}),{statusCode:409});
});

test('invalid UTF-8 stays read only and override is a path hint without editing it',async t=>{
 const f=await fixture(t);await fs.writeFile(f.path,Buffer.from([0xff,0xfe]));await fs.writeFile(join(f.home,'AGENTS.override.md'),'override');
 const invalid=await f.service.read(user);assert.equal(invalid.writable,false);assert.match(invalid.reason!,/UTF-8/);assert.equal(invalid.overriddenBy,join(f.home,'AGENTS.override.md'));
 await assert.rejects(f.service.write(user,{expectedVersion:invalid.version,content:'valid'}),{statusCode:409});assert.deepEqual(await fs.readFile(f.path),Buffer.from([0xff,0xfe]));
 const project=await f.service.read(f.projectTarget);assert.equal(project.overriddenBy,null);
 await fs.writeFile(join(f.project,'AGENTS.override.md'),'project override');assert.equal((await f.service.read(f.projectTarget)).overriddenBy,join(f.project,'AGENTS.override.md'));
});

test('no fallback home or arbitrary client paths and project ids',async t=>{
 const f=await fixture(t),unavailable=new Instructions({codexHome:async()=>null,projects:f.projects});
 await assert.rejects(unavailable.read(user),{statusCode:503,code:'INSTRUCTIONS_HOME_UNAVAILABLE'});
 for(const target of [{scope:'user',path:f.project},{scope:'user',projectId:f.projectTarget.projectId},{scope:'project'},{scope:'project',projectId:'../../escape'}])await assert.rejects(f.service.read(target as any),{statusCode:400});
 const first=await f.service.read(user);await assert.rejects(f.service.write(user,{expectedVersion:first.version,content:'x',path:f.project} as any),{statusCode:400});
});

test('file links, directories, and a project junction escape are rejected',async t=>{
 const f=await fixture(t),outside=join(f.dir,'outside');await fs.mkdir(outside);
 const first=await f.service.read(user);await fs.mkdir(f.path);
 await assert.rejects(f.service.write(user,{expectedVersion:first.version,content:'x'}),{statusCode:409});await fs.rmdir(f.path);
 await fs.writeFile(join(outside,'AGENTS.md'),'safe');
 // Junction fallback still creates an actual reparse link at the fixed filename on restricted Windows hosts.
 try{await fs.symlink(join(outside,'AGENTS.md'),f.path,'file');}catch(e:any){if(process.platform!=='win32'||!['EPERM','EACCES'].includes(e.code))throw e;await fs.symlink(join(outside,'AGENTS.md'),f.path,'junction');t.diagnostic('Used a junction at AGENTS.md because file symlinks require Developer Mode/admin.');}
 assert.equal((await fs.lstat(f.path)).isSymbolicLink(),true);await assert.rejects(f.service.read(user),{statusCode:409});await fs.unlink(f.path);
 await fs.rename(f.project,join(f.root,'original'));await fs.symlink(outside,f.project,'junction');
 await assert.rejects(f.service.read(f.projectTarget),{statusCode:409});assert.equal(await fs.readFile(join(outside,'AGENTS.md'),'utf8'),'safe');
});

test('trusted user home cannot be redirected by a directory junction',async t=>{
 const f=await fixture(t),outside=join(f.dir,'outside');await fs.mkdir(outside);await fs.rename(f.home,join(f.dir,'original-home'));await fs.symlink(outside,f.home,'junction');
 await assert.rejects(f.service.read(user),{statusCode:409});await assert.rejects(fs.stat(join(outside,'AGENTS.md')),{code:'ENOENT'});
});

test('rename failure leaves original bytes and removes only its own temporary file',async t=>{
 const f=await fixture(t);await fs.writeFile(f.path,Buffer.from([239,187,191,97,13,10]));const bytes=await fs.readFile(f.path),before=await f.service.read(user);
 t.mock.method(fs,'rename',async()=>{throw Object.assign(Error('secret internal failure'),{code:'EPERM'});});
 await assert.rejects(f.service.write(user,{expectedVersion:before.version,content:'replacement'}),{statusCode:503,code:'INSTRUCTIONS_WRITE_FAILED'});
 assert.deepEqual(await fs.readFile(f.path),bytes);assert.deepEqual(await fs.readdir(f.home),['AGENTS.md']);
});

test('saving rechecks external version and target type after creating the temporary file',async t=>{
 const f=await fixture(t);await fs.writeFile(f.path,'original');const before=await f.service.read(user),open=fs.open;
 t.mock.method(fs,'open',async(...args:any[])=>{
  const handle=await (open as any)(...args);
  if(String(args[0]).includes('.tmp'))await fs.writeFile(f.path,'external');
  return handle;
 });
 await assert.rejects(f.service.write(user,{expectedVersion:before.version,content:'replacement'}),{statusCode:409});assert.equal(await fs.readFile(f.path,'utf8'),'external');assert.deepEqual(await fs.readdir(f.home),['AGENTS.md']);
});

test('a target replaced by a directory during save stays untouched',async t=>{
 const f=await fixture(t),before=await f.service.read(user),open=fs.open;
 t.mock.method(fs,'open',async(...args:any[])=>{const handle=await (open as any)(...args);if(String(args[0]).includes('.tmp'))await fs.mkdir(f.path);return handle;});
 await assert.rejects(f.service.write(user,{expectedVersion:before.version,content:'replacement'}),{statusCode:409});assert.equal((await fs.lstat(f.path)).isDirectory(),true);assert.deepEqual(await fs.readdir(f.home),['AGENTS.md']);
});

test('a parent redirected during save cannot write or clean up paths in the new destination',async t=>{
 const f=await fixture(t),before=await f.service.read(user),open=fs.open,outside=join(f.dir,'outside'),old=join(f.dir,'original-home');await fs.mkdir(outside);await fs.writeFile(join(outside,'AGENTS.md'),'outside');
 t.mock.method(fs,'open',async(...args:any[])=>{
  if(String(args[0]).includes('.tmp')){
   if(process.platform==='win32'){
    // Simulate open capturing the old parent before redirection; Windows cannot move a parent with an open child.
    const name=basename(String(args[0]));await fs.rename(f.home,old);await fs.symlink(outside,f.home,'junction');args[0]=join(old,name);
   }else{
    const handle=await (open as any)(...args),sync=handle.sync.bind(handle);
    t.mock.method(handle,'sync',async()=>{await sync();await fs.rename(f.home,old);await fs.symlink(outside,f.home,'junction');});
    return handle;
   }
  }
  return (open as any)(...args);
 });
 await assert.rejects(f.service.write(user,{expectedVersion:before.version,content:'replacement'}),{statusCode:409});assert.equal(await fs.readFile(join(outside,'AGENTS.md'),'utf8'),'outside');assert.deepEqual(await fs.readdir(outside),['AGENTS.md']);
 assert.equal((await fs.readdir(old)).filter(name=>name.endsWith('.tmp')).length,1,'uncertain old directory is deliberately left alone');
});

test('temporary cleanup does not unlink a replacement owned by an external editor',async t=>{
 const f=await fixture(t);await fs.writeFile(f.path,'original');const before=await f.service.read(user),unlink=fs.unlink,writeFile=fs.writeFile;
 let replaced='';
 t.mock.method(fs,'rename',async(source:any)=>{replaced=String(source);await unlink(source);await writeFile(source,'external temporary');throw Object.assign(Error('failure'),{code:'EPERM'});});
 await assert.rejects(f.service.write(user,{expectedVersion:before.version,content:'replacement'}),{statusCode:503});assert.equal(await fs.readFile(f.path,'utf8'),'original');assert.equal(await fs.readFile(replaced,'utf8'),'external temporary');
});

test('temporary handle stays open through failed rename and identity cleanup',async t=>{
 const f=await fixture(t);await fs.writeFile(f.path,'original');const before=await f.service.read(user),open=fs.open,unlink=fs.unlink,writeFile=fs.writeFile,lstat=fs.lstat;
 let handle:any,path='',renameOpen=false,cleanupOpen=false,failed=false,closed=false;
 t.mock.method(fs,'open',async(...args:any[])=>{
  const value=await (open as any)(...args);
  if(String(args[0]).endsWith('.tmp')){handle=value;path=String(args[0]);const close=value.close.bind(value);t.mock.method(value,'close',async()=>{await close();closed=true;});}
  return value;
 });
 t.mock.method(fs,'rename',async(source:any)=>{renameOpen=handle.fd!==-1;await unlink(source);await writeFile(source,'external temporary');failed=true;throw Object.assign(Error('failure'),{code:'EPERM'});});
 t.mock.method(fs,'lstat',async(...args:any[])=>{if(failed&&String(args[0])===path)cleanupOpen=handle.fd!==-1;return (lstat as any)(...args);});
 await assert.rejects(f.service.write(user,{expectedVersion:before.version,content:'replacement'}),{statusCode:503,code:'INSTRUCTIONS_WRITE_FAILED'});
 assert.equal(renameOpen,true,'the original inode must stay open during external replacement');assert.equal(cleanupOpen,true,'identity cleanup must precede closing the original inode');assert.equal(closed,true,'the temporary handle must close after failure cleanup');
 assert.equal(await fs.readFile(f.path,'utf8'),'original');assert.equal(await fs.readFile(path,'utf8'),'external temporary');
});

test('successful replacement followed by failed readback reports an unknown write without retry',async t=>{
 const f=await fixture(t);await fs.writeFile(f.path,'original');const before=await f.service.read(user),open=fs.open,rename=fs.rename;let replaced=false,count=0;
 t.mock.method(fs,'rename',async(...args:any[])=>{count++;await (rename as any)(...args);replaced=true;});
 t.mock.method(fs,'open',async(...args:any[])=>{if(replaced)throw Object.assign(Error('internal secret'),{code:'EACCES'});return (open as any)(...args);});
 await assert.rejects(f.service.write(user,{expectedVersion:before.version,content:'saved'}),{statusCode:504,code:'SETTINGS_WRITE_UNKNOWN'});
 assert.equal(count,1);assert.equal(await fs.readFile(f.path,'utf8'),'saved');
});

test('temporary close failure after replacement reports an unknown write without retry',async t=>{
 const f=await fixture(t);await fs.writeFile(f.path,'original');const before=await f.service.read(user),open=fs.open,rename=fs.rename;let renamed=0,closes=0;
 t.mock.method(fs,'rename',async(...args:any[])=>{renamed++;return (rename as any)(...args);});
 t.mock.method(fs,'open',async(...args:any[])=>{
  const handle=await (open as any)(...args);
  if(String(args[0]).endsWith('.tmp')){const close=handle.close.bind(handle);t.mock.method(handle,'close',async()=>{await close();if(++closes===1)throw Error('private close failure');});}
  return handle;
 });
 await assert.rejects(f.service.write(user,{expectedVersion:before.version,content:'saved'}),(error:any)=>error.statusCode===504&&error.code==='SETTINGS_WRITE_UNKNOWN'&&!error.message.includes('private close failure'));
 assert.equal(renamed,1);assert.equal(closes,2);assert.equal(await fs.readFile(f.path,'utf8'),'saved');assert.deepEqual(await fs.readdir(f.home),['AGENTS.md']);
});

test('Runtime configuration home belongs to the currently initialized native process',async t=>{
 const f=await fixture(t),runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url))],cwd:f.home});f.beforeCleanup.push(()=>runtime.close());
 assert.equal(await runtime.configurationHome(),f.home);
 await runtime.close();await assert.rejects(runtime.configurationHome(),{statusCode:503});
});

test('Runtime never falls back to stale initialization data or relative native home',async t=>{
 const runtime=new Runtime({executable:'unused',cwd:process.cwd()});t.after(()=>runtime.close());
 t.mock.method(runtime as any,'getServer',async()=>{(runtime as any).server={};(runtime as any).initializeInfo={codexHome:'relative-home'};return (runtime as any).server;});
 assert.equal(await runtime.configurationHome(),null);
 t.mock.method(runtime as any,'getServer',async()=>{throw Object.assign(Error('native unavailable'),{statusCode:503});});
 (runtime as any).initializeInfo={codexHome:process.cwd()};await assert.rejects(runtime.configurationHome(),{statusCode:503});
 (runtime as any).server=undefined;
});

test('instructions routes enforce auth Origin CSRF fixed inputs and support full UTF-8 limit',async t=>{
 const f=await fixture(t),dataDir=join(f.dir,'auth');await initializeAuth(dataDir,'instructions-test-password');
 const runtime=new Runtime({executable:'unused',cwd:f.home});t.mock.method(runtime,'configurationHome',async()=>f.home);
 const app=await buildServer({dataDir,origin:'http://localhost:3000',runtime,projects:f.projects});f.beforeCleanup.push(async()=>{await app.close();await runtime.close();});
 assert.equal((await app.inject({url:'/api/codex/instructions?scope=user',headers:{host:'localhost:3000'}})).statusCode,401);
 const csrf=await app.inject({url:'/api/auth/session',headers:{host:'localhost:3000'}}),headers:any={host:'localhost:3000',origin:'http://localhost:3000','x-csrf-token':csrf.json().csrfToken,cookie:String(csrf.headers['set-cookie']).split(';')[0]};
 const login=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{password:'instructions-test-password'}});headers.cookie+='; '+String(login.headers['set-cookie']).split(';')[0];
 const initial=await app.inject({url:'/api/codex/instructions?scope=user',headers});assert.equal(initial.statusCode,200,initial.body);
 const input={scope:'user',expectedVersion:initial.json().version,content:'a'.repeat(262144)};
 for(const badHeaders of [{...headers,'x-csrf-token':''},{...headers,origin:'http://evil.example'}])assert.equal((await app.inject({method:'POST',url:'/api/codex/instructions',headers:badHeaders,payload:input})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/codex/instructions',headers:{...headers,cookie:headers.cookie.split(';')[0]},payload:input})).statusCode,401);
 for(const payload of [{...input,filePath:f.project},{...input,projectId:f.projectTarget.projectId},{...input,scope:'project',projectId:'../../escape'}])assert.equal((await app.inject({method:'POST',url:'/api/codex/instructions',headers,payload})).statusCode,400);
 assert.equal((await app.inject({url:'/api/codex/instructions?scope=user&path=/secret',headers})).statusCode,400);
 const saved=await app.inject({method:'POST',url:'/api/codex/instructions',headers,payload:input});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().content.length,262144);
 assert.equal((await app.inject({method:'POST',url:'/api/codex/instructions',headers,payload:input})).statusCode,409);
});
