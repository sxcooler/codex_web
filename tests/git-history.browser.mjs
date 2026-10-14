// Isolated fake API, real GitHistory/GitPanel components and local Chrome.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const server=await createServer({cacheDir:'.local/vite',server:{host:'127.0.0.1',port:0,strictPort:true}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const width of [390,1280]){
  const page=await browser.newPage({locale:'zh-CN',viewport:{width,height:900}});
  await page.route('**/api/sessions/*/files/image?*',route=>route.request().url().includes('path=broken.png')?route.fulfill({status:404}):route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')}));
  for(const fixture of ['git-repositories','git-history','workspace-panels','workspace-panels?fetch','workspace-panels?images']){
   const [fixtureName,mode]=fixture.split('?'),fixtureUrl=new URL(`/tests/${fixtureName}.html`,`http://127.0.0.1:${server.httpServer.address().port}`);
   if(mode)fixtureUrl.searchParams.set(mode,'');
   await page.goto(fixtureUrl.href);
   await page.waitForFunction(()=>/^(PASS|FAIL)/.test(document.querySelector('#result')?.textContent??''));
   assert.match(await page.locator('#result').textContent(),/^PASS/);
   if(mode)assert.equal(await page.locator('#result').getAttribute('data-mode'),mode,'Requested fixture mode did not execute');
   if(fixture==='git-history'){
    // Branch selection resets the page count; load more to inspect the upward edge again.
    const more=page.getByRole('button',{name:'加载更早的 100 条',exact:true});await more.click();
    await page.waitForFunction(()=>document.querySelectorAll('.git-commit').length===20);
    assert.deepEqual(await page.locator('.git-commit .commit-summary').allTextContents(),Array.from({length:20},(_,i)=>(i===0?'main':i===1?'origin/HEADorigin/mainv0.1.1':'')+'提交 '+(i+1)));
    assert.equal(await page.locator('.git-graph circle').count(),20);
    const edge=await page.locator('.git-graph').evaluate(svg=>{
     const nodes=[...svg.querySelectorAll('circle')],child=nodes[2],parent=nodes[0],middle=nodes[1];
     const path=[...svg.querySelectorAll('path')].find(p=>{const length=p.getTotalLength(),start=p.getPointAtLength(0),end=p.getPointAtLength(length);return Math.abs(start.y-child.cy.baseVal.value)<.1&&Math.abs(end.y-parent.cy.baseVal.value)<.1;});
     if(!path)return null;
     const start=path.getPointAtLength(0),end=path.getPointAtLength(path.getTotalLength());let clearance=Infinity;
     for(let n=0;n<=100;n++){const point=path.getPointAtLength(path.getTotalLength()*n/100);clearance=Math.min(clearance,Math.hypot(point.x-middle.cx.baseVal.value,point.y-middle.cy.baseVal.value));}
     return {startX:start.x,endX:end.x,childX:child.cx.baseVal.value,parentX:parent.cx.baseVal.value,clearance,width:svg.width.baseVal.value};
    });
    assert.ok(edge);assert.equal(edge.startX,edge.childX);assert.equal(edge.endX,edge.parentX);assert.ok(edge.clearance>4,'Upward edge crossed unrelated node');assert.ok(edge.width>=44);
    await page.locator('.git-graph-list').evaluate(e=>e.scrollTop=0);
   }
   if(fixture==='git-repositories'){
    const controls=await page.locator('.git-history-controls>label').evaluateAll(labels=>labels.map(label=>{const box=label.getBoundingClientRect();return {top:box.top,bottom:box.bottom,left:box.left,right:box.right};}));
    assert.equal(controls.length,2);assert.ok(width===390?controls[1].top>=controls[0].bottom:controls[1].left>=controls[0].right,'Repository and branch layout does not match viewport');
    const listHeight=await page.locator('.git-graph-list').evaluate(list=>list.clientHeight);
    assert.ok(listHeight>=48,`Repository notice hid the entire commit list (${listHeight}px)`);
   }
   await page.screenshot({path:`.local/${fixture.replace('?','-')}-${width}.png`});
   console.log(`${width}: ${fixture} PASS`);
   if(fixture==='git-repositories'){
    await page.evaluate(()=>localStorage.setItem('codex.project-panel.repository-test',JSON.stringify(window.reloadState)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/git-repositories.html?restore`);
    await page.waitForFunction(()=>/^(PASS|FAIL)/.test(document.querySelector('#result')?.textContent??''));
    assert.match(await page.locator('#result').textContent(),/^PASS/);console.log(`${width}: repository page reload PASS`);
    await page.locator('.git-commit').click();await page.waitForSelector('.commit-metadata h3');
    await page.getByRole('button',{name:/^README\.md/}).click();await page.waitForSelector('.diff-view');
    await page.screenshot({path:`.local/git-repositories-selection-${width}.png`});
   }
  }
  await page.close();
 }
}finally{await browser.close();await server.close();}
