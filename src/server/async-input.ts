import type {DatabaseSync} from 'node:sqlite';
import type {Runtime} from '../codex/runtime.ts';

const invalid=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode,code:'RUNTIME_INPUT_ANSWER'});
export class AsyncInputs {
  private active=new Set<string>();
  private db:DatabaseSync;
  private runtime:Runtime;
  constructor(db:DatabaseSync,runtime:Runtime){
    this.db=db;this.runtime=runtime;
    db.exec(`CREATE TABLE IF NOT EXISTS input_answers(thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,item_id TEXT NOT NULL,request_id TEXT NOT NULL,signature TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(thread_id,turn_id,item_id));`);
  }
  states(threadId:string):Record<string,{status:string}>{
    const rows=this.db.prepare('SELECT turn_id,item_id,status FROM input_answers WHERE thread_id=?').all(threadId) as any[];
    return Object.fromEntries(rows.map(row=>[row.turn_id+':'+row.item_id,{status:row.status}]));
  }
  reconcile(threadId:string,snapshot:any){
    const accepted=new Set((snapshot.thread.turns??[]).flatMap((turn:any)=>(turn.items??[]).filter((item:any)=>item.type==='userMessage').map((item:any)=>item.clientId)));
    const rows=this.db.prepare("SELECT request_id FROM input_answers WHERE thread_id=? AND status='unknown'").all(threadId) as any[];
    for(const row of rows)if(accepted.has(row.request_id))this.db.prepare("UPDATE input_answers SET status='accepted' WHERE thread_id=? AND request_id=?").run(threadId,row.request_id);
  }
  async answer(threadId:string,turnId:string,itemId:string,input:{answers:string[];clientRequestId:string;expectedTurnId?:string}){
    const key=JSON.stringify([threadId,turnId,itemId]),signature=JSON.stringify(input.answers);
    const old=this.db.prepare('SELECT * FROM input_answers WHERE thread_id=? AND turn_id=? AND item_id=?').get(threadId,turnId,itemId) as any;
    if(old){
      if(old.status==='accepted'&&old.signature===signature)return {status:'accepted'};
      if(old.status==='unknown'&&!this.active.has(key)){
        const snapshot=await this.runtime.snapshot(threadId,{window:true});
        if(snapshot.thread.turns?.some((turn:any)=>turn.items?.some((item:any)=>item.type==='userMessage'&&item.clientId===old.request_id))){
          this.db.prepare("UPDATE input_answers SET status='accepted' WHERE thread_id=? AND turn_id=? AND item_id=?").run(threadId,turnId,itemId);
          if(old.signature===signature)return {status:'accepted'};
        }
      }
      throw invalid('这个提问已经提交或结果待核实，请检查历史；不会自动重发。');
    }
    if(this.active.has(key))throw invalid('这个提问已经在提交。');
    this.active.add(key);
    try{
      const item=await this.runtime.question(threadId,turnId,itemId);
      if(!Array.isArray(input.answers)||input.answers.length!==item.questions.length||input.answers.some(a=>typeof a!=='string'||!a.trim()||a.length>12000))throw invalid('每个问题都需要有效回答。',400);
      const text='关于你的提问：\n'+item.questions.map((q:any,i:number)=>`${i+1}. ${q.title}\n回答：${input.answers[i]}`).join('\n\n');
      if(text.length>12000)throw invalid('回答内容过长。',400);
      this.db.prepare("INSERT INTO input_answers VALUES(?,?,?,?,?,'unknown')").run(threadId,turnId,itemId,input.clientRequestId,signature);
      try{
        const result=await this.runtime.send(threadId,{text,clientRequestId:input.clientRequestId,...(input.expectedTurnId?{expectedTurnId:input.expectedTurnId}:{})});
        this.db.prepare("UPDATE input_answers SET status='accepted' WHERE thread_id=? AND turn_id=? AND item_id=?").run(threadId,turnId,itemId);
        return {...result,status:'accepted'};
      }catch(error:any){
        if(error.statusCode>=400&&error.statusCode<500)this.db.prepare('DELETE FROM input_answers WHERE thread_id=? AND turn_id=? AND item_id=?').run(threadId,turnId,itemId);
        throw error;
      }
    }finally{this.active.delete(key);}
  }
}
