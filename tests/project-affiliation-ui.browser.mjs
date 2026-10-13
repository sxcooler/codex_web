import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import viteConfig from '../vite.config.ts';

const artifacts=await mkdtemp(join(tmpdir(),'codex-project-menu-')),calls=[],errors=[];
const projects=[{id:'one',name:'codex_web',path:'C:/work/codex_web'},{id:'two',name:'sample-project',path:'C:/work/sample-project'}];
const catalog={state:'ready',projects:projects.map(p=>({id:'native-'+p.id,name:p.name,roots:[{path:p.path,workspaceId:p.id,available:true}]})),workspaces:projects.map(p=>({workspaceId:p.id,nativeProjectId:'native-'+p.id,status:'synced'}))};
const rows=Array.from({length:18},(_,i)=>({id:'thread-'+i,name:'会话 '+i,cwd:projects[i<9?0:1].path,projectId:i===0?null:'native-'+(i<9?'one':'two'),createdAt:100-i,updatedAt:100-i}));
const server=await createServer({...viteConfig,configFile:false,server:{...viteConfig.server,host:'127.0.0.1',port:0,strictPort:true}});await server.listen();
const origin=`http://127.0.0.1:${server.httpServer.address().port}`,browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:780}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();window.__stream=this;queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}};});
   await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname,method=route.request().method();calls.push({path,method});let data={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/project-catalog')data=catalog;
    else if(path==='/api/projects')data={projects,workRoot:'C:/work'};
    else if(path==='/api/sessions')data={data:rows,nextCursor:null};
    else if(path.endsWith('/name')){rows.find(r=>path.includes('/'+r.id+'/')).name=route.request().postDataJSON().name;}
    else if(path==='/api/sessions/thread-0')data={thread:{...rows[0],turns:[]},metadata:{project_path:projects[0].path},project:projects[0],phase:'IDLE',pending:[],epoch:'test',revision:0,syncCursor:'test:0'};
    else if(path.endsWith('/status'))data={resync:false};
    else if(path==='/api/models')data={data:[]};
    else if(path==='/api/permission-modes')data={modes:[]};
    await route.fulfill({json:data});
   });
   await page.goto(origin+'/sessions/thread-0');await page.locator('.session-title').waitFor();
   if(width<1001)await page.getByRole('button',{name:'展开左侧栏',exact:true}).click();
   const sidebar=page.locator('.sidebar');await sidebar.getByLabel(/^会话菜单/).first().click();
   assert.equal(await sidebar.getByLabel(/^移入项目/).count(),0,'Manual assignment picker removed');assert.equal(await sidebar.getByRole('button',{name:/移入项目|移出项目/}).count(),0,'Manual assignment buttons removed');
   const menu=sidebar.locator('.session-menu>div:visible');await menu.waitFor();
   assert.deepEqual(await menu.getByRole('button').allTextContents(),['重命名','收藏','从 Web 隐藏','清除 Web 元数据','归档会话']);
   assert.ok(await menu.evaluate(el=>{const r=el.getBoundingClientRect();return [0.25,0.75].every(k=>el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height*k)));}),'No underlying row menus cover the popup');
   await menu.screenshot({path:join(artifacts,`menu-${width}.png`)});await page.keyboard.press('Escape');assert.equal(await menu.count(),0,'Escape closes popup');assert.equal(await sidebar.isVisible(),true,'Escape keeps the mobile sidebar open');
   const more=sidebar.getByRole('button',{name:'更多',exact:true});for(let i=0;i<2&&await more.count();i++)await more.last().click();
   const last=sidebar.getByLabel(/^会话菜单/).last();await last.scrollIntoViewIfNeeded();await last.click();await menu.waitFor();
   assert.ok(await menu.evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=8&&r.bottom<=innerHeight-8;}),'Bottom row popup is fully inside viewport');
   assert.equal(await menu.getByRole('button',{name:'归档会话',exact:true}).isVisible(),true);await page.screenshot({path:join(artifacts,`bottom-${width}.png`)});
   await page.keyboard.press('Escape');await sidebar.getByLabel(/^会话菜单/).first().click();
   page.once('dialog',dialog=>dialog.accept('菜单交互测试'));await menu.getByRole('button',{name:'重命名',exact:true}).click();await sidebar.getByLabel('会话菜单 菜单交互测试',{exact:true}).waitFor();
   if(width<1001)await page.keyboard.press('Escape');
   await page.getByRole('button',{name:'操作',exact:true}).click();assert.equal(await page.getByLabel('移入项目',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:/移入项目|移出项目/}).count(),0);
   assert.equal(await page.getByText('项目：codex_web',{exact:true}).count(),1,'Header retains Web affiliation while native ID is pending');
   await page.keyboard.press('Escape');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No viewport overflow');
   console.log(JSON.stringify({width,manualProjectControls:0,popupLayer:true,bottomPopupVisible:true,rename:true,webProjectHeader:true}));
  }finally{await context.close();}
 }
 assert.deepEqual(errors,[]);assert.equal(calls.filter(c=>c.method==='POST'&&c.path.endsWith('/project')).length,0);assert.equal(calls.filter(c=>c.method==='POST'&&c.path==='/api/sessions').length,0);console.log('PASS: desktop/mobile menus, native popover geometry, Escape, rename, unified header; artifacts '+artifacts);
}finally{await browser.close();await server.close();}
