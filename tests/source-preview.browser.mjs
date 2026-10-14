import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const baseline=process.argv.includes('--baseline'),server=await createServer({cacheDir:'.local/source-preview-vite',server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true}),results=[];
try{
 for(const width of [390,1280]){
  const page=await browser.newPage({locale:'zh-CN',viewport:{width,height:900}}),errors=[];let observed,stage='initial';
  page.on('pageerror',error=>errors.push(error.message));
  const render=async(path,text,anchor)=>{stage=path;await page.evaluate(({path,text,anchor})=>renderPreview(path,text,anchor),{path,text,anchor});await page.waitForFunction(text=>document.querySelector('.preview-content pre')?.textContent===text,text);};
  const colored=()=>page.waitForFunction(()=>[...document.querySelectorAll('.preview-content pre span')].some(node=>node.style.color),{},{timeout:5000});
  try{
   await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/source-preview.html${baseline?'?baseline':''}`,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.renderPreview&&document.querySelector('.preview-content pre'));
   const original=await page.evaluate(()=>previewState.text);
   assert.equal(await page.locator('.preview-content pre').textContent(),original);
   observed={renderer:await page.evaluate(()=>previewRenderer),sourceExact:true,textLength:original.length,coloredSpans:await page.locator('.preview-content pre span[style]').count(),style:await page.locator('.preview-content pre').evaluate(node=>({whiteSpace:getComputedStyle(node).whiteSpace,overflowWrap:getComputedStyle(node).overflowWrap}))};
   await colored();
   if(!baseline){
    assert.equal(await page.evaluate(()=>previewRenderer),'source');
    for(const [path,text] of [['x.xml','<?xml version="1.0"?>\n<root value="你好"/>\n'],['x.json','{"answer":42}\n'],['x.yaml','answer: true\n'],['x.js','const answer = 42;\n'],['x.tsx','const x = <p>Hello</p>;\n'],['x.py','def answer():\n  return 42\n'],['x.ps1','$answer = Get-Content "demo.txt"\n'],['x.cpp','#include <string>\nint answer = 42;\n'],['Dockerfile','FROM node:24\n'],['Makefile','all:\n\techo hello\n'],['CMakeLists.txt','cmake_minimum_required(VERSION 3.20)\n'],['x.md','# source heading\n'],['x.crlf.ts','const answer = 42;\r\n\r\n']]){await render(path,text);await colored();assert.equal(await page.locator('pre').textContent(),text);}
    const literal='<script>window.sourceExecuted=true</script>\n  \t尾部\n\n';await render('x.unknown',literal);assert.equal(await page.locator('pre span[style]').count(),0);assert.equal(await page.evaluate(()=>window.sourceExecuted),undefined);
    assert.equal(await page.locator('pre').textContent(),literal);
    const boundary='//'+ 'x'.repeat(262142);
    await page.evaluate(()=>{previewState.heartbeat=0;previewState.heartbeatTimer=setInterval(()=>previewState.heartbeat++,25);});
    await render('boundary.js',boundary);await page.waitForFunction(()=>previewState.workers.at(-1)?.terminated);
    const heartbeat=await page.evaluate(()=>{clearInterval(previewState.heartbeatTimer);return previewState.heartbeat;});assert.ok(heartbeat>=5,'Main thread must respond while pathological tokenizer is running');
    assert.equal(await page.locator('pre').textContent(),boundary);assert.equal(await page.locator('pre span[style]').count(),0,'2s worker timeout must keep pathological source plain');assert.equal(await page.locator('.source-preview-notice').count(),0);
    console.log(`${width}: original 262144-byte pathological line plain, main heartbeat=${heartbeat}`);
    const anchored=Array.from({length:120},(_,i)=>`const value${i} = ${i};`).join('\n')+'\n\n';await render('anchor.ts',anchored,{fragment:'L60-L62'});await colored();
    assert.equal(await page.locator('mark').textContent(),anchored.split('\n').slice(59,62).join('\n')+'\n');
    const markedColors=await page.locator('mark').evaluate(mark=>({color:getComputedStyle(mark).color,spans:[...mark.querySelectorAll('span')].map(span=>getComputedStyle(span).color)}));
    assert.ok(markedColors.spans.length>0,'Anchor contrast check must include actual highlighted tokens');assert.ok(markedColors.spans.every(color=>color===markedColors.color),'Marked token text must inherit the original mark color');
    assert.equal(await page.locator('pre').evaluate(pre=>[...pre.querySelectorAll('span')].some(span=>!span.closest('mark')&&span.style.color&&getComputedStyle(span).color!==getComputedStyle(pre.querySelector('mark')).color)),true,'Unmarked source must retain syntax colors');
    const before=await page.locator('.preview-content').evaluate(node=>node.scrollTop);assert.ok(before>0);assert.ok(Math.abs(await page.locator('mark').evaluate(node=>node.getBoundingClientRect().top-node.closest('.preview-content').getBoundingClientRect().top))<35);
    await page.locator('.preview-content').evaluate(node=>node.scrollTop=240);await page.evaluate(()=>previewState.anchor=null);await render('anchor.ts',anchored);assert.equal(await page.locator('.preview-content').evaluate(node=>node.scrollTop),240);
    const edge='//'+ 'a'.repeat(110)+'\nconst value = 1;\n//'+ 'z'.repeat(110),collision=edge.replace('= 1','= 2');await render('cache.js',edge);await colored();await render('cache.js',collision);assert.equal(await page.locator('pre').textContent(),collision);
    await page.evaluate(()=>controlWorkers('fake'));await render('slow-anchor.ts',anchored.replaceAll('value','pending'),{fragment:'L60-L62'});
    await page.waitForFunction(()=>previewState.workers.at(-1)?.options?.code.includes('pending'));
    await page.locator('.preview-content').evaluate(node=>node.scrollTop=240);await page.evaluate(()=>replyWorker(previewState.workers.length-1));await colored();assert.equal(await page.locator('.preview-content').evaluate(node=>node.scrollTop),240,'Async colors must not repeat anchor scrolling');
    await render('slow.py','answer = 1\n');await page.waitForFunction(()=>previewState.workers.at(-1)?.options?.code==='answer = 1\n');const oldWorker=await page.evaluate(()=>previewState.workers.length-1);
    await render('new.ts','const latest = 2;\n');await page.waitForFunction(()=>previewState.workers.at(-1)?.options?.code==='const latest = 2;\n');
    await page.evaluate(()=>replyWorker(previewState.workers.length-1));await colored();await page.evaluate(index=>replyWorker(index),oldWorker);
    assert.equal(await page.locator('pre').textContent(),'const latest = 2;\n');
    const badSource=' \tconst preserve = 42;\r\n\r\n\n';await render('bad.ts',badSource);await page.waitForFunction(()=>previewState.workers.at(-1)?.options?.code.includes('preserve'));await page.evaluate(()=>replyWorker(previewState.workers.length-1,'wrong'));assert.equal(await page.locator('pre').textContent(),badSource);assert.equal(await page.locator('pre span[style]').count(),0);
    await render('boundary-fake.js',boundary);await page.waitForFunction(()=>previewState.workers.at(-1)?.options?.code.length===262144);const admitted=await page.evaluate(()=>previewState.workers.length);await page.evaluate(()=>replyWorker(previewState.workers.length-1));await colored();assert.equal(await page.locator('.source-preview-notice').count(),0);
    await render('over.js',boundary+'x');assert.equal(await page.locator('pre span[style]').count(),0);assert.match(await page.locator('.source-preview-notice').textContent(),/文件较大/);assert.equal(await page.evaluate(()=>previewState.workers.length),admitted,'Over-byte-budget must not create a worker');
    await render('utf8.js','//'+'你'.repeat(87381));assert.match(await page.locator('.source-preview-notice').textContent(),/文件较大/);assert.equal(await page.evaluate(()=>previewState.workers.length),admitted);
    const lines=Array.from({length:4999},()=> '//x').join('\n')+'\n';assert.equal(lines.split('\n').length,5000);await render('lines.js',lines);await page.waitForFunction(()=>previewState.workers.at(-1)?.options?.code===previewState.text);await page.evaluate(()=>replyWorker(previewState.workers.length-1));await colored();assert.equal(await page.locator('.source-preview-notice').count(),0);const lineAdmitted=await page.evaluate(()=>previewState.workers.length);
    await render('lines.js',lines+'\n',{fragment:'L4000-L4002'});assert.equal(await page.locator('pre span[style]').count(),0);assert.match(await page.locator('.source-preview-notice').textContent(),/文件较大/);assert.equal(await page.locator('mark').textContent(),'//x\n//x\n//x\n');assert.equal(await page.evaluate(()=>previewState.workers.length),lineAdmitted);
    await render('timeout.ts','const timed = 42;\n');await page.waitForFunction(()=>previewState.workers.at(-1)?.options?.code.includes('timed'));await page.waitForFunction(()=>previewState.workers.at(-1).terminated);await page.evaluate(()=>replyWorker(previewState.workers.length-1));assert.equal(await page.locator('pre span[style]').count(),0,'Late message after timeout must remain plain');
    await render('deadline.ts','const expired = 42;\n');await page.waitForFunction(()=>previewState.workers.at(-1)?.options?.code.includes('expired'));
    await page.evaluate(()=>{const descriptor=Object.getOwnPropertyDescriptor(performance,'now'),now=performance.now.bind(performance);Object.defineProperty(performance,'now',{configurable:true,value:()=>now()+3000});try{replyWorker(previewState.workers.length-1);}finally{if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete performance.now;}});
    assert.equal(await page.locator('pre span[style]').count(),0,'Elapsed deadline must reject message before a delayed timer runs');assert.equal(await page.evaluate(()=>previewState.workers.at(-1).terminated),true);
    for(const kind of ['error','messageerror']){await render(kind+'.ts','const failure = 42;\n');await page.waitForFunction(()=>previewState.workers.at(-1)?.options?.code.includes('failure'));await page.evaluate(kind=>replyWorker(previewState.workers.length-1,kind),kind);assert.equal(await page.evaluate(()=>previewState.workers.at(-1).terminated),true);assert.equal(await page.locator('pre').textContent(),'const failure = 42;\n');}
    await page.evaluate(()=>controlWorkers('throw'));await render('startup.ts','const startup = 42;\n');assert.equal(await page.locator('pre span[style]').count(),0);await page.evaluate(()=>controlWorkers('real'));
    await page.evaluate(async()=>renderMarkdown('```js\nconst markdown = 42;\n```'));
    await page.waitForFunction(()=>document.querySelector('[data-streamdown="code-block-body"] code span[style*="--sdm-c"]'));
    assert.match(await page.locator('[data-streamdown="code-block-body"]').textContent(),/const markdown = 42;/);
    assert.deepEqual(errors,[]);
   }
   results.push({width,ok:true});console.log(`${width}: source preview ${baseline?'baseline':'fidelity/languages/bounds/anchor/cache/late callback/Markdown'} PASS`);
  }catch(error){const current=await page.locator('.preview-content pre').textContent().catch(()=>null);results.push({width,ok:false,stage,message:error.message,observed,currentLength:current?.length,currentHead:current?.slice(0,80),errors});console.error(`${width}: FAIL at ${stage}: ${error.message} current=${JSON.stringify({length:current?.length,head:current?.slice(0,80)})}`);}
  finally{await page.close();}
 }
 await mkdir('.local/file-preview-highlight-20261009',{recursive:true});await writeFile(`.local/file-preview-highlight-20261009/${baseline?'before':'after'}.json`,JSON.stringify(results,null,2));
 if(results.some(result=>!result.ok))process.exitCode=1;
}finally{await browser.close();await server.close();}
