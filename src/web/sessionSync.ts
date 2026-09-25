import type {Json} from './api.ts';
const object=(value:unknown):value is Json=>!!value&&typeof value==='object'&&!Array.isArray(value);
const terminal=(turn:Json)=>['completed','interrupted','failed'].includes(turn.status);
// Returns null when this event cannot safely extend the current baseline.
export function applyChange(snapshot:Json,event:Json):Json|null{
  if(!object(event)||event.threadId!==snapshot.thread?.id||event.kind==='resync'||typeof event.id!=='string'||event.id.split(':')[0]!==snapshot.epoch||!Number.isSafeInteger(event.revision))return null;
  if(event.revision<=snapshot.revision)return snapshot;
  if(event.revision!==snapshot.revision+1||!object(event.patch))return null;
  const patch=event.patch;if(!['state','thread','turn','item','delta'].some(key=>object(patch[key])))return null;
  const next={...snapshot,...patch.state,revision:event.revision,syncCursor:event.id,thread:{...snapshot.thread,...patch.thread,turns:snapshot.thread.turns??[]}};
  const incoming=patch.turn,record=patch.item,delta=patch.delta;
  const turnId=incoming?.id??record?.turnId??delta?.turnId;
  if(!incoming&&!record&&!delta)return next;
  if(typeof turnId!=='string')return null;
  const turns:Json[]=[...next.thread.turns],index=turns.findIndex(turn=>turn.id===turnId),previous=index<0?{id:turnId,status:'inProgress',items:[]}:turns[index];
  let turn={...previous,items:[...(previous.items??[])]};
  if(incoming){
    if(!object(incoming)||incoming.id!==turnId||incoming.items!==undefined&&!Array.isArray(incoming.items))return null;
    if(!terminal(previous)||terminal(incoming)){
      turn={...turn,...incoming,items:turn.items};
      for(const item of incoming.items??[]){if(!object(item)||typeof item.id!=='string')return null;const n=turn.items.findIndex((old:Json)=>old.id===item.id);if(n<0)turn.items.push(item);else if(!turn.items[n]._syncCompleted||terminal(incoming))turn.items[n]=item;}
    }
  }
  if(record){
    if(!object(record.item)||typeof record.item.id!=='string')return null;
    const n=turn.items.findIndex((old:Json)=>old.id===record.item.id);
    const item={...record.item,...(record.completed?{_syncCompleted:true}:{})};
    if(!terminal(turn)||record.completed){if(n<0)turn.items.push(item);else if(!turn.items[n]._syncCompleted||record.completed)turn.items[n]=item;}
  }
  if(delta){
    const reasoning=delta.field==='summary'||delta.field==='content';
    if(!['text','aggregatedOutput','summary','content'].includes(delta.field)||typeof delta.itemId!=='string'||typeof delta.text!=='string'||!Number.isSafeInteger(delta.offset)||delta.offset<0)return null;
    if(reasoning?(!Number.isSafeInteger(delta.index)||delta.index<0||delta.index>10000):delta.index!==undefined)return null;
    const n=turn.items.findIndex((item:Json)=>item.id===delta.itemId),old=n<0?reasoning?{id:delta.itemId,type:'reasoning',summary:[],content:[]}:{id:delta.itemId,type:delta.field==='text'?'agentMessage':'commandExecution',status:'inProgress',[delta.field]:''}:turn.items[n];
    if(!terminal(turn)&&!old._syncCompleted){
      if(reasoning&&(old.type!=='reasoning'||!Array.isArray(old[delta.field])))return null;
      const text=(reasoning?old[delta.field][delta.index]:old[delta.field])??'';if(typeof text!=='string'||text.length<delta.offset)return null;
      const overlap=Math.min(text.length-delta.offset,delta.text.length);if(text.slice(delta.offset,delta.offset+overlap)!==delta.text.slice(0,overlap))return null;
      const value=text+delta.text.slice(overlap),parts=reasoning?[...old[delta.field]]:null;
      if(parts){while(parts.length<=delta.index)parts.push('');parts[delta.index]=value;}
      const item={...old,[delta.field]:parts??value};if(n<0)turn.items.push(item);else turn.items[n]=item;
    }
  }
  if(index<0)turns.push(turn);else turns[index]=turn;
  next.thread.turns=turns;return next;
}

// Older pages add history only; live state and the SSE cursor stay authoritative.
export function prependHistory(snapshot:Json,page:Json,cursor:string):Json {
  if(snapshot.history?.nextCursor!==cursor)return snapshot;
  if(!Array.isArray(page.turns)||!page.turns.every((turn:Json)=>object(turn)&&typeof turn.id==='string'&&Array.isArray(turn.items))||(page.nextCursor!==null&&typeof page.nextCursor!=='string')||page.nextCursor===cursor)throw new Error('历史分页无效，请刷新会话后重试');
  const ids=new Set((snapshot.thread.turns??[]).map((turn:Json)=>turn.id));
  const older=page.turns.filter((turn:Json)=>{if(ids.has(turn.id))return false;ids.add(turn.id);return true;});
  const attachments=new Map((snapshot.attachmentPreviews??[]).map((file:Json)=>[file.path,file]));
  for(const file of page.attachmentPreviews??[])if(!attachments.has(file.path))attachments.set(file.path,file);
  return {...snapshot,inputAnswers:{...snapshot.inputAnswers,...page.inputAnswers},history:{nextCursor:page.nextCursor},attachmentPreviews:[...attachments.values()],thread:{...snapshot.thread,turns:[...older,...snapshot.thread.turns]}};
}
