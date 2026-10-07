export type PanelTab='changes'|'files'|'history';
type Reading={collapsed:boolean;listScroll:number;previewScroll:number;contentScroll:number};
type FileVisit={path:string;fragment:string;mode:'preview'|'source';contentScroll:number};
export type PanelState={tab:PanelTab;changes:{staged:boolean;path:string;split:boolean}&Reading;files:{directory:string;back:FileVisit[];forward:FileVisit[];recent:string[]}&FileVisit&Reading;history:{ref:string;commit:string;parent:string;path:string;scroll:number;listScroll:number;pages:number;listCollapsed:boolean;filesCollapsed:boolean;filesScroll:number}};
export type StorageLike=Pick<Storage,'getItem'|'setItem'>;
// ponytail: panel responses are refetchable; keep 20 recent entries unless measured navigation needs more.
export function cacheEntry<T>(cache:Record<string,T>,entryKey:string,value:T,limit=20):Record<string,T>{const next={...cache};delete next[entryKey];next[entryKey]=value;for(const key of Object.keys(next).slice(0,-limit))delete next[key];return next;}
const initial=():PanelState=>({tab:'changes',changes:{collapsed:false,staged:false,path:'',split:false,listScroll:0,previewScroll:0,contentScroll:0},files:{collapsed:false,directory:'',path:'',fragment:'',back:[],forward:[],recent:[],mode:'preview',listScroll:0,previewScroll:0,contentScroll:0},history:{listCollapsed:false,filesCollapsed:false,filesScroll:0,ref:'HEAD',commit:'',parent:'',path:'',scroll:0,listScroll:0,pages:1}});
const key=(projectId:string)=>'codex.project-panel.'+projectId;
const string=(value:unknown,fallback='')=>typeof value==='string'?value:fallback;
const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
const reading=(value:any):Reading=>({collapsed:value?.collapsed===true,listScroll:number(value?.listScroll),previewScroll:number(value?.previewScroll),contentScroll:number(value?.contentScroll)});
const fileVisit=(value:any):FileVisit=>({path:string(value?.path),fragment:string(value?.fragment),mode:value?.mode==='source'?'source':'preview',contentScroll:number(value?.contentScroll)});
const visits=(value:any):FileVisit[]=>Array.isArray(value)?value.map(fileVisit).filter(visit=>visit.path).slice(-20):[];
const recentFiles=(value:any,path:string):string[]=>[...new Set([path,...(Array.isArray(value)?value:[])].filter((path):path is string=>typeof path==='string'&&!!path))].slice(0,20);
export function loadPanelState(storage:StorageLike,projectId:string):PanelState{try{const value=JSON.parse(storage.getItem(key(projectId))??'null'),fallback=initial();if(!value||!['changes','files','history'].includes(value.tab))return fallback;return {tab:value.tab,changes:{staged:typeof value.changes?.staged==='boolean'?value.changes.staged:false,path:string(value.changes?.path),split:typeof value.changes?.split==='boolean'?value.changes.split:false,...reading(value.changes)},files:{directory:string(value.files?.directory),...fileVisit(value.files),back:visits(value.files?.back),forward:visits(value.files?.forward),recent:recentFiles(value.files?.recent,string(value.files?.path)),...reading(value.files)},history:{listCollapsed:value.history?.listCollapsed===true,filesCollapsed:value.history?.filesCollapsed===true,filesScroll:number(value.history?.filesScroll),ref:string(value.history?.ref,'HEAD'),commit:string(value.history?.commit),parent:string(value.history?.parent),path:string(value.history?.path),scroll:number(value.history?.scroll),listScroll:number(value.history?.listScroll),pages:Number.isInteger(value.history?.pages)&&value.history.pages>=1&&value.history.pages<=100?value.history.pages:1}};}catch{return initial();}}
export function savePanelState(storage:StorageLike,projectId:string,state:PanelState){try{storage.setItem(key(projectId),JSON.stringify(state));}catch{}}

export function openPanelFile(state:PanelState,path:string,fragment='',direction?:'back'|'forward'):PanelState{
 const files=state.files,here={...fileVisit(files),path:files.path||files.recent[0]||''};
 const target=direction?files[direction].at(-1):{path,fragment,mode:'preview' as const,contentScroll:0};
 if(!target?.path)return state;
 const changed=here.path!==target.path;
 // ponytail: retain 20 file visits per direction; increase only if longer browsing sessions need it.
 const push=(stack:FileVisit[])=>here.path?[...stack,here].slice(-20):stack;
 const back=direction==='back'?files.back.slice(0,-1):direction==='forward'||changed?push(files.back):files.back;
 const forward=direction==='forward'?files.forward.slice(0,-1):direction==='back'?push(files.forward):changed?[]:files.forward;
 return {...state,tab:'files',files:{...files,...target,directory:target.path.split('/').slice(0,-1).join('/'),back,forward,recent:recentFiles(files.recent,target.path),listScroll:0,previewScroll:0}};
}
