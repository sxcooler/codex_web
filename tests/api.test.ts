import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { get } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { initializeAuth } from '../src/server/auth.ts';
import { buildServer } from '../src/server/app.ts';
import { Projects } from '../src/projects.ts';
import sharp from 'sharp';

test('authenticated project/session routes keep cwd server-owned and SSE closes on logout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-api-'));
  let app: any;
  const runtime: any = new EventEmitter();
  let created: any;
  let replayCursor: string | undefined;
  let archiveFilter=false,archiveInput:any;
  const picture=await sharp({create:{width:1200,height:800,channels:3,background:'#89cdb1'}}).png().toBuffer();
  let imageReads=0;
  Object.assign(runtime, {
    create: async (input: any) => { created = input; return {threadId:'thread-1',status:'idle'}; },
    list: async (_cursor:string,archived=false) => {archiveFilter=archived;return { data:[{id:'thread-1',cwd:created?.cwd}],nextCursor:null };},
    snapshot: async () => ({thread:{id:'thread-1',cwd:created?.cwd,turns:[]},phase:'IDLE',pending:[]}),
    status: async () => ({resync:false}),
    history: async (_id:string,before:string) => ({turns:[{id:before}],nextCursor:null}),
    output: async (_id:string,turnId:string,itemId:string) => ({output:turnId+':'+itemId}),
    image: async (threadId:string,turnId:string,itemId:string,imageId:string) => {imageReads++;assert.equal(threadId,'thread-1');assert.equal(turnId,'turn-1');assert.equal(itemId,'item-1');if(imageId==='0'.repeat(64))throw Object.assign(new Error('missing'),{code:'RUNTIME_NOT_FOUND',statusCode:404});return picture;},
    replay: (_threadId:string,cursor?:string) => { replayCursor=cursor; return {reset:true,events:[]}; }, close: async () => {}, diagnostics: async () => ({available:true}),
    rename: async (_id:string,name:string) => ({name}),
    open: async () => ({phase:'IDLE'}),
    archive: async (id:string,archived:boolean) => {archiveInput={id,archived};return {threadId:id,archived};},
  });
  try {
    const root = join(dir,'work'); await mkdir(root);
    const dataDir=join(dir,'data'); await initializeAuth(dataDir,'api-test-password-long');
    app=await buildServer({dataDir,origin:'http://localhost:3000',projects:new Projects(root),runtime});
    assert.equal((await app.inject({url:'/api/projects',headers:{host:'localhost:3000'}})).statusCode,401);
    assert.equal((await app.inject({url:'/api/sessions/thread-1/files/image?path=picture.png',headers:{host:'localhost:3000'}})).statusCode,401);
    assert.equal((await app.inject({url:'/%61pi/sessions/thread-1/events',headers:{host:'localhost:3000'}})).statusCode,401);
    const csrf=await app.inject({url:'/api/auth/session',headers:{host:'localhost:3000'}});
    const headers:any={host:'localhost:3000',origin:'http://localhost:3000','x-csrf-token':csrf.json().csrfToken,cookie:csrf.headers['set-cookie'].split(';')[0]};
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{password:'api-test-password-long'}});
    headers.cookie+='; '+login.headers['set-cookie'].split(';')[0];
    const imageUrl='/api/sessions/thread-1/turns/turn-1/items/item-1/images/'+'a'.repeat(64);
    assert.equal((await app.inject({url:imageUrl,headers:{host:'localhost:3000'}})).statusCode,401);
    assert.equal(imageReads,0);
    const thumbnail=await app.inject({url:imageUrl,headers});
    assert.equal(thumbnail.statusCode,200,thumbnail.body);
    assert.match(thumbnail.headers['content-type'],/^image\/webp/);
    assert.ok(thumbnail.rawPayload.length<=65536);
    const dimensions=await sharp(thumbnail.rawPayload).metadata();
    assert.ok(dimensions.width!<=384&&dimensions.height!<=384);
    await app.inject({url:imageUrl,headers});assert.equal(imageReads,1,'Thumbnail cache missed');
    assert.equal((await app.inject({url:imageUrl,headers:{host:'localhost:3000'}})).statusCode,401,'Cache must not bypass login');
    assert.equal((await app.inject({url:imageUrl,headers:{...headers,host:'evil.example'}})).statusCode,403);
    const original=await app.inject({url:imageUrl+'?size=original',headers});
    assert.equal(original.statusCode,200);assert.deepEqual(original.rawPayload,picture);
    assert.match(original.headers['cache-control'],/no-store/);
    assert.equal((await app.inject({url:imageUrl+'?path=secret',headers})).statusCode,400);
    assert.equal((await app.inject({url:imageUrl+'?size=huge',headers})).statusCode,400);
    assert.equal((await app.inject({url:imageUrl.replace('a'.repeat(64),'0'.repeat(64)),headers})).statusCode,404);
    const project=await app.inject({method:'POST',url:'/api/projects',headers,payload:{name:'Test',folderName:'test'}});
    assert.equal(project.statusCode,200,project.body);
    const projectId=project.json().project.id;
    assert.equal((await app.inject({method:'POST',url:'/api/sessions',headers,payload:{cwd:'C:\\',clientRequestId:'test-request-1'}})).statusCode,400);
    const session=await app.inject({method:'POST',url:'/api/sessions',headers,payload:{projectId,clientRequestId:'test-request-1',prompt:'hello'}});
    assert.equal(session.statusCode,200,session.body);
    assert.equal(created.cwd,join(root,'test'));
    assert.equal((await app.inject({method:'POST',url:'/api/sessions/thread-1/open',headers,payload:{}})).json().phase,'IDLE');
    assert.equal((await app.inject({method:'POST',url:'/api/sessions/thread-1/open',headers,payload:{cwd:root}})).statusCode,400);
    for(const kind of ['archive','unarchive']){
      const url='/api/sessions/thread-1/'+kind;
      assert.equal((await app.inject({method:'POST',url,headers:{...headers,cookie:headers.cookie.split(';')[0]},payload:{}})).statusCode,401);
      assert.equal((await app.inject({method:'POST',url,headers:{...headers,'x-csrf-token':''},payload:{}})).statusCode,403);
      assert.equal((await app.inject({method:'POST',url,headers,payload:{force:true}})).statusCode,400);
      assert.equal((await app.inject({method:'POST',url,headers,payload:{}})).statusCode,200);
      assert.deepEqual(archiveInput,{id:'thread-1',archived:kind==='archive'});
    }
    assert.equal((await app.inject({url:'/api/sessions?archived=true',headers})).statusCode,200);assert.equal(archiveFilter,true);
    await app.inject({url:'/api/sessions',headers});assert.equal(archiveFilter,false);
    const fetchRoute='/api/sessions/thread-1/git/fetch';
    assert.equal((await app.inject({method:'POST',url:fetchRoute,headers:{...headers,cookie:headers.cookie.split(';')[0]},payload:{}})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:fetchRoute,headers:{...headers,'x-csrf-token':''},payload:{}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:fetchRoute,headers,payload:{cwd:root}})).statusCode,400);
    const fetchResult=await app.inject({method:'POST',url:fetchRoute,headers,payload:{}});
    assert.equal(fetchResult.statusCode,200,fetchResult.body);assert.equal(fetchResult.json().skipped,'no-remotes');
    await copyFile(new URL('../public/assets/icon-mobile-v1-192.png',import.meta.url),join(root,'test','picture.png'));
    const image=await app.inject({url:'/api/sessions/thread-1/files/image?path=picture.png&v=1',headers});
    assert.equal(image.statusCode,200,image.body); assert.equal(image.headers['content-type'],'image/webp');
    assert.equal(image.headers['cache-control'],'no-store'); assert.equal(image.headers['x-content-type-options'],'nosniff');
    assert.equal(image.rawPayload.subarray(8,12).toString(),'WEBP');
    assert.equal((await app.inject({url:'/api/sessions/thread-1/files/image',headers})).statusCode,400);
    assert.equal((await app.inject({url:'/api/sessions/thread-1/files/image?path=missing.png',headers})).statusCode,404);
    assert.equal((await app.inject({url:'/api/sessions/thread-1/files/image?path=picture.png&revision=HEAD',headers})).statusCode,400);
    execFileSync('git',['add','picture.png'],{cwd:join(root,'test'),windowsHide:true});
    const stagedImage=await app.inject({url:'/api/sessions/thread-1/files/image?path=picture.png&revision=index',headers});
    assert.equal(stagedImage.statusCode,200,stagedImage.body);
    assert.deepEqual(stagedImage.rawPayload,image.rawPayload);
    const chinesePrompt='验'.repeat(12_000);
    const chinese=await app.inject({method:'POST',url:'/api/sessions',headers,payload:{projectId,clientRequestId:'chinese-request-1',prompt:chinesePrompt}});
    assert.equal(chinese.statusCode,200,chinese.body);
    assert.equal(created.prompt,chinesePrompt);
    assert.equal((await app.inject({method:'POST',url:'/api/sessions',headers,payload:{projectId,clientRequestId:'oversize-request-1',prompt:'验'.repeat(100_000)}})).statusCode,400);
    const snapshot=await app.inject({url:'/api/sessions/thread-1',headers});
    assert.equal(snapshot.json().project.id,projectId);
    if (process.platform === 'linux') {
      const other = await app.inject({ method:'POST', url:'/api/projects', headers, payload:{name:'Case-sensitive',folderName:'Test'} });
      assert.equal(other.statusCode,200,other.body);
      created.cwd = join(root,'Test');
      assert.equal((await app.inject({url:'/api/sessions/thread-1',headers})).json().project.id,other.json().project.id);
      created.cwd = 'C:\\Windows\\foreign-project';
      assert.equal((await app.inject({url:'/api/sessions/thread-1',headers})).json().project,null);
      created.cwd = relative(process.cwd(), join(root,'test'));
      assert.equal((await app.inject({url:'/api/sessions/thread-1',headers})).json().project,null);
      created.cwd = '/' + join(root,'test');
      assert.equal((await app.inject({url:'/api/sessions/thread-1',headers})).json().project,null);
      created.cwd = join(root,'test');
    }
    assert.deepEqual((await app.inject({url:'/api/sessions/thread-1/history?before=turn-20',headers})).json(),{turns:[{id:'turn-20'}],nextCursor:null,attachmentPreviews:[]});
    assert.deepEqual((await app.inject({url:'/api/sessions/thread-1/turns/turn-20/items/command-1/output',headers})).json(),{output:'turn-20:command-1'});
    for(const url of ['/api/sessions/thread-1/history','/api/sessions/thread-1/history?before=','/api/sessions/thread-1/history?before=ok&extra=1','/api/sessions/thread-1/history?before=bad%2Fid','/api/sessions/thread-1/turns/bad%2Fid/items/command/output','/api/sessions/thread-1/turns/turn/items/bad%20id/output','/api/sessions/thread-1/turns/turn/items/command/output?extra=1']) assert.equal((await app.inject({url,headers})).statusCode,400,url);
    const history=await app.inject({url:'/api/sessions/thread-1/git/log',headers});
    assert.equal(history.statusCode,200,history.body); assert.equal(history.json().repository,true);
    const renamed=await app.inject({method:'POST',url:'/api/sessions/thread-1/name',headers,payload:{name:'  New name  '}});
    assert.equal(renamed.json().name,'New name');
    const changed=await app.inject({method:'POST',url:'/api/sessions/thread-1/metadata',headers,payload:{favorite:true,hidden:true}});
    assert.equal(changed.json().metadata.favorite,true); assert.equal(changed.json().metadata.hidden,true);
    assert.equal((await app.inject({url:'/api/sessions',headers})).json().data.length,0);
    assert.equal((await app.inject({url:'/api/sessions?includeHidden=true',headers})).json().data.length,1);
    assert.equal((await app.inject({method:'POST',url:'/api/sessions/thread-1/metadata/clear',headers,payload:{}})).json().metadata,null);
    assert.equal((await app.inject({url:'/api/sessions/thread-1/files',headers})).statusCode,200);
    assert.equal((await app.inject({url:'/api/sessions/bad%3Aid',headers})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:'/api/sessions/thread-1/abort',headers,payload:{unexpected:true}})).statusCode,400);
    assert.equal((await app.inject({url:'/api/sessions/thread-1?unexpected=true',headers})).statusCode,400);
    const metadata=new DatabaseSync(join(dataDir,'metadata.sqlite'));
    metadata.exec("CREATE TRIGGER reject_metadata BEFORE INSERT ON session_meta BEGIN SELECT RAISE(FAIL, 'test disk failure'); END;");
    metadata.close();
    const degraded=await app.inject({method:'POST',url:'/api/sessions',headers,payload:{projectId,clientRequestId:'test-request-2'}});
    assert.equal(degraded.statusCode,200,degraded.body);
    assert.equal(degraded.json().threadId,'thread-1');
    assert.match(degraded.json().warning,/metadata/i);
    assert.equal((await app.inject({url:'/api/sessions/thread-1',headers})).statusCode,200);
    runtime.create=async()=>{throw Object.assign(new Error('Acceptance unknown'),{statusCode:504,code:'RUNTIME_UNCERTAIN',partial:{threadId:'known-thread'}});};
    const uncertain=await app.inject({method:'POST',url:'/api/projects',headers,payload:{name:'Partial',folderName:'partial',clientRequestId:'test-request-3'}});
    assert.equal(uncertain.statusCode,504);
    assert.equal(uncertain.json().code,'RUNTIME_UNCERTAIN');
    assert.ok(uncertain.json().project.id);
    assert.equal(uncertain.json().partial.threadId,'known-thread');
    assert.deepEqual((await app.inject({url:'/api/sessions/thread-1/status?epoch=epoch',headers})).json(),{resync:false});
    assert.equal((await app.inject({url:'/api/sessions/thread-1/events?cursor=bad',headers})).statusCode,400);
    const address=await app.listen({host:'127.0.0.1',port:0});
    const queryResponse=await new Promise<any>(resolve=>get(address+'/api/sessions/thread-1/events?cursor=epoch:7',{headers},resolve));
    assert.equal(queryResponse.statusCode,200); assert.equal(replayCursor,'epoch:7'); queryResponse.destroy();
    const response=await new Promise<any>(resolve=>get(address+'/api/sessions/thread-1/events?cursor=epoch:7',{headers:{...headers,'last-event-id':'epoch:9'}},resolve));
    assert.equal(replayCursor,'epoch:9');
    assert.equal(response.statusCode,200);
    assert.equal(response.headers['cache-control'],'no-store');
    const reader=response[Symbol.asyncIterator]();
    assert.match(String((await reader.next()).value),/event: resync/);
    await app.inject({method:'POST',url:'/api/auth/logout',headers});
    while (!(await reader.next()).done) { /* drain queued heartbeat */ }
    assert.equal(runtime.listenerCount('change'),0);
  } finally {
    await app?.close(); assert.equal(dirname(dir),tmpdir()); await rm(dir,{recursive:true,force:true});
  }
});
