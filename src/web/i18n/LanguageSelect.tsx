import {useLocale} from './LocaleProvider.tsx';
import type {LocalePreference} from './types.ts';
export function LanguageSelect(){
 const {preference,persisted,setPreference,t}=useLocale();
 return <div className="language-preference"><label>{t('locale.label')}<select aria-label={t('locale.label')} value={preference} onChange={event=>setPreference(event.target.value as LocalePreference)}><option value="system">{t('locale.system')}</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>{!persisted?<div role="alert" className="notice error">{t('locale.unsaved')}<button type="button" onClick={()=>setPreference(preference)}>{t('locale.retry')}</button></div>:null}</div>;
}
