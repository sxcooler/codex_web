import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const server=await createServer({cacheDir:'.local/task2-vite',server:{host:'127.0.0.1',port:0,strictPort:true}});await server.listen();
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [1280,390]){
  const page=await browser.newPage({locale:'zh-CN',viewport:{width,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/file-read-congestion.html`);
  await page.locator('.preview-content [role="alert"]').waitFor({timeout:3000});
  assert.match(await page.locator('.preview-content').innerText(),/读取超时/);
  assert.equal(await page.getByRole('button',{name:'↻ 刷新',exact:true}).isEnabled(),true,'list timeout must unlock explicit retry');
  assert.ok((await page.evaluate(()=>window.budgets)).filter(ms=>ms===30000).length>=2);
  await page.evaluate(()=>window.mode='ok');await page.getByRole('button',{name:'↻ 刷新',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.preview-content')?.textContent.includes('retry succeeded'));
  assert.equal(await page.locator('.preview-content [role="alert"]').count(),0);
  await page.evaluate(()=>window.mode='hang');await page.getByRole('button',{name:'↻ 刷新',exact:true}).click();
  await page.locator('.preview-content [role="alert"]').waitFor();
  assert.match(await page.locator('.preview-content').innerText(),/retry succeeded/,'timeout must retain cached content');
  await page.evaluate(()=>{window.mode='ok';window.renderPanel(false)});
  await page.evaluate(()=>window.renderPanel(true));await page.waitForFunction(()=>!document.querySelector('.preview-content [role="alert"]'));
  await page.evaluate(()=>window.mode='hang');await page.getByRole('button',{name:'↻ 刷新',exact:true}).click();
  await page.evaluate(()=>window.renderPanel(false));await page.waitForTimeout(150);
  assert.equal(await page.locator('.preview-content [role="alert"]').count(),0,'cleanup abort must not leave a timeout error');
  await page.evaluate(()=>{window.mode='ok';window.renderPanel(true)});await page.waitForFunction(()=>!document.querySelector('.preview-content [role="alert"]'));
  await page.getByRole('button',{name:'变更',exact:true}).click();await page.locator('.file-list button').first().click();
  await page.evaluate(()=>window.mode='hang');await page.getByRole('button',{name:'↻ 刷新',exact:true}).click();
  await page.locator('.preview-content [role="alert"]').waitFor();
  await page.evaluate(()=>window.mode='ok');await page.getByRole('button',{name:'↻ 刷新',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.preview-content [role="alert"]'));
  assert.match(await page.locator('.preview-content').innerText(),/diff retry succeeded/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);await page.screenshot({path:`.local/task2-file-timeout-${width}.png`});console.log(`${width}: hung list/content/diff, deadline, retry, retained content PASS`);await page.close();
 }
}finally{await browser?.close();await server.close();}
