import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {api} from './api.ts';
import {DiffView} from './GitHistory.tsx';
import {textDiff} from './textDiff.ts';
import type {DraftProps,SettingsProject} from './Settings.tsx';
type InstructionDocument={path:string;content:string;version:string;exists:boolean;writable:boolean;reason?:string;overriddenBy:string|null};
export function InstructionsSettings({projects,onDirtyChange,onLeave,actions}:DraftProps&{projects:SettingsProject[]}){
 const [scope,setScope]=useState<'user'|'project'>('user'),[project,setProject]=useState(''),[document,setDocument]=useState<InstructionDocument|null>(null),[content,setContent]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[blocked,setBlocked]=useState<'conflict'|'unknown'|null>(null);
 const errorBox=useRef<HTMLDivElement>(null),saving=useRef(false),dirty=!!document&&content!==document.content;
 useLayoutEffect(()=>{onDirtyChange(dirty);return()=>onDirtyChange(false);},[dirty,onDirtyChange]);
 useEffect(()=>{if(error)errorBox.current?.focus();},[error]);
 const target={scope,...(scope==='project'?{projectId:project}:{})};
 const read=async(preserve=false,signal?:AbortSignal)=>{if(scope==='project'&&!project)return;setBusy(true);setError('');try{const next:InstructionDocument=await api('/codex/instructions?'+new URLSearchParams(target),undefined,signal);if(signal?.aborted)return;setDocument(next);if(!preserve)setContent(next.content);setBlocked(null);if(preserve)setNotice('已重新读取；保留草稿，请比较原文与新文后再保存。');}catch(e:any){if(!signal?.aborted)setError(e.message);}finally{if(!signal?.aborted)setBusy(false);}};
 useEffect(()=>{setDocument(null);setContent('');setNotice('');setBlocked(null);const controller=new AbortController();void read(false,controller.signal);return()=>controller.abort();},[scope,project]);
 const comparison=useMemo(()=>document&&content!==document.content?textDiff(document.content,content):null,[document,content]);
 const tooLarge=new TextEncoder().encode(content).length>262144;
 const save=async()=>{if(!document?.writable||!dirty||busy||blocked||tooLarge||saving.current)return false;saving.current=true;setBusy(true);setError('');setNotice('');try{const next=await api('/codex/instructions',{...target,expectedVersion:document.version,content});setDocument(next);setContent(next.content);setNotice('指令已保存，后续新会话读取。');return true;}catch(e:any){setError(e.message);if(e.status===409)setBlocked('conflict');else if(e.status===504||!e.status)setBlocked('unknown');return false;}finally{saving.current=false;setBusy(false);}};
 actions.current={save,discard:()=>{setContent(document?.content??'');onDirtyChange(false);}};
 return <div className="settings-editor"><p className="muted small">编辑个人或项目的固定 AGENTS.md；后续新会话读取，项目子目录也可能有独立指令。</p>
  <div className="settings-context"><label htmlFor="instructions-scope">指令范围</label><select id="instructions-scope" aria-label="指令范围" value={scope} disabled={busy} onChange={event=>{const value=event.target.value as typeof scope;onLeave(()=>setScope(value));}}><option value="user">个人 AGENTS.md</option><option value="project">项目根 AGENTS.md</option></select></div>
  {scope==='project'?<label>指令项目<select aria-label="指令项目" value={project} disabled={busy} onChange={event=>{const value=event.target.value;onLeave(()=>setProject(value));}}><option value="">请选择项目</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>:null}
  {error?<div ref={errorBox} tabIndex={-1} role="alert" className="notice error">{error}</div>:null}{notice?<p role="status" className="notice">{notice}</p>:null}
  <button disabled={busy||(scope==='project'&&!project)} onClick={()=>void read(dirty)}>{blocked==='unknown'?'先读回核对':blocked==='conflict'?'重新读取并比较':busy?'读取中…':'重新读取指令'}</button>
  {document?<><details className="settings-details settings-config-details"><summary>指令文件详情</summary><p className="path">{document.path}</p></details>{!document.exists?<p className="notice">尚未创建</p>:null}{document.overriddenBy?<p className="notice">存在覆盖文件：{document.overriddenBy}。本页仅编辑 AGENTS.md。</p>:null}{!document.writable?<p className="notice">{document.reason??'文件只读'}</p>:null}
   <form onSubmit={event=>{event.preventDefault();void save();}}><div className="settings-card settings-instruction-editor"><label>指令原始文本<textarea aria-label="指令原始文本" rows={12} disabled={busy||!document.writable} value={content} onChange={event=>{setContent(event.target.value);setNotice('');}}/></label></div>
    {comparison?<section className="instructions-comparison" aria-label="指令修改对比"><div className="instructions-diff-heading"><h3>修改对比</h3><span>原文与新文</span></div><div className="instructions-diff"><DiffView content={comparison} split/></div>{comparison.simplified?<p className="muted small">内容较长，变化区按删除与新增整段显示。</p>:null}{comparison.truncated?<p className="notice">仅预览每侧前部分内容（最多 2,000 行）；编辑文本和保存不会截断。</p>:null}</section>:null}
    {tooLarge?<p role="alert" className="notice error">指令超过 256 KiB，无法保存。</p>:null}
    <div className="settings-save"><span>{dirty?'指令已修改':'没有待保存的更改'}</span><div className="actions"><button type="button" disabled={busy||!dirty} onClick={()=>{setContent(document.content);onDirtyChange(false);}}>放弃更改</button><button className="primary" disabled={busy||!document.writable||!dirty||!!blocked||tooLarge} aria-busy={busy}>{saving.current?'保存中…':'保存指令'}</button></div></div>
   </form><p className="muted small">保存保留原有 BOM 与换行风格；新文件使用 UTF-8、LF。版本核对与原子替换不是跨编辑器的事务锁。</p></>:busy?<p role="status">读取指令…</p>:null}
 </div>;
}
