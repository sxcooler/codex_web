import {createTranslator} from './messages.ts';
import {formatDisplayError} from './errors.ts';
import type {Locale,UiText} from './types.ts';
export type {UiText} from './types.ts';
export {msg} from './messages.ts';
export function formatText(value:UiText,locale:Locale):string{
 if(typeof value==='string')return value;
 if(value&&'key' in value&&Array.isArray(value.args)){
  const args=value.args.map(arg=>arg&&typeof arg==='object'&&('key' in arg||'message' in arg)?formatText(arg as UiText,locale):arg);
  return (createTranslator(locale) as (key:string,...args:unknown[])=>string)(value.key,...args);
 }
 return formatDisplayError(value,locale);
}
