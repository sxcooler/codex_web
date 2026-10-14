import {useLocale} from './i18n/LocaleProvider.tsx';
import {msg} from './i18n/messages.ts';
import type {UiText} from './i18n/types.ts';
import {useCallback,useEffect,useLayoutEffect,useRef,useState,type MutableRefObject} from 'react';
import {usePanes} from './PaneLayout.tsx';
import {AccountUsagePanel} from './AccountUsage.tsx';
import {navigate,setNavigationGuard} from './navigation.ts';
import {ConfigSettings} from './ConfigSettings.tsx';
import {InstructionsSettings} from './InstructionsSettings.tsx';
import {InstalledPlugins} from './InstalledPlugins.tsx';
import {readSendShortcut,writeSendShortcut,type SendShortcut} from './preferences.ts';
import {WebSettings} from './WebSettings.tsx';

export type SettingsProject={id:string;name:string;path:string};
export type DraftActions={save:()=>Promise<boolean>;discard:()=>void;isSaving?:()=>boolean};
export type DraftProps={onDirtyChange:(dirty:boolean)=>void;onLeave:(proceed:()=>void)=>void;actions:MutableRefObject<DraftActions|null>};

export function Settings({onChanged,projects,route}:{onChanged:()=>void;projects:SettingsProject[];route:string}){
 const {t,text}=useLocale();
 const sections=[['general',t("settings.general")],['configuration',t("settings.configuration")],['personalization',t("settings.personalization")],['usage',t("settings.usage")],['plugins',t("settings.plugins.title")],['web','Codex Web']] as const;
  const panes=usePanes(),requested=new URLSearchParams(route.split('?')[1]??'').get('section');
  const [section,label]=sections.find(([id])=>id===requested)??sections[0];
  const instructions=section==='personalization'&&new URLSearchParams(route.split('?')[1]??'').get('view')==='instructions',scroll=useRef<HTMLDivElement>(null);
  useEffect(()=>{scroll.current?.scrollTo(0,0);},[section,instructions]);
  const [dirty,setDirty]=useState(false),[pending,setPending]=useState<(()=>void)|null>(null),[saving,setSaving]=useState(false),[instructionNotice,setInstructionNotice]=useState<UiText>('');
  const previousInstructions=useRef(instructions);
  useEffect(()=>{if(previousInstructions.current&&!instructions&&section==='personalization')document.querySelector<HTMLElement>('.settings-entry')?.focus({preventScroll:true});if(instructions||section!=='personalization')setInstructionNotice('');previousInstructions.current=instructions;},[instructions,section]);
  const dirtyRef=useRef(false),actions=useRef<DraftActions|null>(null),leaveDialog=useRef<HTMLDialogElement>(null),cancelLeave=useRef<HTMLButtonElement>(null),leaveOpener=useRef<HTMLElement|null>(null),leaveFailed=useRef(false);
  const onDirtyChange=useCallback((value:boolean)=>{dirtyRef.current=value;setDirty(value);},[]);
  const onLeave=useCallback((proceed:()=>void)=>{if(!dirtyRef.current){proceed();return;}leaveOpener.current=document.activeElement as HTMLElement;setPending(()=>proceed);},[]);
  useLayoutEffect(()=>dirty?setNavigationGuard(onLeave):undefined,[dirty,onLeave]);
  useEffect(()=>{if(!dirty)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  useEffect(()=>{if(pending){if(!leaveDialog.current?.open)leaveDialog.current?.showModal();cancelLeave.current?.focus();}else if(leaveDialog.current?.open){leaveDialog.current.close();if(leaveFailed.current)document.querySelector<HTMLElement>('.settings-section [role=alert][tabindex]')?.focus();else leaveOpener.current?.focus();leaveFailed.current=false;}},[pending]);
  const leave=async(save:boolean)=>{if(saving||!pending)return;setSaving(true);try{if(save&&(!actions.current||!await actions.current.save())){leaveFailed.current=true;setPending(null);return;}if(!save)actions.current?.discard();dirtyRef.current=false;setDirty(false);setPending(null);pending();}finally{setSaving(false);}};
  const draftProps={onDirtyChange,onLeave,actions};
  const returnFromInstructions=(saved:boolean)=>{onDirtyChange(false);setPending(null);setInstructionNotice(saved?msg("settings.instructions.saved"):'');if(saved&&pending)pending();else navigate('/settings?section=personalization');};
  return <main className="settings" inert={panes.mobile&&panes.drawer!==null}>
    <header className="settings-header"><h1>{t("settings.title")}</h1><label className="settings-mobile-navigation">{t("settings.categories")}<select aria-label={t("settings.categories")} value={section} onChange={event=>navigate('/settings?section='+event.target.value)}>{sections.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label></header>
    <div className="settings-layout"><nav className="settings-navigation" aria-label={t("settings.categories")}><p className="settings-nav-group">Codex</p>{sections.map(([id,name])=><div key={id}>{id==='web'?<p className="settings-nav-group">Codex Web</p>:null}<a href={'/settings?section='+id} aria-current={section===id?'page':undefined} onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate('/settings?section='+id);}}>{name}</a></div>)}</nav>
      <section className="settings-section" aria-labelledby="settings-section-title"><h2 id="settings-section-title" className="settings-section-title">{instructions?t("settings.instructions.title"):label}</h2><div ref={scroll} className="settings-scroll"><div className="settings-content">
      {section==='general'?<><BrowserGeneral/><ConfigSettings key="speed" mode="speed" projects={projects} {...draftProps}/></>:section==='usage'?<AccountUsagePanel/>:section==='configuration'?<ConfigSettings key="config" projects={projects} {...draftProps}/>:section==='personalization'?instructions?<><a className="settings-back" href="/settings?section=personalization" onClick={event=>{event.preventDefault();navigate('/settings?section=personalization');}}>{t("settings.instructions.back")}</a><InstructionsSettings projects={projects} onReturn={returnFromInstructions} {...draftProps}/></>:<><div className="settings-group"><h3>{t("settings.instructions.title")}</h3>{instructionNotice?<p role="status" className="settings-feedback">{text(instructionNotice)}</p>:null}<div className="settings-card"><div className="settings-row"><div><h4>{t("settings.instructions.codex")}</h4><p>{t("settings.instructions.entryHelp")}</p></div><a className="settings-entry" href="/settings?section=personalization&view=instructions" onClick={event=>{event.preventDefault();navigate('/settings?section=personalization&view=instructions');}}>{t("settings.instructions.edit")}</a></div></div></div><ConfigSettings key="memory" mode="memory" projects={projects} {...draftProps}/></>:section==='web'?<WebSettings onChanged={onChanged}/>:<InstalledPlugins/>}
      </div></div></section>
    </div>
    <dialog ref={leaveDialog} className="restart-dialog" aria-labelledby="leave-settings-title" onCancel={event=>{event.preventDefault();if(!saving)setPending(null);}}>
      <h2 id="leave-settings-title">{t("settings.leave.title")}</h2><p>{actions.current?.isSaving?.()?t("settings.leave.inFlight"):t("settings.leave.help")}</p>
      <div className="actions"><button ref={cancelLeave} disabled={saving} onClick={()=>setPending(null)}>{t("settings.cancel")}</button><button disabled={saving} onClick={()=>void leave(false)}>{t("settings.discard")}</button><button className="primary" disabled={saving||actions.current?.isSaving?.()} onClick={()=>void leave(true)}>{saving?t("settings.saving"):t("settings.leave.save")}</button></div>
    </dialog>
  </main>;
}

function BrowserGeneral(){
 const {t,text}=useLocale();
 const [shortcut,setShortcut]=useState(readSendShortcut),[error,setError]=useState<UiText>(''),[notice,setNotice]=useState<UiText>('');const alert=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(error)alert.current?.focus();},[error]);
 return <div className="settings-group"><h3>{t("settings.chat")}</h3><div className="settings-card"><div className="settings-row"><div><label htmlFor="send-shortcut">{t("settings.shortcut.label")}</label><p>{t("settings.shortcut.help")}</p></div><select id="send-shortcut" value={shortcut} onChange={event=>{const value=event.target.value as SendShortcut;if(writeSendShortcut(value)){setShortcut(value);setError('');setNotice(msg("settings.shortcut.saved"));}else{setError(msg("settings.shortcut.failed"));setNotice('');}}}><option value="enter">{t("settings.shortcut.enter")}</option><option value="mod-enter">{t("settings.shortcut.modEnter")}</option></select></div></div>{error?<div ref={alert} tabIndex={-1} role="alert" className="notice error">{text(error)}</div>:null}{notice?<p role="status" className="settings-feedback">{text(notice)}</p>:null}</div>;
}
