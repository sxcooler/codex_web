import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright';

const artifacts=await mkdtemp(join(tmpdir(),'codex-mermaid-fullscreen-'));
const server=await createServer({cacheDir:'.local/mermaid-nested-vite',server:{host:'127.0.0.1',port:0,strictPort:true}});
let browser;const results=[];
const frame=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
try{
 await server.listen();await server.transformRequest('/src/web/style.css');
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [1280,390]){
  const page=await browser.newPage({locale:'zh-CN',viewport:{width,height:900},hasTouch:width===390}),errors=[];
  page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.addInitScript(()=>{window.dialogEvents=[];for(const type of ['cancel','close'])document.addEventListener(type,event=>window.dialogEvents.push({type,target:event.target.className,modal:event.target.matches(':modal')}),true);for(const capture of [true,false])window.addEventListener('keydown',event=>{if(event.key==='Escape')window.dialogEvents.push({type:'keydown',capture,prevented:event.defaultPrevented,target:event.target.className,popovers:document.querySelectorAll(':popover-open').length});},capture);});
  try{
   await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/preview-fullscreen.html`);
   await page.locator('.directory-list button').filter({hasText:'reading.md'}).click();
   const graph=page.locator('.mermaid-preview'),area=page.locator('.preview-content');
   await graph.scrollIntoViewIfNeeded();await graph.locator('[aria-label="Mermaid chart"] svg').waitFor();await page.evaluate(()=>document.fonts.ready);
   assert.match(await page.title(),/文件预览回归/);assert.equal(await page.locator('vite-error-overlay').count(),0);
   for(const mode of ['document','inline']){
    if(mode==='document')await page.locator('.preview-expand').click();
    await graph.scrollIntoViewIfNeeded();await frame(page);
    await graph.getByRole('button',{name:'放大',exact:true}).click();await frame(page);
    await graph.getByRole('button',{name:'全屏查看',exact:true}).scrollIntoViewIfNeeded();await frame(page);
    const before=await graph.evaluate(node=>{window.nestedSvg=node.querySelector('[aria-label="Mermaid chart"] svg');window.nestedStage=node.querySelector('[role="application"]');const area=node.closest('.preview-content'),rect=node.getBoundingClientRect();return {top:area.scrollTop,left:area.scrollLeft,scrollHeight:area.scrollHeight,chartTop:rect.top,transform:window.nestedStage.style.transform,requests:window.requests,workers:window.workers,tasks:window.tasks};});
    await graph.getByRole('button',{name:'全屏查看',exact:true}).click();
    const fullscreen=page.locator('[data-streamdown="mermaid-fullscreen"]');await fullscreen.locator('[aria-label="Mermaid chart"] svg').waitFor();await frame(page);
    const state=await fullscreen.evaluate(node=>{const rect=node.getBoundingClientRect(),hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);return {onTop:node.contains(hit),nativeModal:node.matches('dialog:modal'),svgStable:node.querySelector('[aria-label="Mermaid chart"] svg')===window.nestedSvg,stageStable:node.querySelector('[role="application"]')===window.nestedStage};});
    assert.equal(state.onTop,true,'Diagram fullscreen must be above the document modal');assert.equal(state.nativeModal,true);assert.equal(state.svgStable,true);assert.equal(state.stageStable,true);
    assert.equal(await page.locator('dialog:modal').count(),mode==='document'?2:1);
    for(let n=0;n<10;n++){await page.keyboard.press('Tab');assert.equal(await fullscreen.evaluate(node=>node.contains(document.activeElement)),true,'Tab remains in the innermost modal');}
    await page.screenshot({path:join(artifacts,`${width}-${mode}.png`)});
    await page.keyboard.press('Escape');await frame(page);
    assert.equal(await page.locator('[data-streamdown="mermaid-fullscreen"]').count(),0);assert.equal(await page.locator('dialog:modal').count(),mode==='document'?1:0,'First Esc closes the chart only');
    const after=await graph.evaluate(node=>{const area=node.closest('.preview-content'),button=node.querySelector('.mermaid-expand');return {svgStable:node.querySelector('[aria-label="Mermaid chart"] svg')===window.nestedSvg,transform:node.querySelector('[role="application"]').style.transform,top:area.scrollTop,left:area.scrollLeft,scrollHeight:area.scrollHeight,chartTop:node.getBoundingClientRect().top,requests:window.requests,workers:window.workers,tasks:window.tasks,focused:document.activeElement===button,outline:getComputedStyle(button).outlineStyle};});
    assert.equal(after.svgStable,true);assert.equal(after.transform,before.transform);assert.equal(after.top,before.top);assert.equal(after.left,before.left);assert.equal(after.scrollHeight,before.scrollHeight);assert.ok(Math.abs(after.chartTop-before.chartTop)<1);assert.equal(after.requests,before.requests);assert.equal(after.workers,before.workers);assert.equal(after.tasks,before.tasks);assert.equal(after.focused,true);assert.equal(after.outline,'none','Esc does not leave a focus ring');
    await graph.getByRole('button',{name:'全屏查看',exact:true}).focus();await page.keyboard.press('Enter');await frame(page);await graph.getByRole('button',{name:'退出全屏',exact:true}).click();await frame(page);assert.equal(await page.locator('dialog:modal').count(),mode==='document'?1:0);
    if(mode==='document'){await page.keyboard.press('Escape');await frame(page);assert.equal(await page.locator('dialog:modal').count(),0,'Second Esc collapses the document');}
    await graph.getByRole('button',{name:'重置视图',exact:true}).click();results.push({width,mode,status:'PASS',...state});
   }
   await graph.getByRole('button',{name:'全屏查看',exact:true}).click();await page.evaluate(()=>window.renderPanel(false));await frame(page);assert.equal(await page.locator('dialog:modal').count(),0,'Hiding the preview closes nested fullscreen');await page.evaluate(()=>window.renderPanel(true));await frame(page);
   await graph.getByRole('button',{name:'全屏查看',exact:true}).click();await page.evaluate(()=>window.renderPanel(true,'other-session','other-project'));await frame(page);assert.equal(await page.locator('dialog:modal').count(),0,'Changing owner leaves no modal');
   await page.evaluate(()=>{const input=document.body.appendChild(document.createElement('input'));input.id='typing-focus';input.value='正在输入的草稿';input.focus();window.renderStandaloneDiagram();});
   const standalone=page.locator('#standalone-diagram .mermaid-preview');await standalone.waitFor();assert.equal(await page.locator('#typing-focus').evaluate(node=>node===document.activeElement),true,'Mounting an inline chart must not steal input focus');await standalone.scrollIntoViewIfNeeded();await standalone.locator('[aria-label="Mermaid chart"] svg').waitFor();assert.equal(await page.locator('#typing-focus').evaluate(node=>node===document.activeElement),true);
   assert.deepEqual(errors,[]);await page.close();
  }catch(error){await page.screenshot({path:join(artifacts,'failure-'+width+'.png')});const dialogs=await page.evaluate(()=>({events:window.dialogEvents,dialogs:[...document.querySelectorAll('dialog')].map(node=>({className:node.className,open:node.open,modal:node.matches(':modal')})),active:document.activeElement?.outerHTML}));await writeFile(join(artifacts,'dialog-events-'+width+'.json'),JSON.stringify(dialogs,null,2));console.log(JSON.stringify(dialogs,null,2));throw error;}
 }
 await writeFile(join(artifacts,'result.json'),JSON.stringify({status:'PASS',results},null,2));console.log(JSON.stringify({status:'PASS',artifacts,results},null,2));
}catch(error){await writeFile(join(artifacts,'failure.json'),JSON.stringify({message:error.message,results},null,2));console.log('FAIL evidence: '+artifacts);throw error;}finally{await browser?.close();await server.close();}
