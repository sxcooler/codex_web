import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import Fastify from 'fastify';
import sharp from 'sharp';
import {Runtime} from '../src/codex/runtime.ts';
import {Projects} from '../src/projects.ts';
import {registerApi} from '../src/server/api.ts';

async function fixture(t:any){
  const evidence=resolve('.local/implementation-projectless');await mkdir(evidence,{recursive:true});
  const dir=await mkdtemp(join(evidence,'files-api-')),root=join(dir,'work'),outside=join(dir,'outside');
  await mkdir(root);await mkdir(outside);await mkdir(join(root,'project'));
  await writeFile(join(root,'root.md'),'# Root');await writeFile(join(root,'project','project.md'),'# Project');
  await writeFile(join(root,'.env'),'secret');await writeFile(join(outside,'private.txt'),'outside');
  const png=await sharp({create:{width:12,height:9,channels:3,background:'red'}}).png().toBuffer();
  await writeFile(join(root,'root.png'),png);await writeFile(join(root,'project','project.png'),png);
  const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url))],cwd:dir,idleMs:60_000});
  const projects=new Projects(root),[project]=await projects.list(),app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});
  app.setErrorHandler((error:any,_request,reply)=>reply.code(error.statusCode??500).send({error:error.message,code:error.code}));
  registerApi(app,{dataDir:dir,runtime,projects,authenticated:()=>()=>true});
  t.after(async()=>{await app.close();const rel=relative(evidence,dir);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(dir,{recursive:true,force:true});});
  const rpc=async(method:string,params:any={})=>(await (runtime as any).getServer()).request(method,params);
  return {app,runtime,projects,project,root,outside,rpc};
}

test('root and selected project files work before a session without starting or opening a task',async t=>{
  const f=await fixture(t);
  for(const [base,name,text] of [['/api/files','root','# Root'],['/api/projects/'+f.project.id+'/files','project','# Project']]){
    const listing=await f.app.inject(base);assert.equal(listing.statusCode,200,listing.body);assert.ok(listing.json().files.some((file:any)=>file.path===name+'.md'));
    const entry=await f.app.inject(base+'/entry?path='+name+'.md');assert.equal(entry.statusCode,200,entry.body);assert.deepEqual(entry.json(),{path:name+'.md',type:'file'});
    const content=await f.app.inject(base+'/content?path='+name+'.md');assert.equal(content.statusCode,200,content.body);assert.equal(content.json().text,text);
    const image=await f.app.inject(base+'/image?path='+name+'.png&v=refresh');assert.equal(image.statusCode,200,image.body);assert.equal(image.headers['content-type'],'image/webp');assert.equal(image.headers['cache-control'],'no-store');assert.equal(image.headers['x-content-type-options'],'nosniff');assert.equal(image.headers['content-security-policy'],"default-src 'none'; sandbox");assert.equal((await sharp(image.rawPayload).metadata()).width,12);
  }
  const stats=await f.rpc('fixture/stats');assert.equal(stats.lastThread,undefined);assert.equal(stats.resumes,0);assert.equal(stats.turnStarts,0);assert.equal(stats.modelLists,0);
});

test('file-only scopes reject unknown queries, unsafe paths, missing IDs and Git image versions',async t=>{
  const f=await fixture(t);
  for(const base of ['/api/files','/api/projects/'+f.project.id+'/files']){
    for(const suffix of ['?unknown=yes','/entry?path=.&unknown=yes','/content?path=root.md&root='+encodeURIComponent(f.outside),'/image?path=root.png&revision=index','/image?path=root.png&repository='])assert.equal((await f.app.inject(base+suffix)).statusCode,400,base+suffix);
    for(const path of ['../outside/private.txt',f.outside+'/private.txt','.env','.git/config',...(process.platform==='win32'?['root.md:stream']:[])]){
      for(const endpoint of ['entry','content','image']){const response=await f.app.inject(base+'/'+endpoint+'?path='+encodeURIComponent(path));assert.ok([400,403].includes(response.statusCode),response.body);}
    }
    assert.equal((await f.app.inject(base+'/content')).statusCode,400);
    assert.equal((await f.app.inject(base+'/entry?path=missing')).statusCode,404);
  }
  assert.equal((await f.app.inject('/api/projects/'+'0'.repeat(24)+'/files')).statusCode,404);
  assert.equal((await f.app.inject('/api/projects/not-an-id/files')).statusCode,400);
  await assert.rejects(f.projects.resolve(undefined as any));
  await assert.rejects(f.projects.gitStatus(undefined as any));
});

test('Linux file-only scopes preserve native colon filenames', {skip:process.platform!=='linux'}, async t=>{
  const f=await fixture(t);
  for(const [base,root] of [['/api/files',f.root],['/api/projects/'+f.project.id+'/files',f.project.path]]){
    await writeFile(join(root,'native:stream.md'),'native colon file');
    await writeFile(join(root,'native:preview.png'),await sharp({create:{width:1,height:1,channels:3,background:'red'}}).png().toBuffer());
    assert.equal((await f.app.inject(base+'/entry?path=native%3Astream.md')).statusCode,200);
    assert.equal((await f.app.inject(base+'/content?path=native%3Astream.md')).json().text,'native colon file');
    assert.equal((await f.app.inject(base+'/image?path=native%3Apreview.png')).statusCode,200);
    for(const endpoint of ['entry','content','image'])assert.equal((await f.app.inject(base+'/'+endpoint+'?path=missing%3Astream')).statusCode,404);
  }
});

test('root file scope retains directory link restrictions and opt-in sensitive path protection',async t=>{
  const f=await fixture(t);await writeFile(join(f.outside,'.env'),'hidden');await symlink(f.outside,join(f.root,'linked'),'junction');
  assert.ok(!(await f.projects.listFiles(undefined)).files.some(file=>file.path==='linked'));
  for(const path of ['linked','linked/private.txt'])assert.equal((await f.app.inject('/api/files/entry?path='+encodeURIComponent(path))).statusCode,403);
  const allowed=new Projects(f.root,true);assert.equal((await allowed.readFile(undefined,'linked/private.txt')).text,'outside');await assert.rejects(allowed.readFile(undefined,'linked/.env'),{statusCode:403});
});

test('session files follow verified cwd while projectless Git and outside cwd remain blocked',async t=>{
  const f=await fixture(t);
  for(const [id,cwd] of [['root-thread',f.root],['project-thread',f.project.path],['outside-thread',f.outside],['nested-thread',join(f.project.path,'nested')]])await f.rpc('fixture/native-thread',{threadId:id,status:{type:'notLoaded'},thread:{cwd,projectId:null}});
  for(const [id,name] of [['root-thread','root'],['project-thread','project']]){
    const base='/api/sessions/'+id+'/files';assert.equal((await f.app.inject(base)).statusCode,200);assert.equal((await f.app.inject(base+'/entry?path='+name+'.md')).statusCode,200);assert.equal((await f.app.inject(base+'/content?path='+name+'.md')).json().text,'# '+(name==='root'?'Root':'Project'));assert.equal((await f.app.inject(base+'/image?path='+name+'.png')).statusCode,200);
  }
  for(const id of ['outside-thread','nested-thread'])for(const suffix of ['','/entry?path=private.txt','/content?path=private.txt','/image?path=private.png'])assert.equal((await f.app.inject('/api/sessions/'+id+'/files'+suffix)).statusCode,404,id+suffix);
  for(const suffix of ['/git/files','/git/repositories','/git/log'])assert.equal((await f.app.inject('/api/sessions/root-thread'+suffix)).statusCode,404);
  assert.equal((await f.app.inject('/api/sessions/root-thread/files/image?path=root.png&revision=index')).statusCode,400);
  assert.equal((await f.app.inject('/api/sessions/root-thread/files/image?path=root.png&repository=')).statusCode,400);
  await f.rpc('fixture/native-thread',{threadId:'root-thread',status:{type:'notLoaded'},thread:{cwd:f.outside,projectId:null}});
  assert.equal((await f.app.inject('/api/sessions/root-thread/files/content?path=root.md')).statusCode,404,'A formerly valid root thread must not retain old file access after cwd changes');
  const stats=await f.rpc('fixture/stats');assert.equal(stats.lastThread,undefined);assert.equal(stats.resumes,0);assert.equal(stats.turnStarts,0);
});

test('raw files serve original 4K PNG and JPEG bytes with image-only access restrictions',async t=>{
 const f=await fixture(t);
 await f.rpc('fixture/native-thread',{threadId:'raw-thread',status:{type:'notLoaded'},thread:{cwd:f.project.path,projectId:null}});
 const png=await sharp({create:{width:3840,height:2160,channels:3,background:'red'}}).png().toBuffer();
 const jpeg=await sharp(png).jpeg().toBuffer();
 for(const dir of [f.root,f.project.path]){
  await writeFile(join(dir,'原帧 #1.png'),png);await writeFile(join(dir,'original.jpg'),jpeg);
  await writeFile(join(dir,'bad.png'),'<html>not an image</html>');
  await writeFile(join(dir,'vector.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  await writeFile(join(dir,'huge.png'),Buffer.alloc(20*1024*1024+1));
  await writeFile(join(dir,'.env.png'),png);
 }
 await writeFile(join(f.outside,'private.png'),png);await symlink(f.outside,join(f.root,'linked'),'junction');
 for(const base of ['/api/files','/api/projects/'+f.project.id+'/files','/api/sessions/raw-thread/files']){
  for(const [path,bytes,type] of [['原帧 #1.png',png,'image/png'],['original.jpg',jpeg,'image/jpeg']] as const){
   const response=await f.app.inject(base+'/raw?path='+encodeURIComponent(path));
   assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.rawPayload,bytes);
   assert.equal(response.headers['content-type'],type);assert.equal(response.headers['content-disposition'],'inline');
   assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['x-content-type-options'],'nosniff');
   assert.equal(response.headers['content-security-policy'],"default-src 'none'; sandbox");
   assert.equal((await sharp(response.rawPayload).metadata()).width,3840);
  }
  for(const [path,status] of [['bad.png',415],['vector.svg',415],['huge.png',413],['.env.png',403],['../outside/private.png',400],[join(f.outside,'private.png'),400]] as const)assert.equal((await f.app.inject(base+'/raw?path='+encodeURIComponent(path))).statusCode,status,path);
  for(const suffix of ['/raw','/raw?path=original.jpg&revision=index'])assert.equal((await f.app.inject(base+suffix)).statusCode,400);
 }
 assert.equal((await f.app.inject('/api/files/raw?path=linked/private.png')).statusCode,403);
});
