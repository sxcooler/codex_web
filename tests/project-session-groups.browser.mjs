import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
import viteConfig from '../vite.config.ts';
import {chromium} from 'playwright';

await mkdir('.local',{recursive:true});
const artifacts=await mkdtemp(join(tmpdir(),'codex-project-group-collapse-'));
const reads=[],errors=[],held=[],geometry=[];
let holdPage=false,failPage=false,vdxPath='C:/work/SampleSDK',updatedName='支持子仓库日志与原生任务标题';
const codexNames=[updatedName,'修复 JSON 返回导致服务崩溃','增加前进、后退和最近文件','调查登录状态自动退出','配置 Codex AppServer 代理','首页模型与权限设置','第七个任务','第八个任务','第九个任务'];
codexNames[8]='很长的会话名称'.repeat(12);const longProject='很长的项目名称'.repeat(10);
const rows=()=>[
 ...codexNames.map((name,index)=>({id:'code-'+(index+1),name:index===0?updatedName:name,cwd:index%2?'C:\\WORK\\codex_web\\':'C:/work/codex_web',updatedAt:100-index,metadata:{favorite:index===0}})),
 ...['检查 sdk 与 vcpkg 远程变更','调查 vcpkg 子仓库显示差异'].map((name,index)=>({id:'vdx-'+index,name,cwd:vdxPath,updatedAt:70-index})),
 ...['浮层地图','dualview','poemap-overlay-mapping 分支','架构设计','导航验证','工作区联调'].map((name,index)=>({id:'ai-'+index,name,cwd:'C:/work/sample-project',updatedAt:60-index})),
 ...Array.from({length:4},(_,index)=>({id:'none-'+index,name:'无项目任务 '+index,cwd:index%2?'C:/work':undefined,updatedAt:50-index})),
 ...Array.from({length:4},(_,index)=>({id:'external-'+index,name:'未注册任务 '+index,cwd:'C:/external/codex_web',updatedAt:40-index})),
].map(row=>({...row,createdAt:row.updatedAt}));
const pages={
 'page-1':{data:Array.from({length:3},(_,index)=>({id:'vdx-old-'+index,name:'SampleSDK 较旧任务 '+index,cwd:'C:/work/SampleSDK',updatedAt:30-index})),nextCursor:'page-2'},
 'page-2':{data:[{id:'other-page',name:'另一项目任务',cwd:'C:/other/page',updatedAt:20}],nextCursor:'page-3'},
 'page-3':{data:[...Array.from({length:3},(_,index)=>({id:'vdx-last-'+index,name:'SampleSDK 更旧任务 '+index,cwd:'C:/work/SampleSDK',updatedAt:10-index})),{id:'discovered',name:'新发现项目任务',cwd:'C:/other/discovered',updatedAt:5},{id:'long-project',name:'长项目任务',cwd:'C:/other/'+longProject,updatedAt:4}],nextCursor:null},
};
for(const page of Object.values(pages))for(const row of page.data)row.createdAt=row.updatedAt;
const json=(response,value,status=200)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
const server=await createServer({...viteConfig,configFile:false,cacheDir:'.local/project-groups-vite',server:{...viteConfig.server,host:'127.0.0.1',port:0,strictPort:true},plugins:[...viteConfig.plugins,{name:'project-group-browser-api',configureServer(vite){vite.middlewares.use((request,response,next)=>{
 const url=new URL(request.url,'http://127.0.0.1'),path=url.pathname;if(!path.startsWith('/api/'))return next();
 if(path==='/api/auth/session')return json(response,{authenticated:true,csrfToken:'test'});
 if(path==='/api/project-catalog')return json(response,{state:'ready',projects:[],workspaces:[]});
 if(path==='/api/projects')return json(response,{projects:[{id:'code',name:'codex_web',path:'C:/work/codex_web'},{id:'vdx',name:'SampleSDK',path:'C:/work/SampleSDK'},{id:'ai',name:'sample-project',path:'C:/work/sample-project'}],workRoot:'C:/work'});
 if(path==='/api/account/usage')return json(response,{accountId:null,updatedAt:Date.now(),rateLimits:null,resetSupported:false});
 if(path==='/api/models')return json(response,{data:[]});
 if(path==='/api/permission-modes')return json(response,{modes:[]});
 if(path==='/api/sessions'){
  reads.push(new URLSearchParams(url.searchParams));const cursor=url.searchParams.get('cursor'),value=cursor?pages[cursor]:{data:rows(),nextCursor:'page-1'};
  if(holdPage&&cursor){held.push(()=>json(response,failPage?{error:'项目分页暂不可用'}:value,failPage?503:200));return;}return json(response,value);
 }
 if(path==='/api/sessions/code-1')return json(response,{thread:{id:'code-1',name:updatedName,cwd:'C:/work/codex_web',turns:[]},phase:'IDLE',pending:[],epoch:'group-test',revision:0,syncCursor:'group-test:0'});
 if(path.endsWith('/status'))return json(response,{resync:false});
 return json(response,{});
});}}]});
await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({locale:'zh-CN',viewport:{width:1280,height:900}}),page=await context.newPage();
page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(()=>{
 localStorage.setItem('codex-web:session-grouping:v1','project');
 window.EventSource=class extends EventTarget{constructor(){super();window.__groupStream=this;queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}};
});
const until=async(check,message)=>{const deadline=Date.now()+8000;while(!await check()){assert.ok(Date.now()<deadline,message);await new Promise(resolve=>setTimeout(resolve,25));}};
const group=name=>page.locator('.project-session-group').filter({has:page.getByRole('heading',{name,exact:true})});
const registered=()=>group('codex_web').filter({has:page.locator('summary[title="C:/work/codex_web"]')});
const visible=group=>group.locator('.session-link:visible').count();
const more=group=>group.getByRole('button',{name:'更多',exact:true});
const less=group=>group.getByRole('button',{name:'收起',exact:true});
const sync=()=>page.evaluate(()=>window.__groupStream.dispatchEvent(new MessageEvent('sessions',{data:'{"revision":1}'})));
try{
 await server.transformRequest('/src/web/style.css');
 await page.goto(origin+'/sessions/code-1');await until(async()=>await registered().count()===1,'Registered project header must exist');
 await until(async()=>await visible(registered())===3,'Each project starts with three sessions');
 assert.equal(await visible(group('无项目')),3);assert.equal(await visible(group('SampleSDK')),2);
 const external=group('codex_web').filter({has:page.locator('summary[title="C:/external/codex_web"]')});assert.equal(await visible(external),3);
 await page.waitForTimeout(250);const readCount=reads.length;assert.equal(await less(registered()).count(),0);await more(registered()).click();assert.equal(await visible(registered()),6);await more(registered()).click();assert.equal(await visible(registered()),9);assert.equal(reads.length,readCount,'Loaded project items expand without HTTP');
 assert.equal(await less(registered()).count(),1,'Expanded rows have a collapse control');const initialMoreBox=await more(registered()).boundingBox(),initialLessBox=await less(registered()).boundingBox();assert.ok(Math.abs(initialMoreBox.y-initialLessBox.y)<2,'More and collapse share one row');await more(group('sample-project')).click();await less(registered()).focus();await page.keyboard.press('Enter');assert.equal(await visible(registered()),3);assert.equal(await visible(group('sample-project')),6,'Collapse only affects its project');assert.equal(await less(registered()).count(),0);assert.equal(reads.length,readCount,'Collapse stays local');assert.equal(await registered().locator(':scope>summary').evaluate(el=>el===document.activeElement),true,'Collapse returns keyboard focus to its project');assert.equal(await registered().locator('.session-link.selected').count(),1);assert.ok(page.url().endsWith('/sessions/code-1'));await less(group('sample-project')).click();await more(registered()).click();await more(registered()).click();assert.equal(await visible(registered()),9);assert.equal(reads.length,readCount,'Collapsed rows remain cached');
 assert.ok(await registered().locator('.session-link').last().evaluate(element=>element.scrollWidth>element.clientWidth),'Long session title is truncated within its row');
 await group('sample-project').locator(':scope>summary').focus();await page.keyboard.press('Space');assert.equal(await visible(group('sample-project')),0);await page.keyboard.press('Enter');assert.equal(await visible(group('sample-project')),3);
 holdPage=true;const beforePage=reads.length;await more(group('SampleSDK')).click();await until(()=>held.length===1,'Project more requests a single current next page');
 assert.equal(await more(group('SampleSDK')).isEnabled(),false);assert.equal(await more(registered()).isEnabled(),false);assert.equal(await page.getByRole('button',{name:'加载更多',exact:true}).isEnabled(),false);assert.equal(await less(registered()).isEnabled(),true);await less(registered()).click();assert.equal(await visible(registered()),3,'Collapse is immediate during pagination');assert.equal(held.length,1);
 holdPage=false;failPage=true;held.shift()();await until(async()=>await page.getByRole('alert').filter({hasText:'项目分页暂不可用'}).count()===1,'Pagination failure is visible');assert.equal(await visible(group('SampleSDK')),2);assert.equal(reads.length,beforePage+1);assert.equal(await visible(registered()),3,'A late page does not undo collapse');await more(registered()).click();await more(registered()).click();
 failPage=false;await more(group('SampleSDK')).click();await until(async()=>await visible(group('SampleSDK'))===5,'Retry adds at most three visible rows');assert.equal(reads.length,beforePage+2);assert.equal(reads.at(-1).get('cursor'),'page-1');
 const beforeOther=reads.length;await more(group('SampleSDK')).click();await until(async()=>reads.length===beforeOther+1&&!await page.getByRole('button',{name:'加载更多',exact:true}).isDisabled(),'Another more reads one page only');assert.equal(await visible(group('SampleSDK')),5);assert.equal(reads.at(-1).get('cursor'),'page-2');
 await page.waitForTimeout(100);assert.equal(reads.length,beforeOther+1,'No history scan for a missing project');
 await page.getByRole('button',{name:'加载更多',exact:true}).click();await until(async()=>await visible(group('SampleSDK'))===8,'Global pagination preserves project count and discovers groups');assert.equal(await visible(group('discovered')),1);
 assert.equal(await more(group('SampleSDK')).count(),0);assert.equal(await less(group('SampleSDK')).isVisible(),true,'Collapse remains after the last page');const beforeCollapse=reads.length;await less(group('SampleSDK')).click();assert.equal(await visible(group('SampleSDK')),3);await more(group('SampleSDK')).click();await more(group('SampleSDK')).click();assert.equal(await visible(group('SampleSDK')),8);assert.equal(reads.length,beforeCollapse);
 assert.ok(await group(longProject).locator(':scope>summary').evaluate(element=>element.scrollWidth>element.clientWidth),'Long project header stays on one truncated line');
 await more(group('无项目')).click();assert.equal(await visible(group('无项目')),4);await more(external).click();assert.equal(await visible(external),4);
 await group('SampleSDK').locator(':scope>summary').click();await until(async()=>await group('SampleSDK').locator(':scope>summary').getAttribute('aria-expanded')==='false','Fold updates expanded state');assert.equal(await visible(group('SampleSDK')),0);
 updatedName='数据同步后保留展开和选中状态';await sync();await until(()=>registered().locator('.session-link.selected').textContent().then(text=>text.includes(updatedName)),'Shared snapshots preserve selected row');assert.equal(await visible(registered()),9);assert.equal(await visible(group('SampleSDK')),0);
 await page.getByRole('button',{name:'刷新最近会话',exact:true}).click();await until(async()=>reads.at(-1).get('refresh')==='true'&&await visible(registered())===3,'Manual refresh resets counts');assert.equal(await visible(external),3);assert.equal(await visible(group('无项目')),3);assert.equal(await visible(group('SampleSDK')),0,'Manual refresh preserves project folds');await more(registered()).click();await more(registered()).click();
 await page.evaluate(()=>{localStorage.setItem('codex-web:session-sort:v1','created_at');window.dispatchEvent(new Event('session-sort-changed'));});await until(async()=>reads.at(-1).get('sortKey')==='created_at'&&await visible(registered())===9,'Sort reads its own cache key and renders its response');assert.equal(await visible(registered()),9);assert.equal(await visible(group('SampleSDK')),0);
 const checkbox=page.getByLabel('显示已隐藏会话');await checkbox.check();await until(async()=>reads.at(-1).get('includeHidden')==='true'&&await visible(registered())===3,'Hidden filter resets counts');assert.equal(await visible(group('SampleSDK')),0);await more(registered()).click();assert.equal(await visible(registered()),6);
 const search=page.getByRole('searchbox',{name:'搜索会话标题'});await search.fill('标题');await until(async()=>reads.at(-1).get('searchTerm')==='标题'&&await visible(registered())===3,'Search resets counts');assert.equal(await visible(group('SampleSDK')),0);await more(registered()).click();assert.equal(await visible(registered()),6);
 await page.getByRole('combobox',{name:'会话列表范围'}).selectOption('archived');await until(async()=>reads.at(-1).get('archived')==='true'&&await visible(registered())===3,'Archive filter resets counts');assert.equal(await registered().locator('.session-link.selected').count(),0);assert.equal(await registered().locator('.session-menu').count(),3);
 await page.getByRole('combobox',{name:'会话列表范围'}).selectOption('recent');await search.fill('');await until(async()=>await visible(registered())===3&&!reads.at(-1).has('searchTerm'),'Return to recent resets counts');
 await more(registered()).click();const selectedMenu=registered().locator('.session-menu').first().locator(':scope>button');await selectedMenu.click();await until(()=>registered().getByRole('button',{name:'重命名',exact:true}).isVisible(),'Row menu opens after its native toggle event');await selectedMenu.click();
 updatedName=codexNames[0];await sync();await until(async()=>await registered().locator('.session-link.selected').textContent().then(text=>text.includes(updatedName)),'Capture uses approved copy');
 await checkbox.uncheck();await until(async()=>await visible(registered())===3,'Capture uses default hidden filter');await more(registered()).click();
 await group('sample-project').locator(':scope>summary').click();
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:width===390?1044:1012});if(width===390)await page.getByRole('button',{name:'展开左侧栏',exact:true}).click();
  if(width===1280){const handle=await page.getByRole('separator',{name:'调整左侧栏宽度'}).boundingBox(),sidebar=await page.locator('.sidebar').boundingBox();await page.mouse.move(handle.x+handle.width/2,handle.y+50);await page.mouse.down();await page.mouse.move(handle.x+handle.width/2+330-sidebar.width,handle.y+50);await page.mouse.up();}
  if(width===390){await checkbox.check();await until(async()=>await visible(registered())===3,'Mobile reference starts with three');await checkbox.uncheck();await group('sample-project').locator(':scope>summary').click();}
  if(await less(registered()).count())await less(registered()).click();await more(registered()).click();assert.equal(await visible(registered()),6);const moreBox=await more(registered()).boundingBox(),lessBox=await less(registered()).boundingBox();assert.ok(Math.abs(moreBox.y-lessBox.y)<2&&moreBox.x+moreBox.width<=lessBox.x,'More and collapse share one row');assert.ok(lessBox.width>=44&&lessBox.height>=44,'Collapse target is at least 44px');await registered().screenshot({path:join(artifacts,`expanded-${width}.png`)});const beforeLess=reads.length;await less(registered()).click();assert.equal(await visible(registered()),3);assert.equal(reads.length,beforeLess);await more(registered()).click();assert.equal(await visible(registered()),6);
  await page.locator('.sidebar>.recent').evaluate(element=>element.scrollTop=0);await page.mouse.move(width-10,20);
  assert.equal(await group('SampleSDK').locator(':scope>summary').isVisible(),true,'Folded project header stays visible');
  const navBox=await page.locator('.sidebar>.recent').boundingBox();for(const target of [registered(),group('SampleSDK')]){const box=await target.locator(':scope>summary').boundingBox();assert.ok(box.y>=navBox.y&&box.y+box.height<=navBox.y+navBox.height,'Expanded and folded headers stay inside the captured scroll viewport');}
  await page.locator('.sidebar').screenshot({path:join(artifacts,`project-groups-${width}.png`)});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No viewport overflow');
  for(const header of await page.locator('.project-session-group>summary').all()){const box=await header.boundingBox();assert.ok(box.height>=44,'Project target is at least 44px');}
  const spacing=await registered().evaluate(element=>{const header=element.querySelector('summary').getBoundingClientRect(),body=element.querySelector('.project-sessions').getBoundingClientRect();return body.left-header.left;});assert.equal(spacing,18,'Project body follows an 18px guide indentation');
  geometry.push({width,values:await page.locator('.sidebar>.recent').evaluate(element=>({scrollTop:element.scrollTop,nav:element.getBoundingClientRect().toJSON(),headers:[...element.querySelectorAll('.project-session-group>summary')].map(header=>{const style=getComputedStyle(header);return {name:header.textContent,expanded:header.getAttribute('aria-expanded'),rect:header.getBoundingClientRect().toJSON(),display:style.display,visibility:style.visibility,contentVisibility:style.contentVisibility,fontSize:style.fontSize,background:style.backgroundColor};})})),indent:spacing});
 }
 vdxPath='C:\\WORK\\samplesdk\\';await page.setViewportSize({width:1280,height:900});await page.reload();await until(async()=>await registered().count()===1,'Reload restores groups');assert.equal(await visible(registered()),3,'New page defaults to three');assert.equal(await visible(group('SampleSDK')),0,'Reload preserves folded canonical project across slash/case changes');
 await page.getByRole('combobox',{name:'会话分组方式'}).selectOption('flat');await until(async()=>await page.locator('.project-session-group').count()===0,'Flat mode has no grouping disclosure');assert.equal(await page.locator('.sidebar .session-link').count(),rows().length,'Flat mode shows every loaded row');
 assert.deepEqual(errors,[]);await writeFile(join(artifacts,'geometry.json'),JSON.stringify({geometry,reads:reads.map(query=>query.toString()),errors},null,2)+'\n');console.log('PASS: project 3/+3/collapse, manual reset and passive preservation, cached rows, keyboard focus, one-page bounded more/retry, folds and 390/1280 layout; artifacts '+artifacts);
}finally{holdPage=false;for(const finish of held.splice(0))finish();await context.close();await browser.close();await server.close();}
