import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {previewRelativePath,readPreviewSnapshot,MAX_PREVIEW_BYTES} from '../src/server/rich-preview.ts';
import {Runtime} from '../src/codex/runtime.ts';
import {Projects} from '../src/projects.ts';
import {initializeAuth} from '../src/server/auth.ts';
import {buildServer} from '../src/server/app.ts';

test('preview paths are checked before touching filesystem and stay inside the bound project',()=>{
 assert.equal(previewRelativePath('C:\\work\\project','C:\\work\\project\\docs\\demo.html'),'docs/demo.html');
 assert.equal(previewRelativePath('C:\\work\\project','c:\\WORK\\PROJECT\\demo.html'),'demo.html');
 assert.equal(previewRelativePath('/work/project','/work/project/demo.html'),'demo.html');
 assert.equal(previewRelativePath('/work/project','demo.html'),'demo.html');
 for(const path of ['https://outside.test/a.html','file:///work/project/a.html','//host/share/a.html','\\\\host\\share\\a.html','/work/project-evil/a.html','/work/project/../secret.html','/outside/a.html','a\0.html'])assert.throws(()=>previewRelativePath('/work/project',path));
 for(const path of ['C:\\outside\\a.html','C:\\work\\project\\a.html:secret','C:relative.html'])assert.throws(()=>previewRelativePath('C:\\work\\project',path));
 assert.throws(()=>previewRelativePath('/work/project','a'.repeat(4097)));
});

test('preview snapshots read complete bounded HTML and identify the actual bytes',async()=>{
 let calls=0;
 const project={id:'project',name:'project',path:'/work/project'};
 const reader={readReportFile:async(id:string,path:string,limit:number)=>{calls++;assert.equal(id,project.id);assert.equal(path,'demo.html');assert.equal(limit,MAX_PREVIEW_BYTES);return {path,bytes:Buffer.from('<div>Hello</div><script>window.example=1</script>'),mtimeMs:1};}};
 const first=await readPreviewSnapshot(reader,project,'/work/project/demo.html');
 assert.match(first.digest,/^[a-f0-9]{64}$/);assert.match(first.source,/Hello/);assert.equal(first.path,'demo.html');
 assert.equal((await readPreviewSnapshot(reader,project,'demo.html')).digest,first.digest);
 await assert.rejects(readPreviewSnapshot(reader,project,'/outside/demo.html'));assert.equal(calls,2);
});

test('truncated, binary, invalid UTF-8 and non-HTML snapshots never reach execution',async()=>{
 const project={id:'project',name:'project',path:'/work/project'};
 for(const bytes of [Buffer.alloc(MAX_PREVIEW_BYTES+1,65),Buffer.from([0xff,0xfe]),Buffer.from('<p>bad\0</p>'),Buffer.from('plain error page')]){
  await assert.rejects(readPreviewSnapshot({readReportFile:async()=>({path:'demo.html',bytes,mtimeMs:1})},project,'demo.html'));
 }
 await assert.rejects(readPreviewSnapshot({readReportFile:async()=>({path:'demo.txt',bytes:Buffer.from('<div>x</div>'),mtimeMs:1})},project,'demo.txt'));
});

test('preview API enforces auth, csrf, session project and real file boundaries',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'preview-api-')),root=join(dir,'work');await mkdir(root);
 await mkdir(join(root,'p'));
 const projects=new Projects(root),[project]=await projects.list(),runtime=new Runtime({executable:'unused',cwd:root});
 t.mock.method(runtime,'threadCwd',async()=>project.path);
 const dataDir=join(dir,'data');await initializeAuth(dataDir,'preview-test-password');
 const app=await buildServer({dataDir,origin:'http://localhost:3000',projects,runtime});
 t.after(async()=>{await app.close();await runtime.close();assert.ok(dir.startsWith(join(tmpdir(),'preview-api-')));await rm(dir,{recursive:true,force:true});});
 const url='/api/sessions/preview-thread/rich-preview',payload={path:join(project.path,'demo.html')};
 await writeFile(payload.path,'<div>Hello snapshot</div>');
 const csrf=await app.inject({url:'/api/auth/session',headers:{host:'localhost:3000'}});
 const headers:any={host:'localhost:3000',origin:'http://localhost:3000','x-csrf-token':csrf.json().csrfToken,cookie:String(csrf.headers['set-cookie']).split(';')[0]};
 assert.equal((await app.inject({method:'POST',url,headers,payload})).statusCode,401);
 const login=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{password:'preview-test-password'}});headers.cookie+='; '+String(login.headers['set-cookie']).split(';')[0];
 assert.equal((await app.inject({method:'POST',url,headers:{...headers,'x-csrf-token':''},payload})).statusCode,403);
 const response=await app.inject({method:'POST',url,headers,payload});assert.equal(response.statusCode,200);assert.match(response.json().source,/Hello snapshot/);assert.equal(response.headers['cache-control'],'no-store');
 for(const path of [join(dir,'outside.html'),join(project.path,'.env.html')]){await writeFile(path,'<div>secret</div>');assert.equal((await app.inject({method:'POST',url,headers,payload:{path}})).statusCode,403);}
 await writeFile(join(project.path,'bad.txt'),'plain');
 assert.equal((await app.inject({method:'POST',url,headers,payload:{path:'bad.txt'}})).statusCode,415);
 const outside=join(dir,'outside');await mkdir(outside);await writeFile(join(outside,'secret.html'),'<div>outside</div>');await symlink(outside,join(project.path,'escape'),process.platform==='win32'?'junction':'dir');
 assert.equal((await app.inject({method:'POST',url,headers,payload:{path:'escape/secret.html'}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url,headers,payload:{path:payload.path,projectId:'other'}})).statusCode,400);
});
