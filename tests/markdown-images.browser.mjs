import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const server=await createServer({server:{host:'127.0.0.1',port:0}});await server.listen();
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport}),remote=[],errors=[],requested=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**://example.invalid/**',route=>{remote.push(route.request().url());return route.abort();});
  await page.route('**/api/sessions/fixture/files/image?*',route=>{const path=new URL(route.request().url()).searchParams.get('path');requested.push(path);return path.endsWith('missing.png')?route.fulfill({status:404,body:'missing'}):route.fulfill({contentType:'image/png',path:path.startsWith('docs/assets/screenshots/')?path:'public/assets/icon-mobile-v1-512.png'});});
  const base=`http://127.0.0.1:${server.httpServer.address().port}`;
  for(const suffix of ['', '?streaming=1']){
   await page.goto(base+'/tests/markdown-images.html'+suffix);
   await page.locator('img[alt="HTML"]').waitFor();
   await page.waitForFunction(()=>document.querySelector('img[alt="HTML"]')?.naturalWidth>0);
   assert.equal(await page.locator('img[alt="HTML"]').getAttribute('width'),'360');
   assert.equal((await page.locator('img[alt="HTML"]').boundingBox()).height,720);
   assert.equal(await page.locator('.markdown-message [onerror],.markdown-message [style*="position"],.markdown-message [srcset],.markdown-message #unsafe,.markdown-message script,.markdown-message iframe').count(),0);
   assert.equal(await page.locator('img[alt="超大"]').getAttribute('width'),null);
   await page.waitForFunction(()=>document.body.textContent.includes('图片无法加载'));
   assert.equal(await page.locator('.markdown-message img').count(),3);
   assert.equal(await page.evaluate(()=>!!window.imageExecuted),false);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert.match(await page.locator('body').innerText(),/仅支持项目内图片/);
  }
  assert.ok(requested.includes('assets/图 片.png'));
  await page.goto(base+'/tests/markdown-images.html?unbound=1');await page.getByRole('button',{name:'复制 Markdown'}).waitFor();assert.equal(await page.locator('img').count(),0);
  await page.goto(base+'/tests/markdown-images.html?chat=1');await page.locator('img[alt="HTML"]').waitFor();assert.equal(await page.locator('img[alt="标准"]').count(),0,'chat paths must use project root');
  const readme=await readFile('README.md','utf8');
  await page.route('**/api/sessions/fixture/files?*',route=>route.fulfill({json:{files:[{path:'README.md',type:'file'}]}}));
  await page.route('**/api/sessions/fixture/files/content?*',route=>route.fulfill({json:{text:readme}}));
  await page.goto(base+'/tests/markdown-images.html?panel=1');
  await page.locator('.markdown-message img').first().waitFor({state:'attached'});
  await page.locator('.markdown-message img').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('.markdown-message img')?.naturalWidth>0);
  assert.equal(await page.locator('.markdown-message img').count(),2,'actual README preview must show both screenshots');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);
  await page.goto(base+'/tests/markdown.html');await page.waitForFunction(()=>!document.querySelector('#result').textContent.startsWith('RUNNING'));assert.match(await page.locator('#result').innerText(),/^PASS/);
  console.log(`${viewport.width}: PASS (README panel, Markdown/HTML, streaming, chat, attributes, bounds, failure, no external requests, Markdown regression)`);await page.close();
 }
}finally{await browser?.close();await server.close();}
