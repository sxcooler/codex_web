import {createRoot} from 'react-dom/client';
import {LocaleProvider,useLocale} from '../src/web/i18n/LocaleProvider.tsx';
import {PaneLayout} from '../src/web/PaneLayout.tsx';
import {drafts} from '../src/web/drafts.ts';
import {Session} from '../src/web/SessionView.tsx';
import '../src/web/style.css';
const changed=async()=>{};
const initial=(window as any).fixtureInitial;if(initial)drafts.set('i18n-test',{initialSnapshot:initial,text:'Preserved history draft',settings:{},attachments:[]});
function Fixture(){
 const {setPreference}=useLocale();
 return <div style={{height:'100dvh',display:'flex',flexDirection:'column',overflow:'hidden'}}>
  <div><button id="english" onClick={()=>setPreference('en')}>English</button><button id="chinese" onClick={()=>setPreference('zh-CN')}>中文</button></div>
  <PaneLayout className="feedback-frame"><div className="workspace"><div className="workspace-content"><Session id="i18n-test" onChanged={changed} onReleased={()=>{}} onNotificationHandled={()=>{}}/></div></div></PaneLayout>
 </div>;
}
const style=document.createElement('style');style.textContent='.feedback-frame{display:flex;flex:1;min-height:0}.feedback-frame>.workspace{flex:1}';document.head.append(style);
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{locale:'zh-CN',preference:'zh-CN',persisted:true}}><Fixture/></LocaleProvider>);
