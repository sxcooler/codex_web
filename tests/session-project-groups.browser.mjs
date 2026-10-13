import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import viteConfig from '../vite.config.ts';
import {chromium} from 'playwright';

await mkdir('.local',{recursive:true});
const desktopRoot='C:/Users/fixture/Documents/Codex',desktop={originator:'Codex Desktop',projectId:null,gitInfo:null};
const rows=[
 {id:'known',name:'已注册项目任务',cwd:'\\\\?\\C:\\WORK\\Known'},
 {id:'root',name:'根目录无项目任务',cwd:'\\\\?\\C:\\WORK'},
 {id:'desktop',name:'Desktop 无项目任务',cwd:'\\\\?\\C:\\Users\\fixture\\Documents\\Codex\\2026-10-07\\qi',...desktop,metadata:{project_path:null}},
 {id:'missing',name:'缺少目录任务'},
 {id:'external',name:'真实未注册项目任务',cwd:'C:/external/External',projectId:null,gitInfo:null,metadata:{project_path:null}},
 {id:'git',name:'临时根下真实仓库任务',cwd:desktopRoot+'/2026-10-07/git-task',...desktop,gitInfo:{branch:'main'}},
 {id:'alias',name:'同一注册项目另一个任务',cwd:'c:/work/known/'},
 {id:'poemap',name:'poemap随机录像验证与后续工作',cwd:'\\\\?\\C:\\work\\sample-project',projectId:null,metadata:{project_path:'C:/work/sample-project'}},
 {id:'ponytail',name:'Ponytail 历史会话',cwd:'C:/work/sample-project',projectId:null},
 {id:'502',name:'codex_web 历史会话',cwd:desktopRoot+'/2026-10-11/502',projectId:'native-web',metadata:{project_path:null}},
].map((row,index)=>({...row,createdAt:100-index,updatedAt:100-index}));
const errors=[],reads=[];let refreshes=0;
const server=await createServer({...viteConfig,configFile:false,cacheDir:'.local/session-project-groups-vite',server:{...viteConfig.server,host:'127.0.0.1',port:0,strictPort:true}});
await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
  try{
   page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(()=>{if(!localStorage.getItem('codex-web:session-grouping:v2'))localStorage.setItem('codex-web:session-grouping:v2','directory');window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}};});
   await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;let data={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'fixture'};
    else if(path==='/api/project-catalog')data={state:'ready',projects:[{id:'native-web',name:'codex_web',roots:[{path:'C:/work/codex_web'}]}],workspaces:[]};
    else if(path==='/api/projects'||path==='/api/projects/refresh'){if(path.endsWith('/refresh'))refreshes++;data={projects:[{id:'known',name:'Known',path:'C:/work/Known'},{id:'ai',name:'sample-project',path:'C:/work/sample-project'},{id:'web',name:'codex_web',path:'C:/work/codex_web'}],workRoot:'C:/work',desktopProjectlessRoot:desktopRoot};}
    else if(path==='/api/sessions'){reads.push(path);data={data:rows,nextCursor:null};}
    else if(path==='/api/account/usage')data={accountId:null,updatedAt:Date.now(),rateLimits:null,resetSupported:false};
    else if(path==='/api/models')data={data:[]};
    else if(path==='/api/permission-modes')data={modes:[]};
    await route.fulfill({json:data});
   });
   await page.goto(origin);
   if(width<1001)await page.getByRole('button',{name:'展开左侧栏',exact:true}).click();
   const sidebar=page.getByRole('complementary',{name:'左侧栏'});
   await sidebar.locator('.session-link').last().waitFor();assert.equal(await sidebar.locator('.session-link').count(),10);
   assert.equal(await sidebar.getByRole('combobox',{name:'会话分组方式'}).inputValue(),'project');
   assert.deepEqual(await sidebar.getByRole('combobox',{name:'会话分组方式'}).locator('option').evaluateAll(options=>options.map(option=>option.value)),['project','flat']);
   await page.getByRole('heading',{name:'无项目',exact:true}).waitFor();
   assert.deepEqual(await sidebar.locator('.session-group h3').allTextContents(),['Known','无项目','External','git-task','sample-project','codex_web']);
   const ai=sidebar.locator('.session-group').filter({has:page.getByRole('heading',{name:'sample-project',exact:true})});assert.deepEqual(await ai.locator('.session-link').allTextContents(),['poemap随机录像验证与后续工作','Ponytail 历史会话']);assert.equal(await sidebar.getByRole('heading',{name:'502',exact:true}).count(),0);
   const none=sidebar.locator('.session-group').filter({has:page.getByRole('heading',{name:'无项目',exact:true})});
   assert.deepEqual(await none.locator('.session-link').allTextContents(),['根目录无项目任务','Desktop 无项目任务','缺少目录任务']);
   const known=sidebar.locator('.session-group').filter({has:page.getByRole('heading',{name:'Known',exact:true})});assert.equal(await known.locator('.session-link').count(),2);
   if(width<1001)await page.keyboard.press('Escape');
   await page.getByRole('button',{name:'刷新项目',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('[aria-label="刷新项目"]')?.textContent==='刷新');
   if(width<1001)await page.getByRole('button',{name:'展开左侧栏',exact:true}).click();
   assert.deepEqual(await sidebar.locator('.session-group h3').allTextContents(),['Known','无项目','External','git-task','sample-project','codex_web']);
   await none.locator(':scope > summary').click();assert.equal(await none.locator(':scope > summary').getAttribute('aria-expanded'),'false');
   await page.reload();if(width<1001)await page.getByRole('button',{name:'展开左侧栏',exact:true}).click();
   await page.getByRole('heading',{name:'无项目',exact:true}).waitFor();assert.equal(await none.locator(':scope > summary').getAttribute('aria-expanded'),'false');
   await none.locator(':scope > summary').click();assert.equal(await none.locator('.session-link').count(),3);
   await page.screenshot({path:`.local/session-project-groups-${width}.png`});
   console.log(JSON.stringify({width,headings:await sidebar.locator('.session-group h3').allTextContents(),noProjectCount:3,registeredAliases:2,refreshRootRetained:true,foldReloadRetained:true}));
  }finally{await context.close();}
 }
 assert.deepEqual(errors,[]);assert.equal(refreshes,2);console.log(JSON.stringify({result:'PASS',reads:reads.length,refreshes,errors}));
}finally{await browser?.close();await server.close();}
