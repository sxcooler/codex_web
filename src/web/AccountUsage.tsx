import {useLocale} from './i18n/LocaleProvider.tsx';
import {msg,type UiText} from './i18n/text.ts';
import type {Locale} from './i18n/types.ts';
import {createTranslator} from './i18n/messages.ts';
import {createContext,useCallback,useContext,useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {api} from './api.ts';
import {absoluteTime,balanceText,codexCredits,countdown,creditCount,credits,finite,headlineRemaining,isCodex,pendingKey,readPending,remaining,timestamp,usableCredit,usageGroups,windowLabel,type AccountUsage,type ResetCredit,type ResetOperation,type UsageGroup} from './accountUsage.ts';
import {sharedStateEvent,type SharedStateChange} from './sharedState.ts';

const Context=createContext<{open:(source:HTMLElement)=>void;label:string;remaining:number|null;stale:boolean;content:ReactNode;watch:()=>()=>void}|null>(null);
const nativeText=(value:unknown,fallback:string)=>typeof value==='string'&&value.trim()?value:fallback;
const expiry=(credit:ResetCredit,locale:Locale)=>credit.expiresAt===null?createTranslator(locale)('account.expiry.none'):absoluteTime(credit.expiresAt,locale);
const results:Record<string,UiText>={reset:msg('account.result.reset'),nothingToReset:msg('account.result.nothing'),noCredit:msg('account.result.noCredit'),alreadyRedeemed:msg('account.result.redeemed')};
const rejectedCodes=new Set(['ACCOUNT_CREDIT_UNAVAILABLE','ACCOUNT_RESET_UNSUPPORTED','ACCOUNT_CHANGED','ACCOUNT_INVALID_INPUT','ACCOUNT_RESET_CONFLICT','ACCOUNT_RESET_BUSY']);
function Group({name,group,now}:{name:string;group:UsageGroup;now:number}){
  const {locale,t}=useLocale();
  const windows=[group.primary,group.secondary].filter(value=>value!=null);
  return <section className="usage-group"><h3>{name}</h3>{windows.length?windows.map((window,index)=>{const value=remaining(window),label=windowLabel(window?.windowDurationMins,locale);return <div className="usage-window" key={index} data-status={value===null?'unknown':'current'} style={value!==null?{'--usage-hue':value*1.5} as CSSProperties:undefined}><div><strong>{label}</strong><span className="usage-remaining">{value===null?t('account.unavailable'):t('account.remaining',Math.round(value))}</span></div>{value!==null?<progress max={100} value={value} aria-label={t('account.remaining.aria',name,label)}/>:null}<p className="small muted">{t('account.resetAt',absoluteTime(window?.resetsAt,locale))}<br/>{countdown(window?.resetsAt,now,locale)}</p></div>;}):<p className="muted">{t('account.unavailable')}</p>}</section>;
}
export function AccountUsageButton(){const {t}=useLocale();const state=useContext(Context);return state?<button type="button" className="account-usage-button" data-status={state.stale?'stale':state.remaining!==null?'current':'unknown'} style={state.remaining!==null?{'--usage-hue':state.remaining*1.5} as CSSProperties:undefined} onClick={event=>state.open(event.currentTarget)} aria-label={t('account.button.aria',state.stale,state.label)}><span className="usage-badge"><span>{t('account.badge')}</span><span className="usage-headline">{state.label}</span>{state.stale?<span className="usage-stale" aria-hidden="true">{t('account.stale.badge')}</span>:null}</span></button>:null;}
export function AccountUsagePanel({active=true}:{active?:boolean}){
  const state=useContext(Context),watch=state?.watch;
  useEffect(()=>active?watch?.():undefined,[active,watch]);
  return state?.content??null;
}
export function AccountUsageProvider({children}:{children:ReactNode}){
  const {locale,t,text}=useLocale();
  const [data,setData]=useState<AccountUsage|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState<UiText>(''),[notice,setNotice]=useState<UiText>(''),[open,setOpen]=useState(false),[now,setNow]=useState(Date.now()),[visiblePanels,setVisiblePanels]=useState(0);
  const [selected,setSelected]=useState<{accountId:string;credit:ResetCredit}|null>(null),[pending,setPending]=useState<ResetOperation|null>(null),[busy,setBusy]=useState(false),[storageError,setStorageError]=useState<UiText>('');
  const current=useRef(data),alive=useRef(true),usageGeneration=useRef(0),usageRevision=useRef(0),locked=useRef(false),inflight=useRef<{fresh:boolean;promise:Promise<AccountUsage|null>}|null>(null),panel=useRef<HTMLDialogElement>(null),confirmation=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null),opener=useRef<HTMLElement|null>(null);
  const watch=useCallback(()=>{setVisiblePanels(count=>count+1);return()=>setVisiblePanels(count=>count-1);},[]);
  const restorePending=(accountId:string|null)=>{try{setPending(accountId?readPending(accountId):null);setStorageError('');}catch(e:any){setPending(null);setStorageError(e?.message?e:msg('account.storage.unavailable'));}};
  const invalidate=useCallback(()=>{usageGeneration.current++;usageRevision.current++;current.current=null;setData(null);setPending(null);setSelected(null);setNotice('');setError('');setNow(Date.now());},[]);
  const accept=useCallback((value:AccountUsage):AccountUsage|null=>{
    if(!value||typeof value!=='object'||!(value.accountId===null||typeof value.accountId==='string'))throw Object.assign(Error('用量数据暂不可用'),{i18n:msg('account.data.unavailable')});
    if(current.current?.accountId===value.accountId&&finite(current.current.updatedAt)&&finite(value.updatedAt)&&value.updatedAt<current.current.updatedAt)return null;
    if(current.current?.accountId!==value.accountId){usageGeneration.current++;setSelected(null);setNotice('');}
    current.current=value;setData(value);
    if(value.accountId&&value.pendingReset?.accountId===value.accountId){setSelected(null);try{localStorage.setItem(pendingKey(value.accountId),JSON.stringify(value.pendingReset));restorePending(value.accountId);}catch{setPending(value.pendingReset);setStorageError(msg('account.storage.serverSaved'));}}
    else restorePending(value.accountId);
    setError(value.error||'');setNow(Date.now());return value;
  },[]);
  const read=useCallback(async(fresh=false):Promise<AccountUsage|null>=>{
    if(!alive.current)return null;
    if(inflight.current){if(!fresh||inflight.current.fresh)return inflight.current.promise;await inflight.current.promise;return read(true);}
    const generation=usageGeneration.current,revision=usageRevision.current;setLoading(true);
    const promise=(async()=>{try{
      const value:AccountUsage=await api('/account/usage'+(fresh?'?refresh=true':''));
      if(!alive.current||generation!==usageGeneration.current)return null;
      // The same fresh read may be pushed before its HTTP response; use the newer valid snapshot.
      if(revision!==usageRevision.current&&current.current?.accountId===value.accountId&&finite(current.current?.updatedAt)&&finite(value.updatedAt)&&current.current!.updatedAt>=value.updatedAt)return current.current;
      return accept(value);
    }catch(e:any){if(alive.current&&generation===usageGeneration.current&&revision===usageRevision.current){if(e.data?.code==='ACCOUNT_CHANGED')invalidate();setError(e?.message?e:msg('account.update.failed'));setNow(Date.now());}return null;}finally{inflight.current=null;if(alive.current)setLoading(false);}})();
    inflight.current={fresh,promise};return promise;
  },[accept,invalidate]);
  useEffect(()=>{
    alive.current=true;void read();
    const lost=()=>{alive.current=false;invalidate();setOpen(false);};
    const shared=(event:Event)=>{
      if(!alive.current)return;const {kind,value}=(event as CustomEvent<SharedStateChange>).detail;
      if(kind==='ready'){void read();return;}
      if(kind==='usage-invalidated'){invalidate();return;}
      if(kind==='usage-error'){usageGeneration.current++;usageRevision.current++;if(value?.code==='ACCOUNT_CHANGED')invalidate();setError(typeof value?.message==='string'&&value.message.trim()?value.message:msg('account.update.failed'));setNow(Date.now());return;}
      if(kind==='usage')try{if(accept(value))usageRevision.current++;}catch(e:any){setError(e);}
    };
    const storage=()=>{restorePending(current.current?.accountId??null);};
    window.addEventListener(sharedStateEvent,shared);window.addEventListener('auth-lost',lost);window.addEventListener('storage',storage);
    return()=>{alive.current=false;usageRevision.current++;window.removeEventListener(sharedStateEvent,shared);window.removeEventListener('auth-lost',lost);window.removeEventListener('storage',storage);};
  },[read,accept,invalidate]);
  useEffect(()=>{if(!visiblePanels)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[visiblePanels]);
  useEffect(()=>{const dialog=panel.current;if(open&&!dialog?.open)dialog?.showModal();else if(!open&&dialog?.open){dialog.close();opener.current?.focus();}},[open]);
  useEffect(()=>{const dialog=confirmation.current;if(selected&&!dialog?.open){dialog?.showModal();cancel.current?.focus();}else if(!selected&&dialog?.open)dialog.close();},[selected]);
  const freshEnough=(value:AccountUsage|null)=>!!value&&!value.stale&&!value.error&&finite(value.updatedAt)&&Date.now()-value.updatedAt<30000;
  const canReset=!!data?.accountId&&data.resetSupported===true&&!data.stale&&!error&&!pending&&!busy&&!storageError;
  const choose=async(credit:ResetCredit,source:HTMLElement)=>{
    if(locked.current||!canReset)return;locked.current=true;setBusy(true);setNotice('');const accountId=current.current?.accountId;
    try{const value=await read(true),latest=credits(value).find(item=>item.id===credit.id),count=creditCount(value?.rateLimitResetCredits?.availableCount);
      if(!freshEnough(value)||!value?.accountId||value.accountId!==accountId||!value.resetSupported||!latest||!usableCredit(latest)||count===null||BigInt(count)===0n){if(alive.current)setNotice(msg('account.reset.changedBeforeChoose'));return;}
      if(readPending(value.accountId)){restorePending(value.accountId);return;}if(source.isConnected&&source.closest('dialog')?.open!==false)setSelected({accountId:value.accountId,credit:latest});
    }catch(e:any){if(alive.current)setStorageError(e);}finally{locked.current=false;if(alive.current)setBusy(false);}
  };
  const submit=async(operation:ResetOperation)=>{
    try{
      const result=await api('/account/usage/reset',operation),message=typeof result?.outcome==='string'&&Object.hasOwn(results,result.outcome)?results[result.outcome]:null;
      if(!message)throw Object.assign(Error('服务返回了无法识别的结果'),{i18n:msg('account.reset.unknownResult')});
      try{if(readPending(operation.accountId)?.idempotencyKey===operation.idempotencyKey)localStorage.removeItem(pendingKey(operation.accountId));}catch{}
      if(!alive.current||current.current?.accountId!==operation.accountId)return;
      setPending(null);setNotice(message);await read(true);
    }catch(e:any){
      const rejected=rejectedCodes.has(e.data?.code)||e.status===400;
      if(rejected){try{if(readPending(operation.accountId)?.idempotencyKey===operation.idempotencyKey)localStorage.removeItem(pendingKey(operation.accountId));}catch{}}
      if(alive.current&&current.current?.accountId===operation.accountId){setPending(rejected?null:operation);setNotice(msg(rejected?'account.reset.rejected':'account.reset.unverified',e?.message?e:msg('account.reset.disconnected')));await read(true);}
    }
    finally{locked.current=false;if(alive.current)setBusy(false);}
  };
  const confirm=()=>{
    if(locked.current||!selected)return;
    const latest=credits(current.current).find(credit=>credit.id===selected.credit.id),count=creditCount(current.current?.rateLimitResetCredits?.availableCount);
    if(current.current?.accountId!==selected.accountId||!current.current.resetSupported||!freshEnough(current.current)||!latest||!usableCredit(latest)||count===null||BigInt(count)===0n){setSelected(null);setNotice(msg('account.reset.changed'));return;}
    try{
      if(readPending(selected.accountId)){restorePending(selected.accountId);setSelected(null);return;}
      const operation={accountId:selected.accountId,creditId:selected.credit.id as string,idempotencyKey:crypto.randomUUID()};
      localStorage.setItem(pendingKey(operation.accountId),JSON.stringify(operation));
      if(readPending(operation.accountId)?.idempotencyKey!==operation.idempotencyKey)throw Object.assign(Error('无法保存操作标识'),{i18n:msg('account.storage.cannotSave')});
      locked.current=true;setBusy(true);setPending(operation);setSelected(null);setNotice(msg('account.reset.using'));void submit(operation);
    }catch(e:any){setSelected(null);setStorageError(msg('account.storage.pendingFailure',e));}
  };
  const retry=async()=>{
    if(locked.current||!pending)return;locked.current=true;setBusy(true);const operation=pending;
    const value=await read(true);if(!freshEnough(value)||value?.accountId!==operation.accountId||!value.resetSupported){locked.current=false;if(alive.current){setBusy(false);setNotice(msg('account.reset.cannotVerify'));}return;}
    await submit(operation);
  };
  const groups=usageGroups(data),main=groups.find(isCodex),others=groups.filter(group=>!isCodex(group)),count=creditCount(data?.rateLimitResetCredits?.availableCount),items=credits(data),value=headlineRemaining(data),stale=!!data&&(!!error||!!data.stale||!!data.error||!finite(data.updatedAt)||now-data.updatedAt>60000);
  const incomplete=count!==null&&BigInt(count)>BigInt(items.filter(item=>usableCredit(item,now)).length);
  const content=<div className="usage-content">
      <p className="muted">{t('account.description')}</p>
      <div className="usage-heading"><p className="small muted">{t('account.updatedAt',finite(data?.updatedAt)&&data.updatedAt>0?absoluteTime(Math.floor(data.updatedAt/1000),locale):t('account.unavailable'))}</p><button type="button" disabled={loading} onClick={()=>void read(true)}>{loading?t('account.refreshing'):t('account.refresh')}</button></div>
      {loading?<p role="status">{t('account.reading')}</p>:null}{notice?<p role="status" className="notice">{text(notice)}</p>:null}{error?<p role="alert" className="notice error">{text(msg('account.update.error',error))}</p>:null}{stale?<p className="usage-stale">{t('account.stale.description')}</p>:null}
      {main?<Group name="Codex" group={main[1]} now={now}/>:<section className="usage-group"><h3>Codex</h3><p className="muted">{t('account.mainUnavailable')}</p></section>}
      {others.length?<details className="usage-others"><summary>{t('account.otherQuotas',others.length)}</summary>{others.map(([id,group])=><Group key={id} name={nativeText(group.limitName,id)} group={group} now={now}/>)}</details>:null}
      <section className="usage-group usage-balance"><div className="usage-balance-row"><div><h3>{t('account.balance.title')}</h3><p className="muted small">{t('account.balance.description')}</p></div><strong className="balance-value">{balanceText(codexCredits(data),locale)}</strong></div></section>
      <section className="usage-group"><h3>{t('account.credits.title')} <span className="muted">{t('account.credits.available',count??t('account.unavailable'),count!==null)}</span></h3>
        {!data?.resetSupported?<p className="muted">{data?.resetUnavailableReason||t('account.reset.unsupported')}</p>:null}{storageError?<p role="alert" className="notice error">{text(storageError)}</p>:null}
        {pending?<div className="notice"><p>{t('account.reset.pending')}</p><button type="button" disabled={busy||!data?.resetSupported||loading} onClick={()=>void retry()}>{t('account.reset.retry')}</button></div>:null}
        {incomplete||(!items.length&&count!=='0')?<p className="muted">{t('account.credits.detailsUnavailable',!!items.length)}</p>:null}
        {items.map((credit,index)=><article className="usage-credit" key={typeof credit.id==='string'?credit.id:index}><h4>{nativeText(credit.title,t('account.credits.title'))}</h4><p>{t('account.credits.scope',credit.resetType==='codexRateLimits'?t('account.credits.scopeCodex'):t('account.credits.scopeUnknown'))}</p>{typeof credit.description==='string'?<p className="muted">{credit.description}</p>:null}<p className="small muted">{t('account.credits.expires',expiry(credit,locale))}</p>{usableCredit(credit,now)?<button type="button" disabled={!canReset||count===null||BigInt(count)===0n||loading} onClick={event=>void choose(credit,event.currentTarget)}>{t('account.credits.use')}</button>:<span className="muted small">{credit.status==='redeeming'?t('account.credits.redeeming'):credit.status==='redeemed'?t('account.credits.redeemed'):timestamp(credit.expiresAt)!==null&&timestamp(credit.expiresAt)!<=now?t('account.credits.expired'):t('account.unavailable')}</span>}</article>)}
      </section>
  </div>;
  return <Context.Provider value={{open:source=>{opener.current=source;setOpen(true);setNow(Date.now());void read();},label:value===null||stale?'':` · ${Math.round(value)}%`,remaining:value,stale:stale||!!error,content,watch}}>{children}
    <dialog ref={panel} className="account-usage-dialog" aria-labelledby="account-usage-title" onCancel={event=>{event.preventDefault();setOpen(false);}} onClick={event=>{if(event.target===event.currentTarget)setOpen(false);}}><div className="usage-content usage-dialog-heading">
      <div className="usage-heading"><h2 id="account-usage-title">{t('account.title')}</h2><button type="button" className="quiet" aria-label={t('account.close.title')} onClick={()=>setOpen(false)}>{t('account.close')}</button></div>
    </div><AccountUsagePanel active={open}/></dialog>
    <dialog ref={confirmation} className="account-usage-dialog usage-confirm" aria-labelledby="usage-confirm-title" onCancel={event=>{event.preventDefault();setSelected(null);}} onClick={event=>{if(event.target===event.currentTarget)setSelected(null);}}><div className="usage-content"><h2 id="usage-confirm-title">{t('account.confirm.title')}</h2>{selected?<><h3>{nativeText(selected.credit.title,t('account.credits.title'))}</h3><p>{t('account.confirm.scope')}</p><p>{t('account.credits.expires',expiry(selected.credit,locale))}</p><p>{t('account.confirm.available',count??t('account.unavailable'))}</p><p>{t('account.confirm.description')}</p></>:null}<div className="usage-actions"><button type="button" ref={cancel} onClick={()=>setSelected(null)}>{t('account.confirm.cancel')}</button><button type="button" className="primary" disabled={busy} onClick={confirm}>{t('account.confirm.use')}</button></div></div></dialog>
  </Context.Provider>;
}
