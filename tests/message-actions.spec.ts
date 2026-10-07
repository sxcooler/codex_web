import {test,expect,type Page,type Route} from '@playwright/test';

const agent=(id:string,text:string,memoryCitation?:unknown)=>({id,type:'agentMessage',text,memoryCitation});
const citation={entries:[{path:'MEMORY.md',lineStart:3,lineEnd:5,note:'保留原有草稿'},{path:'<img src=x onerror=alert(1)>',lineStart:8,lineEnd:8,note:'<script>window.citationExecuted=true</script> & "安全文本"'},null,{path:'bad',lineStart:'3',lineEnd:5,note:'invalid'}],threadIds:['original-thread']};
const completed={id:'selected-turn',status:'completed',items:[agent('progress','中间说明'),{type:'commandExecution',id:'cmd',command:'echo test',status:'completed'},agent('final','**最终回答**',citation),{...agent('async','异步问题'),delivery:'async',questions:[{title:'是否继续',options:['是','否']}]}]};
async function fixture(page:Page,options:{turns?:any[];fork?:(route:Route)=>Promise<void>;listFails?:()=>boolean}={}){
  const posts:any[]=[],requests:string[]=[],errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    (window as any).sources=[];(window as any).copies=[];
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text:string)=>(window as any).copies.push(text)}});
    window.EventSource=class extends EventTarget{closed=false;constructor(){super();(window as any).sources.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){this.closed=true;}} as any;
  });
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;requests.push(path);let data:any={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[]};
    else if(path==='/api/sessions'){
      if(options.listFails?.())return route.fulfill({status:503,json:{error:'list unavailable'}});
      data={data:[{id:'source-thread',name:'源会话'},{id:'new-thread',name:'新分支'}],nextCursor:null};
    }else if(path==='/api/sessions/source-thread/fork'){
      posts.push(route.request().postDataJSON());
      return options.fork?options.fork(route):route.fulfill({json:{threadId:'new-thread',status:'idle'}});
    }else if(path==='/api/sessions/source-thread')data={thread:{id:'source-thread',name:'源会话',turns:options.turns??[completed]},history:{nextCursor:'older'},phase:'IDLE',pending:[],epoch:'actions',revision:0,syncCursor:'actions:0'};
    else if(path==='/api/sessions/new-thread')data={thread:{id:'new-thread',name:'新分支',turns:[]},phase:'IDLE',pending:[]};
    else if(path.endsWith('/history'))data={turns:[{id:'older-turn',status:'completed',items:[agent('older','历史回答',citation)]}],nextCursor:null};
    else if(path==='/api/models')data={data:[]};
    else if(path==='/api/permission-modes')data={modes:[]};
    else if(path.endsWith('/status'))data={resync:false};
    else if(path.endsWith('/leave'))data={handoffReady:true};
    await route.fulfill({json:data});
  });
  await page.goto('/sessions/source-thread');
  await expect(page.getByRole('button',{name:'复制 Markdown'}).first()).toBeVisible();
  return {posts,requests,errors};
}
const message=(page:Page,text:string)=>page.locator('article.message').filter({hasText:text});

test('fork appears only on the final ordinary assistant of completed turns',async({page})=>{
  await fixture(page,{turns:[completed,{id:'running',status:'inProgress',items:[agent('live','正在生成',citation)]},{id:'failed',status:'failed',items:[agent('failed-agent','失败回答')]}]});
  await expect(page.getByRole('button',{name:'分支到新聊天',exact:true})).toHaveCount(1);
  await expect(message(page,'最终回答').getByRole('button',{name:'分支到新聊天',exact:true})).toBeVisible();
  await expect(message(page,'正在生成').getByRole('button',{name:'引用的记忆'})).toHaveCount(0);
  await page.getByRole('button',{name:/加载更早/}).click();
  await expect(message(page,'历史回答').getByRole('button',{name:'分支到新聊天',exact:true})).toBeVisible();
  await page.evaluate(({citation})=>(window as any).sources.findLast((source:any)=>!source.closed).dispatchEvent(new MessageEvent('change',{data:JSON.stringify({id:'actions:1',threadId:'source-thread',revision:1,kind:'turn',patch:{turn:{id:'running',status:'completed',items:[{id:'live',type:'agentMessage',text:'正在生成',memoryCitation:citation}]}}})})),{citation});
  await expect(message(page,'正在生成').getByRole('button',{name:'引用的记忆'})).toBeVisible();
  await expect(message(page,'正在生成').getByRole('button',{name:'分支到新聊天',exact:true})).toBeVisible();
});

for(const refreshFailure of [false,true])test(`fork sends the selected turn once and navigates while refresh failure=${refreshFailure}`,async({page})=>{
  let respond:()=>Promise<void>=async()=>{},fail=false;
  const {posts}=await fixture(page,{listFails:()=>fail,fork:route=>new Promise<void>(resolve=>{respond=async()=>{fail=refreshFailure;await route.fulfill({json:{threadId:'new-thread',status:'idle'}});resolve();};})});
  await page.locator('#message').fill('源会话未发送的草稿');
  const button=page.getByRole('button',{name:'分支到新聊天',exact:true});
  await button.dblclick();
  await expect.poll(()=>posts.length).toBe(1);
  await expect(button).toBeDisabled();
  expect(Object.keys(posts[0]).sort()).toEqual(['clientRequestId','lastTurnId']);
  expect(posts[0].lastTurnId).toBe('selected-turn');expect(posts[0].clientRequestId).toMatch(/^[a-zA-Z0-9_-]{8,128}$/);
  await respond();await expect(page).toHaveURL(/\/sessions\/new-thread$/);
  if(refreshFailure)await expect(page.getByText(/最近会话同步失败/)).toBeVisible();
  await page.getByRole('link',{name:'源会话',exact:true}).click();
  await expect(page.locator('#message')).toHaveValue('源会话未发送的草稿');
  await expect(page.getByRole('button',{name:'打开已创建的会话'})).toBeVisible();
  expect(posts).toHaveLength(1);
});

test('a definite fork rejection stays on source and permits explicit retry',async({page})=>{
  const {posts}=await fixture(page,{fork:route=>route.fulfill({status:409,json:{error:'selected turn incomplete',code:'RUNTIME_FORK_TURN_INCOMPLETE'}})});
  await page.getByRole('button',{name:'分支到新聊天',exact:true}).click();
  await expect(page.getByText('selected turn incomplete')).toBeVisible();await expect(page).toHaveURL(/source-thread$/);
  await page.getByRole('button',{name:'重试分支'}).click();await expect.poll(()=>posts.length).toBe(2);
  expect(posts[1].clientRequestId).not.toBe(posts[0].clientRequestId);
});

for(const kind of ['unknown','partial','permission','malformed','missing','disconnect','unclassified'])test(`fork ${kind} is recoverable without another POST`,async({page})=>{
  const {posts}=await fixture(page,{fork:async route=>{
    if(kind==='disconnect')return route.abort('failed');
    if(kind==='malformed')return route.fulfill({status:409,contentType:'application/json',body:'{'});
    if(kind==='missing')return route.fulfill({json:{status:'idle'}});
    if(kind==='unclassified')return route.fulfill({status:409,json:{error:'unclassified failure',code:'NEW_NATIVE_ERROR'}});
    return route.fulfill({status:kind==='permission'?503:504,json:{error:'verification failed',code:kind==='permission'?'RUNTIME_PERMISSION_MISMATCH':'RUNTIME_RESULT_UNKNOWN',...(kind==='partial'||kind==='permission'?{partial:{threadId:'new-thread'}}:{})}});
  }});
  await page.getByRole('button',{name:'分支到新聊天',exact:true}).click();
  await expect(page.getByText(/先核对会话列表/)).toBeVisible();
  await expect(page.getByRole('button',{name:'重试分支'})).toHaveCount(0);
  await page.getByRole('button',{name:'刷新最近会话',exact:true}).click();
  await expect(page).toHaveURL(/source-thread$/);expect(posts).toHaveLength(1);
  if(kind==='partial'||kind==='permission'){await page.getByRole('button',{name:'打开已创建的会话'}).click();await expect(page).toHaveURL(/new-thread$/);}
});

for(const scenario of [
  {name:'missing status',response:{threadId:'new-thread'},recoverable:true},
  {name:'unexpected status',response:{threadId:'new-thread',status:'running'},recoverable:true},
  {name:'invalid ID',response:{threadId:'../invalid',status:'idle'},recoverable:false},
  {name:'source ID',response:{threadId:'source-thread',status:'idle'},recoverable:false},
])test(`successful envelope with ${scenario.name} stays unknown and preserves only a valid recovery ID`,async({page})=>{
  const {posts}=await fixture(page,{fork:route=>route.fulfill({json:scenario.response})});
  await page.getByRole('button',{name:'分支到新聊天',exact:true}).click();
  await expect(page.getByText(/先核对会话列表/)).toBeVisible();
  await expect(page).toHaveURL(/source-thread$/);
  await expect(page.getByRole('button',{name:'分支到新聊天',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'重试分支'})).toHaveCount(0);
  expect(posts).toHaveLength(1);
  const open=page.getByRole('button',{name:'打开已创建的会话'});
  if(scenario.recoverable){
    await expect(open).toBeVisible();await open.click();await expect(page).toHaveURL(/new-thread$/);
  }else await expect(open).toHaveCount(0);
  expect(posts).toHaveLength(1);
});

for(const outcome of ['success','partial'])test(`late ${outcome} response does not navigate and survives leaving and returning`,async({page})=>{
  let respond:()=>Promise<void>=async()=>{};
  const {posts}=await fixture(page,{fork:route=>new Promise<void>(resolve=>{respond=async()=>{await route.fulfill(outcome==='success'?{json:{threadId:'new-thread',status:'idle'}}:{status:504,json:{error:'readback failed',code:'RUNTIME_RESULT_UNKNOWN',partial:{threadId:'new-thread'}}});resolve();};})});
  await page.locator('#message').fill('离开后保留');
  await page.getByRole('button',{name:'分支到新聊天',exact:true}).click();await expect.poll(()=>posts.length).toBe(1);
  await page.getByRole('button',{name:'＋ 新任务',exact:true}).click();await expect(page).toHaveURL(/\/$/);
  await page.getByRole('link',{name:'源会话',exact:true}).click();
  await expect(page.getByRole('button',{name:'分支到新聊天',exact:true})).toBeDisabled();
  await page.locator('#message').fill('返回后新草稿');
  await respond();await expect(page.getByRole('button',{name:'打开已创建的会话'})).toBeVisible();
  await expect(page).toHaveURL(/source-thread$/);await expect(page.locator('#message')).toHaveValue('返回后新草稿');
  await page.getByRole('button',{name:'＋ 新任务',exact:true}).click();await page.getByRole('link',{name:'源会话',exact:true}).click();
  await expect(page.getByRole('button',{name:'打开已创建的会话'})).toBeVisible();expect(posts).toHaveLength(1);
});

for(const width of [390,1440])test(`citation panel uses safe text, keyboard dismissal and history at ${width}px`,async({page},testInfo)=>{
  await page.setViewportSize({width,height:900});
  const {requests,errors}=await fixture(page,{turns:[completed,...[null,{}, {entries:[]}, {entries:[{path:'bad',lineStart:0,lineEnd:4,note:'invalid'},null]}].map((memoryCitation,index)=>({id:'empty-'+index,status:'completed',items:[agent('empty-'+index,'无有效引用 '+index,memoryCitation)]}))]});
  await expect(page.getByRole('button',{name:'引用的记忆'})).toHaveCount(1);
  const button=message(page,'最终回答').getByRole('button',{name:'引用的记忆'});await button.focus();await button.press('Enter');
  const panel=page.getByRole('dialog',{name:'引用的记忆'});
  await expect(panel).toBeVisible();await expect(panel).toContainText('保留原有草稿');await expect(panel).toContainText('MEMORY.md:3-5');
  await expect(panel.locator('li')).toHaveCount(2);
  await expect(panel).toContainText('<script>window.citationExecuted=true</script> & "安全文本"');await expect(panel.locator('img,script,a')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).citationExecuted)).toBeUndefined();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('memory-citation.png')});
  await page.keyboard.press('Escape');await expect(panel).not.toBeVisible();await expect(button).toBeFocused();
  await button.click();await expect(panel).toBeVisible();await page.locator('#message').click();await expect(panel).not.toBeVisible();
  await message(page,'最终回答').getByRole('button',{name:'复制 Markdown'}).click();expect(await page.evaluate(()=>(window as any).copies)).toEqual(['**最终回答**']);
  await page.getByRole('button',{name:/加载更早/}).click();await expect(message(page,'历史回答').getByRole('button',{name:'引用的记忆'})).toBeVisible();
  await page.reload();await expect(page.getByRole('button',{name:'引用的记忆'})).toHaveCount(1);
  expect(requests.some(path=>/memory|plugins|\/files\//.test(path))).toBe(false);expect(errors).toEqual([]);
});
