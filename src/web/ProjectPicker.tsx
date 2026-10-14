import type {UiText} from './i18n/types.ts';
import {useLocale} from './i18n/LocaleProvider.tsx';
import {useMemo} from 'react';
export type Workspace={id:string;name:string;path:string};
export type NativeProject={id:string;name:string;roots:{path:string;workspaceId:string|null;available:boolean}[]};
export type ProjectCatalog={state:string;projects:NativeProject[];workspaces:{workspaceId:string;nativeProjectId:string|null;status:string;error?:string;matches?:string[]}[];error?:string;sessionSync?:{pending:number;failed:number}};
export const emptyCatalog:ProjectCatalog={state:'loading',projects:[],workspaces:[]};
export function ProjectPicker({projects,catalog,value,workspaceId,onChange,onRetry,disabled=false}:{projects:Workspace[];catalog:ProjectCatalog;value:string;workspaceId:string;onChange:(value:string,workspaceId:string)=>void;onRetry:(id:string)=>void;disabled?:boolean}){
 const {t,text}=useLocale();
 const statusNames:Record<string,string>={syncing:t('panels.project.syncing'),failed:t('panels.project.addFailed'),removed:t('panels.project.removed'),ambiguous:t('panels.project.choose')};
 const byWorkspace=useMemo(()=>new Map(catalog.workspaces.map(row=>[row.workspaceId,row])),[catalog.workspaces]);
 const native=value.startsWith('native:')?catalog.projects.find(p=>p.id===value.slice(7)):undefined;
 const pending=value.startsWith('workspace:')?byWorkspace.get(value.slice(10)):undefined;
 const roots=native?.roots??[];
 return <div className="native-project-picker"><label>{t('panels.project.label')}<select aria-label={t('panels.project.label')} disabled={disabled} value={value} onChange={e=>{const next=e.target.value,project=catalog.projects.find(p=>'native:'+p.id===next);onChange(next,project?.roots[0]?.available?project.roots[0].workspaceId??'':next.startsWith('workspace:')?next.slice(10):'');}}><option value="">{t('panels.project.none')}</option>{value.startsWith('native:')&&!native?<option value={value} disabled>{t('panels.project.pending')}</option>:null}{catalog.projects.map(p=><option key={p.id} value={'native:'+p.id}>{p.name}</option>)}{projects.filter(p=>byWorkspace.get(p.id)?.status!=='synced').map(p=><option key={p.id} value={'workspace:'+p.id}>{p.name} · {statusNames[byWorkspace.get(p.id)?.status??'syncing']}</option>)}</select></label>
 {native?<label>{t('panels.project.directory')}<select aria-label={t('panels.project.directory')} disabled={disabled} value={workspaceId} onChange={e=>onChange(value,e.target.value)}>{roots.map((root,index)=><option key={root.path} value={root.available?root.workspaceId??'':''} disabled={!root.available}>{index===0?t('panels.project.primaryDirectory'):''}{root.path}{root.available?'':t('panels.project.directoryUnavailable')}</option>)}</select></label>:null}
 {pending?.status==='ambiguous'?<p role="status">{t('panels.project.ambiguous')}</p>:null}
 {catalog.state!=='ready'?<p role="status">{catalog.state==='loading'?t('panels.project.loading'):catalog.error?text(catalog.error):t('panels.project.failed')}</p>:null}
 <div className="catalog-status">{projects.map(p=>{const row=byWorkspace.get(p.id);return row&&row.status!=='synced'?<div key={p.id}><span title={row.error}>{p.name} · {statusNames[row.status]}</span>{['failed','removed'].includes(row.status)?<button type="button" disabled={disabled} aria-label={t('panels.project.retry',p.name)} onClick={()=>onRetry(p.id)}>{row.status==='removed'?t('panels.project.readd'):t('panels.retry')}</button>:null}</div>:null;})}</div>
 </div>;
}
