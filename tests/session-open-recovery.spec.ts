import {test,expect,type Page} from '@playwright/test';

async function setup(page:Page){
  const state={opens:0,failOpen:false,denied:false,external:false,holdRead:false,reading:false,finishRead:()=>{},holdOpen:false,finishOpen:()=>{},posted:[] as any[],holdSend:false,finishSend:()=>{},snapshot:{thread:{id:'recovery',name:'刷新恢复测试',turns:[] as any[]},phase:'IDLE',activeTurnId:null as string|null,pending:[],epoch:'test',syncCursor:'test:0'}};
  await page.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;});
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;let data:any={},status=200;
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[]};
    else if(path==='/api/sessions')data={data:[],nextCursor:null};
    else if(path==='/api/models')data={data:[]};
    else if(path==='/api/permission-modes')data={modes:[]};
    else if(path.endsWith('/open')){state.opens++;if(state.holdOpen)await new Promise<void>(resolve=>{state.finishOpen=resolve;});if(state.failOpen){status=state.denied?403:503;data={error:'测试：运行时暂不可用',code:state.denied?'FORBIDDEN':'RUNTIME_UNAVAILABLE'};}else data={phase:state.external?'EXTERNAL':state.snapshot.phase};}
    else if(path==='/api/sessions/recovery'){if(state.holdRead){state.reading=true;await new Promise<void>(resolve=>{state.finishRead=resolve;});}data={...state.snapshot,...(state.external?{phase:'EXTERNAL',activeTurnId:null}:{})};}
    else if(path.endsWith('/status'))data={resync:false};
    else if(path.endsWith('/messages')){
      const message=route.request().postDataJSON();state.posted.push(message);
      state.snapshot.phase='RUNNING';state.snapshot.activeTurnId='turn';
      state.snapshot.thread.turns=[{id:'turn',status:'inProgress',items:[{id:'user',type:'userMessage',clientId:message.clientRequestId,content:[{type:'text',text:message.text}]}]}];
      if(state.holdSend)await new Promise<void>(resolve=>{state.finishSend=resolve;});
      data={threadId:'recovery',turnId:'turn',status:'started'};
    }
    await route.fulfill({status,json:data}).catch(()=>{});
  });
  return state;
}

for(const width of [1440,390])test(`refresh during an unacknowledged send recovers without resending at ${width}px`,async({page})=>{
  const state=await setup(page);await page.setViewportSize({width,height:900});
  await page.goto('/sessions/recovery');
  await page.getByRole('textbox',{name:'继续这个会话'}).fill('刷新前已发送的任务');
  state.holdSend=true;await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect.poll(()=>state.posted.length).toBe(1);
  state.failOpen=true;await page.reload();
  await expect(page.locator('.composer')).toContainText('会话占用状态未确认');
  await expect(page.locator('.timeline')).toContainText('刷新前已发送的任务');
  await page.getByRole('textbox',{name:'继续这个会话'}).fill('下一条指令');
  await expect(page.getByRole('button',{name:'插话',exact:true})).toBeDisabled();
  await page.screenshot({path:`.local/session-open-${width}-pending.png`});
  state.failOpen=false;state.finishSend();
  await expect(page.getByRole('button',{name:'插话',exact:true})).toBeEnabled({timeout:7000});
  await expect(page.locator('.composer')).not.toContainText('会话占用状态未确认');
  expect(state.posted).toHaveLength(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`.local/session-open-${width}-recovered.png`});
});

test('persistent open failures are bounded and manual retry still verifies external ownership',async({page})=>{
  const state=await setup(page);state.failOpen=true;await page.goto('/sessions/recovery');
  await page.getByRole('textbox',{name:'继续这个会话'}).fill('不要自动发送');
  await expect(page.locator('.composer')).toContainText('测试：运行时暂不可用');
  await expect.poll(()=>state.opens,{timeout:9000}).toBe(3);
  await page.clock.install();await page.clock.runFor(90_000);
  expect(state.opens).toBe(3);
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeDisabled();
  state.failOpen=false;state.external=true;
  await page.locator('.composer').getByRole('button',{name:'重试',exact:true}).click();
  await expect(page.locator('.composer')).toContainText('已在另一个应用中打开');
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeDisabled();
  expect(state.posted).toHaveLength(0);
  state.external=false;await page.getByRole('button',{name:'操作',exact:true}).click();
  await page.getByRole('button',{name:'刷新当前会话'}).click();
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled();
});

test('an open timeout recovers through a fresh open, not through a successful history read',async({page})=>{
  test.setTimeout(45_000);
  const state=await setup(page);state.holdOpen=true;await page.goto('/sessions/recovery');
  await expect(page.locator('.composer')).toContainText('核对超时',{timeout:35_000});
  await page.getByRole('textbox',{name:'继续这个会话'}).fill('超时后继续');
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeDisabled();
  state.holdOpen=false;state.finishOpen();
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled({timeout:7000});
  expect(state.opens).toBe(2);expect(state.posted).toHaveLength(0);
});

test('recovery keeps stale running controls locked until the new ownership snapshot arrives',async({page})=>{
  const state=await setup(page);state.failOpen=true;
  state.snapshot.phase='RUNNING';state.snapshot.activeTurnId='turn';
  await page.goto('/sessions/recovery');
  await expect(page.locator('.composer')).toContainText('会话占用状态未确认');
  await page.getByRole('textbox',{name:'继续这个会话'}).fill('不能发给旧轮次');
  state.failOpen=false;state.external=true;state.holdRead=true;
  await expect.poll(()=>state.reading,{timeout:7000}).toBe(true);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page.getByRole('button',{name:'插话',exact:true})).toBeDisabled();
  state.holdRead=false;state.finishRead();
  await expect(page.locator('.composer')).toContainText('已在另一个应用中打开');
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeDisabled();
  expect(state.posted).toHaveLength(0);
});

test('permission failures do not retry and leaving cancels transient recovery',async({page})=>{
  const state=await setup(page);state.failOpen=true;state.denied=true;
  await page.goto('/sessions/recovery');await expect(page.locator('.composer')).toContainText('会话占用状态未确认');
  await page.clock.install();await page.clock.runFor(10_000);expect(state.opens).toBe(1);
  state.denied=false;await page.locator('.composer').getByRole('button',{name:'重试',exact:true}).click();
  await expect.poll(()=>state.opens).toBe(2);
  await page.getByRole('button',{name:'＋ 新任务',exact:true}).click();
  await expect(page).toHaveURL(/\/$/);await page.clock.runFor(10_000);expect(state.opens).toBe(2);
});

test('an open error remains visible while history is still loading',async({page})=>{
  const state=await setup(page);state.failOpen=true;state.holdRead=true;
  await page.goto('/sessions/recovery');
  await expect.poll(()=>state.reading).toBe(true);
  await expect(page.locator('.composer')).toContainText('测试：运行时暂不可用');
  await page.getByRole('textbox',{name:'继续这个会话'}).fill('仍需确认');
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeDisabled();
  state.holdRead=false;state.finishRead();
});
