import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {createTranslator} from './messages.ts';
import {formatText} from './text.ts';
import {browserLanguages,initialLocaleState,isLocalePreference,localeKey,readLocalePreference,resolveLocale,writeLocalePreference} from './locale.ts';
import type {LocalePreference,LocaleState,UiText} from './types.ts';
const defaults={preference:'system' as LocalePreference,locale:'zh-CN' as const,persisted:true,setPreference:(_value:LocalePreference)=>{},t:createTranslator('zh-CN'),text:(value:UiText)=>formatText(value,'zh-CN')};
const Context=createContext(defaults as Omit<typeof defaults,'locale'>&{locale:LocaleState['locale']});
export function LocaleProvider({children,initial}:{children:ReactNode;initial?:LocaleState}){
 const [state,setState]=useState(initial??initialLocaleState),current=useRef(state);
 const apply=useCallback((next:LocaleState)=>{
  current.current=next;
  if(typeof document!=='undefined'){document.documentElement.lang=next.locale;document.documentElement.dir='ltr';}
  setState(old=>old.preference===next.preference&&old.locale===next.locale&&old.persisted===next.persisted?old:next);
 },[]);
 const setPreference=useCallback((preference:LocalePreference)=>{
  if(!isLocalePreference(preference))return;
  const persisted=writeLocalePreference(preference);
  apply({preference,locale:resolveLocale(preference,browserLanguages()),persisted});
  if(persisted)window.dispatchEvent(new Event('locale-changed'));
 },[apply]);
 useEffect(()=>{
  apply(current.current);
  const synchronize=(event:Event)=>{
   if(event.type==='storage'&&(event as StorageEvent).key!==localeKey&&(event as StorageEvent).key!==null)return;
   if(!current.current.persisted)return;
   const preference=readLocalePreference();apply({preference,locale:resolveLocale(preference,browserLanguages()),persisted:true});
  };
  const language=()=>{const previous=current.current;if(previous.preference==='system')apply({...previous,locale:resolveLocale('system',browserLanguages())});};
  window.addEventListener('storage',synchronize);window.addEventListener('locale-changed',synchronize);window.addEventListener('languagechange',language);
  return()=>{window.removeEventListener('storage',synchronize);window.removeEventListener('locale-changed',synchronize);window.removeEventListener('languagechange',language);};
 },[apply]);
 const t=useMemo(()=>createTranslator(state.locale),[state.locale]);
 const text=useCallback((value:UiText)=>formatText(value,state.locale),[state.locale]);
 const value=useMemo(()=>({...state,setPreference,t,text}),[state,setPreference,t,text]);
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useLocale=()=>useContext(Context);
