import type {Locale} from './types.ts';
import {createTranslator} from './messages.ts';
const dates=new Map<string,Intl.DateTimeFormat>(),numbers=new Map<string,Intl.NumberFormat>();
export function formatDateTime(value:number|string,locale:Locale,options:Intl.DateTimeFormatOptions={}):string{
 if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!value.trim())return createTranslator(locale)('common.unknown');
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return createTranslator(locale)('common.unknown');
 const key=locale+JSON.stringify(options);let formatter=dates.get(key);
 if(!formatter){formatter=new Intl.DateTimeFormat(locale,{...(!Object.keys(options).length?{dateStyle:'short' as const,timeStyle:'medium' as const}:{}),...options});dates.set(key,formatter);}
 return formatter.format(date);
}
export function formatNumber(value:number,locale:Locale,options:Intl.NumberFormatOptions={}):string{
 const key=locale+JSON.stringify(options);let formatter=numbers.get(key);
 if(!formatter){formatter=new Intl.NumberFormat(locale,options);numbers.set(key,formatter);}
 return formatter.format(value);
}
export function formatDuration(milliseconds:number,locale:Locale):string{
 const seconds=Math.floor(milliseconds/1000);
 return (seconds>=3600?Math.floor(seconds/3600)+(locale==='en'?'h ':'小时 '):'')+(seconds>=60?Math.floor(seconds%3600/60)+(locale==='en'?'m ':'分 '):'')+seconds%60+(locale==='en'?'s':'秒');
}
