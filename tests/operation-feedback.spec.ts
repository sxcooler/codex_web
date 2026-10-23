import {test,expect,type Page} from '@playwright/test';

async function setup(page:Page,{locale='zh-CN',width=1440,initial='failed'}={}){
 let state:any={available:true,status:initial,scheduledAt:'2026-10-14T10:38:27.000Z',finishedAt:'2026-10-14T10:38:29.000Z',reason:'Native shutdown was refused.'};
 const writes:string[]=[],errors:string[]=[];let reads=0,offline=false,holdRead=false,releaseRead:(value:any)=>void=()=>{};
 await page.addInitScript(value=>localStorage.setItem('codex-web:locale:v1',value),locale);
 await page.setViewportSize({width,height:900});
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;let data:any={};
  if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
  else if(path==='/api/projects')data={projects:[]};
  else if(path==='/api/sessions')data={data:[],nextCursor:null};
  else if(path==='/api/settings')data={appVersion:'test',nodeVersion:'test',runtime:{},webRestart:state};
  else if(path==='/api/runtime/restart-check')data={checkedAt:'2026-10-22T06:00:00Z',complete:true,sessions:[],blockers:[],issues:[],canRestart:true,canForce:false,version:'a'.repeat(64)};
  else if(path==='/api/models/reload'){writes.push(path);data={data:[]};}
  else if(path==='/api/server/restart'){
   if(route.request().method()==='POST'){writes.push(path);state={available:true,status:'scheduled',scheduledAt:new Date(await page.evaluate(()=>Date.now())+90000).toISOString()};}
   else {reads++;if(offline)return route.abort('failed');if(holdRead){const held=await new Promise<any>(resolve=>releaseRead=resolve);return route.fulfill({json:held});}}
   data=state;
  }
  await route.fulfill({json:data});
 });
 return {writes,errors,reads:()=>reads,state:(value:any)=>{state=value;},offline:(value:boolean)=>{offline=value;},holdRead:()=>{holdRead=true;},releaseRead:(value:any)=>{holdRead=false;releaseRead(value);}};
}

for(const width of [390,1440])for(const locale of ['zh-CN','en'])test(`historical restart failure is a dated record, not a current alarm: ${locale} ${width}`,async({page},info)=>{
 const fixture=await setup(page,{locale,width});await page.goto('/settings?section=web');
 await expect(page.locator('.settings-maintenance')).toBeVisible();
 await expect(page.locator('.settings-maintenance > .notice.error')).toHaveCount(0);
 const history=page.locator('.web-restart-history');await expect(history).toBeVisible();
 await expect(history.locator('summary')).toContainText(locale==='en'?'Last Web restart':'上次 Web 重启');
 await expect(page.getByRole('button',{name:locale==='en'?'Check restart result':'检查重启结果',exact:true})).toHaveCount(0);
 await history.locator('summary').focus();await page.keyboard.press('Enter');await expect(history).toContainText('Native shutdown was refused.');
 await expect(page.getByRole('button',{name:locale==='en'?'Restart Web service':'重启 Web 服务',exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath('historical-restart.png'),fullPage:true});
 expect(fixture.writes).toEqual([]);expect(fixture.errors).toEqual([]);
});

test('a new failed restart is visible once, dismissible, and never resubmitted',async({page},info)=>{
 const fixture=await setup(page,{initial:'idle'});await page.clock.install();await page.goto('/settings?section=web');
 await page.getByRole('button',{name:'重启 Web 服务',exact:true}).click();
 await page.getByRole('button',{name:'重启',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
 fixture.state({available:true,status:'failed',scheduledAt:new Date(await page.evaluate(()=>Date.now())+90000).toISOString(),finishedAt:new Date().toISOString(),reason:'Idle check refused the stop.'});
 await page.clock.fastForward(90000);
 const current=page.locator('.web-restart-current');await expect(current).toContainText('Idle check refused the stop.');
 await page.clock.fastForward(6000);await expect(current).toBeVisible();
 await current.getByRole('button',{name:'关闭此提示',exact:true}).click();await expect(current).toHaveCount(0);
 await expect(page.getByRole('button',{name:'重启 Web 服务',exact:true})).toBeFocused();
 await expect(page.locator('.web-restart-history')).toBeVisible();
 await page.screenshot({path:info.outputPath('failure-dismissed.png'),fullPage:true});
 expect(fixture.writes).toEqual(['/api/server/restart']);expect(fixture.errors).toEqual([]);
});

test('scheduled and unknown restart outcomes keep verification and safety gates',async({page})=>{
 const fixture=await setup(page,{locale:'en',width:390,initial:'unknown'});await page.clock.install();await page.goto('/settings?section=web');
 const current=page.locator('.web-restart-current');await expect(current).toContainText('verification');
 await expect(page.getByRole('button',{name:'Restart Web service',exact:true})).toBeDisabled();
 await expect(current.getByRole('button',{name:'Dismiss this notice',exact:true})).toHaveCount(0);
 await page.clock.fastForward(180000);const readCount=fixture.reads();await page.clock.fastForward(60000);expect(fixture.reads()).toBe(readCount);
 fixture.state({available:true,status:'success',scheduledAt:'2026-10-14T10:38:27.000Z'});
 await current.getByRole('button',{name:'Check restart result',exact:true}).click();
 await expect(current).toHaveCount(0);await expect(page.locator('.web-restart-history')).toContainText('Succeeded');
  await expect(page.locator('.web-restart-history summary')).toBeFocused();
 await expect(page.getByRole('button',{name:'Restart Web service',exact:true})).toBeEnabled();expect(fixture.writes).toEqual([]);
});

test('confirmed restart and native reload success expire without erasing history',async({page})=>{
 const fixture=await setup(page,{initial:'idle'});await page.clock.install();await page.goto('/settings?section=web');
 await page.getByRole('button',{name:'重启Codex',exact:true}).click();await page.getByRole('button',{name:'重启',exact:true}).click();
 await expect(page.locator('.settings-maintenance')).toContainText('Codex 已重启');await page.clock.fastForward(5000);await expect(page.locator('.settings-maintenance')).not.toContainText('Codex 已重启');
 await page.getByRole('button',{name:'重启 Web 服务',exact:true}).click();await page.getByRole('button',{name:'重启',exact:true}).click();
 fixture.state({available:true,status:'success',scheduledAt:new Date(await page.evaluate(()=>Date.now())+90000).toISOString()});await page.clock.fastForward(90000);
  await expect(page.locator('.web-restart-current')).toContainText('Web 服务已重启');await page.clock.fastForward(5000);await expect(page.locator('.web-restart-current')).toHaveCount(0);
 await expect(page.locator('.web-restart-history')).toBeVisible();expect(fixture.writes).toEqual(['/api/models/reload','/api/server/restart']);
});

test('saved configuration feedback expires but draft verification guidance stays',async({page})=>{
 await page.clock.install();await page.goto('/tests/i18n-settings.html?section=configuration');
 await expect(page.locator('#setting-web_search')).toHaveValue('cached');
 await page.evaluate(()=>{
  const original=window.fetch;
  window.fetch=async(input,options)=>{
   if(options?.method==='POST'&&String(input).includes('/codex/settings')){
    const snapshot=await (await original(input)).json(),{values}=JSON.parse(String(options.body));
    for(const [key,value] of Object.entries(values))snapshot.fields[key]={...snapshot.fields[key],userValue:value,effectiveValue:value};
    return Response.json({snapshot:{...snapshot,userVersion:'v2'}});
   }
   return original(input,options);
  };
 });
 await page.locator('#setting-web_search').selectOption('disabled');await page.locator('.settings-save button.primary').click();
 await expect(page.locator('.settings-editor')).toContainText('本机默认配置已保存');await page.clock.fastForward(5000);await expect(page.locator('.settings-editor')).not.toContainText('本机默认配置已保存');
 await page.locator('#setting-web_search').selectOption('live');await page.locator('.settings-editor > button').click();
 const guidance=page.locator('.settings-editor > .settings-feedback[role=status]');await expect(guidance).toBeVisible();await page.clock.fastForward(6000);await expect(guidance).toBeVisible();
 await expect(page.locator('#setting-web_search')).toHaveValue('live');
 await page.locator('.settings-save button[type=button]').click();await expect(guidance).toHaveCount(0);
});

test('unreachable restart stays unconfirmed, stops polling, and verifies on reconnection',async({page})=>{
 const fixture=await setup(page,{locale:'en'});const epoch=new Date('2026-10-15T03:00:00Z');await page.clock.install({time:epoch});
 fixture.state({available:true,status:'scheduled',scheduledAt:new Date(epoch.getTime()+90000).toISOString()});fixture.offline(true);
 await page.goto('/settings?section=web');await page.clock.fastForward(90000);await expect(page.locator('.web-restart-current')).toContainText('Cannot connect');
 await page.clock.fastForward(125000);await expect(page.locator('.web-restart-current')).toContainText('needs verification');
 const reads=fixture.reads();await page.clock.fastForward(60000);expect(fixture.reads()).toBe(reads);
 await expect(page.getByRole('button',{name:'Restart Web service',exact:true})).toBeDisabled();expect(fixture.writes).toEqual([]);
 fixture.offline(false);fixture.state({available:true,status:'success',scheduledAt:new Date(epoch.getTime()+90000).toISOString()});
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.locator('.web-restart-current')).toHaveCount(0);await expect(page.locator('.web-restart-history')).toContainText('Succeeded');
});

test('a response from a previous settings page cannot replace a newer receipt',async({page})=>{
 const fixture=await setup(page);const epoch=new Date('2026-10-15T03:00:00Z');await page.clock.install({time:epoch});
 fixture.state({available:true,status:'scheduled',scheduledAt:epoch.toISOString()});fixture.holdRead();await page.goto('/settings?section=web');
 await expect.poll(fixture.reads).toBe(1);await page.goto('/settings?section=general');
 fixture.state({available:true,status:'failed',scheduledAt:new Date(epoch.getTime()+1000).toISOString(),reason:'New receipt failure'});await page.goto('/settings?section=web');
 const history=page.locator('.web-restart-history');await history.locator('summary').click();await expect(history).toContainText('New receipt failure');
 fixture.releaseRead({available:true,status:'success',scheduledAt:epoch.toISOString()});await page.clock.fastForward(6000);
 await expect(history).toContainText('New receipt failure');expect(fixture.writes).toEqual([]);expect(fixture.errors).toEqual([]);
});

test('a hanging verification cannot keep the restart scheduled beyond its deadline',async({page})=>{
 const fixture=await setup(page,{locale:'en'}),epoch=new Date('2026-10-15T03:00:00Z');await page.clock.install({time:epoch});
 fixture.state({available:true,status:'scheduled',scheduledAt:epoch.toISOString()});fixture.holdRead();await page.goto('/settings?section=web');
 await expect.poll(fixture.reads).toBe(1);await page.clock.fastForward(120001);
 const current=page.locator('.web-restart-current');await expect(current).toContainText('needs verification');
 const check=current.getByRole('button',{name:'Check restart result',exact:true});await expect(check).toBeEnabled();
 fixture.releaseRead({available:true,status:'success',scheduledAt:epoch.toISOString()});
 fixture.state({available:true,status:'failed',scheduledAt:epoch.toISOString(),reason:'Final receipt'});await check.click();
 await expect(page.locator('.web-restart-history')).toContainText('Did not complete');expect(fixture.writes).toEqual([]);
});

test('manual verification releases its busy state after the normal read timeout',async({page},info)=>{
 test.setTimeout(45000);const fixture=await setup(page,{locale:'en',initial:'unknown'});fixture.holdRead();await page.goto('/settings?section=web');
 const current=page.locator('.web-restart-current');await current.getByRole('button',{name:'Check restart result',exact:true}).click();
 await expect(current.getByRole('button',{name:'Loading…',exact:true})).toBeDisabled();
 await page.screenshot({path:info.outputPath('manual-reading.png'),fullPage:true});
 await expect.poll(fixture.reads).toBe(1);await expect(current).toContainText('read timed out',{timeout:35000});
 await expect(current.getByRole('button',{name:'Check restart result',exact:true})).toBeEnabled();expect(fixture.writes).toEqual([]);
});

test('hidden pages stop automatic reads but keep the deadline and verify when visible',async({page},info)=>{
 const fixture=await setup(page,{locale:'en',width:390}),epoch=new Date('2026-10-15T03:00:00Z');await page.clock.install({time:epoch});
 fixture.state({available:true,status:'scheduled',scheduledAt:new Date(epoch.getTime()+90000).toISOString()});await page.goto('/settings?section=web');
 await page.evaluate(()=>Object.defineProperty(document,'visibilityState',{get:()=> 'hidden',configurable:true}));await page.clock.fastForward(210001);
 await expect(page.locator('.web-restart-current')).toContainText('needs verification');expect(fixture.reads()).toBe(0);
 await page.locator('.web-restart-current').scrollIntoViewIfNeeded();
 await page.screenshot({path:info.outputPath('unknown-restart.png'),fullPage:true});
 fixture.state({available:true,status:'success',scheduledAt:new Date(epoch.getTime()+90000).toISOString()});
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{get:()=> 'visible',configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
 await expect(page.locator('.web-restart-history')).toContainText('Succeeded');expect(fixture.writes).toEqual([]);expect(fixture.errors).toEqual([]);
});
