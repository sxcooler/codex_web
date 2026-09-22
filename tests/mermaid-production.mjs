// Run after npm run build. Optional argument: a real Markdown file to preview.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {buildServer} from '../src/server/app.ts';
import {initializeAuth} from '../src/server/auth.ts';

async function touchDrag(page,x,y,dx,dy){
 const cdp=await page.context().newCDPSession(page);
 try{
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});await page.waitForTimeout(50);
  for(let step=1;step<=5;step++){
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*step/5,y:y+dy*step/5,id:1}]});
   await page.waitForTimeout(30);
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(200);
 }finally{await cdp.detach();}
}

const text=process.argv[2]?await readFile(process.argv[2],'utf8'):'# 流程\n\n```mermaid\nflowchart TD\n A[预检与定位] --> B{可信阶段证据}\n B -->|继续| C[清怪与探索]\n C --> B\n B -->|完成| D[释放并结束]\n```';
const dataDir=await mkdtemp(join(tmpdir(),'codex-mermaid-csp-'));
const port=Number(process.env.MERMAID_TEST_PORT??3199),origin=`http://127.0.0.1:${port}`;
let app,browser;
try{
 await initializeAuth(dataDir,'mermaid-test-password');
 app=await buildServer({dataDir,origin,distDir:resolve('dist')});await app.listen({host:'127.0.0.1',port});
 browser=await chromium.launch({channel:'chrome',headless:true});
 await mkdir('.local/mermaid-csp',{recursive:true});
 for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport,isMobile:viewport.width<600,hasTouch:viewport.width<600}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
   window.cspViolations=[];addEventListener('securitypolicyviolation',event=>window.cspViolations.push(event.violatedDirective));
   window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')))}close(){}};
   localStorage.setItem('codex-web:panels:v1',JSON.stringify({version:1,left:false,right:false}));
  });
  const id='mermaid-csp',path='docs/diagram.md',snapshot={project:{id:'project',path:'/example/project'},thread:{id,name:'Mermaid 样式验证',cwd:'/example/project',turns:[{id:'turn',status:'completed',items:[{id:'answer',type:'agentMessage',text:`[打开测试文档](${path})`}]}]},phase:'IDLE',pending:[]};
  await page.route('**/api/**',route=>{
   const p=new URL(route.request().url()).pathname;let value={};
   if(p==='/api/auth/session')value={authenticated:true,csrfToken:'test'};
   else if(p==='/api/projects')value={projects:[snapshot.project]};
   else if(p==='/api/sessions')value={data:[snapshot.thread]};
   else if(p==='/api/sessions/'+id)value=snapshot;
   else if(p.endsWith('/files/content'))value={text};
   else if(p.endsWith('/files'))value={files:[{path,type:'file'}]};
   else if(p==='/api/models')value={data:[]};
   else if(p.startsWith('/api/permission-modes'))value={modes:[]};
   return route.fulfill({json:value});
  });
  const response=await page.goto(origin+'/sessions/'+id);
  assert.match(response.headers()['content-security-policy'],/script-src 'self';/);
  await page.getByRole('link',{name:'打开测试文档'}).click();
  const diagrams=page.locator('#right-sidebar .mermaid-preview');await diagrams.first().waitFor();
  for(let i=0;i<await diagrams.count();i++){
   const diagram=diagrams.nth(i);
   await diagram.evaluate(element=>{
    window.diagramHeights=[element.getBoundingClientRect().height];
    window.diagramResizeObserver=new ResizeObserver(()=>window.diagramHeights.push(element.getBoundingClientRect().height));
    window.diagramResizeObserver.observe(element);
   });
   await diagram.scrollIntoViewIfNeeded();
   const svg=diagram.locator('[aria-label="Mermaid chart"] svg');await svg.waitFor({state:'visible',timeout:30000});
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const heights=await page.evaluate(()=>{window.diagramResizeObserver.disconnect();return window.diagramHeights;});
   assert.ok(Math.max(...heights)-Math.min(...heights)<=1,`Diagram loading shifted layout: ${heights.join(' -> ')}`);
   const styles=await svg.evaluate(element=>({
    nodes:[...element.querySelectorAll('.node rect,.node polygon')].map(n=>getComputedStyle(n).fill),
    labels:[...element.querySelectorAll('.node text')].map(n=>getComputedStyle(n).fill),
    edges:[...element.querySelectorAll('.flowchart-link')].map(n=>({fill:getComputedStyle(n).fill,stroke:getComputedStyle(n).stroke})),
   }));
   assert.ok(styles.nodes.length&&styles.labels.length&&styles.edges.length,'Missing flowchart elements');
   assert.ok(styles.nodes.every(c=>c!=='rgb(0, 0, 0)'),JSON.stringify(styles));
   assert.ok(styles.labels.every(c=>c!=='rgb(0, 0, 0)'),JSON.stringify(styles));
   assert.ok(styles.edges.every(c=>c.fill==='none'&&c.stroke!=='rgb(0, 0, 0)'&&c.stroke!=='none'),JSON.stringify(styles));
   const bounds=await diagram.boundingBox(),zoomBounds=await diagram.getByRole('button',{name:'放大',exact:true}).boundingBox();
   assert.ok(zoomBounds.y+zoomBounds.height<=bounds.y+bounds.height,'Zoom controls were clipped by the preview');
   await diagram.getByRole('button',{name:'放大',exact:true}).click();
   await diagram.getByRole('button',{name:'重置视图',exact:true}).click();
   if(viewport.width<600){
    const stage=diagram.getByRole('application'),pane=page.locator('#right-sidebar .preview-content');
    await stage.scrollIntoViewIfNeeded();
    const box=await stage.boundingBox(),paneBox=await pane.boundingBox(),before=await pane.evaluate(el=>el.scrollTop);
    const original=await stage.evaluate(el=>el.style.transform);
    const y=(Math.max(box.y,paneBox.y)+Math.min(box.y+box.height,paneBox.y+paneBox.height))/2;
    await touchDrag(page,box.x+box.width/2,y,0,-80);
    assert.ok(await pane.evaluate(el=>el.scrollTop)>before,'Inline touch gesture did not scroll the document');
    assert.equal(await stage.evaluate(el=>el.style.transform),original,'Inline touch gesture incorrectly panned the diagram');
   }
   await diagram.getByRole('button',{name:'全屏查看',exact:true}).click();
   await page.getByRole('dialog',{name:'全屏查看'}).locator('svg .node text').first().waitFor({state:'visible'});
   if(viewport.width<600){
    const stage=page.getByRole('dialog',{name:'全屏查看'}).getByRole('application');
    const original=await stage.evaluate(el=>el.style.transform),box=await stage.boundingBox();
    await touchDrag(page,box.x+box.width/2,box.y+box.height/2,50,60);
    assert.notEqual(await stage.evaluate(el=>el.style.transform),original,'Fullscreen touch drag did not pan the diagram');
    await page.getByRole('dialog',{name:'全屏查看'}).getByRole('button',{name:'重置视图',exact:true}).click();
    assert.equal(await stage.evaluate(el=>el.style.transform),original,'Reset did not restore fullscreen pan');
    await page.waitForTimeout(200); // Let the renderer's 150ms transform transition finish before the screenshot.
   }
   await page.screenshot({path:`.local/mermaid-csp/${viewport.width}-${i}-fullscreen.png`});
   await page.getByRole('button',{name:'退出全屏',exact:true}).click();
   await diagram.screenshot({path:`.local/mermaid-csp/${viewport.width}-${i}.png`});
  }
  assert.deepEqual(await page.evaluate(()=>window.cspViolations),[],'Production CSP blocked diagram styling');
  assert.deepEqual(errors,[]);
  // Allowing generated CSS must never authorize inline script execution.
  await page.evaluate(()=>{const s=document.createElement('script');s.textContent='window.inlineScriptExecuted=true';document.body.append(s)});
  assert.equal(await page.evaluate(()=>window.inlineScriptExecuted),undefined);
  console.log(`${viewport.width}: PASS (${await diagrams.count()} diagrams, stable loading height, real server CSP, dark colors, fullscreen${viewport.width<600?', touch pan/reset and inline scroll':''}, inline scripts blocked)`);
  await page.close();
 }
}finally{await browser?.close();await app?.close();await rm(dataDir,{recursive:true,force:true});}
