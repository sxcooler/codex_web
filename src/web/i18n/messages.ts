import * as common from './catalogs/common.ts';
import * as app from './catalogs/app.ts';
import * as account from './catalogs/account.ts';
import * as session from './catalogs/session.ts';
import * as settings from './catalogs/settings.ts';
import * as panels from './catalogs/panels.ts';
import type {DisplayArgs,Locale,LocalizedMessage} from './types.ts';
export const catalogs={zh:{...common.zh,...app.zh,...account.zh,...session.zh,...settings.zh,...panels.zh},en:{...common.en,...app.en,...account.en,...session.en,...settings.en,...panels.en}};
export type MessageKey=keyof typeof catalogs.zh;
export type MessageArgs<K extends MessageKey>=(typeof catalogs.zh)[K] extends (...args:infer A)=>string?A:[];
export type Translator=<K extends MessageKey>(key:K,...args:MessageArgs<K>)=>string;
const missing=new Set<string>();
export function createTranslator(locale:Locale):Translator{
 const chosen=catalogs[locale==='en'?'en':'zh'] as unknown as Record<string,string|((...args:unknown[])=>string)>;
 const fallback=catalogs.zh as unknown as typeof chosen;
 return ((key:string,...args:unknown[])=>{
  const entry=Object.hasOwn(chosen,key)?chosen[key]:Object.hasOwn(fallback,key)?fallback[key]:undefined;
  if(typeof entry==='function')return entry(...args);
  if(typeof entry==='string')return entry;
  if(!missing.has(key)){missing.add(key);console.warn('Missing interface message: '+key);}
  return `[${key}]`;
 }) as Translator;
}
export function msg<K extends MessageKey>(key:K,...args:DisplayArgs<MessageArgs<K>>):LocalizedMessage{return {key,args};}
