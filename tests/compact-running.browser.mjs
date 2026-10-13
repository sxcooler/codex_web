import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';

const evidence='.local/compact-ui-20261009/compact-browser/'+Date.now();await mkdir(evidence,{recursive:true});
console.log('Evidence: '+evidence);
const server=await createServer({cacheDir:'.local/compact-ui-20261009/compact-vite',server:{host:'127.0.0.1',port:0,strictPort:true}});await server.listen();let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  for(const width of [1280,390]){
    const page=await browser.newPage({viewport:{width,height:900}}),errors=[],imageReads=[],remoteReads=[];let outputReads=0;
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**://example.invalid/**',route=>{remoteReads.push(route.request().url());return route.abort();});
    await page.route('**/api/**',route=>{
      const url=new URL(route.request().url());
      if(url.pathname.endsWith('/output')){outputReads++;return route.fulfill({json:{output:'完整输出'}});}
      if(url.pathname.includes('/images/'))return route.fulfill({contentType:'image/png',path:'public/assets/icon-mobile-v1-180.png'});
      if(url.pathname.endsWith('/files/image')){const path=url.searchParams.get('path');imageReads.push(path);return path==='missing.png'?route.fulfill({status:404,body:'missing'}):route.fulfill({contentType:'image/png',path:'public/assets/icon-mobile-v1-180.png'});}
      return route.fulfill({json:{}});
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/turn-activity.html`);await page.locator('.execution-process').waitFor();
    const update=patch=>page.evaluate(patch=>window.updateActivity(patch),patch),item=id=>page.locator(`[data-item-id="${id}"]`),outer=()=>page.locator('.execution-process').first(),open=node=>node.evaluate(node=>node.open);
    const until=async(check,message)=>{const end=Date.now()+8000;while(!await check()){assert.ok(Date.now()<end,message);await page.waitForTimeout(30);}};
    const cmd=(id,extra={})=>({id,type:'commandExecution',pluginId:null,scriptPath:null,command:'echo '+id,cwd:'/project',processId:null,source:'agent',commandActions:[],durationMs:30,status:'completed',exitCode:0,outputDeferred:true,outputBytes:4096,aggregatedOutput:'短输出',...extra});
    const progress=(id,text=id)=>({id,type:'agentMessage',phase:'commentary',text});
    const initial=[progress('intro','原文进度 [文件](./src/example.ts)'),{id:'empty',type:'reasoning',summary:[]},cmd('first'),{id:'view',type:'imageView',path:'/project/readback.png'},progress('after'),cmd('nonzero',{command:"powershell -NoProfile -Command 'rg missing src'",status:'failed',exitCode:1}),cmd('second'),cmd('exit-two',{status:'failed',exitCode:2}),cmd('one-error',{status:'failed',exitCode:1,error:{message:'执行器错误'}}),{id:'tool-error',type:'mcpToolCall',tool:'search_graph',status:'completed',error:{message:'工具错误原文'}},cmd('third'),{id:'denied',type:'fileChange',status:'declined',changes:[]},{id:'interrupt',type:'subAgentActivity',kind:'interrupted',agentPath:'review'},cmd('active',{status:'inProgress',exitCode:null})];
    await update({turn:{id:'compact',status:'inProgress',items:initial},revealItemId:undefined,revealToken:undefined});await item('intro').waitFor({state:'visible'});
    assert.equal(await open(outer()),true);assert.equal(await page.locator('.execution-records').count(),4);assert.equal(await page.locator('.execution-records[open]').count(),0);assert.equal(await item('empty').isVisible(),false);assert.equal(await item('nonzero').isVisible(),false,'native failed/exit1 must be folded');assert.match(await outer().locator(':scope > summary').innerText(),/14 项过程/);assert.match(await page.locator('.execution-records').last().innerText(),/正在运行命令/);
    assert.equal(await item('exit-two').isVisible(),true);assert.match(await item('exit-two').innerText(),/命令退出码 2/);assert.equal(await item('one-error').isVisible(),true);assert.match(await item('one-error').innerText(),/命令退出码 1/);assert.match(await item('tool-error').innerText(),/工具错误/);assert.match(await item('denied').innerText(),/已拒绝/);assert.match(await item('interrupt').innerText(),/已中止/);
    assert.equal(await item('view').locator('.image-view').getAttribute('open'),null);assert.equal(await item('view').locator('img').count(),0);assert.equal(outputReads,0);assert.deepEqual(imageReads,[]);
    const metrics=await page.locator('.execution-steps > .turn-item,.execution-steps > .execution-records').evaluateAll(nodes=>nodes.map(node=>{const style=getComputedStyle(node);return {paddingTop:style.paddingTop,paddingBottom:style.paddingBottom,lineHeight:style.lineHeight};}));assert.ok(metrics.every(row=>row.paddingTop==='12px'&&row.paddingBottom==='12px'&&row.lineHeight==='23px'),JSON.stringify(metrics));
    await page.locator('.execution-records > summary').first().press('Enter');await item('empty').waitFor({state:'visible'});assert.match(await item('empty').innerText(),/未提供摘要/);assert.equal(outputReads,0);assert.equal(await item('empty').getByRole('button',{name:'查看详情',exact:true}).count(),1,'empty reasoning must still expose its original record');await item('empty').getByRole('button',{name:'查看详情',exact:true}).click();assert.match(await item('empty').locator('pre').innerText(),/"id": "empty"/);
    await item('first').getByRole('button',{name:'查看输出',exact:true}).click();await until(async()=>outputReads===1&&await item('first').innerText().then(text=>text.includes('完整输出')),'deferred output must load only after request');
    await item('view').locator('summary').press('Enter');await item('view').locator('.image-preview a').waitFor();assert.equal(await item('view').locator('a').getAttribute('target'),'_blank');assert.deepEqual(imageReads,['readback.png']);assert.doesNotMatch(await item('view').innerText(),/已完成|查看失败/);
    await page.screenshot({path:`${evidence}/running-${width}.png`});
    await update({turn:{id:'compact',status:'completed',items:[...initial,{id:'final',type:'agentMessage',phase:'final_answer',text:'最终答复'}]}});await until(async()=>!await open(outer()),'untouched default outer group must auto-collapse');await item('final').waitFor({state:'visible'});assert.equal(await item('view').isVisible(),false);assert.equal(outputReads,1);
    await update({revealItemId:'nonzero',revealToken:1});await item('nonzero').waitFor({state:'visible'});assert.equal(await open(outer()),true);assert.equal(await item('nonzero').getByRole('button',{name:'查看输出',exact:true}).getAttribute('aria-expanded'),'false');assert.equal(outputReads,1,'notification reveal must not read output');assert.match(await item('nonzero').innerText(),/命令退出码 1/);assert.match(await item('nonzero').innerText(),/powershell -NoProfile/);assert.doesNotMatch(await item('nonzero').innerText(),/已完成/);await item('nonzero').focus();assert.equal(await item('nonzero').evaluate(node=>node===document.activeElement),true);
    await item('nonzero').getByRole('button',{name:'查看输出',exact:true}).click();await until(async()=>outputReads===2&&await item('nonzero').innerText().then(text=>text.includes('完整输出')),'native exit1 output must remain available on demand');
    await outer().locator(':scope > summary').click();await update({revealItemId:'view',revealToken:2});await item('view').locator('.image-preview a').waitFor();assert.equal(await open(outer()),true);assert.equal(await open(item('view').locator('.image-view')),true);
    for(const path of ['https://example.invalid/remote.png','/elsewhere/outside.png','', '/project/missing.png']){
      await update({turn:{id:'path-'+path,status:'inProgress',items:[{id:'path-view',type:'imageView',path} ]},revealItemId:undefined,revealToken:undefined});await item('path-view').locator('summary').click();
      if(path.endsWith('missing.png')){await item('path-view').getByRole('alert').waitFor();assert.match(await item('path-view').innerText(),/图片预览不可用/);assert.doesNotMatch(await item('path-view').innerText(),/查看失败|本轮失败/);}
      else {assert.equal(await item('path-view').locator('img').count(),0);assert.equal(await item('path-view').getByRole('alert').count(),0);if(!path)assert.match(await item('path-view').innerText(),/图片路径未提供/);}
    }
    assert.deepEqual(remoteReads,[]);assert.ok(imageReads.every(path=>['readback.png','missing.png'].includes(path)));
    for(const terminal of ['completed','failed','interrupted'])for(const choice of ['default','reveal','closed','manual']){
      const turn={id:terminal+'-'+choice,status:'inProgress',items:[cmd('target')]};await update({turn,revealItemId:undefined,revealToken:undefined});await outer().waitFor();
      if(choice!=='default')await update({revealItemId:'target',revealToken:3});
      if(choice==='closed'||choice==='manual'){await outer().locator(':scope > summary').click();if(choice==='manual')await outer().locator(':scope > summary').click();}
      await update({turn:{...turn,status:terminal}});await until(async()=>await open(outer())===(choice==='reveal'||choice==='manual'),'terminal must preserve explicit open choices '+terminal+'/'+choice);
      await update({turn:{...turn,status:terminal,items:[{...turn.items[0],command:'late command'}]}});assert.equal(await open(outer()),choice==='reveal'||choice==='manual','SSE terminal completion must preserve choice');if(choice==='reveal'||choice==='manual')assert.equal(await item('target').isVisible(),true);
    }
    await update({turn:{id:'record-merge',status:'inProgress',items:[cmd('merge-first'),progress('merge-break'),cmd('merge-last')]},revealItemId:'merge-last',revealToken:4});await item('merge-last').waitFor({state:'visible'});
    await update({turn:{id:'record-merge',status:'inProgress',items:[cmd('merge-first'),{id:'merge-break',type:'reasoning',summary:[]},cmd('merge-last')]}});assert.equal(await page.locator('.execution-records').count(),1);assert.equal(await open(page.locator('.execution-records')),true,'late classification merging retains revealed item expansion');
    await page.locator('.execution-records > summary').click();await update({turn:{id:'record-merge',status:'inProgress',items:[cmd('merge-first'),{id:'merge-break',type:'reasoning',summary:['补齐']},cmd('merge-last'),cmd('new-record')]}});assert.equal(await open(page.locator('.execution-records')),false,'new SSE records must not reopen manually collapsed segment');
    assert.equal(outputReads,2);assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await update({turn:{id:'exception-relocation',status:'inProgress',items:[{id:'before-command',type:'reasoning',summary:[]},cmd('relocated')]},revealItemId:'relocated',revealToken:5});await item('relocated').getByRole('button',{name:'查看输出',exact:true}).click();await until(async()=>outputReads===3&&await item('relocated').innerText().then(text=>text.includes('完整输出')),'relocation output missing');
    await update({turn:{id:'exception-relocation',status:'inProgress',items:[{id:'before-command',type:'reasoning',summary:[]},cmd('relocated',{status:'failed',exitCode:2})]}});await item('relocated').getByRole('button',{name:'收起输出',exact:true}).waitFor();assert.equal(outputReads,3,'moving an exception out of compact records must preserve cached command output');
    await update({turn:{id:'exception-relocation',status:'inProgress',items:[{id:'before-command',type:'reasoning',summary:[]},cmd('relocated',{status:'failed',exitCode:2,outputBytes:8192})]}});await until(async()=>outputReads===4,'changed output metadata must invalidate the saved output');
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/execution-process.html`);await until(async()=>await page.locator('#result').textContent().then(text=>!text.startsWith('RUNNING')),'actual Session SSE fixture timed out');assert.match(await page.locator('#result').textContent(),/^PASS/);assert.deepEqual(errors,[]);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/session-performance.html`);await until(async()=>await page.locator('#result').textContent().then(text=>!text.startsWith('RUNNING')),'history performance fixture timed out');assert.match(await page.locator('#result').textContent(),/^PASS/);assert.deepEqual(errors,[]);
    await writeFile(`${evidence}/result-${width}.json`,JSON.stringify({result:'PASS',width,outputReads,imageReads,remoteReads,metrics,errors},null,2));console.log(width+': PASS compact grouping, terminal choices, reveal, image boundaries, lazy output, keyboard, SSE');await page.close();
  }
}catch(error){await writeFile(`${evidence}/failure.json`,JSON.stringify({message:error.message,stack:error.stack},null,2));throw error;}finally{await browser?.close();await server.close();}
