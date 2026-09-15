import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {api} from './api.ts';
import {absoluteTime,countdown,creditCount,credits,finite,headlineRemaining,isCodex,pendingKey,readPending,remaining,timestamp,usableCredit,usageGroups,windowLabel,type AccountUsage,type ResetCredit,type ResetOperation,type UsageGroup} from './accountUsage.ts';

const Context=createContext<{open:(source:HTMLElement)=>void;label:string;stale:boolean}|null>(null);
const text=(value:unknown,fallback:string)=>typeof value==='string'&&value.trim()?value:fallback;
const expiry=(credit:ResetCredit)=>credit.expiresAt===null?'无到期限制':absoluteTime(credit.expiresAt);
const results:Record<string,string>={reset:'重置成功',nothingToReset:'当前无需重置',noCredit:'该机会已不可用',alreadyRedeemed:'该机会已使用'};
const rejectedCodes=new Set(['ACCOUNT_CREDIT_UNAVAILABLE','ACCOUNT_RESET_UNSUPPORTED','ACCOUNT_CHANGED','ACCOUNT_INVALID_INPUT','ACCOUNT_RESET_CONFLICT','ACCOUNT_RESET_BUSY']);
function Group({name,group,now}:{name:string;group:UsageGroup;now:number}){
  const windows=[group.primary,group.secondary].filter(value=>value!=null);
  return <section className="usage-group"><h3>{name}</h3>{windows.length?windows.map((window,index)=>{const value=remaining(window),label=windowLabel(window?.windowDurationMins);return <div className="usage-window" key={index}><div><strong>{label}</strong><span>{value===null?'暂不可用':`${Math.round(value)}% 剩余`}</span></div>{value!==null?<progress max={100} value={value} aria-label={`${name} ${label}剩余额度`}/>:null}<p className="small muted">自动重置：{absoluteTime(window?.resetsAt)}<br/>{countdown(window?.resetsAt,now)}</p></div>;}):<p className="muted">暂不可用</p>}</section>;
}
export function AccountUsageButton(){const state=useContext(Context);return state?<button type="button" className="quiet account-usage-button" onClick={event=>state.open(event.currentTarget)} aria-label={'账户用量'+(state.stale?'，数据待更新':'')}><span>用量</span><span className="usage-headline">{state.label}</span>{state.stale?<span className="usage-stale" aria-hidden="true">待更新</span>:null}</button>:null;}
export function AccountUsageProvider({children}:{children:ReactNode}){
  const [data,setData]=useState<AccountUsage|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[open,setOpen]=useState(false),[now,setNow]=useState(Date.now());
  const [selected,setSelected]=useState<{accountId:string;credit:ResetCredit}|null>(null),[pending,setPending]=useState<ResetOperation|null>(null),[busy,setBusy]=useState(false),[storageError,setStorageError]=useState('');
  const current=useRef(data),alive=useRef(true),locked=useRef(false),inflight=useRef<{fresh:boolean;promise:Promise<AccountUsage|null>}|null>(null),panel=useRef<HTMLDialogElement>(null),confirmation=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null),opener=useRef<HTMLElement|null>(null);
  const restorePending=(accountId:string|null)=>{try{setPending(accountId?readPending(accountId):null);setStorageError('');}catch(e:any){setPending(null);setStorageError(e.message||'浏览器存储不可用，无法安全保存操作标识。');}};
  const read=useCallback(async(fresh=false):Promise<AccountUsage|null>=>{
    if(!alive.current)return null;
    if(inflight.current){if(!fresh||inflight.current.fresh)return inflight.current.promise;await inflight.current.promise;return read(true);}
    setLoading(true);
    const promise=(async()=>{try{
      const value:AccountUsage=await api('/account/usage'+(fresh?'?refresh=true':''));
      if(!alive.current)return null;
      if(!value||typeof value!=='object'||!(value.accountId===null||typeof value.accountId==='string'))throw Error('用量数据暂不可用');
      if(current.current?.accountId!==value.accountId){setSelected(null);setNotice('');}
      current.current=value;setData(value);
      if(value.accountId&&value.pendingReset?.accountId===value.accountId){setSelected(null);try{localStorage.setItem(pendingKey(value.accountId),JSON.stringify(value.pendingReset));restorePending(value.accountId);}catch{setPending(value.pendingReset);setStorageError('浏览器存储不可用；服务已保存本次操作标识。');}}
      else restorePending(value.accountId);
      setError(value.error||'');setNow(Date.now());return value;
    }catch(e:any){if(alive.current){if(e.data?.code==='ACCOUNT_CHANGED'){current.current=null;setData(null);setPending(null);setSelected(null);}setError(e.message||'用量更新失败');setNow(Date.now());}return null;}finally{inflight.current=null;if(alive.current)setLoading(false);}})();
    inflight.current={fresh,promise};return promise;
  },[]);
  useEffect(()=>{
    alive.current=true;void read();
    const wake=()=>{if(document.visibilityState==='visible'&&Date.now()-(current.current?.updatedAt||0)>30000)void read();};
    const lost=()=>{alive.current=false;current.current=null;setData(null);setPending(null);setSelected(null);setOpen(false);setNotice('');setError('');};
    const storage=()=>{restorePending(current.current?.accountId??null);};
    const timer=setInterval(()=>{if(document.visibilityState==='visible'){setNow(Date.now());void read();}},60000);
    window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);window.addEventListener('auth-lost',lost);window.addEventListener('storage',storage);
    return()=>{alive.current=false;clearInterval(timer);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);window.removeEventListener('auth-lost',lost);window.removeEventListener('storage',storage);};
  },[read]);
  useEffect(()=>{if(!open)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[open]);
  useEffect(()=>{
    const deadlines=usageGroups(data).flatMap(([,group])=>[group.primary?.resetsAt,group.secondary?.resetsAt]).map(timestamp).filter((value):value is number=>value!==null&&value>Date.now());
    if(!deadlines.length)return;const timer=setTimeout(()=>{if(document.visibilityState==='visible')void read(true);},Math.min(2147483647,Math.max(1,Math.min(...deadlines)-Date.now()+50)));return()=>clearTimeout(timer);
  },[data,read]);
  useEffect(()=>{const dialog=panel.current;if(open&&!dialog?.open)dialog?.showModal();else if(!open&&dialog?.open){dialog.close();opener.current?.focus();}},[open]);
  useEffect(()=>{const dialog=confirmation.current;if(selected&&!dialog?.open){dialog?.showModal();cancel.current?.focus();}else if(!selected&&dialog?.open)dialog.close();},[selected]);
  const freshEnough=(value:AccountUsage|null)=>!!value&&!value.stale&&!value.error&&finite(value.updatedAt)&&Date.now()-value.updatedAt<30000;
  const canReset=!!data?.accountId&&data.resetSupported===true&&!data.stale&&!error&&!pending&&!busy&&!storageError;
  const choose=async(credit:ResetCredit)=>{
    if(locked.current||!canReset)return;locked.current=true;setBusy(true);setNotice('');const accountId=current.current?.accountId;
    try{const value=await read(true),latest=credits(value).find(item=>item.id===credit.id),count=creditCount(value?.rateLimitResetCredits?.availableCount);
      if(!freshEnough(value)||!value?.accountId||value.accountId!==accountId||!value.resetSupported||!latest||!usableCredit(latest)||count===null||BigInt(count)===0n){if(alive.current)setNotice('账户或机会状态已变化，无法确认使用。请刷新后重新选择。');return;}
      if(readPending(value.accountId)){restorePending(value.accountId);return;}if(panel.current?.open)setSelected({accountId:value.accountId,credit:latest});
    }catch(e:any){if(alive.current)setStorageError(e.message);}finally{locked.current=false;if(alive.current)setBusy(false);}
  };
  const submit=async(operation:ResetOperation)=>{
    try{
      const result=await api('/account/usage/reset',operation),message=typeof result?.outcome==='string'&&Object.hasOwn(results,result.outcome)?results[result.outcome]:null;
      if(!message)throw Error('服务返回了无法识别的结果');
      try{if(readPending(operation.accountId)?.idempotencyKey===operation.idempotencyKey)localStorage.removeItem(pendingKey(operation.accountId));}catch{}
      if(!alive.current||current.current?.accountId!==operation.accountId)return;
      setPending(null);setNotice(message);await read(true);
    }catch(e:any){
      const rejected=rejectedCodes.has(e.data?.code)||e.status===400;
      if(rejected){try{if(readPending(operation.accountId)?.idempotencyKey===operation.idempotencyKey)localStorage.removeItem(pendingKey(operation.accountId));}catch{}}
      if(alive.current&&current.current?.accountId===operation.accountId){setPending(rejected?null:operation);setNotice((rejected?'未执行重置：':'结果待核实：')+(e.message||'连接中断'));await read(true);}
    }
    finally{locked.current=false;if(alive.current)setBusy(false);}
  };
  const confirm=()=>{
    if(locked.current||!selected)return;
    const latest=credits(current.current).find(credit=>credit.id===selected.credit.id),count=creditCount(current.current?.rateLimitResetCredits?.availableCount);
    if(current.current?.accountId!==selected.accountId||!current.current.resetSupported||!freshEnough(current.current)||!latest||!usableCredit(latest)||count===null||BigInt(count)===0n){setSelected(null);setNotice('账户或机会状态已变化，请重新选择。');return;}
    try{
      if(readPending(selected.accountId)){restorePending(selected.accountId);setSelected(null);return;}
      const operation={accountId:selected.accountId,creditId:selected.credit.id as string,idempotencyKey:crypto.randomUUID()};
      localStorage.setItem(pendingKey(operation.accountId),JSON.stringify(operation));
      if(readPending(operation.accountId)?.idempotencyKey!==operation.idempotencyKey)throw Error('无法保存操作标识');
      locked.current=true;setBusy(true);setPending(operation);setSelected(null);setNotice('正在使用重置机会…');void submit(operation);
    }catch(e:any){setSelected(null);setStorageError('无法安全保存待核实操作：'+e.message);}
  };
  const retry=async()=>{
    if(locked.current||!pending)return;locked.current=true;setBusy(true);const operation=pending;
    const value=await read(true);if(!freshEnough(value)||value?.accountId!==operation.accountId||!value.resetSupported){locked.current=false;if(alive.current){setBusy(false);setNotice('暂时无法核对账户，请稍后重试本次操作。');}return;}
    await submit(operation);
  };
  const groups=usageGroups(data),main=groups.find(isCodex),others=groups.filter(group=>!isCodex(group)),count=creditCount(data?.rateLimitResetCredits?.availableCount),items=credits(data),value=headlineRemaining(data),stale=!!data&&(!!error||!!data.stale||!!data.error||!finite(data.updatedAt)||now-data.updatedAt>60000);
  const incomplete=count!==null&&BigInt(count)>BigInt(items.filter(item=>usableCredit(item,now)).length);
  return <Context.Provider value={{open:source=>{opener.current=source;setOpen(true);setNow(Date.now());void read();},label:value===null||stale?'':` · ${Math.round(value)}%`,stale:stale||!!error}}>{children}
    <dialog ref={panel} className="account-usage-dialog" aria-labelledby="account-usage-title" onCancel={event=>{event.preventDefault();setOpen(false);}} onClick={event=>{if(event.target===event.currentTarget)setOpen(false);}}><div className="usage-content">
      <div className="usage-heading"><h2 id="account-usage-title">账户用量</h2><button type="button" className="quiet" aria-label="关闭账户用量" onClick={()=>setOpen(false)}>关闭</button></div>
      <p className="muted">当前 Codex 账户，所有客户端共享</p>
      <div className="usage-heading"><p className="small muted">最近成功更新：{finite(data?.updatedAt)&&data.updatedAt>0?absoluteTime(Math.floor(data.updatedAt/1000)):'暂不可用'}</p><button type="button" disabled={loading} onClick={()=>void read(true)}>{loading?'刷新中…':'刷新'}</button></div>
      {loading?<p role="status">正在读取账户用量…</p>:null}{notice?<p role="status" className="notice">{notice}</p>:null}{error?<p role="alert" className="notice error">用量更新失败：{error}</p>:null}{stale?<p className="usage-stale">以下为上次读取的数据，待更新。</p>:null}
      {main?<Group name="Codex" group={main[1]} now={now}/>:<section className="usage-group"><h3>Codex</h3><p className="muted">主额度暂不可用</p></section>}
      {others.length?<details className="usage-others"><summary>其他额度（{others.length}）</summary>{others.map(([id,group])=><Group key={id} name={text(group.limitName,id)} group={group} now={now}/>)}</details>:null}
      <section className="usage-group"><h3>重置机会 <span className="muted">可用 {count??'暂不可用'}{count!==null?' 次':''}</span></h3>
        {!data?.resetSupported?<p className="muted">{data?.resetUnavailableReason||'当前原生账户暂不支持安全重置。'}</p>:null}{storageError?<p role="alert" className="notice error">{storageError}</p>:null}
        {pending?<div className="notice"><p>有一次操作结果待核实。核对后可使用原操作标识重试，不会改用另一条机会。</p><button type="button" disabled={busy||!data?.resetSupported||loading} onClick={()=>void retry()}>核对并重试本次操作</button></div>:null}
        {incomplete||(!items.length&&count!=='0')?<p className="muted">{items.length?'部分':'全部'}机会详情暂不可用。</p>:null}
        {items.map((credit,index)=><article className="usage-credit" key={typeof credit.id==='string'?credit.id:index}><h4>{text(credit.title,'重置机会')}</h4><p>重置范围：{credit.resetType==='codexRateLimits'?'Codex 额度':'暂不可用（未知类型）'}</p>{typeof credit.description==='string'?<p className="muted">{credit.description}</p>:null}<p className="small muted">到期时间：{expiry(credit)}</p>{usableCredit(credit,now)?<button type="button" disabled={!canReset||count===null||BigInt(count)===0n||loading} onClick={()=>void choose(credit)}>使用</button>:<span className="muted small">{credit.status==='redeeming'?'正在使用':credit.status==='redeemed'?'已使用':timestamp(credit.expiresAt)!==null&&timestamp(credit.expiresAt)!<=now?'已过期':'暂不可用'}</span>}</article>)}
      </section>
    </div></dialog>
    <dialog ref={confirmation} className="account-usage-dialog usage-confirm" aria-labelledby="usage-confirm-title" onCancel={event=>{event.preventDefault();setSelected(null);}} onClick={event=>{if(event.target===event.currentTarget)setSelected(null);}}><div className="usage-content"><h2 id="usage-confirm-title">使用重置机会？</h2>{selected?<><h3>{text(selected.credit.title,'重置机会')}</h3><p>重置范围：Codex 额度</p><p>到期时间：{expiry(selected.credit)}</p><p>当前可用：{count??'暂不可用'} 次</p><p>确认后将尝试消耗 1 次重置机会。成功消耗后，本页面不提供撤销操作。</p></>:null}<div className="usage-actions"><button type="button" ref={cancel} onClick={()=>setSelected(null)}>取消</button><button type="button" className="primary" disabled={busy} onClick={confirm}>确认消耗 1 次</button></div></div></dialog>
  </Context.Provider>;
}
