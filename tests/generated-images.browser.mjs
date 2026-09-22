import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const server=await createServer({server:{host:'127.0.0.1',port:0}});await server.listen();
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport}),requests=[],external=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**://example.invalid/**',route=>{external.push(route.request().url());return route.abort();});
  await page.route('**/api/sessions/generated/turns/turn/items/*/images/*',route=>{requests.push(route.request().url());return route.request().url().includes('/broken/')?route.fulfill({status:404,body:'missing'}):route.fulfill({contentType:'image/png',path:'public/assets/icon-mobile-v1-512.png'});});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/generated-images.html`);
  const cards=page.locator('.generated-image');await cards.nth(5).waitFor({timeout:5000});
  const first=cards.first();await first.locator('img').scrollIntoViewIfNeeded();await first.locator('img').evaluate(img=>img.decode());
  assert.ok(await first.locator('img').evaluate(img=>img.naturalWidth>0));
  assert.match(await first.locator('a').getAttribute('href'),/size=original$/);assert.equal(await first.locator('a').getAttribute('target'),'_blank');
  assert.equal(await first.locator('details').getAttribute('open'),null);await first.locator('summary').click();assert.match(await first.locator('details').innerText(),/请绘制会话页布局原型/);
  assert.doesNotMatch(await page.locator('#root').innerText(),/"type"|"result"|C:\\private/);
  assert.match(await cards.nth(1).innerText(),/正在生成/);assert.match(await cards.nth(2).innerText(),/用量已达上限/);assert.match(await cards.nth(3).innerText(),/未提供可预览的图片/);
  assert.match(await cards.nth(4).innerText(),/https:\/\/example.invalid\/generated.png/);assert.equal(await cards.nth(4).locator('img,a,iframe').count(),0);
  const broken=cards.nth(5);await broken.scrollIntoViewIfNeeded();await broken.getByRole('button',{name:'重试图片'}).waitFor();
  assert.ok(requests.every(url=>!url.includes('size=original')));assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`.local/generated-images-${viewport.width}.png`,fullPage:true});
  console.log(`${viewport.width}: PASS (generated preview, original link, prompt, progress, failure, missing data, URL-only, failed image)`);await page.close();
 }
}finally{await browser?.close();await server.close();}
