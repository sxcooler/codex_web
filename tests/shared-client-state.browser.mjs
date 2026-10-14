import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';

await mkdir('.local',{recursive:true});
const requests=[],streams=new Set(),heldUsage=[],heldLists=[];
let authenticated=true,holdUsage=false,holdOldSearch=false,failCursor=false,staleCursor=false,revision=0;
let usage={accountId:'account-a',updatedAt:Date.now(),rateLimits:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+1}},rateLimitsByLimitId:null,rateLimitResetCredits:{availableCount:'1',credits:[{id:'credit-a',title:'旧账户机会',resetType:'codexRateLimits',status:'available',expiresAt:null}]},resetSupported:true};
let firstName='初始会话';
const json=(response,data,status=200)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(data));};
const server=await createServer({cacheDir:'.local/shared-state-vite',server:{host:'127.0.0.1',port:0,strictPort:true},plugins:[{name:'shared-state-browser-api',configureServer(vite){vite.middlewares.use((request,response,next)=>{
  const url=new URL(request.url,'http://127.0.0.1'),path=url.pathname;
  if(!path.startsWith('/api/'))return next();
  requests.push({path,query:url.searchParams.toString(),method:request.method});
  if(path==='/api/auth/session')return json(response,{authenticated,expired:!authenticated,csrfToken:'test'});
  if(path==='/api/auth/login'){authenticated=true;return json(response,{authenticated:true});}
  if(path==='/api/auth/renew')return json(response,{authenticated});
  if(path==='/api/state/events'||/^\/api\/sessions\/[^/]+\/events$/.test(path)){
    if(!authenticated)return json(response,{error:'Authentication required'},401);
    response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});response.write('event: ready\ndata: {}\n\n');
    const stream={path,response};streams.add(stream);request.on('close',()=>streams.delete(stream));return;
  }
  if(path==='/api/account/usage'){
    const value={...usage};if(holdUsage){heldUsage.push({fresh:url.searchParams.get('refresh')==='true',finish:()=>json(response,value)});return;}return json(response,value);
  }
  if(path==='/api/projects')return json(response,{projects:[],workRoot:'C:/work'});
  if(path==='/api/models')return json(response,{data:[]});
  if(path==='/api/permission-modes')return json(response,{modes:[]});
  if(path==='/api/sessions'){
    const term=url.searchParams.get('searchTerm'),cursor=url.searchParams.get('cursor');
    const rows=term?[{id:term==='旧搜索'?'old-search':'new-search',name:term+'结果',updatedAt:5}]:cursor?[{id:'older',name:'已加载的下一页',updatedAt:1}]:[{id:'shared-1',name:firstName,updatedAt:4,release:{requested:true,handoffReady:false}}];
    const result={data:rows,nextCursor:term||cursor?null:'next'};
    if(holdOldSearch&&term==='旧搜索'){heldLists.push(()=>json(response,result));return;}
    return failCursor&&cursor?json(response,{error:'分页缓存读取失败'},503):json(response,staleCursor&&cursor?{...result,stale:true,error:{message:'后台刷新失败，显示旧快照'}}:result);
  }
  if(/^\/api\/sessions\/[^/]+$/.test(path))return json(response,{thread:{id:path.split('/').at(-1),name:'线程标题',cwd:'C:/work',turns:[{id:'done',status:'completed',items:[{id:'answer',type:'agentMessage',text:'主会话消息仍然可读'}]}]},phase:'IDLE',pending:[],epoch:'shared-test',revision:0,syncCursor:'shared-test:0'});
  if(path.endsWith('/status'))return json(response,{resync:false});
  return json(response,{});
});}}]});
await server.listen();
const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({locale:'zh-CN',viewport:{width:1280,height:900}}),pages=[],errors=[];
const until=async(check,message)=>{const end=Date.now()+10_000;while(!await check()){assert.ok(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,25));}};
const broadcast=(kind,value={})=>{for(const {response} of streams)response.write(`event: ${kind}\ndata: ${JSON.stringify(value)}\n\n`);};
const listReads=()=>requests.filter(request=>request.path==='/api/sessions');
const usageReads=()=>requests.filter(request=>request.path==='/api/account/usage');
const finishUsage=()=>{for(const {finish} of heldUsage.splice(0))finish();};
const heartbeat=setInterval(()=>broadcast('ping'),2000);
try {
  for(const route of ['/','/sessions/shared-1','/sessions/shared-2','/sessions/shared-3']){
    const page=await context.newPage();pages.push(page);page.on('pageerror',error=>errors.push(error.message));await page.clock.install();await page.goto(origin+route);
    await page.locator('.account-usage-button').waitFor();await page.locator('.sidebar .session-link').waitFor();
  }
  await until(()=>streams.size===4,'Four authenticated tabs must each own one steady stream');
  assert.equal([...streams].filter(stream=>stream.path==='/api/state/events').length,1,'Only the home tab opens the global stream');
  assert.equal([...streams].filter(stream=>stream.path.endsWith('/events')&&stream.path.includes('/sessions/')).length,3);
  const page=pages[0],names=()=>page.locator('.sidebar .session-link').allTextContents();
  await page.getByRole('button',{name:'加载更多',exact:true}).evaluate(button=>button.click());await until(async()=> (await names()).includes('已加载的下一页'),'Pagination must append');
  await page.locator('.account-usage-button').evaluate(button=>button.click());await page.locator('.account-usage-dialog[open]').waitFor();
  const quietLists=listReads().length,quietUsage=usageReads().length,quietRenewals=requests.filter(request=>request.path==='/api/auth/renew').length;
  for(const tab of pages)await tab.evaluate(()=>{for(const kind of ['focus','pageshow','online'])window.dispatchEvent(new Event(kind));document.dispatchEvent(new Event('visibilitychange'));});
  for(let step=0;step<13;step++){broadcast('ping');await new Promise(resolve=>setTimeout(resolve,25));for(const tab of pages)await tab.clock.runFor(10_000);}
  assert.equal(listReads().length,quietLists,'Focus/visibility/interval must not refresh the recent list');
  assert.equal(usageReads().length,quietUsage,'Focus/visibility/interval/usage expiry must not read usage');
  assert.equal(requests.filter(request=>request.path==='/api/auth/renew').length,quietRenewals,'Background work must not renew login');
  usage={...usage,updatedAt:await page.evaluate(()=>Date.now()),rateLimits:{limitId:'codex',primary:{usedPercent:9,windowDurationMins:300,resetsAt:null}}};broadcast('usage',usage);
  await until(async()=> (await Promise.all(pages.map(tab=>tab.locator('.usage-headline').textContent()))).every(value=>value===' · 91%'),'Usage push must update all tabs');
  firstName='推送后的原生标题';broadcast('sessions',{revision:++revision});
  await until(async()=> (await names()).includes(firstName),'Sessions push must refresh cached rows');
  assert.ok((await names()).includes('已加载的下一页'),'Shared update must retain loaded pages');
  assert.ok(listReads().every(request=>!new URLSearchParams(request.query).has('refresh')),'Automatic reads must use shared cache');
  failCursor=true;firstName='暂不应部分覆盖';broadcast('sessions',{revision:++revision});
  await until(async()=>await page.getByRole('alert').filter({hasText:'分页缓存读取失败'}).count()===1,'Page failure must be visible');
  assert.deepEqual(await names(),['推送后的原生标题','已加载的下一页'],'Page failure must not partly replace loaded rows');
  failCursor=false;firstName='分页整体恢复';broadcast('sessions',{revision:++revision});await until(async()=> (await names()).includes(firstName),'Shared update must recover after error');
  staleCursor=true;broadcast('sessions',{revision:++revision});await until(async()=>await page.getByRole('alert').filter({hasText:'后台刷新失败，显示旧快照'}).count()===1,'Successful HTTP with a stale cached page must show the shared failure');
  assert.deepEqual(await names(),['分页整体恢复','已加载的下一页'],'Stale cached pages must remain visible');
  staleCursor=false;broadcast('sessions',{revision:++revision});await until(async()=>await page.getByRole('alert').filter({hasText:'后台刷新失败，显示旧快照'}).count()===0,'Fresh cached snapshots must clear the shared error');
  await page.getByRole('button',{name:'关闭账户用量',exact:true}).click();
  await page.getByRole('button',{name:'刷新最近会话',exact:true}).click();await until(async()=> (await names()).length===1,'Explicit refresh retains first-page reset behavior');
  assert.equal(new URLSearchParams(listReads().at(-1).query).get('refresh'),'true','Only the explicit list refresh forces native refresh');
  await page.locator('.account-usage-button').click();await page.locator('.account-usage-dialog[open]').waitFor();
  await page.locator('.account-usage-dialog[open]').getByRole('button',{name:'刷新',exact:true}).click();await until(()=>usageReads().at(-1).query==='refresh=true','Explicit usage refresh must remain fresh');
  await until(async()=>await page.getByRole('button',{name:'使用',exact:true}).isEnabled(),'Fresh reset preflight must be available');
  holdUsage=true;await page.getByRole('button',{name:'使用',exact:true}).click();await until(()=>heldUsage.some(read=>read.fresh),'Same-account fresh reset preflight must be in flight');
  usage={...usage,updatedAt:await page.evaluate(()=>Date.now()),rateLimitResetCredits:{availableCount:'1',credits:[{id:'credit-a',title:'同账户最新机会',resetType:'codexRateLimits',status:'available',expiresAt:null}]}};broadcast('usage',usage);
  await until(async()=> (await page.locator('.account-usage-dialog[open]').textContent()).includes('同账户最新机会'),'Same-account SSE must arrive before its HTTP snapshot');
  holdUsage=false;finishUsage();await until(async()=>await page.locator('.usage-confirm[open]').count()===1,'Successful same-account SSE before the fresh HTTP response must still allow reset confirmation');
  assert.ok((await page.locator('.usage-confirm[open]').textContent()).includes('同账户最新机会'),'Confirmation must use the latest same-account credit');await page.getByRole('button',{name:'取消',exact:true}).click();
  holdUsage=true;await page.getByRole('button',{name:'使用',exact:true}).click();await until(()=>heldUsage.some(read=>read.fresh),'Reset preflight must hold the old account response');
  broadcast('usage-invalidated');usage={...usage,accountId:'account-b',updatedAt:await page.evaluate(()=>Date.now()),rateLimitResetCredits:{availableCount:'1',credits:[{id:'credit-b',title:'新账户机会',resetType:'codexRateLimits',status:'available',expiresAt:null}]}};broadcast('usage',usage);
  await until(async()=> (await page.locator('.account-usage-dialog[open]').textContent()).includes('新账户机会'),'New account must replace old reset opportunities');
  holdUsage=false;finishUsage();await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await page.locator('.usage-confirm[open]').count(),0,'Retired read must not return an old account snapshot to reset confirmation');
  assert.ok(!(await page.locator('.account-usage-dialog[open]').textContent()).includes('同账户最新机会'),'Old reset data must not reappear');
  assert.equal(requests.filter(request=>request.path==='/api/account/usage/reset').length,0);
  await until(async()=> (await Promise.all(pages.map(tab=>tab.locator('.account-usage-dialog:not(.usage-confirm) .usage-heading button').last().isEnabled()))).every(Boolean),'Previous account reads must settle before reconnect');
  // Four SSEs leave two HTTP/1.1 slots; held responses intentionally queue the other reads.
  holdUsage=true;broadcast('ready');await until(()=>heldUsage.length>=1,'Reconnect-ready must start cached usage reads');
  broadcast('usage-invalidated');await until(async()=> (await Promise.all(pages.map(tab=>tab.locator('.usage-headline').textContent()))).every(value=>value===''),'Account invalidation must immediately clear old data');
  usage={...usage,accountId:'account-c',updatedAt:await page.evaluate(()=>Date.now()),rateLimits:{limitId:'codex',primary:{usedPercent:12}}};broadcast('usage',usage);
  await until(async()=> (await Promise.all(pages.map(tab=>tab.locator('.usage-headline').textContent()))).every(value=>value===' · 88%'),'New account push must render');
  holdUsage=false;finishUsage();await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok((await Promise.all(pages.map(tab=>tab.locator('.usage-headline').textContent()))).every(value=>value===' · 88%'),'Late old-account reads must not overwrite a pushed account');
  broadcast('usage-error',{message:'共享更新失败'});await until(async()=>await page.getByRole('alert').filter({hasText:'共享更新失败'}).count()===1,'Shared usage errors must render');
  assert.ok(await page.locator('.account-usage-dialog[open]').textContent().then(value=>value.includes('88% 剩余')),'Same-account failure retains known successful data');broadcast('usage',usage);
  await page.getByRole('button',{name:'关闭账户用量',exact:true}).click();
  holdOldSearch=true;await page.getByRole('searchbox',{name:'搜索会话标题'}).fill('旧搜索');await page.clock.runFor(350);await until(()=>heldLists.length===1,'Old query must start');
  await page.getByRole('searchbox',{name:'搜索会话标题'}).fill('当前搜索');await page.clock.runFor(350);await until(async()=> (await names()).includes('当前搜索结果'),'Current query must replace old scope');
  broadcast('sessions',{revision:++revision});await until(()=>new URLSearchParams(listReads().at(-1).query).get('searchTerm')==='当前搜索','Push must read the current query');
  holdOldSearch=false;for(const finish of heldLists.splice(0))finish();await new Promise(resolve=>setTimeout(resolve,100));assert.deepEqual(await names(),['当前搜索结果'],'Late query result must not overwrite the current filter');
  for(const width of [390,1280]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`.local/shared-client-state-${width}.png`});}
  const reconnect=[...streams].find(stream=>stream.path==='/api/state/events');const beforeReconnect=listReads().length;reconnect.response.end();
  await until(()=>streams.size===4&&listReads().length>beforeReconnect,'Real EventSource reconnect-ready must read cached current queries');
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button',{name:'清空会话搜索',exact:true}).click();await page.clock.runFor(350);await page.locator('.session-link').first().click();
  await until(()=>streams.size===4&&![...streams].some(stream=>stream.path==='/api/state/events'),'Thread navigation must replace global stream with the existing thread stream');
  authenticated=false;for(const {response} of [...streams])response.end();
  await until(async()=> (await Promise.all(pages.map(tab=>tab.getByLabel('管理员密码').count()))).every(count=>count===1),'Stream expiry must reuse session auth and show login');
  await until(()=>streams.size===0,'Auth loss must close every stream');
  const readsAfterLogout=requests.length;for(const tab of pages)await tab.clock.runFor(125_000);assert.equal(requests.length,readsAfterLogout,'Logged-out tabs must leave no timers or reads');
  assert.deepEqual(errors,[]);
  console.log('PASS: four real same-host Chrome tabs, one SSE each, cached pushes/reconnect, no automatic polling, safe usage invalidation, pagination/query/manual refresh and auth cleanup');
} finally {
  clearInterval(heartbeat);finishUsage();for(const finish of heldLists.splice(0))finish();for(const {response} of streams)response.end();await context.close();await browser.close();await server.close();
}
