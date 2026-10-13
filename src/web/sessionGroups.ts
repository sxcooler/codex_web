type Project={name:string;path:string};
type Session=Record<string,any>;

// Comparison keys only; project grouping never changes the native cwd.
function pathKey(path:string){
  let normalized=path.replaceAll('\\','/');
  if(/^\/\/\?\/UNC\//i.test(normalized))normalized='//'+normalized.slice(8);
  else if(/^\/\/\?\/[a-z]:\//i.test(normalized))normalized=normalized.slice(4);
  normalized=normalized.replace(/\/+$/,'')||'/';
  return /^[a-z]:(?:\/|$)/i.test(normalized)||normalized.startsWith('//')?normalized.toLowerCase():normalized;
}

function desktopProjectless(session:Session,key:string,root:string|null){
  if(!root||session.originator!=='Codex Desktop'||session.projectId!==null||session.gitInfo!==null||session.metadata?.project_path)return false;
  const prefix=pathKey(root)+'/';if(!key.startsWith(prefix))return false;
  const match=/^(\d{4})-(\d{2})-(\d{2})\/([^/]+)$/.exec(key.slice(prefix.length));
  if(!match||match[4]==='.'||match[4]==='..')return false;
  const [year,month,day]=match.slice(1,4).map(Number),date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day;
}

export function sessionGroups<T extends Session>(sessions:T[],projects:Project[],workRoot:string|null,desktopProjectlessRoot:string|null,catalog?:{state:string;projects:{id:string;name:string;roots:{path:string}[]}[]}){
  const groups=new Map<string,{key:string;name:string;path:string;items:T[]}>(),registered=new Map(projects.map(project=>[pathKey(project.path),project]));
  const nativeRoots=new Map((catalog?.state==='ready'?catalog.projects:[]).map(project=>{
    const roots=[...new Set(project.roots.map(root=>pathKey(root.path)).filter(key=>registered.has(key)))];
    return [project.id,roots.length===1?registered.get(roots[0])!.path:undefined];
  }));
  for(const session of sessions){
    const nativePath=typeof session.cwd==='string'&&session.cwd?session.cwd:null;
    const knownCwd=nativePath&&registered.has(pathKey(nativePath))?nativePath:null;
    const path=session.metadata?.project_path||knownCwd||nativeRoots.get(session.projectId)||nativePath||'',key=path?pathKey(path):'';
    const project=registered.get(key),noProject=!project&&(!path||!!workRoot&&key===pathKey(workRoot)||!!nativePath&&desktopProjectless(session,key,desktopProjectlessRoot)),groupKey=noProject?'':key;
    let group=groups.get(groupKey);
    if(!group){group={key:groupKey,name:noProject?'无项目':project?.name||path.replaceAll('\\','/').replace(/\/+$/,'').split('/').at(-1)||path,path:noProject?'':project?.path||path,items:[]};groups.set(groupKey,group);}
    group.items.push(session);
  }
  return [...groups.values()];
}
