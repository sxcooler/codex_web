import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright';

const output=process.env.PREVIEW_READING_QA_DIR??await mkdtemp(join(tmpdir(),'codex-preview-reading-'));
await mkdir(output,{recursive:true});
const server=await createServer({cacheDir:join(output,'vite'),server:{host:'127.0.0.1',port:0,hmr:false}}),results=[];
let browser;
try{
 await server.listen();browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [390,844,1280,1440,1920,2048,3440]){
  const page=await browser.newPage({locale:'zh-CN',viewport:{width,height:width===844?390:900},hasTouch:width<=844}),errors=[];
  let metrics;
  try{
   page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
   await page.route('**/favicon.ico',route=>route.fulfill({status:204}));
   await page.route('**/api/sessions/*/files/image?*',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=','base64')}));
   const url=`http://127.0.0.1:${server.httpServer.address().port}/tests/preview-fullscreen.html`;
   await page.goto(url,{timeout:60000});assert.equal(page.url(),url);assert.equal(await page.title(),'文件预览回归');
   await page.locator('.directory-list button').filter({hasText:'reading.md'}).click();await page.waitForSelector('.markdown-message h1');assert.equal(await page.locator('vite-error-overlay').count(),0);
   const paragraph=page.locator('.markdown-message p').filter({hasText:/^中文正文：/}),ordinary=await paragraph.boundingBox();
   const settled=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const toggle=async()=>{await page.locator('.preview-expand:visible').click();await settled();};
   const position=target=>target.evaluate(n=>{const area=n.closest('.preview-content');return n.getBoundingClientRect().top-area.getBoundingClientRect().top;});
   const readFrom=target=>target.evaluate(n=>{const area=n.closest('.preview-content');area.scrollTop+=n.getBoundingClientRect().top-area.getBoundingClientRect().top+24;});
   await page.evaluate(()=>window.readingRoot=document.querySelector('.markdown-message'));
   await toggle();assert.equal(await page.locator('dialog:modal').count(),1);
   metrics=await page.locator('.markdown-message').evaluate(root=>{
    const area=root.closest('.preview-content'),box=node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width};},p=[...root.querySelectorAll('p')].find(n=>n.textContent.startsWith('中文正文：')),blocks=root.firstElementChild,tables=[...root.querySelectorAll('[data-streamdown="table-wrapper"]')];
    return{root:box(root),paragraph:box(p),fontSize:parseFloat(getComputedStyle(root).fontSize),heading:box(root.querySelector('h1')),actions:box(root.querySelector('.message-actions')),small:box(tables[0]),wide:box(tables[1]),wideContent:tables[1].lastElementChild.scrollWidth,nested:tables.slice(2).map(n=>({box:box(n),parent:box(n.closest('ul,blockquote'))})),list:box(blocks.querySelector(':scope>ul')),quote:box(blocks.querySelector(':scope>blockquote')),pageOverflow:document.documentElement.scrollWidth-innerWidth,areaOverflow:area.scrollWidth-area.clientWidth};
   });
   await page.screenshot({path:join(output,`reading-${width}.png`)});
   assert.ok(Math.abs(metrics.paragraph.width-Math.min(metrics.root.width,960))<1,'Prose restores the first-version reading width: '+JSON.stringify(metrics));
   assert.ok(Math.abs(metrics.heading.left-metrics.paragraph.left)<1&&Math.abs(metrics.heading.width-metrics.paragraph.width)<1,'Heading shares the prose column');
   assert.ok(Math.abs(metrics.actions.left-metrics.paragraph.left)<1&&Math.abs(metrics.actions.width-metrics.paragraph.width)<1,'Document actions share the prose column');
   assert.ok(Math.abs((metrics.paragraph.left+metrics.paragraph.right)/2-(metrics.root.left+metrics.root.right)/2)<1,'Prose column is centered');
   assert.ok(Math.abs(metrics.small.width-metrics.paragraph.width)<2,'Short table stays at prose width');
   const cap=width>=1920?1920:width>=1440?1440:960;
   assert.ok(metrics.wide.width<=cap+1&&Math.abs(metrics.wide.width-metrics.root.width)<2,'Wide table uses the available wide column');
   if(width>=1440)assert.ok(metrics.wide.width>metrics.paragraph.width+200,'Table can grow beyond prose');
   assert.ok(metrics.wideContent>metrics.wide.width,'Very wide table scrolls internally');
   assert.ok(metrics.list.width<=metrics.paragraph.width+1&&metrics.quote.width<=metrics.paragraph.width+1,'Nested table does not widen its parent');
   for(const nested of metrics.nested)assert.ok(nested.box.width<=nested.parent.width+1&&nested.box.left>=nested.parent.left);
   assert.ok(metrics.pageOverflow<=1&&metrics.areaOverflow<=1,'Only the table scrolls horizontally');
   await page.locator('.markdown-message h2').filter({hasText:/^小表格$/}).evaluate(n=>{const area=n.closest('.preview-content');area.scrollTop+=n.getBoundingClientRect().top-area.getBoundingClientRect().top-24;});
   await page.screenshot({path:join(output,`tables-${width}.png`)});
   const scroll=page.locator('[data-streamdown="table-wrapper"]').nth(1).locator(':scope>div:last-child');
   assert.equal(await scroll.getAttribute('tabindex'),'0','Table scroll area is in the keyboard order');
   await scroll.scrollIntoViewIfNeeded();await scroll.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');
   assert.equal(await scroll.evaluate(n=>n===document.activeElement),true,'Tab can re-enter the table scroll area');
   await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelectorAll('[data-streamdown="table-wrapper"]')[1].lastElementChild.scrollLeft>0);
   // Native keyboard scrolling keeps animating after its first visible movement.
   await scroll.evaluate(n=>new Promise((resolve,reject)=>{let last=n.scrollLeft,quiet=0,frames=0;const check=()=>{const left=n.scrollLeft;quiet=left===last?quiet+1:0;last=left;if(quiet===3)resolve();else if(++frames>60)reject(new Error('Keyboard scroll did not settle'));else requestAnimationFrame(check);};requestAnimationFrame(check);}));
   assert.ok(await scroll.evaluate(n=>getComputedStyle(n).outlineStyle!=='none'&&parseFloat(getComputedStyle(n).outlineWidth)>0),'Keyboard table focus is visible');
   await scroll.evaluate(n=>n.scrollLeft=600);await readFrom(scroll);const tableTop=await position(scroll);await toggle();assert.equal(await scroll.evaluate(n=>n.scrollLeft),600,'Collapse keeps table horizontal position');
   assert.ok(Math.abs(await position(scroll)-tableTop)<3,'Collapse preserves the table reading position');
   assert.ok(Math.abs((await paragraph.boundingBox()).width-ordinary.width)<1,'Ordinary panel keeps its previous width');
   const ordinaryTableTop=await position(scroll);await toggle();assert.ok(Math.abs(await position(scroll)-ordinaryTableTop)<3,'Expand preserves the table reading position');
   assert.equal(await scroll.evaluate(n=>n.scrollLeft),600,'Expand keeps table horizontal position');await toggle();
   const reading=page.locator('.markdown-message p').filter({hasText:/^正文段 12：/});
   await readFrom(reading);const before=await position(reading);await toggle();assert.ok(Math.abs(await position(reading)-before)<3,'Expand preserves a paragraph in the middle of the document');
   const later=page.locator('.markdown-message p').filter({hasText:/^正文段 18：/});await readFrom(later);const afterReading=await position(later);await page.keyboard.press('Escape');await settled();
   assert.equal(await page.locator('dialog:modal').count(),0);assert.ok(Math.abs(await position(later)-afterReading)<3,'Esc collapse preserves the new reading position');
   assert.equal(await page.locator('.preview-expand').evaluate(n=>getComputedStyle(n).outlineStyle==='none'),true,'Esc leaves no focus outline');
   assert.equal(await page.evaluate(()=>document.querySelector('.markdown-message')===readingRoot),true,'Prose nodes remain stable');
   await toggle();
   const code=page.locator('[data-streamdown="code-block"]');await code.scrollIntoViewIfNeeded();assert.ok(await code.evaluate(n=>n.getBoundingClientRect().width<=n.closest('.markdown-message').getBoundingClientRect().width));
   assert.ok(await page.locator('[data-streamdown="code-block-body"]').evaluate(n=>n.scrollWidth>n.clientWidth),'Long code scrolls internally');
   await page.locator('.markdown-image').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.markdown-image')?.complete);assert.ok(await page.locator('.markdown-image').evaluate(n=>n.naturalWidth>0));
   await page.locator('.mermaid-preview').scrollIntoViewIfNeeded();await page.waitForSelector('.mermaid-preview svg',{timeout:20000});
   assert.ok(await page.locator('.mermaid-preview').evaluate(n=>n.getBoundingClientRect().width<=n.closest('.markdown-message').getBoundingClientRect().width),'Diagram remains within the document');
   if(width===2048){
    await page.evaluate(()=>document.querySelector('.preview-content').scrollTop=0);
    const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1024,height:450,deviceScaleFactor:2,mobile:false});await settled();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.preview-content').scrollWidth<=document.querySelector('.preview-content').clientWidth+1),'2x reflow emulation has no page overflow');
    await page.screenshot({path:join(output,'reading-2x-reflow.png')});await cdp.detach();
   }
   assert.equal(await page.locator('vite-error-overlay').count(),0);assert.deepEqual(errors,[]);
   results.push({width,pass:true,...metrics});
  }catch(error){process.exitCode=1;results.push({width,error:error.message,metrics,errors});}finally{await page.close();}
 }
 await writeFile(join(output,'results.json'),JSON.stringify({browser:'Chrome / repository Playwright',browserPlugin:'Browser plugin not available',results},null,2));
 console.log(JSON.stringify({output,results},null,2));
}finally{await browser?.close();await server.close();}
