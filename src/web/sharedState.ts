export const sharedStateEvent='shared-state';
export type SharedStateChange={kind:string;value?:any};

export function forwardSharedState(source:EventSource):()=>void {
  const listeners=['ready','usage','usage-invalidated','usage-error','sessions','project-catalog-invalidated'].map(kind=>{
    const listener=(event:Event)=>{
      try{window.dispatchEvent(new CustomEvent<SharedStateChange>(sharedStateEvent,{detail:{kind,...(kind==='ready'?{}:{value:JSON.parse((event as MessageEvent).data)})}}));}catch{}
    };
    source.addEventListener(kind,listener);return {kind,listener};
  });
  return()=>{for(const {kind,listener} of listeners)source.removeEventListener(kind,listener);};
}
