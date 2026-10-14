// Real Chrome, isolated fixture APIs; no live service or real user data.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const server=await createServer({cacheDir:'.local/vite-composer-preference',server:{host:'127.0.0.1',port:0,strictPort:true}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
const url=`http://127.0.0.1:${server.httpServer.address().port}/tests/session-toolbar.html`,key='codex-web:panels:v1',failures=[];
let passed=0;
async function scenario(width,name,seed,run,denied){
 const context=await browser.newContext({locale:'zh-CN',viewport:{width,height:900}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await context.addInitScript(({key,seed,denied})=>{
  if(!sessionStorage.getItem('composer-preference-seeded')){if(seed!==null)localStorage.setItem(key,seed);sessionStorage.setItem('composer-preference-seeded','yes');}
  if(denied){const original=Storage.prototype[denied];Storage.prototype[denied]=function(name,...args){if(this===localStorage&&name===key)throw new DOMException('Fixture storage denied','SecurityError');return original.call(this,name,...args);};}
 },{key,seed,denied});
 await page.route('**/sessions/**',async route=>{if(route.request().resourceType()==='document')await route.fulfill({response:await route.fetch({url})});else await route.continue();});
 const collapse=page.getByRole('button',{name:'收起输入区',exact:true}),expand=page.getByRole('button',{name:'展开输入',exact:true});
 const ready=()=>page.waitForFunction(()=>document.querySelector('.session-project')?.textContent==='demo-workspace');
 try{
  await page.goto(url);await ready();
  await run({page,collapse,expand,ready});
  assert.deepEqual(errors,[]);passed++;console.log(`${width}: ${name} PASS`);
 }catch(error){failures.push({width,name,message:error.message});console.error(`${width}: ${name} FAIL: ${error.message}`);}
 finally{await context.close();}
}
try{
 for(const width of [390,1280]){
  await scenario(width,'collapse and expand survive reload with draft/focus',null,async({page,collapse,expand,ready})=>{
   await collapse.waitFor();await page.locator('#message').fill('刷新保留草稿');
   await page.evaluate(()=>window.testTextarea=document.querySelector('#message'));
   await collapse.click();await expand.waitFor();
   assert.equal(await expand.evaluate(node=>document.activeElement===node),true);
   assert.equal(await page.evaluate(()=>testTextarea===document.querySelector('#message')),true);
   assert.equal(await page.locator('#message').inputValue(),'刷新保留草稿');
   await page.reload();await ready();
   assert.equal(await expand.isVisible(),true,'Collapsed composer must survive browser refresh');
   await page.locator('#message').fill('展开保留草稿');
   await page.evaluate(()=>window.testTextarea=document.querySelector('#message'));
   await expand.click();await collapse.waitFor();
   assert.equal(await page.locator('#message').evaluate(node=>document.activeElement===node),width>1000);
   assert.equal(await page.evaluate(()=>testTextarea===document.querySelector('#message')),true);
   assert.equal(await page.locator('#message').inputValue(),'展开保留草稿');
   await page.reload();await ready();assert.equal(await expand.count(),0,'Expanded composer must survive browser refresh');
  });
  for(const [name,seed] of [
   ['old v1',JSON.stringify({version:1,left:false,right:false})],
   ['bad JSON','{broken'],
   ['wrong composer type',JSON.stringify({version:1,left:false,right:false,composerCollapsed:'true'})],
   ['wrong version',JSON.stringify({version:2,left:true,right:true,composerCollapsed:true})],
  ])await scenario(width,name,seed,async({page,collapse,expand})=>{
   assert.equal(await expand.count(),0,'Invalid or missing composer preference must default expanded');await collapse.waitFor();
   if(width>1000&&(name==='old v1'||name==='wrong composer type'))assert.equal(await page.locator('[data-panel-toggle="left"]').getAttribute('aria-expanded'),'false','Existing sidebar preference changed');
  });
  await scenario(width,'existing collapsed v1 and cross-session reuse',JSON.stringify({version:1,left:true,right:false,composerCollapsed:true}),async({page,collapse,expand,ready})=>{
   assert.equal(await expand.isVisible(),true,'Saved true must restore collapsed composer');
   await page.locator('#message').fill('切换会话保留草稿');
   await page.evaluate(()=>{history.pushState(null,'','/sessions/other');window.dispatchEvent(new PopStateEvent('popstate'));});
   await page.waitForFunction(()=>document.querySelector('.session-title')?.textContent==='另一演示会话');assert.equal(await expand.isVisible(),true);
   await expand.click();await collapse.waitFor();
   await page.evaluate(()=>{history.pushState(null,'','/sessions/toolbar-test');window.dispatchEvent(new PopStateEvent('popstate'));});
   await ready();assert.equal(await expand.count(),0);assert.equal(await page.locator('#message').inputValue(),'切换会话保留草稿');await page.reload();await ready();assert.equal(await expand.count(),0);
  });
  await scenario(width,'details expansion survives reload',JSON.stringify({version:1,left:true,right:true,composerCollapsed:true}),async({page,expand,ready})=>{
   await page.evaluate(()=>testState.snapshot.phase='EXTERNAL');
   await page.getByRole('button',{name:'操作',exact:true}).click();await page.getByRole('button',{name:'刷新当前会话'}).click();
   await page.getByRole('button',{name:'查看详情',exact:true}).waitFor();await page.getByRole('button',{name:'查看详情',exact:true}).click();
   assert.equal(await expand.count(),0);await page.reload();await ready();assert.equal(await expand.count(),0);
  });
  await scenario(width,'storage read denied',JSON.stringify({version:1,left:true,right:true,composerCollapsed:true}),async({collapse,expand})=>{
   await collapse.waitFor();await collapse.click();await expand.waitFor();await expand.click();await collapse.waitFor();
  },'getItem');
  await scenario(width,'storage write denied',JSON.stringify({version:1,left:true,right:true,composerCollapsed:false}),async({page,collapse,expand,ready})=>{
   await collapse.waitFor();await collapse.click();await expand.waitFor();await page.reload();await ready();assert.equal(await expand.count(),0,'Rejected write must leave stored preference unchanged');
  },'setItem');
 }
 console.log(JSON.stringify({passed,failed:failures.length,failures}));
 if(failures.length)process.exitCode=1;
}finally{await browser.close();await server.close();}
