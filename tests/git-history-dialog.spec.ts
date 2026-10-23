import {test,expect,type Page} from '@playwright/test';

const commits=Array.from({length:24},(_,i)=>({id:'c'+i,parents:i?['p1']:['p1','p2'],subject:'Demo navigation change '+i,author:'Demo Developer',date:'2026-10-20T08:00:00Z',refs:[]}));
const defaultFiles=Array.from({length:16},(_,i)=>({path:i?'src/feature-'+i+'.ts':'src/first.ts',added:2,deleted:1,status:'modified'}));
const diff=(path:string)=>({hunks:[{oldStart:1,newStart:1,oldLines:0,newLines:100,lines:Array.from({length:100},(_,i)=>({kind:'add',newLine:i+1,text:path+' demo line '+i}))}]});
async function setup(page:Page,options:{files?:any[];saved?:boolean;locale?:string;handler?:(route:any,url:URL)=>Promise<boolean>}={}){
 const reads:string[]=[],writes:string[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(({saved,locale})=>{localStorage.clear();localStorage.setItem('codex-web:locale:v1',locale);if(saved)localStorage.setItem('codex.project-panel.dialog-demo',JSON.stringify({tab:'history',history:{commit:'c0',parent:'p1',path:'src/first.ts',scroll:160}}));},{saved:!!options.saved,locale:options.locale??'zh-CN'});
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());reads.push(url.pathname+url.search);if(route.request().method()!=='GET')writes.push(url.pathname);
  if(await options.handler?.(route,url))return;
  const data=url.pathname.endsWith('/git/repositories')?{repositories:[{path:'',kind:'main',available:true},{path:'vendor/ui',kind:'nested',available:true}],complete:false}
   :url.pathname.endsWith('/git/log')?{repository:true,commits,branches:[{ref:'refs/heads/main',name:'main'}],nextCursor:null}
   :url.pathname.endsWith('/git/commit')?{commit:{...commits[0],message:'Demo commit'},parent:url.searchParams.get('parent')??'p1',files:options.files??defaultFiles}
   :url.pathname.endsWith('/git/commit/diff')?diff(url.searchParams.get('path')!):{};
  await route.fulfill({json:data});
 });
 await page.goto('/tests/git-history-dialog.html');await expect(page).toHaveTitle('Git history dialog QA');await expect(page.locator('.git-commit')).toHaveCount(24);
 return {reads,writes,errors};
}
async function openFirst(page:Page){await page.locator('.git-commit').first().click();const file=page.locator('.commit-files-section .file-list button').first();await expect(file).toBeVisible();await file.click();return file;}
const modal=(page:Page)=>page.locator('.preview-shell:modal');

for(const width of [390,1440])test(`layout fills unselected space at every viewport ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});await setup(page);
 const history=page.locator('.git-history'),available=await history.evaluate(n=>n.clientHeight);
 expect(await history.locator(':scope > .panel-list-section').evaluate(n=>n.clientHeight)).toBeGreaterThanOrEqual(available*.95);
 await page.locator('.git-commit').first().click();await expect(page.locator('.commit-files-section .file-list button')).toHaveCount(16);
 const first=await history.locator(':scope > .panel-list-section').evaluate(n=>n.clientHeight),second=await page.locator('.commit-files-section').evaluate(n=>n.clientHeight);
 expect(first/second).toBeGreaterThan(1.4);expect(first/second).toBeLessThan(1.6);await expect(page.locator('.preview-shell:visible')).toHaveCount(0);
});
test('file opens directly in one dialog and closes to its trigger',async({page})=>{
 await setup(page);const trigger=await openFirst(page);await expect(modal(page)).toHaveCount(1);await expect(modal(page).locator('.diff-line').first()).toContainText('src/first.ts');
 const close=modal(page).getByRole('button',{name:'关闭预览',exact:true});await expect(close).toBeFocused();await page.keyboard.press('Escape');await expect(modal(page)).toHaveCount(0);await expect(trigger).toBeFocused();await expect(page.locator('.preview-shell:visible')).toHaveCount(0);
});
test('same file reopens from cache without rebuilding content',async({page})=>{
 const {reads,writes,errors}=await setup(page);const trigger=await openFirst(page);await expect(modal(page).locator('.diff-line').first()).toBeVisible();
 const area=modal(page).locator('.preview-content');await area.evaluate(node=>{(window as any).previewNode=node.firstElementChild;node.scrollTop=160;});const before=reads.length;
 await page.keyboard.press('Escape');await expect(modal(page)).toHaveCount(0);await trigger.click();await expect(modal(page)).toHaveCount(1);
 await expect(area).toHaveJSProperty('scrollTop',160);expect(await area.evaluate(node=>node.firstElementChild===(window as any).previewNode)).toBe(true);expect(reads.length).toBe(before);expect(writes).toEqual([]);expect(errors).toEqual([]);
});

test('adjacent files keep one modal and enforce boundaries',async({page})=>{
 await setup(page,{files:defaultFiles.slice(0,3)});await openFirst(page);const shell=modal(page),previous=shell.getByRole('button',{name:'上一文件',exact:true}),next=shell.getByRole('button',{name:'下一文件',exact:true});
 await expect(previous).toBeDisabled();await expect(next).toBeEnabled();await expect(shell.getByRole('status').filter({hasText:'第 1 / 3 个文件'})).toBeVisible();
 await shell.locator('.preview-content').evaluate(node=>node.scrollTop=150);await next.click();await expect(shell.locator('.diff-line').first()).toContainText('src/feature-1.ts');await expect(shell.locator('.preview-content')).toHaveJSProperty('scrollTop',0);
 await next.click();await expect(shell.locator('.diff-line').first()).toContainText('src/feature-2.ts');await expect(next).toBeDisabled();await expect(previous).toBeFocused();await expect(shell).toHaveCount(1);
 await previous.press('Enter');await expect(shell.locator('.diff-line').first()).toContainText('src/feature-1.ts');await previous.click();await expect(previous).toBeDisabled();await expect(next).toBeFocused();
});
test('one file disables both navigation buttons',async({page})=>{
 await setup(page,{files:defaultFiles.slice(0,1)});await openFirst(page);await expect(modal(page).getByRole('button',{name:'上一文件',exact:true})).toBeDisabled();await expect(modal(page).getByRole('button',{name:'下一文件',exact:true})).toBeDisabled();
});
test('an empty commit cannot open preview',async({page})=>{
 await setup(page,{files:[]});await page.locator('.git-commit').first().click();await expect(page.locator('.commit-files-section')).toContainText('没有可显示的文件变更');await expect(page.locator('.commit-files-section .file-list button')).toHaveCount(0);await expect(modal(page)).toHaveCount(0);
});
test('saved selection stays closed until an explicit click',async({page})=>{
 const {reads}=await setup(page,{saved:true});const file=page.locator('.commit-files-section .file-list button').first();await expect(file).toHaveClass('active');await expect(modal(page)).toHaveCount(0);expect(reads.filter(path=>path.includes('/git/commit/diff'))).toHaveLength(0);
 await file.click();await expect(modal(page).locator('.diff-line').first()).toBeVisible();await expect(modal(page).locator('.preview-content')).toHaveJSProperty('scrollTop',160);
});
for(const [name,patch,context] of [
 ['session',{id:'second-session'},true],['project',{project:'second-project'},true],['hidden',{visible:false},true],
 ['repository',{repository:'vendor/ui'},false],['ref',{ref:'refs/heads/main'},false],['commit',{commit:'c1'},false],['parent',{parent:'p2'},false],
] as const)test(`a changed ${name} context closes the dialog without reopening`,async({page})=>{
 await setup(page);await openFirst(page);await expect(modal(page)).toHaveCount(1);
 await page.evaluate(({patch,context})=>(window as any).historyFixture[context?'context':'update'](patch),{patch,context});await expect(modal(page)).toHaveCount(0);
 if(name==='hidden'){await page.evaluate(()=>(window as any).historyFixture.context({visible:true}));await expect(modal(page)).toHaveCount(0);}
});
test('late response cannot reopen a closed dialog and reopening retries an unfinished read',async({page})=>{
 let release:()=>void=()=>{};let first=true;const held=new Promise<void>(resolve=>release=resolve);
 const {reads}=await setup(page,{handler:async(route,url)=>{if(url.pathname.endsWith('/git/commit/diff')&&first){first=false;await held;await route.fulfill({json:diff('late first')}).catch(()=>{});return true;}return false;}});
 const file=await openFirst(page);await expect.poll(()=>reads.filter(path=>path.includes('/git/commit/diff')).length).toBe(1);await page.keyboard.press('Escape');await expect(modal(page)).toHaveCount(0);release();
 await file.click();await expect(modal(page).locator('.diff-line').first()).toContainText('src/first.ts');expect(reads.filter(path=>path.includes('/git/commit/diff'))).toHaveLength(2);
});
test('late A cannot contaminate a failed B and a later A can be read again',async({page})=>{
 let release:()=>void=()=>{};let first=true;const held=new Promise<void>(resolve=>release=resolve);
 const {reads}=await setup(page,{files:defaultFiles.slice(0,2),handler:async(route,url)=>{
  if(!url.pathname.endsWith('/git/commit/diff'))return false;
  if(url.searchParams.get('path')==='src/first.ts'&&first){first=false;await held;await route.fulfill({json:diff('stale A')}).catch(()=>{});return true;}
  if(url.searchParams.get('path')==='src/feature-1.ts'){await route.fulfill({status:503,json:{error:'Demo B unavailable'}});return true;}return false;
 }});
 await openFirst(page);await expect.poll(()=>reads.filter(path=>path.includes('/git/commit/diff')).length).toBe(1);await modal(page).getByRole('button',{name:'下一文件',exact:true}).click();await expect(modal(page).getByRole('alert')).toContainText('Demo B unavailable');release();await expect(modal(page).locator('.diff-line')).toHaveCount(0);
 await modal(page).getByRole('button',{name:'上一文件',exact:true}).click();await expect(modal(page).locator('.diff-line').first()).toContainText('src/first.ts');
});
test('refresh keeps only same-resource content and handles a removed file',async({page})=>{
 let fail=false,removed=false;
 await setup(page,{handler:async(route,url)=>{
  if(removed&&url.pathname.endsWith('/git/commit')){await route.fulfill({json:{commit:commits[0],files:defaultFiles.slice(1)}});return true;}
  if(fail&&url.pathname.endsWith('/git/commit/diff')){await route.fulfill({status:503,json:{error:'Demo refresh failed'}});return true;}return false;
 }});
 await openFirst(page);await expect(modal(page).locator('.diff-line').first()).toContainText('src/first.ts');fail=true;await page.evaluate(()=>(window as any).historyFixture.refresh());await expect(modal(page).getByRole('alert')).toContainText('Demo refresh failed');await expect(modal(page).locator('.diff-line').first()).toContainText('src/first.ts');
 removed=true;await page.evaluate(()=>(window as any).historyFixture.refresh());await expect(modal(page)).toContainText('文件已不可用');await expect(modal(page).locator('.diff-line')).toHaveCount(0);await expect(modal(page).getByRole('button',{name:'下一文件',exact:true})).toBeDisabled();await modal(page).getByRole('button',{name:'关闭预览',exact:true}).click();await expect(modal(page)).toHaveCount(0);
});
test('locale and scroll changes preserve content and completed reads',async({page})=>{
 const {reads}=await setup(page);await openFirst(page);await expect(modal(page).locator('.diff-line').first()).toBeVisible();const before=reads.length;
 await modal(page).locator('.preview-content').evaluate(node=>{(window as any).contentNode=node.firstElementChild;node.scrollTop=120;});
 await page.evaluate(()=>{localStorage.setItem('codex-web:locale:v1','en');window.dispatchEvent(new Event('locale-changed'));});await expect(modal(page).getByRole('button',{name:'Close preview',exact:true})).toBeVisible();await expect(modal(page)).toContainText('File 1 of 16');
 await expect(modal(page).locator('.preview-content')).toHaveJSProperty('scrollTop',120);expect(await modal(page).locator('.preview-content').evaluate(node=>node.firstElementChild===(window as any).contentNode)).toBe(true);expect(reads.length).toBe(before);
 const renders=await page.evaluate(()=>(window as any).historyRenders);await modal(page).locator('.preview-content').evaluate(node=>{node.scrollTop=200;node.dispatchEvent(new Event('scroll'));});expect(await page.evaluate(()=>(window as any).historyRenders)).toBe(renders);
});
test('mixed image binary rename empty and truncated differences share navigation',async({page})=>{
 const files=[{path:'image.png',binary:true},{path:'blob.bin',binary:true},{path:'new.ts',oldPath:'old.ts'},{path:'large.ts'}];
 await setup(page,{files,handler:async(route,url)=>{
  if(url.pathname.endsWith('/files/image')){await route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR5nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=','base64')});return true;}
  if(!url.pathname.endsWith('/git/commit/diff'))return false;const path=url.searchParams.get('path');await route.fulfill({json:path==='image.png'?{images:{before:null,after:{path,revision:'c0'}}}:path==='blob.bin'?{binary:true}:path==='new.ts'?{hunks:[]}:{...diff(path!),truncated:true}});return true;
 }});
 await openFirst(page);await expect(modal(page).locator('img')).toHaveCount(1);await expect(modal(page).locator('img')).toHaveJSProperty('naturalWidth',1);
 const next=modal(page).getByRole('button',{name:'下一文件',exact:true});await next.click();await expect(modal(page)).toContainText('二进制');await next.click();await expect(modal(page)).toContainText('没有文本差异');await next.click();await expect(modal(page)).toContainText('已截断');await expect(next).toBeDisabled();await expect(modal(page)).toHaveCount(1);
});

for(const [width,locale] of [[390,'en'],[1280,'zh-CN']] as const)test(`keyboard focus and 200 percent zoom keep dialog controls visible ${width} ${locale}`,async({page},info)=>{
 await page.setViewportSize({width,height:900});const {errors,writes}=await setup(page,{locale});const trigger=await openFirst(page),shell=modal(page),close=shell.locator('.preview-close');await expect(close).toBeFocused();
 await page.keyboard.press('Tab');await expect(shell.getByRole('button',{name:locale==='en'?'Next file':'下一文件',exact:true})).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(close).toBeFocused();
 await page.keyboard.press('Shift+Tab');await expect(shell.locator('.preview-copy')).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(shell.locator('.preview-content')).toBeFocused();await page.keyboard.press('Tab');await expect(shell.locator('.preview-copy')).toBeFocused();
 await page.screenshot({path:info.outputPath('dialog-keyboard.png')});
 await page.locator('#root').evaluate(node=>node.style.zoom='2');
 for(const button of [close,shell.getByRole('button',{name:locale==='en'?'Next file':'下一文件',exact:true})]){const rect=await button.boundingBox();expect(rect!.x).toBeGreaterThanOrEqual(0);expect(rect!.y).toBeGreaterThanOrEqual(0);expect(rect!.x+rect!.width).toBeLessThanOrEqual(width+1);expect(rect!.y+rect!.height).toBeLessThanOrEqual(901);}
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('dialog-zoom.png')});
 await shell.evaluate(node=>{const popover=document.createElement('div');popover.popover='auto';popover.textContent='Demo inner details';node.append(popover);popover.showPopover();});await page.keyboard.press('Escape');await expect(page.locator(':popover-open')).toHaveCount(0);await expect(shell).toHaveCount(1);await page.keyboard.press('Escape');await expect(shell).toHaveCount(0);await expect(trigger).toBeFocused();await page.keyboard.press('Enter');await expect(shell).toHaveCount(1);await expect(close).toBeFocused();await page.keyboard.press('Escape');await expect(shell).toHaveCount(0);expect(errors).toEqual([]);expect(writes).toEqual([]);
});
