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
import { Runtime } from '../src/codex/runtime.ts';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import Fastify from 'fastify';
import {registerApi} from '../src/server/api.ts';
import {MetadataStore} from '../src/server/metadata.ts';

test('empty-preview fork supplements persist, remain reachable after native exhaustion and bind pagination to sort/filter',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fork-list-api-')),runtime=new Runtime({executable:process.execPath,cwd:dir});
  t.mock.method(runtime,'close',async()=>{});
  const headers=new Map<string,any>(),reads:string[]=[],sorts:string[]=[];let active=0,maxActive=0;
  t.mock.method(runtime,'list',async(cursor,archived,sort)=>{sorts.push(sort!);return {data:cursor?[]:[{id:'native',createdAt:15,updatedAt:25}],nextCursor:null};});
  const readHeader=async(id:string)=>{reads.push(id);active++;maxActive=Math.max(active,maxActive);await new Promise(resolve=>setTimeout(resolve,1));active--;const thread=headers.get(id);return thread?{thread,archived:!!thread.archived}:null;};
  const headerMock=t.mock.method(runtime,'forkListHeader',readHeader);
  t.mock.method(runtime,'snapshot',async id=>({thread:{...headers.get(id),turns:[]},phase:'IDLE',pending:[]}));
  t.mock.method(runtime,'fork',async()=>({threadId:'new-fork',status:'idle',cwd:dir,header:headers.get('new-fork')}));
  t.mock.method(runtime,'invalidateForkHeader',()=>{});
  const project:any={root:dir,list:async()=>[]};
  let app=Fastify();registerApi(app,{dataDir:dir,runtime,projects:project,authenticated:()=>()=>true});
  try{
    const store=new MetadataStore(join(dir,'metadata.sqlite'));
    for(let i=0;i<34;i++){const thread={id:'fork-'+i,forkedFromId:'source',source:'vscode',preview:'',createdAt:100-i,updatedAt:200-i,cwd:dir};headers.set(thread.id,thread);store.registerFork(thread);}
    store.update('fork-33',{hidden:true});store.close();
    const first=await app.inject('/api/sessions?sortKey=created_at');assert.equal(first.statusCode,200,first.body);
    assert.equal(reads.length,32);assert.ok(maxActive<=4);assert.ok(first.json().forksPending);assert.ok(first.json().nextCursor);assert.ok(!first.json().data.some((thread:any)=>thread.id==='fork-33'));
    const home=join(dir,'native-home');await mkdir(join(home,'sessions'),{recursive:true});(runtime as any).initializeInfo={codexHome:home};
    for(const id of ['fork-0','fork-1']){const path=join(home,'sessions',id+'.jsonl');await writeFile(path,'header');headers.get(id).path=path;}
    const initialized=new Promise(resolve=>setTimeout(()=>resolve({request:async(method:string,input:any)=>{assert.equal(method,'thread/read');assert.equal(input.includeTurns,false);reads.push(input.threadId);return {thread:{...headers.get(input.threadId),turns:[]}};}}),20));
    t.mock.method(runtime as any,'getServer',()=>initialized);headerMock.mock.restore();
    const second=await app.inject('/api/sessions?sortKey=created_at&cursor='+encodeURIComponent(first.json().nextCursor));assert.equal(second.statusCode,200,second.body);
    assert.deepEqual(second.json().data.map((thread:any)=>thread.id),['fork-0','fork-1']);assert.equal(second.json().nextCursor,null);assert.equal(reads.length,34);assert.equal(sorts.length,1,'do not restart an exhausted native stream');
    t.mock.method(runtime,'forkListHeader',readHeader);
    assert.equal((await app.inject('/api/sessions?sortKey=updated_at&cursor='+encodeURIComponent(first.json().nextCursor))).statusCode,400);
    assert.equal((await app.inject('/api/sessions?sortKey=created_at&archived=true&cursor='+encodeURIComponent(first.json().nextCursor))).statusCode,400);
    assert.equal((await app.inject('/api/sessions?sortKey=recency_at')).statusCode,400);
    headers.set('existing',{id:'existing',forkedFromId:'source',source:'vscode',preview:'',createdAt:300,updatedAt:400,cwd:dir});
    assert.equal((await app.inject('/api/sessions/existing')).statusCode,200);
    headers.set('new-fork',{...headers.get('existing'),id:'new-fork'});
    assert.equal((await app.inject({method:'POST',url:'/api/sessions/source/fork',payload:{lastTurnId:'done',clientRequestId:'test-fork-1'}})).statusCode,200);
    await app.close();app=Fastify();registerApi(app,{dataDir:dir,runtime,projects:project,authenticated:()=>()=>true});
    const refreshed=(await app.inject('/api/sessions')).json();assert.ok(refreshed.data.some((thread:any)=>thread.id==='existing'));assert.ok(refreshed.data.some((thread:any)=>thread.id==='new-fork'));
    headers.get('new-fork').archived=true;headers.delete('existing');
    const recent=(await app.inject('/api/sessions')).json();assert.ok(!recent.data.some((thread:any)=>['new-fork','existing'].includes(thread.id)));
    const archived=(await app.inject('/api/sessions?archived=true')).json();assert.deepEqual(archived.data.filter((thread:any)=>thread.id.startsWith('new')).map((thread:any)=>thread.id),['new-fork']);
    const included=(await app.inject('/api/sessions?includeHidden=true')).json();assert.ok(included.data.some((thread:any)=>thread.id==='fork-33'));
    const originalNow=Date.now;let now=originalNow(),attempted=0;
    const timer=t.mock.method(Date,'now',()=>now);
    t.mock.method(runtime,'forkListHeader',async(_id,timeoutMs)=>{assert.ok(timeoutMs!>0&&timeoutMs!<=5000);attempted++;now+=2000;throw Error('native read timed out');});
    const partial=(await app.inject('/api/sessions')).json();timer.mock.restore();
    assert.equal(partial.forkReadsFailed,true);assert.equal(partial.forksPending,true);assert.ok(partial.nextCursor);
    assert.deepEqual(partial.data.map((thread:any)=>thread.id),['native'],'a failed supplement cannot manufacture headers');
    assert.equal(attempted,4,'the expired budget must not schedule another header batch');
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('fork API enforces authentication, strict body and native project association without repeating degraded forks',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-fork-api-'));
  let app:any;
  const runtime=new Runtime({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/runtime-server.mjs',import.meta.url))],cwd:dir,idleMs:60_000});
  try{
    const root=join(dir,'work');await mkdir(root);
    const projects=new Projects(root),project=await projects.create({name:'Fork project',folderName:'fork-project'});
    const dataDir=join(dir,'data');await initializeAuth(dataDir,'fork-api-password-long');
    app=await buildServer({dataDir,origin:'http://localhost:3000',projects,runtime});
    await (runtime as any).call('fixture/native-thread',{threadId:'source',status:{type:'notLoaded'},thread:{cwd:project.path,turns:[{id:'first',status:'completed',items:[]}]}});
    const payload={lastTurnId:'first',clientRequestId:'fork-api-request-1'},url='/api/sessions/source/fork';
    const csrf=await app.inject({url:'/api/auth/session',headers:{host:'localhost:3000'}});
    const headers:any={host:'localhost:3000',origin:'http://localhost:3000','x-csrf-token':csrf.json().csrfToken,cookie:csrf.headers['set-cookie'].split(';')[0]};
    assert.equal((await app.inject({method:'POST',url,headers,payload})).statusCode,401);
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{password:'fork-api-password-long'}});
    headers.cookie+='; '+login.headers['set-cookie'].split(';')[0];
    const {['x-csrf-token']:token,...noCsrf}=headers;
    assert.equal((await app.inject({method:'POST',url,headers:noCsrf,payload})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url,headers:{...headers,origin:'http://other.test'},payload})).statusCode,403);
    for(const invalid of [{...payload,cwd:root},{...payload,config:{}},{...payload,lastTurnId:'bad/id'},{...payload,clientRequestId:'x'},{clientRequestId:payload.clientRequestId}]){
      assert.equal((await app.inject({method:'POST',url,headers,payload:invalid})).statusCode,400);
    }
    assert.equal((await (runtime as any).call('fixture/stats',{})).forks,0);
    const response=await app.inject({method:'POST',url,headers,payload});
    assert.equal(response.statusCode,200,response.body);
    assert.deepEqual(response.json(),{threadId:'fork-1',status:'idle'});
    const metadata=new DatabaseSync(join(dataDir,'metadata.sqlite'));
    try{
      assert.equal((metadata.prepare('SELECT project_path FROM session_meta WHERE thread_id=?').get('fork-1') as any).project_path,project.path);
      assert.equal((metadata.prepare('SELECT thread_id FROM known_forks WHERE thread_id=?').get('fork-1') as any).thread_id,'fork-1');
      metadata.exec("CREATE TRIGGER reject_fork_metadata BEFORE INSERT ON session_meta BEGIN SELECT RAISE(FAIL, 'test disk failure'); END;");
    }finally{metadata.close();}
    const degradedInput={...payload,clientRequestId:'fork-api-request-2'};
    const degraded=await app.inject({method:'POST',url,headers,payload:degradedInput});
    assert.equal(degraded.statusCode,200,degraded.body);assert.equal(degraded.json().threadId,'fork-2');assert.match(degraded.json().warning,/metadata/i);
    assert.deepEqual((await app.inject({method:'POST',url,headers,payload:degradedInput})).json(),degraded.json());
    assert.equal((await (runtime as any).call('fixture/stats',{})).forks,2);
    assert.ok((await app.inject({url:'/api/sessions',headers})).json().data.some((thread:any)=>thread.id==='fork-2'));
    const originalList=projects.list;
    projects.list=async()=>{throw new Error('project association unavailable');};
    const unassociated=await app.inject({method:'POST',url,headers,payload:{...payload,clientRequestId:'fork-api-request-4'}});
    assert.equal(unassociated.statusCode,200,unassociated.body);assert.equal(unassociated.json().threadId,'fork-3');assert.match(unassociated.json().warning,/metadata/i);
    projects.list=originalList;
    runtime.fork=async()=>{throw Object.assign(new Error('Fork result unknown'),{code:'RUNTIME_RESULT_UNKNOWN',statusCode:504,partial:{threadId:'known-fork'}});};
    const uncertain=await app.inject({method:'POST',url,headers,payload:{...payload,clientRequestId:'fork-api-request-3'}});
    assert.equal(uncertain.statusCode,504);assert.deepEqual(uncertain.json(),{error:'Fork result unknown',code:'RUNTIME_RESULT_UNKNOWN',partial:{threadId:'known-fork'}});
  }finally{if(app)await app.close();else await runtime.close();await rm(dir,{recursive:true,force:true});}
});

test('authenticated project/session routes keep cwd server-owned and SSE closes on logout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-api-'));
  let app: any;
  const runtime: any = new EventEmitter();
  let created: any,modelDefaults:any;
  let allowHistory=true;
  let replayCursor: string | undefined;
  let archiveFilter=false,archiveInput:any;
  const picture=await sharp({create:{width:1200,height:800,channels:3,background:'#89cdb1'}}).png().toBuffer();
  let imageReads=0;
  Object.assign(runtime, {
    create: async (input: any) => { created = input; return {threadId:'thread-1',status:'idle'}; },
    saveModelDefaults: async (cwd:string,model:string,effort:string,expectedVersion:string) => {modelDefaults={cwd,model,effort,expectedVersion};return {model,effort,effectiveModel:model,effectiveEffort:effort};},
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
    invalidateForkHeader:()=>{},
  });
  try {
    const root = join(dir,'work'); await mkdir(root);
    const dataDir=join(dir,'data'); await initializeAuth(dataDir,'api-test-password-long');
    app=await buildServer({dataDir,origin:'http://localhost:3000',projects:new Projects(root),runtime});
    let eventStream: any;
    app.addHook('onRequest', async (request: any, reply: any) => { if (request.url.includes('/events')) eventStream = reply.raw; });
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
    assert.equal((await app.inject({method:'POST',url:'/api/model-defaults',headers:{host:'localhost:3000'},payload:{model:'fixture'}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/model-defaults',headers,payload:{model:'fixture',keyPath:'secret'}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:'/api/model-defaults',headers,payload:{projectId,model:'fixture',effort:'high'}})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:'/api/model-defaults',headers,payload:{projectId,model:'fixture',effort:'high',expectedVersion:'user-v1'}})).statusCode,200);
    assert.deepEqual(modelDefaults,{cwd:join(root,'test'),model:'fixture',effort:'high',expectedVersion:'user-v1'});
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
    const hiddenPage=await app.inject({url:'/api/sessions',headers});assert.equal(hiddenPage.statusCode,200,hiddenPage.body);assert.equal(hiddenPageReads,5,'Hidden sessions must not scan the entire history in one request');assert.deepEqual(hiddenPage.json().data,[]);
    assert.equal(JSON.parse(Buffer.from(hiddenPage.json().nextCursor.slice(5),'base64url').toString()).native,'5');
    const nextHiddenPage=await app.inject({url:'/api/sessions?cursor='+encodeURIComponent(hiddenPage.json().nextCursor),headers});assert.equal(nextHiddenPage.json().nextCursor,null);
    runtime.list=async(cursor:string|undefined)=>cursor?{data:[{id:'parent'}],nextCursor:null}:{data:[],nextCursor:'after-subagents'};
    assert.deepEqual((await app.inject({url:'/api/sessions',headers})).json().data.map((thread:any)=>thread.id),['parent'],'Continue past a page containing only filtered subagents');
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
    assert.equal(queryResponse.statusCode,200); assert.equal(replayCursor,'epoch:7');
    assert.doesNotThrow(() => eventStream.emit('error', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })));
    assert.equal(runtime.listenerCount('change'),0, 'Broken SSE must release its runtime listener');
    queryResponse.destroy();
    const malformedResponse=await new Promise<any>(resolve=>get(address+'/api/sessions/thread-1/events',{headers},resolve));
    const circular: any = { threadId: 'thread-1', kind: 'change' }; circular.patch = circular;
    assert.doesNotThrow(() => runtime.emit('change', circular));
    assert.equal(runtime.listenerCount('change'),0, 'Unserializable SSE must close only its connection');
    malformedResponse.destroy();
    assert.equal((await app.inject({url:'/api/sessions/thread-1/status',headers})).statusCode,200, 'HTTP remains usable after stream failures');
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
