import assert from 'node:assert/strict';
import test from 'node:test';
import {sessionGroups} from '../src/web/sessionGroups.ts';

const desktopRoot='C:/Users/fixture/Documents/Codex',workRoot='C:/work';
const desktop={originator:'Codex Desktop',projectId:null,gitInfo:null};
const groups=(rows:Record<string,any>[],projects:{name:string;path:string}[]=[])=>sessionGroups(rows,projects,workRoot,desktopRoot);

test('extended Windows drive and UNC aliases share project keys without changing cwd',()=>{
  const rows=[{id:'a',cwd:'\\\\?\\C:\\WORK\\One\\'},{id:'b',cwd:'c:/work/one'},{id:'c',cwd:'\\\\?\\UNC\\Host\\Share\\Project'},{id:'d',cwd:'//host/share/project/'}];
  const result=groups(rows,[{name:'One',path:'C:/work/One'},{name:'Network',path:'\\\\host\\share\\project'}]);
  assert.deepEqual(result.map(g=>[g.name,g.key,g.items.map(x=>x.id)]),[['One','c:/work/one',['a','b']],['Network','//host/share/project',['c','d']]]);
  assert.equal(rows[0].cwd,'\\\\?\\C:\\WORK\\One\\');
});

test('empty cwd, canonical WORK_ROOT and verified Desktop task directories form one no-project group',()=>{
  const result=groups([{id:'missing'},{id:'root',cwd:'\\\\?\\C:\\WORK\\'},{id:'desktop',cwd:desktopRoot+'/2026-10-07/qi',...desktop},{id:'alias',cwd:'\\\\?\\C:\\Users\\fixture\\Documents\\Codex\\2026-10-08\\new-chat',...desktop}]);
  assert.deepEqual(result.map(g=>[g.name,g.key,g.items.map(x=>x.id)]),[['无项目','',['missing','root','desktop','alias']]]);
});

test('real registered and unregistered projects retain their groups and legacy metadata fallback',()=>{
  const result=groups([{id:'registered',cwd:desktopRoot+'/2026-10-07/repo',...desktop},{id:'external',cwd:'C:/external/One',metadata:{project_path:null},projectId:null,gitInfo:null},{id:'fallback',metadata:{project_path:'C:/work/Two'}},{id:'posix',cwd:'/Case/Project'},{id:'posix-other',cwd:'/case/Project'}],[{name:'Selected',path:desktopRoot+'/2026-10-07/repo'}]);
  assert.deepEqual(result.map(g=>[g.name,g.items.map(x=>x.id)]),[['Selected',['registered']],['One',['external']],['Two',['fallback']],['Project',['posix']],['Project',['posix-other']]]);
});

test('Desktop no-project classification requires every provenance field and exact root, date and task depth',()=>{
  const valid=desktopRoot+'/2026-10-07/task';
  const candidates=[{cwd:valid,originator:'vscode',projectId:null,gitInfo:null},{cwd:valid,originator:'Codex Desktop',gitInfo:null},{cwd:valid,originator:'Codex Desktop',projectId:null},{cwd:'D:/other/Documents/Codex/2026-10-07/task',...desktop},{cwd:desktopRoot+'/2026-02-30/task',...desktop},{cwd:desktopRoot+'/2026-10-07/task/nested',...desktop},{cwd:desktopRoot+'/2026-10-07/..',...desktop}];
  for(const candidate of candidates)assert.notEqual(groups([candidate])[0].key,'',JSON.stringify(candidate));
  assert.notEqual(sessionGroups([{cwd:valid,...desktop}],[],workRoot,null)[0].key,'');
});

test('explicit native project, Git metadata or Web project evidence veto Desktop no-project inference',()=>{
  const cwd=desktopRoot+'/2026-10-07/repo';
  for(const extra of [{projectId:'native-project'},{gitInfo:{branch:'main'}},{metadata:{project_path:cwd}}])assert.notEqual(groups([{cwd,...desktop,...extra}])[0].key,'');
});

test('one project grouping keeps Web directory affiliation while native membership is missing',()=>{
 const projects=[{name:'sample-project',path:'C:/work/sample-project'},{name:'codex_web',path:'C:/work/codex_web'}];
 const rows=[{id:'poemap',projectId:null,cwd:'\\\\?\\C:\\work\\sample-project',metadata:{project_path:'C:/work/sample-project'}},{id:'ponytail',projectId:null,cwd:'C:/work/sample-project'},{id:'502',projectId:'web',cwd:desktopRoot+'/2026-10-11/502',metadata:{project_path:'C:/work/codex_web'}},{id:'none',projectId:null,cwd:workRoot}];
 const before=structuredClone(rows);
 const result=sessionGroups(rows,projects,workRoot,desktopRoot);
 assert.deepEqual(result.map(g=>[g.key,g.name,g.items.map(x=>x.id)]),[['c:/work/sample-project','sample-project',['poemap','ponytail']],['c:/work/codex_web','codex_web',['502']],['','无项目',['none']]]);
 assert.deepEqual(rows,before,'Grouping never mutates native cwd or membership');
});

test('catalog recovers a known directory affiliation after legacy metadata was cleared',()=>{
 const projects=[{name:'codex_web',path:'C:/work/codex_web'},{name:'Other',path:'C:/work/other'}];
 const catalog={state:'ready',projects:[{id:'web',name:'Official name',roots:[{path:'C:/work/codex_web'}]}]};
 const rows=[{id:'recover',projectId:'web',cwd:desktopRoot+'/2026-10-11/502',metadata:{project_path:null}},{id:'unknown',projectId:'missing',cwd:'C:/external/Other'}];
 const result=sessionGroups(rows,projects,workRoot,desktopRoot,catalog);
 assert.deepEqual(result.map(g=>[g.name,g.items.map(x=>x.id)]),[['codex_web',['recover']],['Other',['unknown']]]);
 assert.equal(sessionGroups(rows.slice(0,1),projects,workRoot,desktopRoot,{...catalog,state:'unavailable'})[0].name,'502','Unavailable native catalog is not evidence for reassignment');
});

test('native root recovery normalizes aliases and never guesses between multiple scanned directories',()=>{
 const projects=[{name:'One',path:'C:/work/one'},{name:'Two',path:'C:/work/two'}];
 const catalog={state:'ready',projects:[{id:'aliases',name:'same',roots:[{path:'C:/work/one'},{path:'\\\\?\\C:\\WORK\\ONE\\'}]},{id:'multiple',name:'same',roots:projects.map(p=>({path:p.path}))}]};
 const result=sessionGroups([{id:'recover',projectId:'aliases',cwd:'C:/external/task'},{id:'known',projectId:'multiple',cwd:'C:/work/two'},{id:'ambiguous',projectId:'multiple',cwd:'C:/external/task'}],projects,workRoot,desktopRoot,catalog);
 assert.deepEqual(result.map(g=>[g.name,g.items.map(x=>x.id)]),[['One',['recover']],['Two',['known']],['task',['ambiguous']]]);
});
