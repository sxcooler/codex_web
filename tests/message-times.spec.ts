import {test,expect} from '@playwright/test';

test.use({timezoneId:'Asia/Shanghai',locale:'zh-CN'});
for(const width of [1280,390])test(`historical item times, older pages and live completion at ${width}px`,async({page},testInfo)=>{
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
  await page.setViewportSize({width,height:900});
  await page.addInitScript(()=>{
    (window as any).timeSources=[];
    window.EventSource=class extends EventTarget{
      closed=false;
      constructor(){super();(window as any).timeSources.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}
      close(){this.closed=true;}
    } as any;
  });
  const id='message-times',epoch='time-test',base=Date.parse('2026-10-04T00:01:00Z');
  const user=(id:string,text:string)=>({id,type:'userMessage',content:[{type:'text',text}]});
  const agent=(id:string,text:string)=>({id,type:'agentMessage',text});
  const turn={id:'new',status:'completed',startedAt:base/1000,completedAt:base/1000+60,items:[
    {...user('user','历史用户消息'),startedAtMs:base+1000,completedAtMs:base+1000},
    {...agent('progress','中间进度消息'),startedAtMs:base+2000,completedAtMs:base+3000},
    agent('unknown','没有记录时间的中间消息'),
    {...agent('invalid','无效时间不显示'),startedAtMs:'1790000000000',completedAtMs:-1},
    {...agent('final','历史完成消息'),startedAtMs:base+8000,completedAtMs:base+9000},
  ]};
  const old={id:'old',status:'completed',startedAt:base/1000-120,completedAt:base/1000-60,items:[user('old-user','旧协议用户消息'),agent('old-agent','旧协议完成消息')]};
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;let data:any={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[]};
    else if(path==='/api/sessions')data={data:[{id,name:'历史时间测试'}],nextCursor:null};
    else if(path===`/api/sessions/${id}`)data={thread:{id,name:'历史时间测试',turns:[turn]},history:{nextCursor:'old'},phase:'IDLE',pending:[],epoch,revision:0,syncCursor:epoch+':0'};
    else if(path.endsWith('/history'))data={turns:[old],nextCursor:null};
    else if(path==='/api/models')data={data:[]};
    else if(path==='/api/permission-modes')data={modes:[]};
    else if(path.endsWith('/status'))data={resync:false};
    await route.fulfill({json:data});
  });
  await page.goto(`/sessions/${id}`);
  await expect(page).toHaveTitle(/Codex/);
  const message=(text:string)=>page.locator('article.message').filter({hasText:text});
  await expect(message('历史用户消息').locator('time')).toHaveAttribute('datetime',new Date(base+1000).toISOString());
  await expect(message('中间进度消息').locator('time')).toHaveAttribute('datetime',new Date(base+3000).toISOString());
  await expect(message('历史完成消息').locator('time')).toHaveAttribute('datetime',new Date(base+9000).toISOString());
  await expect(message('没有记录时间的中间消息').locator('time')).toHaveCount(0);
  await expect(message('无效时间不显示').locator('time')).toHaveCount(0);
  await page.getByRole('button',{name:/加载更早/}).click();
  await expect(message('旧协议用户消息').locator('time')).toHaveAttribute('title',/本轮开始/);
  await expect(message('旧协议完成消息').locator('time')).toHaveAttribute('title',/本轮完成/);
  const emit=async(revision:number,patch:any)=>page.evaluate(({id,epoch,revision,patch})=>{
    (window as any).timeSources.findLast((source:any)=>!source.closed).dispatchEvent(new MessageEvent('change',{data:JSON.stringify({id:epoch+':'+revision,threadId:id,kind:'item',revision,patch})}));
  },{id,epoch,revision,patch});
  const live={...agent('live-item','实时消息'),startedAtMs:base+120000};
  await emit(1,{turn:{id:'live-turn',status:'inProgress',items:[live]}});
  await expect(message('实时消息').locator('time')).toHaveAttribute('datetime',new Date(base+120000).toISOString());
  await emit(2,{item:{turnId:'live-turn',item:{...live,completedAtMs:base+123456},completed:true}});
  await expect(message('实时消息').locator('time')).toHaveAttribute('datetime',new Date(base+123456).toISOString());
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('message-times.png')});
  await page.reload();
  await expect(message('中间进度消息').locator('time')).toHaveAttribute('datetime',new Date(base+3000).toISOString());
  expect(errors).toEqual([]);
});
