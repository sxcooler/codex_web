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
export type DraftActions={save:()=>Promise<boolean>;discard:()=>void};
export type DraftProps={onDirtyChange:(dirty:boolean)=>void;onLeave:(proceed:()=>void)=>void;actions:MutableRefObject<DraftActions|null>};

const sections=[['general','常规'],['configuration','配置'],['personalization','个性化'],['usage','使用情况'],['plugins','已安装插件'],['web','Codex Web']] as const;
export function Settings({onChanged,projects,route}:{onChanged:()=>void;projects:SettingsProject[];route:string}){
  const panes=usePanes(),requested=new URLSearchParams(route.split('?')[1]??'').get('section');
  const [section,label]=sections.find(([id])=>id===requested)??sections[0];
  const instructions=section==='personalization'&&new URLSearchParams(route.split('?')[1]??'').get('view')==='instructions',scroll=useRef<HTMLDivElement>(null);
  useEffect(()=>{scroll.current?.scrollTo(0,0);},[section,instructions]);
  const [dirty,setDirty]=useState(false),[pending,setPending]=useState<(()=>void)|null>(null),[saving,setSaving]=useState(false);
  const dirtyRef=useRef(false),actions=useRef<DraftActions|null>(null),leaveDialog=useRef<HTMLDialogElement>(null),cancelLeave=useRef<HTMLButtonElement>(null),leaveOpener=useRef<HTMLElement|null>(null),leaveFailed=useRef(false);
  const onDirtyChange=useCallback((value:boolean)=>{dirtyRef.current=value;setDirty(value);},[]);
  const onLeave=useCallback((proceed:()=>void)=>{if(!dirtyRef.current){proceed();return;}leaveOpener.current=document.activeElement as HTMLElement;setPending(()=>proceed);},[]);
  useLayoutEffect(()=>dirty?setNavigationGuard(onLeave):undefined,[dirty,onLeave]);
  useEffect(()=>{if(!dirty)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  useEffect(()=>{if(pending){if(!leaveDialog.current?.open)leaveDialog.current?.showModal();cancelLeave.current?.focus();}else if(leaveDialog.current?.open){leaveDialog.current.close();if(leaveFailed.current)document.querySelector<HTMLElement>('.settings-section [role=alert][tabindex]')?.focus();else leaveOpener.current?.focus();leaveFailed.current=false;}},[pending]);
  const leave=async(save:boolean)=>{if(saving||!pending)return;setSaving(true);try{if(save&&(!actions.current||!await actions.current.save())){leaveFailed.current=true;setPending(null);return;}if(!save)actions.current?.discard();dirtyRef.current=false;setDirty(false);setPending(null);pending();}finally{setSaving(false);}};
  const draftProps={onDirtyChange,onLeave,actions};
  return <main className="settings" inert={panes.mobile&&panes.drawer!==null}>
    <header className="settings-header"><h1>设置</h1><label className="settings-mobile-navigation">设置分类<select aria-label="设置分类" value={section} onChange={event=>navigate('/settings?section='+event.target.value)}>{sections.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label></header>
    <div className="settings-layout"><nav className="settings-navigation" aria-label="设置分类"><p className="settings-nav-group">Codex</p>{sections.map(([id,name])=><div key={id}>{id==='web'?<p className="settings-nav-group">Codex Web</p>:null}<a href={'/settings?section='+id} aria-current={section===id?'page':undefined} onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate('/settings?section='+id);}}>{name}</a></div>)}</nav>
      <section className="settings-section" aria-labelledby="settings-section-title"><h2 id="settings-section-title" className="settings-section-title">{instructions?'自定义指令':label}</h2><div ref={scroll} className="settings-scroll"><div className="settings-content">
      {section==='general'?<><BrowserGeneral/><ConfigSettings key="speed" mode="speed" projects={projects} {...draftProps}/></>:section==='usage'?<AccountUsagePanel/>:section==='configuration'?<ConfigSettings key="config" projects={projects} {...draftProps}/>:section==='personalization'?instructions?<><a className="settings-back" href="/settings?section=personalization" onClick={event=>{event.preventDefault();navigate('/settings?section=personalization');}}>返回个性化</a><InstructionsSettings projects={projects} {...draftProps}/></>:<><ConfigSettings key="memory" mode="memory" projects={projects} {...draftProps}/><div className="settings-group"><h3>自定义指令</h3><div className="settings-card"><div className="settings-row"><div><h4>Codex 指令</h4><p>编辑个人或项目的 AGENTS.md，供后续新会话读取。</p></div><a className="settings-entry" href="/settings?section=personalization&view=instructions" onClick={event=>{event.preventDefault();navigate('/settings?section=personalization&view=instructions');}}>编辑指令</a></div></div></div></>:section==='web'?<WebSettings onChanged={onChanged}/>:<InstalledPlugins/>}
      </div></div></section>
    </div>
    <dialog ref={leaveDialog} className="restart-dialog" aria-labelledby="leave-settings-title" onCancel={event=>{event.preventDefault();if(!saving)setPending(null);}}>
      <h2 id="leave-settings-title">有未保存的更改</h2><p>保存后离开、放弃更改，或取消留在当前页面。</p>
      <div className="actions"><button ref={cancelLeave} disabled={saving} onClick={()=>setPending(null)}>取消</button><button disabled={saving} onClick={()=>void leave(false)}>放弃更改</button><button className="primary" disabled={saving} onClick={()=>void leave(true)}>{saving?'保存中…':'保存并离开'}</button></div>
    </dialog>
  </main>;
}

function BrowserGeneral(){
 const [shortcut,setShortcut]=useState(readSendShortcut),[error,setError]=useState(''),[notice,setNotice]=useState('');const alert=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(error)alert.current?.focus();},[error]);
 return <div className="settings-group"><h3>聊天</h3><div className="settings-card"><div className="settings-row"><div><label htmlFor="send-shortcut">桌面发送快捷键</label><p>Shift+Enter 换行；手机 Enter 始终换行。</p></div><select id="send-shortcut" value={shortcut} onChange={event=>{const value=event.target.value as SendShortcut;if(writeSendShortcut(value)){setShortcut(value);setError('');setNotice('发送偏好已保存，仅影响此浏览器。');}else{setError('发送偏好未持久化：此浏览器无法保存，请检查存储权限后重试。');setNotice('');}}}><option value="enter">Enter 发送</option><option value="mod-enter">Ctrl/Cmd+Enter 发送</option></select></div></div>{error?<div ref={alert} tabIndex={-1} role="alert" className="notice error">{error}</div>:null}{notice?<p role="status" className="settings-feedback">{notice}</p>:null}</div>;
}
