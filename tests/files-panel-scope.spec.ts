import {test,expect,type Page} from '@playwright/test';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const evidence=resolve('.local/implementation-projectless/panels');mkdirSync(evidence,{recursive:true});
type Request={path:string;method:string;body:unknown};
async function setup(page:Page){
 const requests:Request[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
 const held:{release?:()=>void;prefix?:string;entry?:boolean;fetch?:boolean}={};
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;requests.push({path:path+url.search,method:request.method(),body:request.postDataJSON()});
  const hold=held.prefix&&path.startsWith(held.prefix)&&(held.entry?path.endsWith('/entry'):held.fetch?path.endsWith('/git/fetch'):path.endsWith('/content'));
  if(hold)await new Promise<void>(resolve=>{held.release=resolve;});
  if(path.endsWith('/image'))return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});
  let result:unknown={};
  if(path.endsWith('/entry'))result={type:'file',path:url.searchParams.get('path')};
  else if(path.endsWith('/content'))result={text:url.searchParams.get('path')==='README.md'?'[child](child.txt)\n\n![photo](photo.png)\n\n[escape](../outside.txt)\n\n'+Array.from({length:80},(_,i)=>`Paragraph ${i}`).join('\n\n'):path.includes('old')?'old scope':'current scope'};
  else if(path.endsWith('/files')&&!path.includes('/git/'))result={files:[{path:'README.md',type:'file'},{path:'child.txt',type:'file'},{path:'photo.png',type:'file'},...Array.from({length:30},(_,i)=>({path:'filler-'+i+'.txt',type:'file'}))]};
  else if(path.endsWith('/git/files'))result={files:[{path:'child.txt',status:'M'}]};
  else if(path.endsWith('/git/diff')||path.endsWith('/git/commit/diff'))result={hunks:[{oldStart:1,oldLines:1,newStart:1,newLines:1,lines:[{kind:'add',text:'Changed',newLine:1}]}]};
  else if(path.endsWith('/git/repositories'))result={repositories:[{path:'',name:'Main',kind:'main',available:true},{path:'nested',name:'Nested',kind:'nested',available:true}],complete:true};
  else if(path.endsWith('/git/log'))result={repository:true,commits:[{id:'1'.repeat(40),parents:[],subject:'First',author:'QA',date:'2026-10-30T00:00:00Z',refs:[]}],branches:[],nextCursor:null};
  else if(path.endsWith('/git/fetch'))result={remotes:[{name:'origin',status:'updated'},{name:'backup',status:'failed',error:'network failure'}]};
  else if(path.endsWith('/git/commit'))result={commit:{id:'1'.repeat(40),parents:[],subject:'First',author:'QA',date:'2026-10-30T00:00:00Z'},files:[{path:'child.txt',status:'modified'}]};
  await route.fulfill({json:result}).catch(()=>{});
 });
 return{requests,errors,held};
}
const render=(page:Page,props:Record<string,unknown>)=>page.evaluate(props=>(window as any).renderPanel(props),props);
const settle=(page:Page)=>page.waitForTimeout(150);

for(const cachedTab of ['changes','history'])test(`files-only overrides cached ${cachedTab} without mounting Git`,async({page})=>{
 const {requests,errors}=await setup(page);await page.addInitScript(tab=>localStorage.setItem('codex.project-panel.scope',JSON.stringify({tab,files:{path:'README.md'}})),cachedTab);
 await page.goto('/tests/files-panel-scope.html?filesOnly=true&fileBase=/files');
 await expect(page.locator('.markdown-message h1, .markdown-message a').first()).toBeVisible();
 await expect(page.locator('.tabs button')).toHaveCount(2);await expect(page.locator('.git-history')).toHaveCount(0);
 await expect(page.locator('.tabs button[aria-pressed=true]')).toHaveText('文件');
 expect(requests.every(request=>!request.path.includes('/git/')&&request.method==='GET')).toBe(true);
 await expect(page.locator('.markdown-message img')).toHaveAttribute('src',/\/api\/files\/image\?path=photo.png/);
 await page.getByRole('link',{name:'child',exact:true}).click();await expect(page.locator('.file-preview h3')).toHaveText('child.txt');
 expect(requests.some(request=>request.path==='/api/files/entry?path=child.txt')).toBe(true);
 await page.getByRole('button',{name:'后退',exact:true}).click();await expect(page.getByRole('link',{name:'child',exact:true})).toBeVisible();
 const current=page.locator('.preview-content');await current.evaluate(node=>node.scrollTop=250);await settle(page);const position=await current.evaluate(node=>node.scrollTop),before=requests.length;
 await page.getByRole('button',{name:'↻ 刷新',exact:true}).click();await settle(page);expect(await current.evaluate(node=>node.scrollTop)).toBe(position);
 expect(requests.slice(before).every(request=>request.path.startsWith('/api/files'))).toBe(true);expect(errors).toEqual([]);
});

test('Changes and Files refresh only their own reads; History fetch keeps its repository and stale result scope',async({page})=>{
 const {requests,errors,held}=await setup(page);await page.goto('/tests/files-panel-scope.html');
 await page.locator('.directory-list button').count();await expect(page.locator('.file-list button').first()).toBeVisible();await page.locator('.file-list button').first().click();await expect(page.locator('.diff-line')).toBeVisible();
 let before=requests.length;await page.getByRole('button',{name:'↻ 刷新',exact:true}).click();await settle(page);
 expect(requests.slice(before).map(r=>r.path.split('?')[0]).sort()).toEqual(['/api/sessions/session/git/diff','/api/sessions/session/git/files']);
 await page.getByRole('button',{name:'文件',exact:true}).click();await page.getByTitle('child.txt',{exact:true}).click();await expect(page.locator('.source-preview')).toBeVisible();
 before=requests.length;await page.getByRole('button',{name:'↻ 刷新',exact:true}).click();await settle(page);expect(requests.slice(before).map(r=>r.path.split('?')[0]).sort()).toEqual(['/api/sessions/session/files','/api/sessions/session/files/content']);
 await page.getByRole('button',{name:'Git 日志',exact:true}).click();await page.getByLabel('Git 仓库',{exact:true}).selectOption('nested');await expect(page.locator('.git-commit')).toBeVisible();
 held.prefix='/api/sessions/session';held.fetch=true;before=requests.length;
 await page.getByRole('button',{name:'↻ 刷新',exact:true}).click();await page.getByRole('button',{name:'↻ 刷新',exact:true}).dispatchEvent('click');await settle(page);
 expect(requests.slice(before).filter(r=>r.path.endsWith('/git/fetch'))).toEqual([{path:'/api/sessions/session/git/fetch',method:'POST',body:{repository:'nested'}}]);
 await page.getByRole('button',{name:'文件',exact:true}).click();await page.getByRole('button',{name:'↻ 刷新',exact:true}).click();await settle(page);
 expect(requests.slice(before).filter(r=>r.method==='POST')).toHaveLength(1);
 held.release!();held.fetch=false;await settle(page);await expect(page.locator('.fetch-result')).toHaveCount(0);
 await page.getByRole('button',{name:'Git 日志',exact:true}).click();await expect(page.locator('.fetch-result')).toContainText('backup');expect(requests.slice(before).filter(r=>r.path.includes('/git/log')).every(r=>r.path.includes('repository=nested'))).toBe(true);
 held.fetch=true;held.release=undefined;await page.getByRole('button',{name:'↻ 刷新',exact:true}).click();await expect.poll(()=>!!held.release).toBe(true);const release=held.release!;await render(page,{projectId:'other',id:'other'});await settle(page);release();await settle(page);await expect(page.locator('.fetch-result')).toHaveCount(0);expect(errors).toEqual([]);
});

test('a late fetch does not refresh or display its result in another repository',async({page})=>{
 const {held,requests,errors}=await setup(page);await page.goto('/tests/files-panel-scope.html');await page.getByRole('button',{name:'Git 日志',exact:true}).click();await expect(page.locator('.git-commit')).toBeVisible();
 held.prefix='/api/sessions/session';held.fetch=true;await page.getByRole('button',{name:'↻ 刷新',exact:true}).click();await expect.poll(()=>!!held.release).toBe(true);
 await page.getByLabel('Git 仓库',{exact:true}).selectOption('nested');await expect(page.locator('.git-commit')).toBeVisible();await settle(page);const before=requests.length;held.release!();await settle(page);
 expect(requests.slice(before).filter(r=>r.path.includes('/git/log'))).toEqual([]);await expect(page.locator('.fetch-result')).toHaveCount(0);
 await page.getByLabel('Git 仓库',{exact:true}).selectOption('');await expect(page.locator('.fetch-result')).toContainText('backup');expect(requests.filter(r=>r.method==='POST')).toEqual([{path:'/api/sessions/session/git/fetch',method:'POST',body:{repository:''}}]);expect(errors).toEqual([]);
});

test('switching file roots aborts old content and entry responses',async({page})=>{
 const {held,requests,errors}=await setup(page);await page.goto('/tests/files-panel-scope.html?filesOnly=true&fileBase=/projects/old/files');
 await expect(page.getByTitle('child.txt',{exact:true})).toBeVisible();held.prefix='/api/projects/old/files';
 await page.getByTitle('child.txt',{exact:true}).click();await expect.poll(()=>!!held.release).toBe(true);const contentRelease=held.release!;held.release=undefined;
 await render(page,{filesOnly:true,fileBase:'/files',projectId:'root',openFile:{path:'README.md'}});await expect(page.getByRole('link',{name:'child',exact:true})).toBeVisible();contentRelease();await settle(page);await expect(page.locator('.file-preview h3')).toHaveText('README.md');await expect(page.locator('.preview-content')).not.toContainText('old scope');
 held.prefix='/api/files';held.entry=true;await page.getByRole('link',{name:'child',exact:true}).click();await expect.poll(()=>!!held.release).toBe(true);const entryRelease=held.release!;
 await render(page,{filesOnly:true,fileBase:'/projects/new/files',projectId:'new',openFile:{path:'photo.png'}});await expect(page.locator('.image-preview img')).toHaveAttribute('src',/\/api\/projects\/new\/files\/image\?/);entryRelease();await settle(page);await expect(page.locator('.file-preview h3')).toHaveText('photo.png');expect(requests.every(r=>!r.path.includes('/git/'))).toBe(true);expect(errors).toEqual([]);
});

for(const locale of ['zh-CN','en'])for(const width of [1440,390])test(`file controls and refresh title in ${locale} at ${width}px`,async({page})=>{
 const {errors}=await setup(page);await page.setViewportSize({width,height:900});await page.goto('/tests/files-panel-scope.html');await render(page,{filesOnly:true,fileBase:'/files',projectId:'visual',locale,openFile:{path:'README.md'}});
 await expect(page).toHaveTitle('File panel scope QA');await expect(page).toHaveURL(/\/tests\/files-panel-scope.html$/);await expect(page.locator('vite-error-overlay')).toHaveCount(0);
 await expect(page.locator('.markdown-message a').first()).toBeVisible();const refresh=page.locator('.panel-refresh');await expect(refresh).toHaveAttribute('title',locale==='en'?'Refresh the current directory and file preview':'刷新当前目录与文件预览');
 await refresh.focus();await expect(refresh).toBeFocused();await page.keyboard.press('Enter');await settle(page);await expect(refresh).toBeFocused();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);await page.screenshot({path:resolve(evidence,`files-${locale}-${width}.png`)});
});
