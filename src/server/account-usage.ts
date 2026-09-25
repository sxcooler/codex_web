import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {Runtime} from '../codex/runtime.ts';

type Operation={accountId:string;creditId:string;idempotencyKey:string};
type Usage=Record<string,any>;
const error=(statusCode:number,code:string,message:string)=>Object.assign(new Error(message),{statusCode,code});
const object=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:any)=>typeof value==='string'?value:null;
const finite=(value:any)=>typeof value==='number'&&Number.isFinite(value)?value:null;
const timestamp=(value:any)=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000?value:null;
const count=(value:any)=>typeof value==='bigint'&&value>=0n?value.toString():Number.isSafeInteger(value)&&value>=0?String(value):typeof value==='string'&&/^\d+$/.test(value)?BigInt(value).toString():null;
const window=(value:any)=>object(value)?{usedPercent:finite(value.usedPercent),windowDurationMins:finite(value.windowDurationMins),resetsAt:timestamp(value.resetsAt)}:null;
const bucket=(value:any)=>object(value)?{limitId:text(value.limitId),limitName:text(value.limitName),primary:window(value.primary),secondary:window(value.secondary)}:null;
const outcomes=new Set(['reset','nothingToReset','noCredit','alreadyRedeemed']);

export class AccountUsage {
  private runtime:Runtime;
  private db:DatabaseSync;
  private cache?:{identity:string;data:Usage};
  private loading?:Promise<Usage>;
  private loadingForced=false;
  private generation=0;
  private identity?:string;
  private accountUnverified=false;
  private operations=new Map<string,{key:string;credit:string;promise:Promise<any>}>();
  constructor(runtime:Runtime,db:DatabaseSync){
    this.runtime=runtime;this.db=db;
    db.exec('CREATE TABLE IF NOT EXISTS account_reset_operations(idempotency_key TEXT PRIMARY KEY,account_id TEXT NOT NULL,credit_id TEXT NOT NULL,outcome TEXT,created_at INTEGER NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS account_reset_pending ON account_reset_operations(account_id) WHERE outcome IS NULL');
    runtime.on('accountChanged',this.invalidate);
  }
  invalidate=()=>{this.cache=undefined;this.accountUnverified=true;this.generation++;};
  close(){this.runtime.off('accountChanged',this.invalidate);this.invalidate();}

  read(refresh=false):Promise<Usage>{
    if(this.loading)return refresh&&!this.loadingForced?this.loading.catch(()=>{}).then(()=>this.read(true)):this.loading;
    this.loadingForced=refresh;
    const generation=this.generation;
    this.loading=(async()=>{
      const identity=await this.runtime.accountIdentity();
      if(this.identity&&this.identity!==identity.identity)this.accountUnverified=true;
      this.identity=identity.identity;
      if(this.cache?.identity!==identity.identity)this.cache=undefined;
      if(generation!==this.generation)throw error(409,'ACCOUNT_CHANGED','账户状态已变化，请重新读取用量。');
      if(!refresh&&this.cache&&Date.now()-this.cache.data.updatedAt<30_000)return this.withPending(this.cache.data);
      const raw=await this.runtime.readAccountUsage(),after=await this.runtime.accountIdentity();
      if(identity.identity!==after.identity||generation!==this.generation){this.invalidate();throw error(409,'ACCOUNT_CHANGED','账户状态已变化，请重新读取用量。');}
      const accountId=typeof raw?.accountId==='string'&&raw.accountId?createHash('sha256').update(raw.accountId).digest('hex'):null;
      const credits=raw?.rateLimitResetCredits;
      const data:Usage={accountId,updatedAt:Date.now(),rateLimits:bucket(raw?.rateLimits),rateLimitsByLimitId:object(raw?.rateLimitsByLimitId)?Object.fromEntries(Object.entries(raw.rateLimitsByLimitId).map(([key,value])=>[key,bucket(value)])):null,
        rateLimitResetCredits:object(credits)?{availableCount:count(credits.availableCount),credits:Array.isArray(credits.credits)?credits.credits.filter(object).map((credit:any)=>({id:text(credit.id),resetType:text(credit.resetType),status:text(credit.status),title:text(credit.title),description:text(credit.description),grantedAt:timestamp(credit.grantedAt),...(credit.expiresAt===null?{expiresAt:null}:timestamp(credit.expiresAt)!==null?{expiresAt:timestamp(credit.expiresAt)}:{})})):null}:null,
        resetSupported:!!accountId&&identity.resetProtocol&&after.resetProtocol,
        resetUnavailableReason:!accountId?'原生服务未提供可靠账户标识，暂不能使用重置机会。':!identity.resetProtocol||!after.resetProtocol?'当前账户类型不支持使用重置机会，仍可查看用量。':undefined};
      if(!data.rateLimits&&!data.rateLimitsByLimitId&&!data.rateLimitResetCredits)throw error(503,'ACCOUNT_USAGE_UNAVAILABLE','原生用量接口暂不可用。');
      if(generation===this.generation)this.cache={identity:after.identity,data};
      this.accountUnverified=false;
      return this.withPending(data);
    })().catch(cause=>{if(this.accountUnverified)throw error(409,'ACCOUNT_CHANGED','当前账户状态暂无法核实，请刷新用量。');throw cause;}).finally(()=>{this.loading=undefined;});
    return this.loading;
  }

  private withPending(data:Usage):Usage{
    const pending=data.accountId?this.db.prepare('SELECT account_id AS accountId,credit_id AS creditId,idempotency_key AS idempotencyKey FROM account_reset_operations WHERE account_id=? AND outcome IS NULL').get(data.accountId):null;
    return {...data,pendingReset:pending??null};
  }

  reset(input:Operation):Promise<any>{
    if(!input||!/^[a-f0-9]{64}$/.test(input.accountId)||typeof input.creditId!=='string'||!input.creditId.trim()||input.creditId.length>512||/[\x00-\x1f\x7f]/.test(input.creditId)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.idempotencyKey))return Promise.reject(error(400,'ACCOUNT_INVALID_INPUT','重置参数无效。'));
    const running=this.operations.get(input.accountId);
    if(running)return running.key===input.idempotencyKey&&running.credit===input.creditId?running.promise:Promise.reject(error(409,'ACCOUNT_RESET_BUSY','本账户已有重置操作，请先核实其结果。'));
    const promise=this.performReset(input).finally(()=>{this.operations.delete(input.accountId);this.invalidate();});
    this.operations.set(input.accountId,{key:input.idempotencyKey,credit:input.creditId,promise});return promise;
  }

  private async performReset(input:Operation){
    // Await any earlier read, then force a new snapshot for this confirmation.
    if(this.loading)await this.loading.catch(()=>{});
    const usage=await this.read(true);
    if(usage.accountId!==input.accountId)throw error(409,'ACCOUNT_CHANGED','账户已变化，请重新选择重置机会。');
    if(!usage.resetSupported)throw error(409,'ACCOUNT_RESET_UNSUPPORTED',usage.resetUnavailableReason);
    const previous=this.db.prepare('SELECT * FROM account_reset_operations WHERE idempotency_key=?').get(input.idempotencyKey) as any;
    if(previous){
      if(previous.account_id!==input.accountId||previous.credit_id!==input.creditId)throw error(409,'ACCOUNT_RESET_CONFLICT','操作标识与此前请求不一致。');
      if(previous.outcome)return {outcome:previous.outcome};
    }else{
      if(this.db.prepare('SELECT 1 FROM account_reset_operations WHERE account_id=? AND outcome IS NULL').get(input.accountId))throw error(409,'ACCOUNT_RESET_BUSY','本账户已有结果待核实的操作，请先核实原操作。');
      const credit=usage.rateLimitResetCredits?.credits?.find((credit:any)=>credit.id===input.creditId);
      if(!credit||credit.resetType!=='codexRateLimits'||credit.status!=='available'||!(credit.expiresAt===null||timestamp(credit.expiresAt)!==null&&credit.expiresAt>Date.now()/1000)||!usage.rateLimitResetCredits?.availableCount||BigInt(usage.rateLimitResetCredits.availableCount)===0n)throw error(409,'ACCOUNT_CREDIT_UNAVAILABLE','该重置机会已不可用或详情尚未确认，请刷新用量。');
      // Persist before native mutation. An unknown outcome blocks new operations even after restart.
      this.db.prepare('INSERT INTO account_reset_operations VALUES(?,?,?,NULL,?)').run(input.idempotencyKey,input.accountId,input.creditId,Date.now());
    }
    try {
      const result=await this.runtime.consumeAccountReset({creditId:input.creditId,idempotencyKey:input.idempotencyKey},input.accountId);
      if(!outcomes.has(result?.outcome))throw error(504,'ACCOUNT_RESET_UNKNOWN','重置结果待核实，请重试本次操作。');
      this.db.prepare('UPDATE account_reset_operations SET outcome=? WHERE idempotency_key=?').run(result.outcome,input.idempotencyKey);
      return {outcome:result.outcome};
    }catch(cause){
      if(object(cause)&&['RUNTIME_ACCOUNT_CHANGED','RUNTIME_ACCOUNT_UNSUPPORTED'].includes((cause as any).code)){
        // Only a new attempt is known not to have run; a previous uncertain attempt must retain its key.
        if(!previous){
          this.db.prepare('DELETE FROM account_reset_operations WHERE idempotency_key=? AND outcome IS NULL').run(input.idempotencyKey);
          throw error(409,(cause as any).code==='RUNTIME_ACCOUNT_CHANGED'?'ACCOUNT_CHANGED':'ACCOUNT_RESET_UNSUPPORTED',(cause as Error).message);
        }
      }
      throw error(504,'ACCOUNT_RESET_UNKNOWN','重置结果待核实，请使用原操作标识重试；不要另建操作。');
    }
  }
}
