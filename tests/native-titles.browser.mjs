import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const server=await createServer({cacheDir:'.local/title-vite',server:{host:'127.0.0.1',port:0,strictPort:true}});await server.listen();
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  for(const width of [390,1280]) {
    const page=await browser.newPage({viewport:{width,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/session-toolbar.html?nativeTitle`);
    await page.waitForFunction(()=>window.testState.stream&&document.querySelector('.session-title')?.textContent==='临时任务预览');
    assert.match(await page.locator('.session-toolbar').textContent(),/命名中/);
    const sessionReads=await page.evaluate(()=>testState.calls.filter(path=>path==='/api/sessions/toolbar-test').length);
    await page.evaluate(()=>{
      const state=testState;
      state.snapshot.titlePending=false;state.snapshot.thread.name='生成的原生标题';
      state.stream.dispatchEvent(new MessageEvent('change',{data:JSON.stringify({id:'title-test:1',threadId:'toolbar-test',revision:1,kind:'name',patch:{thread:{name:'生成的原生标题'},state:{titlePending:false}}})}));
    });
    await page.waitForFunction(()=>document.querySelector('.session-title')?.textContent==='生成的原生标题');
    assert.equal(await page.title(),'生成的原生标题 - Codex Web');
    assert.doesNotMatch(await page.locator('.session-toolbar').textContent(),/命名中/);
    await page.waitForFunction(()=>document.querySelector('.recent .session-link.selected')?.textContent==='生成的原生标题',undefined,{timeout:3000});
    assert.equal(await page.evaluate(()=>testState.calls.filter(path=>path==='/api/sessions/toolbar-test').length),sessionReads,'Native name must not refetch main history');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:`.local/native-title-${width}.png`});await page.close();
  }
  console.log('PASS: native preview → generated name updates header/sidebar/browser title at 390px and 1280px');
} finally {await browser.close();await server.close();}
