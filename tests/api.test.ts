import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { get } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
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
  let allowHistory=true;
  let replayCursor: string | undefined;
  let archiveFilter=false,archiveInput:any;
  const picture=await sharp({create:{width:1200,height:800,channels:3,background:'#89cdb1'}}).png().toBuffer();
  let imageReads=0;
  Object.assign(runtime, {
    create: async (input: any) => { created = input; return {threadId:'thread-1',status:'idle'}; },
    list: async (_cursor:string,archived=false) => {archiveFilter=archived;return { data:[{id:'thread-1',cwd:created?.cwd}],nextCursor:null };},
    threadCwd: async () => created?.cwd??null,
    snapshot: async () => {assert.ok(allowHistory,'Workspace requests must not read conversation history');return {thread:{id:'thread-1',cwd:created?.cwd,turns:[]},phase:'IDLE',pending:[]};},
    command: async (id:string,turnId:string,itemId:string) => {assert.equal(id,'thread-1');if(turnId!=='turn-1'||itemId!=='command-1')throw Object.assign(new Error('missing command'),{statusCode:404,code:'RUNTIME_NOT_FOUND'});return {id:itemId,type:'commandExecution'};},
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
    assert.equal((await app.inject({method:'POST',url:'/api/sessions/thread-1/turns/turn-1/items/question-1/answer',headers:{host:'localhost:3000'},payload:{answers:['Yes'],clientRequestId:'answer-old-123'}})).statusCode,403);
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
    allowHistory=false;
    for(const route of ['git/status','git/files','git/diff','git/log','files']){const response=await app.inject({url:'/api/sessions/thread-1/'+route,headers});assert.equal(response.statusCode,200,response.body);}
    await writeFile(join(root,'test','junit.xml'),'<testsuite><testcase name="ok"/></testsuite>');
    const reportUrl='/api/sessions/thread-1/test-reports',reportInput={turnId:'turn-1',commandItemId:'command-1',relativePath:'junit.xml',format:'junit'};
    const report=await app.inject({method:'POST',url:reportUrl,headers,payload:reportInput});assert.equal(report.statusCode,200,report.body);assert.equal(report.json().summary.passed,1);
    assert.equal((await app.inject({method:'POST',url:reportUrl,headers,payload:{...reportInput,turnId:'other'}})).statusCode,404);
    const {turnId,...missingTurn}=reportInput;assert.equal((await app.inject({method:'POST',url:reportUrl,headers,payload:missingTurn})).statusCode,400);
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
    const content=await app.inject({url:'/api/sessions/thread-1/files/content?path=picture.png',headers});assert.equal(content.statusCode,200,content.body);
    const stagedImage=await app.inject({url:'/api/sessions/thread-1/files/image?path=picture.png&revision=index',headers});
    assert.equal(stagedImage.statusCode,200,stagedImage.body);
    assert.deepEqual(stagedImage.rawPayload,image.rawPayload);
    const chinesePrompt='验'.repeat(12_000);
    const chinese=await app.inject({method:'POST',url:'/api/sessions',headers,payload:{projectId,clientRequestId:'chinese-request-1',prompt:chinesePrompt}});
    assert.equal(chinese.statusCode,200,chinese.body);
    assert.equal(created.prompt,chinesePrompt);
    assert.equal((await app.inject({method:'POST',url:'/api/sessions',headers,payload:{projectId,clientRequestId:'oversize-request-1',prompt:'验'.repeat(100_000)}})).statusCode,400);
    allowHistory=true;
    runtime.question=async()=>({questions:[{title:'Continue?',options:['Yes','No']}]});
    runtime.send=async()=>{throw Object.assign(new Error('uncertain delivery'),{statusCode:504,code:'RUNTIME_UNCERTAIN'});};
    assert.equal((await app.inject({method:'POST',url:'/api/sessions/thread-1/turns/turn-1/items/question-1/answer',headers,payload:{answers:['Yes'],clientRequestId:'answer-old-123'}})).statusCode,504);
    assert.equal((await app.inject({url:'/api/sessions/thread-1',headers})).json().inputAnswers['turn-1:question-1'].status,'unknown');
    const originalHistory=runtime.history;runtime.history=async()=>({turns:[{id:'older',items:[{type:'userMessage',clientId:'answer-old-123'}]}],nextCursor:null});
    assert.equal((await app.inject({url:'/api/sessions/thread-1/history?before=old-turn',headers})).json().inputAnswers['turn-1:question-1'].status,'accepted');
    runtime.history=originalHistory;
    const snapshot=await app.inject({url:'/api/sessions/thread-1',headers});
    assert.equal(snapshot.json().project.id,projectId);
    created.cwd=dir;assert.equal((await app.inject({url:'/api/sessions/thread-1/files/content?path=picture.png',headers})).statusCode,404,'Must not trust stale project metadata');created.cwd=join(root,'test');
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
    assert.deepEqual((await app.inject({url:'/api/sessions/thread-1/history?before=turn-20',headers})).json(),{turns:[{id:'turn-20'}],nextCursor:null,inputAnswers:{'turn-1:question-1':{status:'accepted'}},attachmentPreviews:[]});
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
    const originalList=runtime.list;let hiddenPageReads=0;
    for(let i=0;i<8;i++)await app.inject({method:'POST',url:'/api/sessions/hidden-'+i+'/metadata',headers,payload:{hidden:true}});
    runtime.list=async(cursor:string|undefined)=>{hiddenPageReads++;const i=Number(cursor??0);return {data:[{id:'hidden-'+i}],nextCursor:i<7?String(i+1):null};};
    const hiddenPage=await app.inject({url:'/api/sessions',headers});assert.equal(hiddenPage.statusCode,200,hiddenPage.body);assert.equal(hiddenPageReads,5,'Hidden sessions must not scan the entire history in one request');assert.deepEqual(hiddenPage.json().data,[]);assert.equal(hiddenPage.json().nextCursor,'5');
    const nextHiddenPage=await app.inject({url:'/api/sessions?cursor=5',headers});assert.equal(nextHiddenPage.json().nextCursor,null);
    runtime.list=async()=>({data:[{id:'hidden-0'}],nextCursor:'repeated'});
    assert.equal((await app.inject({url:'/api/sessions',headers})).statusCode,503,'Repeated native cursor must fail instead of looping');
    runtime.list=originalList;

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
    for(const route of ['snapshot','history']){
      const original=runtime[route];let entered!:()=>void,aborted!:()=>void;
      const started=new Promise<void>(resolve=>{entered=resolve;}),stopped=new Promise<void>(resolve=>{aborted=resolve;});
      runtime[route]=async(_id:string,option:any,historySignal?:AbortSignal)=>{
        const signal:AbortSignal=route==='snapshot'?option.signal:historySignal!;
        assert.ok(signal instanceof AbortSignal);entered();
        await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted();resolve();},{once:true}));
        signal.throwIfAborted();
      };
      const client=get(address+'/api/sessions/thread-1'+(route==='history'?'/history?before=turn-20':''),{headers});
      client.on('error',()=>{});
      try{await started;client.destroy();await Promise.race([stopped,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Disconnected '+route+' did not cancel the runtime read')),1000);timer.unref();})]);}
      finally{client.destroy();runtime[route]=original;}
    }
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
