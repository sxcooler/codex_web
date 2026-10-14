import {formatDateTime} from './i18n/format.ts';
import {useLocale} from './i18n/LocaleProvider.tsx';
import type {UiText} from './i18n/types.ts';
import {useEffect,useRef,useState} from 'react';
import {api} from './api.ts';
import type {InstalledPluginsSnapshot} from '../codex/installed-plugins.ts';
export function InstalledPlugins(){
 const {t,text,locale}=useLocale();
 const reasons={disabled_by_admin:t("settings.plugins.adminDisabled"),plan_not_eligible:t("settings.plugins.ineligible"),required_app_unavailable:t("settings.plugins.appUnavailable")};
 const [snapshot,setSnapshot]=useState<InstalledPluginsSnapshot|null>(null),[error,setError]=useState<UiText>(''),[busy,setBusy]=useState(false),[search,setSearch]=useState('');const errorBox=useRef<HTMLDivElement>(null),reading=useRef(false);
 const read=async(signal?:AbortSignal)=>{if(reading.current)return;reading.current=true;setBusy(true);setError('');try{const result=await api('/codex/plugins',undefined,signal);if(!signal?.aborted)setSnapshot(result);}catch(e:any){if(!signal?.aborted)setError(e);}finally{reading.current=false;if(!signal?.aborted)setBusy(false);}};
 useEffect(()=>{const controller=new AbortController();void read(controller.signal);return()=>controller.abort();},[]);
 useEffect(()=>{if(error)errorBox.current?.focus();},[error]);
 const items=snapshot?.items.filter(plugin=>(plugin.name??plugin.id).toLocaleLowerCase().includes(search.toLocaleLowerCase()))??[];
 return <div className="settings-editor"><p className="muted">{t("settings.plugins.help")}</p>
  <div className="actions"><button disabled={busy} aria-busy={busy} onClick={()=>void read()}>{busy?t("settings.refreshing"):t("settings.plugins.refresh")}</button></div>
  {error?<div ref={errorBox} tabIndex={-1} role="alert" className="notice error">{text(error)}{snapshot?.supported?t("settings.plugins.retained"):''}</div>:null}
  {snapshot?.supported?<><p className="muted small" data-testid="plugins-updated">{t('settings.plugins.updated',snapshot.updatedAt===null?t('settings.unknown'):formatDateTime(snapshot.updatedAt,locale))}</p>{snapshot.partial?<p className="notice">{t('settings.plugins.partial',snapshot.errorCount)}</p>:null}
   <label>{t("settings.plugins.search")}<input type="search" aria-label={t("settings.plugins.search")} value={search} onChange={event=>setSearch(event.target.value)}/></label>
   {items.length?<ul className="installed-plugins settings-card">{items.map(plugin=><li key={plugin.key}><details className="plugin-details"><summary className="settings-row"><div><h3>{plugin.name??plugin.id}</h3><p className="plugin-summary-description">{plugin.description??t("settings.plugins.descriptionUnknown")}</p></div><span className="plugin-status">{plugin.enabled===true?t("settings.enabled"):plugin.enabled===false?t("settings.disabled"):t("settings.plugins.statusUnknown")}<span className="plugin-detail-hint">{t("settings.plugins.details")}</span></span></summary><div className="settings-details"><p>{plugin.description??t("settings.plugins.descriptionUnknown")}</p><p>{t('settings.plugins.version',plugin.localVersion??t('settings.unknown'))}</p><p>{t('settings.plugins.marketplace',plugin.marketplace??t('settings.plugins.sourceUnknown'))}</p><p className="path">{t('settings.plugins.identity',plugin.id,plugin.key)}</p><p className="muted small">{t('settings.plugins.availability',plugin.availability==='AVAILABLE'?t('settings.plugins.available'):plugin.availability==='DISABLED_BY_ADMIN'?t('settings.plugins.adminDisabled'):t('settings.unknown'),plugin.reason?reasons[plugin.reason]:t('settings.unknown'))}</p></div></details></li>)}</ul>:search?<p>{t("settings.plugins.noMatches")}</p>:!snapshot.partial?<p>{t("settings.plugins.empty")}</p>:<p>{t("settings.plugins.partialEmpty")}</p>}
  </>:snapshot?<p className="notice">{t("settings.plugins.unsupported")}</p>:busy?<p role="status">{t("settings.plugins.loading")}</p>:null}
 </div>;
}
