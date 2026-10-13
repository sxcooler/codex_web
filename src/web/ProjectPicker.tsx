import {useMemo} from 'react';
export type Workspace={id:string;name:string;path:string};
export type NativeProject={id:string;name:string;roots:{path:string;workspaceId:string|null;available:boolean}[]};
export type ProjectCatalog={state:string;projects:NativeProject[];workspaces:{workspaceId:string;nativeProjectId:string|null;status:string;error?:string;matches?:string[]}[];error?:string;sessionSync?:{pending:number;failed:number}};
export const emptyCatalog:ProjectCatalog={state:'loading',projects:[],workspaces:[]};
const statusNames:Record<string,string>={syncing:'同步中',failed:'添加失败',removed:'已从官方移除',ambiguous:'请选择项目'};
export function ProjectPicker({projects,catalog,value,workspaceId,onChange,onRetry,disabled=false}:{projects:Workspace[];catalog:ProjectCatalog;value:string;workspaceId:string;onChange:(value:string,workspaceId:string)=>void;onRetry:(id:string)=>void;disabled?:boolean}){
 const byWorkspace=useMemo(()=>new Map(catalog.workspaces.map(row=>[row.workspaceId,row])),[catalog.workspaces]);
 const native=value.startsWith('native:')?catalog.projects.find(p=>p.id===value.slice(7)):undefined;
 const pending=value.startsWith('workspace:')?byWorkspace.get(value.slice(10)):undefined;
 const roots=native?.roots??[];
 return <div className="native-project-picker"><label>项目<select aria-label="项目" disabled={disabled} value={value} onChange={e=>{const next=e.target.value,project=catalog.projects.find(p=>'native:'+p.id===next);onChange(next,project?.roots[0]?.available?project.roots[0].workspaceId??'':next.startsWith('workspace:')?next.slice(10):'');}}><option value="">无项目</option>{value.startsWith('native:')&&!native?<option value={value} disabled>项目待确认</option>:null}{catalog.projects.map(p=><option key={p.id} value={'native:'+p.id}>{p.name}</option>)}{projects.filter(p=>byWorkspace.get(p.id)?.status!=='synced').map(p=><option key={p.id} value={'workspace:'+p.id}>{p.name} · {statusNames[byWorkspace.get(p.id)?.status??'syncing']}</option>)}</select></label>
 {native?<label>工作目录<select aria-label="工作目录" disabled={disabled} value={workspaceId} onChange={e=>onChange(value,e.target.value)}>{roots.map((root,index)=><option key={root.path} value={root.available?root.workspaceId??'':''} disabled={!root.available}>{index===0?'主目录：':''}{root.path}{root.available?'':'（工作目录未开放）'}</option>)}</select></label>:null}
 {pending?.status==='ambiguous'?<p role="status">同一路径关联多个项目，请在项目列表明确选择。</p>:null}
 {catalog.state!=='ready'?<p role="status">{catalog.state==='loading'?'原生项目目录同步中':catalog.error??'原生项目目录读取失败，归属待确认。'}</p>:null}
 <div className="catalog-status">{projects.map(p=>{const row=byWorkspace.get(p.id);return row&&row.status!=='synced'?<div key={p.id}><span title={row.error}>{p.name} · {statusNames[row.status]}</span>{['failed','removed'].includes(row.status)?<button type="button" disabled={disabled} aria-label={'重试添加 '+p.name} onClick={()=>onRetry(p.id)}>{row.status==='removed'?'重新添加':'重试'}</button>:null}</div>:null;})}</div>
 </div>;
}
