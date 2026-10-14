import {test,expect} from '@playwright/test';
for(const width of [1440,390])test(`switching a live conversation preserves drafts, history, memo details, approval answers and unknown submissions without requests at ${width}px`,async({page},testInfo)=>{
 await page.setViewportSize({width,height:900});
 const calls:string[]=[];const raw='模型原文 **untouched**';let pending=false;
 await page.addInitScript(()=>{(window as any).sources=[];window.EventSource=class extends EventTarget{closed=false;constructor(){super();(window as any).sources.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){this.closed=true;}} as any;});
 const turn={id:'recent',status:'completed',startedAt:1760000000,items:[{id:'command',type:'commandExecution',command:'echo 原始输出',aggregatedOutput:'stdout 保持原文',status:'completed',exitCode:0},{id:'answer',type:'agentMessage',phase:'final_answer',text:raw}]};
 await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url()),path=url.pathname;calls.push(req.method()+' '+path);let data:any={};
  if(path==='/api/models')data={data:[]};else if(path==='/api/permission-modes')data={modes:[]};
  else if(path==='/api/account/usage')data={accountId:null};
  else if(path.endsWith('/status'))data={resync:false};
  else if(path.endsWith('/messages')){await route.abort('failed');return;}
  else if(path.endsWith('/history'))data={turns:[{id:'older',status:'completed',items:[{id:'older-answer',type:'agentMessage',phase:'final_answer',text:'Loaded older raw text'}]}],nextCursor:null};
  else if(path==='/api/sessions/i18n-test')data={thread:{id:'i18n-test',name:'原生标题',cwd:'C:/project',turns:[turn]},epoch:'i18n',revision:0,syncCursor:'i18n:0',phase:'IDLE',pending:pending?[{requestId:'approval',method:'item/tool/requestUserInput',params:{questions:[{id:'q',question:'原生问题',options:[{label:'原生选项'}]}]}}]:[],history:{nextCursor:'recent'}};
  await route.fulfill({json:data});
 });
 await page.goto('/tests/i18n-session.html');await expect(page.locator('#message')).toBeVisible();
 await page.getByRole('button',{name:'加载更早消息',exact:true}).click();await expect(page.getByText('Loaded older raw text')).toBeVisible();
 await page.locator('.execution-process summary').click();await page.locator('.execution-records summary').click();await page.getByRole('button',{name:'查看输出',exact:true}).click();
 await page.locator('#message').fill('保留输入草稿');const before=[...calls];const streams=await page.evaluate(()=>(window as any).sources.length);
 await page.locator('#english').click();await expect(page.getByRole('button',{name:'Send',exact:true})).toBeVisible();await expect(page.locator('html')).toHaveAttribute('lang','en');
 await expect(page.locator('#message')).toHaveValue('保留输入草稿');await expect(page.getByRole('button',{name:'Hide output'})).toBeVisible();await expect(page.getByText('stdout 保持原文',{exact:true})).toBeVisible();await expect(page.getByText('Loaded older raw text')).toBeVisible();expect(calls).toEqual(before);expect(await page.evaluate(()=>(window as any).sources.length)).toBe(streams);
 await page.getByRole('button',{name:'Send',exact:true}).click();await expect(page.locator('.outgoing-status')).toContainText('unconfirmed');
 await page.locator('#message').fill('unknown 后的新草稿');const unknownCalls=[...calls];await page.locator('#chinese').click();await expect(page.locator('.outgoing-status')).toContainText('提交结果待核实');await expect(page.locator('#message')).toHaveValue('unknown 后的新草稿');expect(calls).toEqual(unknownCalls);
 pending=true;await page.evaluate(()=>{(window as any).sources.findLast((s:any)=>!s.closed).dispatchEvent(new MessageEvent('resync',{data:'{}'}));});await expect(page.getByText('原生问题',{exact:true})).toBeVisible();await page.getByLabel('其他回答',{exact:true}).fill('审批原始答案');const approvalCalls=[...calls];
 await page.locator('#english').click();await expect(page.getByLabel('Other answer',{exact:true})).toHaveValue('审批原始答案');await expect(page.getByRole('button',{name:'Submit answer'})).toBeVisible();expect(calls).toEqual(approvalCalls);expect(calls.filter(c=>c.startsWith('POST '))).toEqual(['POST /api/sessions/i18n-test/cancel-release','POST /api/sessions/i18n-test/messages']);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('english-session.png'),fullPage:true});
});

test('stored attachment and model-load errors translate on switch while native names and errors stay raw',async({page})=>{
 const calls:string[]=[];
 await page.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;});
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;calls.push(path);let data:any={},status=200;
  if(path==='/api/models'){status=503;data={error:'原生模型错误 native error',code:'RUNTIME_ERROR'};}
  else if(path==='/api/permission-modes')data={current:'ask',modes:[{id:'ask',available:true,reason:'原生权限说明'}]};
  else if(path==='/api/sessions/i18n-test')data={thread:{id:'i18n-test',name:'原生标题',turns:[]},phase:'IDLE',pending:[]};
  await route.fulfill({status,json:data});
 });
 await page.goto('/tests/i18n-session.html');await expect(page.locator('.option-error')).toContainText('选项读取失败：原生模型错误 native error');
 await page.locator('input[type=file]').setInputFiles(Array.from({length:6},(_,i)=>({name:'原始附件 '+i+'.txt',mimeType:'text/plain',buffer:Buffer.from('raw')})));
 await expect(page.locator('.attachments [role=alert]')).toContainText('最多 5 个附件');
 const before=[...calls];await page.locator('#english').click();await expect(page.locator('.option-error')).toHaveText('Options could not be loaded: 原生模型错误 native error');await expect(page.locator('.attachments [role=alert]')).toHaveText('Too many attachments: each message allows at most 5 attachments.');expect(calls).toEqual(before);
 await page.getByRole('button',{name:'Approval method: Confirm permissions after resuming'}).click();await expect(page.getByRole('menuitemradio',{name:/Ask for approval/})).toContainText('原生权限说明');
});
