import type {Locale,LocalePreference,LocaleState} from './types.ts';
export const localeKey='codex-web:locale:v1';
type StorageLike=Pick<Storage,'getItem'|'setItem'>;
export const isLocalePreference=(value:unknown):value is LocalePreference=>value==='system'||value==='zh-CN'||value==='en';
export function resolveLocale(preference:LocalePreference,languages:readonly string[]):Locale{
 if(preference!=='system')return preference;
 for(const language of languages){
  const value=language.toLowerCase();
  if(/^en(?:-|$)/.test(value))return 'en';
  if(value==='zh'||value==='zh-cn'||value==='zh-sg'||/^zh-hans(?:-|$)/.test(value))return 'zh-CN';
 }
 return 'zh-CN';
}
const storage=():StorageLike|undefined=>{try{return globalThis.localStorage;}catch{return undefined;}};
export function readLocalePreference(source:StorageLike|undefined=storage()):LocalePreference{
 try{const value=source?.getItem(localeKey);return isLocalePreference(value)?value:'system';}catch{return 'system';}
}
export function writeLocalePreference(preference:LocalePreference,target:StorageLike|undefined=storage()):boolean{
 if(!isLocalePreference(preference)||!target)return false;
 try{target.setItem(localeKey,preference);return target.getItem(localeKey)===preference;}catch{return false;}
}
export function browserLanguages():readonly string[]{return typeof navigator==='undefined'?[]:navigator.languages?.length?navigator.languages:[navigator.language];}
export function initialLocaleState():LocaleState{const preference=readLocalePreference();return {preference,locale:resolveLocale(preference,browserLanguages()),persisted:true};}
