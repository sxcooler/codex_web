import {useLocale} from './i18n/LocaleProvider.tsx';
import {msg} from './i18n/messages.ts';
import type {UiText} from './i18n/types.ts';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {api} from './api.ts';
import {DiffView} from './GitHistory.tsx';
import {textDiff} from './textDiff.ts';
import type {DraftProps,SettingsProject} from './Settings.tsx';
type InstructionDocument={path:string;content:string;version:string;exists:boolean;writable:boolean;reason?:string;overriddenBy:string|null};
export function InstructionsSettings({projects,onDirtyChange,onLeave,actions,onReturn}:DraftProps&{projects:SettingsProject[];onReturn:(saved:boolean)=>void}){
 const {t,text}=useLocale();
 const [scope,setScope]=useState<'user'|'project'>('user'),[project,setProject]=useState(''),[document,setDocument]=useState<InstructionDocument|null>(null),[content,setContent]=useState(''),[error,setError]=useState<UiText>(''),[notice,setNotice]=useState<UiText>(''),[busy,setBusy]=useState(false),[blocked,setBlocked]=useState<'conflict'|'unknown'|null>(null);
 const errorBox=useRef<HTMLDivElement>(null),saving=useRef(false),dirty=!!document&&content!==document.content;
 const mounted=useRef(false),returnAction=useRef(onReturn);returnAction.current=onReturn;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useLayoutEffect(()=>{onDirtyChange(dirty);return()=>onDirtyChange(false);},[dirty,onDirtyChange]);
 useEffect(()=>{if(error)errorBox.current?.focus();},[error]);
 const target={scope,...(scope==='project'?{projectId:project}:{})};
 const read=async(preserve=false,signal?:AbortSignal)=>{if(scope==='project'&&!project)return;setBusy(true);setError('');try{const next:InstructionDocument=await api('/codex/instructions?'+new URLSearchParams(target),undefined,signal);if(signal?.aborted)return;setDocument(next);if(!preserve)setContent(next.content);setBlocked(null);if(preserve)setNotice(msg("settings.instructions.rereadNotice"));}catch(e:any){if(!signal?.aborted)setError(e);}finally{if(!signal?.aborted)setBusy(false);}};
 useEffect(()=>{setDocument(null);setContent('');setNotice('');setBlocked(null);const controller=new AbortController();void read(false,controller.signal);return()=>controller.abort();},[scope,project]);
 const comparison=useMemo(()=>document&&content!==document.content?textDiff(document.content,content):null,[document,content]);
 const tooLarge=new TextEncoder().encode(content).length>262144;
 const save=async()=>{if(!document?.writable||!dirty||busy||blocked||tooLarge||saving.current)return false;saving.current=true;setBusy(true);setError('');setNotice('');try{const next=await api('/codex/instructions',{...target,expectedVersion:document.version,content});setDocument(next);setContent(next.content);setNotice(msg("settings.instructions.saved"));return true;}catch(e:any){setError(e);if(e.status===409)setBlocked('conflict');else if(e.status===504||!e.status)setBlocked('unknown');return false;}finally{saving.current=false;setBusy(false);}};
 actions.current={save,isSaving:()=>saving.current,discard:()=>{setContent(document?.content??'');onDirtyChange(false);}};
 const saveAndReturn=async()=>{if(await save()&&mounted.current)returnAction.current(true);};
 return <div className="settings-editor"><p className="muted small">{t("settings.instructions.help")}</p>
  <div className="settings-context"><label htmlFor="instructions-scope">{t("settings.instructions.scope")}</label><select id="instructions-scope" aria-label={t("settings.instructions.scope")} value={scope} disabled={busy} onChange={event=>{const value=event.target.value as typeof scope;onLeave(()=>setScope(value));}}><option value="user">{t("settings.instructions.user")}</option><option value="project">{t("settings.instructions.project")}</option></select></div>
  {scope==='project'?<label>{t("settings.instructions.projectLabel")}<select aria-label={t("settings.instructions.projectLabel")} value={project} disabled={busy} onChange={event=>{const value=event.target.value;onLeave(()=>setProject(value));}}><option value="">{t("settings.instructions.chooseProject")}</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>:null}
  {error?<div ref={errorBox} tabIndex={-1} role="alert" className="notice error">{text(error)}</div>:null}{notice?<p role="status" className="notice">{text(notice)}</p>:null}
  <button disabled={busy||(scope==='project'&&!project)} onClick={()=>void read(dirty)}>{blocked==='unknown'?t("settings.verifyRead"):blocked==='conflict'?t("settings.compareRead"):busy?t("settings.loading"):t("settings.instructions.reread")}</button>
  {document?<><details className="settings-details settings-config-details"><summary>{t("settings.instructions.details")}</summary><p className="path">{document.path}</p></details>{!document.exists?<p className="notice">{t("settings.instructions.notCreated")}</p>:null}{document.overriddenBy?<p className="notice">{t('settings.instructions.overridden',document.overriddenBy)}</p>:null}{!document.writable?<p className="notice">{document.reason??t("settings.instructions.readonly")}</p>:null}
   <form id="instructions-form" onSubmit={event=>{event.preventDefault();void saveAndReturn();}}><div className="settings-card settings-instruction-editor"><label>{t("settings.instructions.raw")}<textarea aria-label={t("settings.instructions.raw")} rows={12} disabled={busy||!document.writable} value={content} onChange={event=>{setContent(event.target.value);setNotice('');}}/></label></div>
    {comparison?<section className="instructions-comparison" aria-label={t("settings.instructions.comparison")}><div className="instructions-diff-heading"><h3>{t("settings.instructions.compare")}</h3><span>{t("settings.instructions.originalNew")}</span></div><div className="instructions-diff"><DiffView content={comparison} split/></div>{comparison.simplified?<p className="muted small">{t("settings.instructions.simplified")}</p>:null}{comparison.truncated?<p className="notice">{t("settings.instructions.truncated")}</p>:null}</section>:null}
    {tooLarge?<p role="alert" className="notice error">{t("settings.instructions.tooLarge")}</p>:null}
   </form><p className="muted small">{t("settings.instructions.encodingHelp")}</p></>:busy?<p role="status">{t("settings.instructions.loading")}</p>:null}
  <div className="settings-save settings-instruction-actions"><span>{dirty?t("settings.instructions.modified"):document?.writable?t("settings.unchanged"):document?t("settings.instructions.viewOnly"):''}</span><div className="actions"><button type="button" disabled={saving.current} onClick={()=>onReturn(false)}>{t("settings.instructions.cancelReturn")}</button>{document?.writable?<button type="submit" form="instructions-form" className="primary" disabled={busy||!dirty||!!blocked||tooLarge} aria-busy={saving.current}>{saving.current?t("settings.saving"):t("settings.instructions.saveReturn")}</button>:null}</div></div>
 </div>;
}
