import {useEffect,useState} from 'react';
import type {Json} from './api.ts';
import {useLocale} from './i18n/LocaleProvider.tsx';
import {nativeRetryText,turnErrorText,turnOutcome} from './turnFeedback.ts';
import {validItemTime} from '../codex/itemTimes.ts';

export function TurnOutcome({turn,latest=false,duration}:{turn:Json;latest?:boolean;duration?:string}){
  const {t,locale}=useLocale(),outcome=turnOutcome(turn,locale);
  const [copied,setCopied]=useState<'success'|'failed'>();
  if(!outcome)return duration?<p className="turn-duration muted small">{t('session.feedback.elapsed')} {duration}</p>:null;
  const error=turnErrorText(turn),raw=typeof turn.error==='string'?turn.error:turn.error?.message;
  const reason=outcome.reason??(typeof raw==='string'?raw.split('\n')[0].slice(0,180):undefined);
  return <section className="turn-outcome" id={'turn-outcome-'+turn.id} data-kind={outcome.kind} tabIndex={-1} aria-label={outcome.title}>
    <div className="turn-outcome-heading"><span aria-hidden="true">{outcome.kind==='interrupted'?'■':'!'}</span><strong>{outcome.title}</strong></div>
    {reason?<p className="turn-outcome-reason">{reason}</p>:outcome.kind==='failed'&&!turn.error?<p>{outcome.detail}</p>:null}
    {latest&&outcome.kind==='failed'?<p className="turn-outcome-recovery muted small">{t('session.feedback.recovery')}</p>:null}
    <div className="turn-outcome-actions"><details><summary>{t('session.feedback.details')}</summary><p>{outcome.detail}</p>{error?<pre>{error}</pre>:null}</details>
      {turn.error?<button type="button" className="quiet" onClick={async()=>{try{await navigator.clipboard.writeText(error);setCopied('success');}catch{setCopied('failed');}}}>{t('session.feedback.copy')}</button>:null}
    </div>
    {copied?<p role="status" className="small">{t(copied==='success'?'session.feedback.copied':'session.feedback.copyFailed')}</p>:null}
    {duration?<p className="turn-duration muted small">{t('session.feedback.elapsed')} {duration}</p>:null}
  </section>;
}

export function NativeRetry({retry}:{retry:Json}){
  const {t,locale}=useLocale();
  return <div className="turn-retry small" role="status"><span>{nativeRetryText(retry,locale)}</span>{retry.message?<details><summary>{t('session.feedback.details')}</summary><pre>{retry.message}</pre></details>:null}</div>;
}

export function CompactionProgress({item}:{item:Json}){
  const {t}=useLocale(),start=validItemTime(item.startedAtMs)&&item.startedAtMs>0?item.startedAtMs:undefined;
  const [delayed,setDelayed]=useState(start!==undefined&&Date.now()-start>=10_000);
  useEffect(()=>{
    setDelayed(start!==undefined&&Date.now()-start>=10_000);
    if(start===undefined)return;
    const timer=setTimeout(()=>setDelayed(true),Math.max(0,start+10_000-Date.now()));
    return()=>clearTimeout(timer);
  },[start]);
  return <p className="turn-progress muted small" role="status">{t(delayed?'session.feedback.compactingLong':'session.feedback.compacting')}</p>;
}
