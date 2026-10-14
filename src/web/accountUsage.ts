import {createTranslator,msg} from './i18n/messages.ts';
import type {Locale} from './i18n/types.ts';
export type UsageWindow={usedPercent?:unknown;windowDurationMins?:unknown;resetsAt?:unknown};
export type UsageGroup={limitId?:unknown;limitName?:unknown;primary?:UsageWindow|null;secondary?:UsageWindow|null;credits?:{hasCredits:boolean|null;unlimited:boolean|null;balance:string|null}|null};
export type ResetCredit={id?:unknown;resetType?:unknown;status?:unknown;grantedAt?:unknown;expiresAt?:unknown;title?:unknown;description?:unknown};
export type AccountUsage={accountId:string|null;updatedAt:number;rateLimits:UsageGroup|null;rateLimitsByLimitId:Record<string,UsageGroup>|null;rateLimitResetCredits:{availableCount:string|null;credits:ResetCredit[]|null}|null;resetSupported:boolean;resetUnavailableReason?:string;pendingReset?:ResetOperation|null;stale?:boolean;error?:string};
export type ResetOperation={accountId:string;creditId:string;idempotencyKey:string};
export const pendingKey=(accountId:string)=>'codex-web:account-reset:v1:'+accountId;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
export function remaining(window:UsageWindow|null|undefined){return finite(window?.usedPercent)?Math.max(0,Math.min(100,100-window.usedPercent)):null;}
export function usageGroups(data:AccountUsage|null):[string,UsageGroup][]{
  if(object(data?.rateLimitsByLimitId)&&Object.keys(data.rateLimitsByLimitId).length)return Object.entries(data.rateLimitsByLimitId).filter(([,value])=>object(value));
  const group=data?.rateLimits;return object(group)?[[typeof group.limitId==='string'?group.limitId:'codex',group]]:[];
}
export const isCodex=([id,group]:[string,UsageGroup])=>id==='codex'||group.limitId==='codex';
export function codexCredits(data:AccountUsage|null){
 if(object(data?.rateLimitsByLimitId)&&Object.hasOwn(data.rateLimitsByLimitId,'codex'))return data.rateLimitsByLimitId.codex?.credits??null;
 const main=usageGroups(data).find(isCodex);if(main)return main[1].credits??null;
 const legacy=data?.rateLimits;return object(legacy)&&(legacy.limitId==null||legacy.limitId==='codex')?legacy.credits??null:null;
}
export function balanceText(credit:UsageGroup['credits'],locale:Locale='zh-CN'){
 const t=createTranslator(locale);
 if(credit?.unlimited===true)return t('account.balance.unlimited');
 if(typeof credit?.balance==='string'&&/^\d+(?:\.\d+)?$/.test(credit.balance)){const [whole,fraction]=credit.balance.split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction===undefined?'':'.'+fraction);}
 return credit?.hasCredits===false?t('account.balance.none'):t('account.unavailable');
}
export function headlineRemaining(data:AccountUsage|null){const main=usageGroups(data).find(isCodex);if(!main)return null;const values=[main[1].primary,main[1].secondary].filter(value=>value!=null).map(remaining);return !values.length||values.some(value=>value===null)?null:Math.min(...values as number[]);}
export function windowLabel(value:unknown,locale:Locale='zh-CN'){const t=createTranslator(locale);if(!finite(value)||value<=0)return t('account.window.unknown');if(value===10080)return t('account.window.weekly');if(value%1440===0)return t('account.window.days',value/1440);if(value%60===0)return t('account.window.hours',value/60);return t('account.window.minutes',value);}
export function timestamp(value:unknown){return finite(value)&&Number.isSafeInteger(value)&&value>=0&&Number.isFinite(new Date(value*1000).getTime())?value*1000:null;}
export function absoluteTime(value:unknown,locale:Locale='zh-CN'){const time=timestamp(value);return time===null?createTranslator(locale)('account.unavailable'):new Date(time).toLocaleString(locale,{timeZoneName:'short'});}
export function countdown(value:unknown,now:number,locale:Locale='zh-CN'){const t=createTranslator(locale),time=timestamp(value);if(time===null)return t('account.unavailable');const minutes=Math.ceil((time-now)/60000);if(minutes<=0)return t('account.countdown.awaiting');if(minutes<60)return t('account.countdown.minutes',minutes);if(minutes<1440)return t('account.countdown.hours',Math.floor(minutes/60),minutes%60);return t('account.countdown.days',Math.floor(minutes/1440),Math.floor(minutes%1440/60));}
export function creditCount(value:unknown){return typeof value==='string'&&/^\d+$/.test(value)?value:null;}
export function credits(data:AccountUsage|null):ResetCredit[]{return Array.isArray(data?.rateLimitResetCredits?.credits)?data.rateLimitResetCredits.credits.filter(object):[];}
export function usableCredit(credit:ResetCredit,now=Date.now()){return typeof credit.id==='string'&&!!credit.id&&credit.resetType==='codexRateLimits'&&credit.status==='available'&&(credit.expiresAt===null||(timestamp(credit.expiresAt)!==null&&timestamp(credit.expiresAt)!>now));}
export function readPending(accountId:string):ResetOperation|null{
  const raw=localStorage.getItem(pendingKey(accountId));if(raw===null)return null;const value:unknown=JSON.parse(raw);
  if(!object(value)||value.accountId!==accountId||typeof value.creditId!=='string'||!value.creditId||typeof value.idempotencyKey!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.idempotencyKey))throw Object.assign(Error('待核实操作记录无法读取，请保留浏览器数据并检查服务状态。'),{i18n:msg('account.storage.invalidPending')});
  return {accountId,creditId:value.creditId,idempotencyKey:value.idempotencyKey};
}
