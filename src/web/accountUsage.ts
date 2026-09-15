export type UsageWindow={usedPercent?:unknown;windowDurationMins?:unknown;resetsAt?:unknown};
export type UsageGroup={limitId?:unknown;limitName?:unknown;primary?:UsageWindow|null;secondary?:UsageWindow|null};
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
export function headlineRemaining(data:AccountUsage|null){const main=usageGroups(data).find(isCodex);if(!main)return null;const values=[main[1].primary,main[1].secondary].filter(value=>value!=null).map(remaining);return !values.length||values.some(value=>value===null)?null:Math.min(...values as number[]);}
export function windowLabel(value:unknown){if(!finite(value)||value<=0)return '额度周期';if(value===10080)return '每周';if(value%1440===0)return `${value/1440} 天`;if(value%60===0)return `${value/60} 小时`;return `${value} 分钟`;}
export function timestamp(value:unknown){return finite(value)&&Number.isSafeInteger(value)&&value>=0&&Number.isFinite(new Date(value*1000).getTime())?value*1000:null;}
export function absoluteTime(value:unknown){const time=timestamp(value);return time===null?'暂不可用':new Date(time).toLocaleString(undefined,{timeZoneName:'short'});}
export function countdown(value:unknown,now:number){const time=timestamp(value);if(time===null)return '暂不可用';const minutes=Math.ceil((time-now)/60000);if(minutes<=0)return '已到预计恢复时间，等待更新';if(minutes<60)return `${minutes} 分钟后`;if(minutes<1440)return `${Math.floor(minutes/60)} 小时 ${minutes%60} 分钟后`;return `${Math.floor(minutes/1440)} 天 ${Math.floor(minutes%1440/60)} 小时后`;}
export function creditCount(value:unknown){return typeof value==='string'&&/^\d+$/.test(value)?value:null;}
export function credits(data:AccountUsage|null):ResetCredit[]{return Array.isArray(data?.rateLimitResetCredits?.credits)?data.rateLimitResetCredits.credits.filter(object):[];}
export function usableCredit(credit:ResetCredit,now=Date.now()){return typeof credit.id==='string'&&!!credit.id&&credit.resetType==='codexRateLimits'&&credit.status==='available'&&(credit.expiresAt===null||(timestamp(credit.expiresAt)!==null&&timestamp(credit.expiresAt)!>now));}
export function readPending(accountId:string):ResetOperation|null{
  const raw=localStorage.getItem(pendingKey(accountId));if(raw===null)return null;const value:unknown=JSON.parse(raw);
  if(!object(value)||value.accountId!==accountId||typeof value.creditId!=='string'||!value.creditId||typeof value.idempotencyKey!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.idempotencyKey))throw Error('待核实操作记录无法读取，请保留浏览器数据并检查服务状态。');
  return {accountId,creditId:value.creditId,idempotencyKey:value.idempotencyKey};
}
