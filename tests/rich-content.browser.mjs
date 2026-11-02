import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
// Browser plugin not available; use the repository's existing Playwright/Chrome path.
const server=await createServer({cacheDir:'.local/extensions/rich-vite',server:{host:'127.0.0.1',port:0}});await server.listen();
await mkdir('.local/extensions',{recursive:true});let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const locale of ['zh-CN','en'])for(const width of [1280,390]){
  const page=await browser.newPage({locale,viewport:{width,height:950}}),errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.copyAttempts=[];window.copyFails=true;Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copyAttempts.push(text);if(window.copyFails)throw Error('fixture failure');}},configurable:true});});
  await page.route('**/api/**',route=>{requests.push(route.request().url());return route.fulfill({status:404,contentType:'application/json',body:'{"error":"fixture only"}'});});
  await page.route('**://example.invalid/**',route=>{requests.push(route.request().url());return route.abort();});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/rich-content.html?locale=${locale}`);
  await page.getByRole('heading',{name:'Rich content fixture'}).waitFor();
  await page.getByText('Final normal paragraph.',{exact:true}).waitFor();
  assert.equal(await page.locator('vite-error-overlay').count(),0);
  assert.equal(await page.locator('.rich-parts iframe').count(),0);
  const draft=page.getByRole('button',{name:locale==='en'?'Use as draft':'放入草稿'});await draft.focus();assert.equal(await draft.evaluate(node=>node===document.activeElement),true);await page.keyboard.press('Enter');
  assert.match(await page.getByRole('textbox',{name:'Reviewable draft'}).inputValue(),/Suggested fix\n\nAdd the missing validation/);
  const file=page.getByRole('link',{name:'C:/fixture/src/a.ts:12–18'}).first();await file.click();assert.match(await page.getByLabel('Opened file').textContent(),/path=src%2Fa.ts#L12-L18/);
  const details=page.locator('.rich-parts>details').filter({has:page.locator('summary',{hasText:'More context'})});assert.equal(await details.getAttribute('open'),'');await details.locator(':scope>summary').click();assert.equal(await details.getAttribute('open'),null);await details.locator(':scope>summary').click();
  const copy=page.getByRole('button',{name:locale==='en'?'Copy original':'复制原文',exact:true});await copy.click();await page.getByText(locale==='en'?'Copy failed. Select and copy from the original.':'复制失败，请在原文中选择并复制。',{exact:true}).waitFor();await page.evaluate(()=>window.copyFails=false);await copy.click();await page.getByText(locale==='en'?'Copied':'已复制',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.copyAttempts.length),2);assert.match(await page.evaluate(()=>window.copyAttempts[1]),/\uE200visualize/);
  await page.locator('.rich-message>.rich-original>summary').click();assert.match(await page.locator('.rich-message>.rich-original>pre').textContent(),/::git-push/);await page.keyboard.press('Escape');
  assert.equal(await page.locator('.tool-content audio').count(),1);assert.equal(await page.locator('.tool-content audio').getAttribute('preload'),'none');assert.equal(await page.locator('.tool-content iframe,.tool-content a').count(),0);await page.locator('.tool-content details>summary').click();assert.match(await page.locator('.tool-content details>pre').textContent(),/"ok": true/);
  assert.deepEqual(requests,[],'passive cards must not fetch, execute controls or open resource URIs');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`.local/extensions/rich-content-${locale}-${width}.png`,fullPage:true});
  await page.locator('.fixture-tools').screenshot({path:`.local/extensions/tool-content-${locale}-${width}.png`});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/rich-content.html?locale=${locale}&draftMode=reject`);
  const rejectedDraft=page.getByRole('button',{name:locale==='en'?'Use as draft':'放入草稿'});await rejectedDraft.click();
  assert.equal(await page.getByRole('textbox',{name:'Reviewable draft'}).inputValue(),'Existing fixture draft');
  assert.equal(await page.getByText(locale==='en'?'Added to a reviewable draft. It has not been sent.':'已放入可审阅草稿，尚未发送。',{exact:true}).count(),0,'a callback that rejects the draft must not produce a local success claim');
  await rejectedDraft.locator('..').screenshot({path:`.local/extensions/rich-draft-rejected-${locale}-${width}.png`});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/rich-content.html?locale=${locale}&draftMode=unavailable`);
  assert.equal(await page.getByRole('button',{name:locale==='en'?'Use as draft':'放入草稿'}).isDisabled(),true);
  await page.getByText(locale==='en'?'This view has no draft composer. Copy the content to use it.':'此视图没有草稿入口；请复制内容后使用。',{exact:true}).waitFor();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/rich-content.html?locale=${locale}&fenceCases=1`);
  await page.getByText('Sample code container',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.fixture-code-regressions [data-streamdown="code-block-body"]').length===3);
  assert.equal(await page.locator('.fixture-code-regressions .rich-preview').count(),0,'code examples must not create preview cards');
  assert.equal(await page.locator('.fixture-code-regressions .rich-card').count(),1,'only the containing writing card is semantic; quoted/listed citations stay code');
  assert.equal(await page.locator('.fixture-code-regressions a').count(),0);
  assert.deepEqual(requests,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('.fixture-code-regressions').screenshot({path:`.local/extensions/rich-code-literal-${locale}-${width}.png`});
  assert.deepEqual(errors,[]);console.log(`${locale} ${width}: PASS (safe cards, code, draft callback/rejection/unavailable, file, fold, copy failure/retry, source, tool content, no passive requests)`);await page.close();
 }
}finally{await browser?.close();await server.close();}
