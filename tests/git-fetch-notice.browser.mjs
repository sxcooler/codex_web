// Real GitPanel and Chrome; isolated API responses, controlled browser time, no Git network.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';

const server=await createServer({cacheDir:'.local/git-fetch-notice-vite',server:{host:'127.0.0.1',port:0,strictPort:true}});await server.listen();
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [1280,390]){
  const page=await browser.newPage({locale:'zh-CN',viewport:{width,height:900}}),errors=[];let result={remotes:[{name:'origin',status:'updated'},{name:'upstream',status:'updated'}]},held,hold=false,calls=0;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path.endsWith('/git/fetch')){calls++;assert.equal(route.request().method(),'POST');if(hold){held=route;return;}await route.fulfill({json:result});return;}
   if(path.endsWith('/git/repositories')){await route.fulfill({json:{repositories:[{path:'',name:'Main',kind:'main',available:true},{path:'sdk',name:'SDK',kind:'submodule',available:true}],complete:true}});return;}
   await route.fulfill({json:path.endsWith('/git/log')?{repository:true,commits:[],branches:[],nextCursor:null}:{files:[]}});
  });
  page.setDefaultTimeout(8000);
  await page.clock.install({time:new Date('2026-10-09T00:00:00Z')});await page.clock.pauseAt(new Date('2026-10-09T00:00:01Z'));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/git-fetch-notice.html`);
  const refresh=page.locator('.panel-refresh'),notice=page.locator('.fetch-result');
  const waitReady=async()=>{await page.waitForFunction(()=>document.querySelector('.panel-refresh')&&!document.querySelector('.panel-refresh').disabled);};
  const fetchResult=async value=>{result=value;await waitReady();await refresh.click();await notice.waitFor();};
  await fetchResult(result);assert.equal(await notice.getAttribute('role'),'status');
  await page.clock.fastForward(4999);assert.equal(await notice.count(),1,'success must remain visible before five seconds');
  await page.clock.fastForward(1);await notice.waitFor({state:'detached'});
  for(const skipped of ['no-remotes','not-repository']){await fetchResult({skipped,remotes:[]});await page.clock.fastForward(5000);await notice.waitFor({state:'detached'});}
  await fetchResult({remotes:[{name:'origin',status:'updated'},{name:'upstream',status:'failed',error:'upstream fixture failure'}]});
  await page.clock.fastForward(6000);assert.equal(await notice.getAttribute('role'),'alert');assert.match(await notice.textContent(),/upstream fixture failure/);
  await fetchResult({error:'uncertain fixture result'});await page.clock.fastForward(6000);assert.match(await notice.textContent(),/uncertain fixture result/);
  await fetchResult({remotes:[{name:'origin',status:'updated'}]});await page.clock.fastForward(4000);
  await fetchResult({remotes:[{name:'origin',status:'timeout',error:'new timeout must stay'}]});await page.clock.fastForward(6000);assert.match(await notice.textContent(),/new timeout must stay/,'old success timer cannot erase new failure');
  await fetchResult({remotes:[{name:'origin',status:'updated'}]});await page.clock.fastForward(4000);await page.getByRole('button',{name:'文件',exact:true}).click();await waitReady();
  await page.clock.fastForward(6000);assert.equal(await notice.count(),0);await page.getByRole('button',{name:'变更',exact:true}).click();await waitReady();await notice.waitFor();
  await page.clock.fastForward(5000);await notice.waitFor({state:'detached'});
  await page.getByRole('button',{name:'Git 日志',exact:true}).click();await waitReady();await page.getByLabel('Git 仓库').waitFor();
  await fetchResult({remotes:[{name:'origin',status:'updated'}]});await page.clock.fastForward(4000);await page.getByLabel('Git 仓库').selectOption('sdk');
  await page.clock.fastForward(6000);assert.equal(await notice.count(),0);await page.getByLabel('Git 仓库').selectOption('');await notice.waitFor();
  await page.clock.fastForward(5000);await notice.waitFor({state:'detached'});
  await fetchResult({remotes:[{name:'origin',status:'updated'}]});await page.clock.fastForward(4000);
  await page.evaluate(()=>window.renderNoticeSession('new-session'));await waitReady();await notice.waitFor({state:'detached'});
  await fetchResult({error:'new session failure'});await page.clock.fastForward(6000);assert.match(await notice.textContent(),/new session failure/);
  hold=true;await waitReady();await refresh.click();await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent.includes('正在获取'));
  await page.evaluate(()=>window.renderNoticeSession('third-session'));await waitReady();await held.fulfill({json:{error:'old session late failure'}});hold=false;
  await page.clock.fastForward(6000);assert.equal(await notice.count(),0,'late previous-session result must stay discarded');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({width,result:'PASS',calls,successExpiry:true,skippedExpiry:true,failuresRetained:true,newResultProtected:true,contextCleanup:true,errors}));await page.close();
 }
}finally{await browser?.close();await server.close();}
