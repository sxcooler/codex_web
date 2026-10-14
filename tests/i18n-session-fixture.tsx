import {createRoot} from 'react-dom/client';
import {LocaleProvider,useLocale} from '../src/web/i18n/LocaleProvider.tsx';
import {PaneLayout} from '../src/web/PaneLayout.tsx';
import {Session} from '../src/web/SessionView.tsx';
import '../src/web/style.css';
const changed=async()=>{};
function Fixture(){const {setPreference}=useLocale();return <><button id="english" onClick={()=>setPreference('en')}>English</button><button id="chinese" onClick={()=>setPreference('zh-CN')}>中文</button><PaneLayout className="app"><Session id="i18n-test" onChanged={changed} onReleased={()=>{}} onNotificationHandled={()=>{}}/></PaneLayout></>;}
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{locale:'zh-CN',preference:'zh-CN',persisted:true}}><Fixture/></LocaleProvider>);
