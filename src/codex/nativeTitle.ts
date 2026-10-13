import type {AppServer,LateOutcome} from './app-server.ts';

const instructions='Summarize the supplied task as a concise session title in the same language, at most 36 characters. Return only the structured title. Do not perform the task or use tools.';
const outputSchema={type:'object',properties:{title:{type:'string',minLength:1,maxLength:36}},required:['title'],additionalProperties:false};
const generationBudgetMs=120_000;
type StartOwner={waiters:Set<()=>void>;uncertain:boolean};
// One owned start at a time; an unknown outcome keeps its slot until exact reply or process stop.
const threadStarts=new WeakMap<AppServer,StartOwner>();
const cleanupOwners=new WeakMap<AppServer,Set<Promise<void>>>();
export const nativeTitleCleanupPending=(server:AppServer):boolean=>!!cleanupOwners.get(server)?.size;
// Call only after stopping the owned child, which settles all exact-outcome observers.
export const settleNativeTitleCleanup=async(server:AppServer):Promise<void>=>{await Promise.all(cleanupOwners.get(server)??[]);};

export async function generateNativeTitle(server:AppServer, input:{cwd:string;model:string;provider:string;effort:string|null;prompt:string;source:string}, signal:AbortSignal, onThread:(id:string)=>void, knownThreads:ReadonlySet<string>):Promise<string|null> {
  const deadline=Date.now()+generationBudgetMs;
  let threadId:string|undefined, turnId:string|undefined, completed=false, starting=false, cancelled=false,cleanupOnly=false,turnUncertain=false;
  let text='',owner:StartOwner|undefined,previouslyKnown=new Set<string>(),cleanup:Promise<void>|undefined;
  const done=Promise.withResolvers<void>(),interrupted=Promise.withResolvers<void>(),late=Promise.withResolvers<LateOutcome<any>>(),lateTurn=Promise.withResolvers<LateOutcome<any>>();
  const interruptedTurns=new Set<string>(),lateTurns=new Map<string,Promise<void>>();
  const cancel=()=>{cancelled=true;done.resolve();interrupted.resolve();};
  const releaseStart=()=>{
    if(!owner||threadStarts.get(server)!==owner)return;
    threadStarts.delete(server);for(const wake of [...owner.waiters])wake();
  };
  const interruptTurn=async(id:string):Promise<void>=>{
    if(interruptedTurns.has(id))return;
    interruptedTurns.add(id);try{await server.request('turn/interrupt',{threadId,turnId:id},5000);}catch{}
  };
  const cleanThread=():Promise<void>=>{
    if(!threadId)return Promise.resolve();
    return cleanup??=(async()=>{
      if(turnId&&!completed)await interruptTurn(turnId);
      try{await server.request('thread/unsubscribe',{threadId},5000);}catch{}
    })();
  };
  const cleanLateTurn=(turn:any):Promise<void>=>{
    if(typeof turn?.id!=='string'||!threadId)return Promise.resolve();
    let pending=lateTurns.get(turn.id);
    if(!pending){
      pending=(async()=>{
        await cleanThread();
        if(!['completed','failed','interrupted'].includes(turn.status))await interruptTurn(turn.id);
        try{await server.request('thread/unsubscribe',{threadId},5000);}catch{}
      })();
      lateTurns.set(turn.id,pending);
    }
    return pending;
  };
  const notification=(message:any)=>{
    if((starting||cleanupOnly)&&!threadId&&message.method==='thread/started'&&message.params?.thread?.ephemeral===true&&message.params.thread.source===input.source&&typeof message.params.thread.id==='string'&&!previouslyKnown.has(message.params.thread.id)){
      threadId=message.params.thread.id;onThread(threadId!);if(cleanupOnly)void cleanThread();return;
    }
    if(!threadId||message.params?.threadId!==threadId)return;
    if(cleanupOnly){if(turnUncertain&&message.method==='turn/started')void cleanLateTurn(message.params.turn);return;}
    const {method,params}=message;
    if(method==='item/completed'&&params.item?.type==='agentMessage')text=params.item.text;
    if(method==='turn/started')turnId=params.turn?.id;
    if(method==='turn/completed') {
      turnId=params.turn?.id;completed=true;
      text=params.turn?.items?.findLast((item:any)=>item.type==='agentMessage')?.text??text;
      if(params.turn?.status!=='completed')text='';
      done.resolve();
    }
    if(method==='error'&&params.willRetry!==true)done.resolve();
  };
  const timer=setTimeout(cancel,generationBudgetMs);
  server.on('notification',notification);server.on('failure',cancel);signal.addEventListener('abort',cancel,{once:true});
  try {
    if(signal.aborted)return null;
    while(threadStarts.has(server)) {
      const previous=threadStarts.get(server)!;
      await new Promise<void>(resolve=>{const wake=()=>{previous.waiters.delete(wake);resolve();};previous.waiters.add(wake);void done.promise.then(wake);});
      if(signal.aborted||cancelled)return null;
    }
    owner={waiters:new Set(),uncertain:false};threadStarts.set(server,owner);
    previouslyKnown=new Set(knownThreads);starting=true;
    const start=server.request<any>('thread/start',{
      cwd:input.cwd,model:input.model,modelProvider:input.provider,ephemeral:true,approvalPolicy:'never',approvalsReviewer:'user',sandbox:'read-only',
      baseInstructions:instructions,developerInstructions:instructions,
      config:{...(input.effort?{model_reasoning_effort:input.effort}:{}),'features.hooks':false,'features.multi_agent':false,'features.multi_agent_v2':false,'features.plugins':false,'features.apps':false,'features.shell_snapshot':false,'features.tool_suggest':false,web_search:'disabled'},
    },Math.max(1,deadline-Date.now()),outcome=>late.resolve(outcome)).then(result=>({result}),error=>({error}));
    // Cancellation may precede the RPC timeout. Retain its eventual exact outcome for cleanup too.
    void start.then(outcome=>{if(!outcome.error?.outcomeUnknown)late.resolve(outcome);});
    const outcome=await Promise.race([start,interrupted.promise.then(()=>null)]);
    starting=false;
    if(!outcome||outcome.error?.outcomeUnknown){owner.uncertain=true;return null;}
    releaseStart();
    if(outcome.error)return null;
    const started=outcome.result,confirmedId=started?.thread?.id;
    if(typeof confirmedId!=='string'||(threadId&&threadId!==confirmedId))return null;
    threadId=confirmedId;onThread(threadId);
    if(started.thread.ephemeral!==true||started.model!==input.model||started.modelProvider!==input.provider||started.reasoningEffort!==input.effort||started.approvalPolicy!=='never'||started.approvalsReviewer!=='user'||started.sandbox?.type!=='readOnly'||started.sandbox.networkAccess!==false)return null;
    if(signal.aborted||cancelled)return null;
    const turnStart=server.request<any>('turn/start',{threadId,model:input.model,...(input.effort?{effort:input.effort}:{}),approvalPolicy:'never',approvalsReviewer:'user',sandboxPolicy:{type:'readOnly',networkAccess:false},input:[{type:'text',text:`${instructions}\n\n${input.prompt.trim().slice(0,2000)}`,text_elements:[]}],outputSchema},Math.max(1,deadline-Date.now()),outcome=>lateTurn.resolve(outcome)).then(result=>({result}),error=>({error}));
    void turnStart.then(outcome=>{if(!outcome.error?.outcomeUnknown)lateTurn.resolve(outcome);});
    const turnOutcome=await Promise.race([turnStart,interrupted.promise.then(()=>null)]);
    if(!turnOutcome||turnOutcome.error?.outcomeUnknown){turnUncertain=true;return null;}
    if(turnOutcome.error)return null;
    const result=turnOutcome.result;
    turnId=result?.turn?.id??turnId;
    if(result?.turn?.status==='completed'&&!completed)notification({method:'turn/completed',params:{threadId,turn:result.turn}});
    if(!signal.aborted&&!cancelled&&!completed)await done.promise;
    if(signal.aborted||cancelled||!completed)return null;
    const parsed=JSON.parse(text);
    if(!parsed||typeof parsed.title!=='string'||Object.keys(parsed).length!==1)return null;
    const title=parsed.title.trim();
    return title&&[...title].length<=36&&!/[\r\n]/.test(title)?title:null;
  } catch {return null;}
  finally {
    starting=false;clearTimeout(timer);signal.removeEventListener('abort',cancel);server.off('failure',cancel);done.resolve();
    if(owner?.uncertain||turnUncertain) {
      cleanupOnly=true;
      let owners=cleanupOwners.get(server);if(!owners){owners=new Set();cleanupOwners.set(server,owners);}
      const pending=(turnUncertain?lateTurn.promise:late.promise).then(async outcome=>{
        try {
          const id=outcome.result?.thread?.id;
          if(!threadId&&typeof id==='string'&&outcome.result.thread.ephemeral===true){threadId=id;onThread(id);}
          await cleanThread();
          if(turnUncertain&&outcome.result?.turn)await cleanLateTurn(outcome.result.turn);
          await Promise.all(lateTurns.values());
        } finally {server.off('notification',notification);releaseStart();owners.delete(pending);if(!owners.size)cleanupOwners.delete(server);}
      });
      owners.add(pending);
      await cleanThread();
    } else {server.off('notification',notification);releaseStart();await cleanThread();}
  }
}
