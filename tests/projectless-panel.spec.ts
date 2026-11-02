import {test,expect,type Page} from '@playwright/test';

const projectId='a'.repeat(24),workRoot='C:/work',projectRoot=workRoot+'/repo';
async function fixture(page:Page,locale='zh-CN'){
 const calls:{method:string;path:string;query:string}[]=[],errors:string[]=[];let cwd=workRoot,epoch='test',workspaceStatus='syncing',holdRoot=false,releaseRoot:()=>void=()=>{};
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(({locale,workRoot,projectId})=>{
  localStorage.clear();localStorage.setItem('codex-web:locale:v1',locale);
  localStorage.setItem('codex.project-panel.files-root:'+workRoot,JSON.stringify({tab:'history'}));
  localStorage.setItem('codex.project-panel.'+projectId,JSON.stringify({tab:'history'}));
  (window as any).__sources=[];
  window.EventSource=class extends EventTarget{url:string;constructor(url:string){super();this.url=url;(window as any).__sources.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;
 },{locale,workRoot,projectId});
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;calls.push({method:request.method(),path,query:url.search});let data:any={};
  if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
  else if(path==='/api/projects')data={projects:[{id:projectId,name:'repo',path:projectRoot}],workRoot};
  else if(path==='/api/project-catalog')data={state:'ready',projects:[],workspaces:[{workspaceId:projectId,path:projectRoot,directoryName:'repo',status:workspaceStatus,nativeProjectId:null}]};
  else if(path==='/api/models')data={data:[{id:'model',model:'model',displayName:'Model',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}]};
  else if(path==='/api/permission-modes')data={model:'model',effort:'low',current:'ask',modes:[{id:'ask',available:true}]};
  else if(path==='/api/sessions')data={data:[],nextCursor:null};
  else if(path==='/api/sessions/thread')data={thread:{id:'thread',cwd,name:'Root conversation',turns:[],status:{type:'idle'}},project:cwd===projectRoot?{id:projectId,path:projectRoot}:null,phase:'IDLE',epoch,revision:1,streamEventId:epoch+':1',pending:[]};
  else if(path==='/api/sessions/thread/open')data={status:'opened'};
  else if(path.endsWith('/files')||path==='/api/files'){
   if(path==='/api/files'&&holdRoot)await new Promise<void>(resolve=>releaseRoot=resolve);
   data={files:[{path:path.startsWith('/api/projects/')||path.startsWith('/api/sessions/')&&cwd===projectRoot?'project.md':'README.md',type:'file',size:30}]};
  }else if(path.endsWith('/files/entry'))data={path:url.searchParams.get('path'),type:'file'};
  else if(path.endsWith('/files/content'))data={path:url.searchParams.get('path'),text:url.searchParams.get('path')==='next.md'?'# Linked document':'# Root document\n\n[next](next.md)',binary:false};
  await route.fulfill({json:data}).catch(error=>{if(!holdRoot)throw error;});
 });
 return {calls,errors,cwd:(next:string)=>{cwd=next;},epoch:(next:string)=>{epoch=next;},workspaceStatus:(next:string)=>{workspaceStatus=next;},holdRoot:()=>{holdRoot=true;},releaseRoot:()=>releaseRoot(),resync:()=>page.evaluate(()=>{for(const source of (window as any).__sources)if(source.url.includes('/sessions/thread/'))source.dispatchEvent(new Event('resync'));})};
}
const panel=(page:Page)=>page.locator('#right-sidebar');
async function openPanel(page:Page){const toggle=page.locator('[data-panel-toggle="right"]');await expect(toggle).toBeEnabled();if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await expect(panel(page)).toBeVisible();}

for(const locale of ['zh-CN','en'])for(const width of [1440,390])test(`new task files use root and selected project ${width} ${locale}`,async({page})=>{
 const f=await fixture(page,locale);await page.setViewportSize({width,height:900});await page.goto('/');await openPanel(page);
 await expect(panel(page).locator('.tabs>button')).toHaveCount(2);await expect(panel(page).locator('.tabs>button').first()).toHaveAttribute('aria-pressed','true');
 await panel(page).locator('.directory-list button').filter({hasText:'README.md'}).click();await expect(panel(page).getByRole('heading',{name:'Root document',exact:true})).toBeVisible();
 await panel(page).getByRole('link',{name:'next',exact:true}).click();await expect(panel(page).getByRole('heading',{name:'Linked document',exact:true})).toBeVisible();
 const fileReads=f.calls.filter(c=>c.path.endsWith('/files/content')).length;await panel(page).locator('.panel-refresh').click();await expect.poll(()=>f.calls.filter(c=>c.path.endsWith('/files/content')).length).toBeGreaterThan(fileReads);
 await page.screenshot({path:`.local/implementation-projectless/home-files-${width}-${locale}.png`});
 if(width===390){await page.keyboard.press('Escape');await expect(page.locator('[data-panel-toggle="right"]')).toBeFocused();}
 await page.locator('.home .project-picker select').first().selectOption('workspace:'+projectId);await openPanel(page);
 await expect(panel(page).locator('.directory-list button').filter({hasText:'project.md'})).toBeVisible();await expect(panel(page).getByRole('heading',{name:'Linked document',exact:true})).toHaveCount(0);
 if(width===390)await page.keyboard.press('Escape');
 await page.locator('.home .creation-fields>.tabs button').nth(1).click();await openPanel(page);await expect(panel(page).locator('.directory-list button').filter({hasText:'README.md'})).toBeVisible();
 if(width===390)await page.keyboard.press('Escape');
 await page.locator('.home .creation-fields>.tabs button').nth(2).click();await openPanel(page);await expect(panel(page).locator('.directory-list button').filter({hasText:'README.md'})).toBeVisible();
 expect(f.calls.filter(c=>c.path.includes('/git/'))).toEqual([]);expect(f.calls.filter(c=>c.method==='POST'&&c.path.startsWith('/api/sessions'))).toEqual([]);
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('codex.project-panel.'+'a'.repeat(24))!).tab)).toBe('history');expect(f.errors).toEqual([]);
});

test('switching new-task roots discards a late response without starting a session',async({page})=>{
 const f=await fixture(page);f.holdRoot();await page.goto('/');await openPanel(page);await expect.poll(()=>f.calls.some(c=>c.path==='/api/files')).toBe(true);
 await page.locator('.home .project-picker select').first().selectOption('workspace:'+projectId);
 await expect(panel(page).locator('.directory-list button').filter({hasText:'project.md'})).toBeVisible();f.releaseRoot();
 await expect(panel(page).locator('.directory-list button').filter({hasText:'README.md'})).toHaveCount(0);expect(f.calls.filter(c=>c.method==='POST'&&c.path.startsWith('/api/sessions'))).toEqual([]);expect(f.errors).toEqual([]);
});

test('projectless session files require the true shared root and disappear for external cwd',async({page})=>{
 const f=await fixture(page);await page.goto('/sessions/thread');await openPanel(page);await expect(panel(page).locator('.tabs>button')).toHaveCount(2);
 await panel(page).locator('.directory-list button').filter({hasText:'README.md'}).click();await expect(panel(page).getByRole('heading',{name:'Root document',exact:true})).toBeVisible();
 const before=f.calls.filter(c=>c.path.includes('/files')).length;f.cwd('D:/private');await f.resync();await expect(panel(page)).toHaveCount(0);await expect(page.locator('[data-panel-toggle="right"]')).toBeDisabled();
 expect(f.calls.filter(c=>c.path.includes('/files')).length).toBe(before);expect(f.calls.filter(c=>c.path.includes('/git/'))).toEqual([]);expect(f.calls.filter(c=>c.path.endsWith('/messages'))).toEqual([]);expect(f.errors).toEqual([]);
});

for(const cwd of ['', 'D:/private'])test(`unconfirmed or external session cwd cannot use the shared file root: ${cwd||'empty'}`,async({page})=>{
 const f=await fixture(page);f.cwd(cwd);await page.goto('/sessions/thread');await expect(page.getByRole('heading',{name:'Root conversation',exact:true})).toBeVisible();await expect(page.locator('[data-panel-toggle="right"]')).toBeDisabled();expect(f.calls.filter(c=>c.path.includes('/files'))).toEqual([]);expect(f.errors).toEqual([]);
});

test('epoch and cwd replacement removes the old root preview and restores project tabs',async({page})=>{
 const f=await fixture(page);await page.goto('/sessions/thread');await openPanel(page);await panel(page).locator('.directory-list button').filter({hasText:'README.md'}).click();await expect(panel(page).getByRole('heading',{name:'Root document',exact:true})).toBeVisible();
 f.cwd(projectRoot);f.epoch('replacement');await f.resync();await expect(panel(page).locator('.tabs>button')).toHaveCount(4);await expect(panel(page).getByRole('heading',{name:'Root document',exact:true})).toHaveCount(0);
 await panel(page).getByRole('button',{name:'文件',exact:true}).click();await expect(panel(page).locator('.directory-list button').filter({hasText:'project.md'})).toBeVisible();expect(f.errors).toEqual([]);
});

test('an unavailable selected project cannot fall back to another file root',async({page})=>{
 const f=await fixture(page);await page.goto('/?project='+'b'.repeat(24));await expect(page.locator('.home .project-picker option[value="workspace:'+projectId+'"]')).toHaveCount(1);await expect(page.locator('[data-panel-toggle="right"]')).toBeDisabled();expect(f.calls.filter(c=>c.path.includes('/files'))).toEqual([]);expect(f.errors).toEqual([]);
});

test('local project files remain usable while native project association blocks task creation',async({page})=>{
 const f=await fixture(page);f.workspaceStatus('ambiguous');await page.goto('/?project='+projectId);await openPanel(page);await expect(panel(page).locator('.directory-list button').filter({hasText:'project.md'})).toBeVisible();
 await page.getByRole('textbox',{name:'任务',exact:true}).fill('do not submit');await expect(page.getByRole('button',{name:'开始任务 →',exact:true})).toBeDisabled();expect(f.calls.some(c=>c.path==='/api/projects/'+projectId+'/files')).toBe(true);expect(f.calls.filter(c=>c.method==='POST'&&c.path.startsWith('/api/sessions'))).toEqual([]);
});
