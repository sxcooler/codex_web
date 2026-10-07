let guard:((proceed:()=>void)=>void)|null=null;
let position=typeof history.state?.settingsPosition==='number'?history.state.settingsPosition:0;
history.replaceState({...history.state,settingsPosition:position},'');
let restoring=false,approved=false;
export function setNavigationGuard(next:typeof guard){guard=next;return()=>{if(guard===next)guard=null;};}
export function requestLeave(proceed:()=>void){if(guard)guard(proceed);else proceed();}
window.addEventListener('popstate',event=>{
  if(restoring){restoring=false;event.stopImmediatePropagation();return;}
  const next=history.state?.settingsPosition;
  if(typeof next!=='number')return;
  if(guard&&!approved&&next!==position){
    event.stopImmediatePropagation();const delta=next-position;restoring=true;history.go(-delta);
    guard(()=>{approved=true;history.go(delta);});return;
  }
  approved=false;position=next;
},{capture:true});
export function navigate(path:string,replace=false){
  const proceed=()=>{if(!replace)position++;history[replace?'replaceState':'pushState']({...history.state,settingsPosition:position},'',path);window.dispatchEvent(new PopStateEvent('popstate'));};
  if(path!==location.pathname+location.search)requestLeave(proceed);else proceed();
}
