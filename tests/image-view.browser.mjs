import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const server=await createServer({server:{host:'127.0.0.1',port:0}});await server.listen();
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport}),requests=[],errors=[],remoteRequests=[];
  await page.route('**://example.invalid/**',route=>{remoteRequests.push(route.request().url());return route.abort();});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/sessions/*/files/image?*',route=>{const url=new URL(route.request().url());requests.push(url.searchParams.get('path'));return requests.at(-1)==='missing.png'?route.fulfill({status:404,body:'missing'}):route.fulfill({contentType:'image/png',path:'public/assets/icon-mobile-v1-512.png'});});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/image-view.html`);
  await page.locator('details').nth(7).waitFor();
  assert.equal(await page.locator('.image-view').count(),8,'imageView still uses the raw JSON fallback');
  assert.equal(await page.locator('img').count(),0);assert.deepEqual(requests,[]);
  for(let i=0;i<8;i++){
   const details=page.locator('.image-view').nth(i);await details.locator('summary').click();
   if(i<3){await details.locator('.image-preview a').waitFor();assert.equal(await details.locator('img').evaluate(img=>img.naturalWidth>0),true);assert.equal(await details.locator('a').getAttribute('target'),'_blank');}
   else if(i===4){assert.equal(await details.locator('.path').textContent(),'https://example.invalid/remote.png');assert.equal(await details.locator('img,iframe,a,button,[role="alert"]').count(),0);}else await details.getByRole('alert').waitFor();
  }
  assert.deepEqual(requests,['runs/预览 #100%.png','runs/linux.png','runs/relative.png','missing.png']);
  assert.deepEqual(remoteRequests,[],'remote image URLs must never be requested');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const first=page.locator('.image-view').first();await first.locator('summary').click();await first.locator('img').waitFor({state:'detached'});
  await first.locator('summary').click();await first.locator('.image-preview a').waitFor();
  await first.screenshot({path:`.local/image-view-${viewport.width}.png`});assert.deepEqual(errors,[]);
  console.log(`${viewport.width}: PASS (collapsed loading, preview, paths, boundaries, missing file, reopen)`);await page.close();
 }
}finally{await browser?.close();await server.close();}
