import {createTranslator,type MessageKey} from './messages.ts';
import type {Locale,LocalizedMessage} from './types.ts';
const codes:Record<string,MessageKey>={AUTH_INVALID_CREDENTIALS:'error.auth.invalid',AUTH_REQUIRED:'error.auth.required',AUTH_RATE_LIMITED:'error.auth.rateLimited',AUTH_PASSWORD_BUSY:'error.auth.busy',REQUEST_FORBIDDEN:'error.request.forbidden',REQUEST_VALIDATION_FAILED:'error.request.invalid',ROUTE_NOT_FOUND:'error.route.missing',INTERNAL_ERROR:'error.internal',RUNTIME_THREAD_BUSY:'error.thread.busy'};
export function formatDisplayError(error:unknown,locale:Locale):string{
 const t=createTranslator(locale);
 if(error&&typeof error==='object'){
  const value=error as {i18n?:LocalizedMessage;data?:{code?:string};code?:string;message?:unknown};
  if(value.i18n&&typeof value.i18n.key==='string'&&Array.isArray(value.i18n.args))return (t as (key:string,...args:unknown[])=>string)(value.i18n.key,...value.i18n.args);
  const code=value.data?.code??value.code??'',key=Object.hasOwn(codes,code)?codes[code]:undefined;
  if(key)return (t as (key:string)=>string)(key);
  if(typeof value.message==='string')return value.message;
 }
 return typeof error==='string'?error:t('common.unknownError');
}
