import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTurnSettings,rememberTurnSettings} from '../src/web/turnSettings.ts';

test('remember only confirmed portable options; storage failures never interrupt a session',t=>{
  let saved:string|null=null,writes=0;
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else delete (globalThis as any).localStorage;});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>saved,setItem:(_key:string,value:string)=>{saved=value;writes++;}}});
  const snapshot:any={phase:'IDLE',model:'current',reasoningEffort:'low',thread:{model:'stale',reasoningEffort:'high',cwd:'/project'},permissions:{approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}}};
  rememberTurnSettings(snapshot);
  assert.deepEqual(loadTurnSettings(),{model:'current',effort:'low',permissionMode:'full-access'});
  rememberTurnSettings(snapshot);assert.equal(writes,1);
  for(const phase of ['RELEASED','EXTERNAL','UNKNOWN'])rememberTurnSettings({...snapshot,phase,model:'ignored'});
  rememberTurnSettings({...snapshot,model:'ignored',permissions:null});
  rememberTurnSettings({...snapshot,model:'ignored',error:'failed'});
  assert.equal(writes,1);
  const workspace={type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
  for(const reviewer of ['user','auto_review']){
    rememberTurnSettings({...snapshot,reasoningEffort:null,permissions:{approvalPolicy:'on-request',approvalsReviewer:reviewer,sandbox:workspace}});
    assert.deepEqual(loadTurnSettings(),{model:'current',permissionMode:reviewer==='user'?'ask':'auto-review'});
  }
  for(const sandbox of [{...workspace,networkAccess:true},{...workspace,writableRoots:['/other']},{...workspace,excludeTmpdirEnvVar:false},{type:'readOnly'}]){
    rememberTurnSettings({...snapshot,permissions:{approvalPolicy:'on-request',approvalsReviewer:'user',sandbox}});
    assert.deepEqual(loadTurnSettings(),{model:'current',effort:'low'});
  }
  for(const value of ['null','[]','{broken','{"model":123}','{"effort":"high"}']){saved=value;assert.deepEqual(loadTurnSettings(),{});}
  saved='{"model":"valid","effort":123,"permissionMode":"bogus","secret":"ignored"}';
  assert.deepEqual(loadTurnSettings(),{model:'valid'});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('blocked');}});
  assert.deepEqual(loadTurnSettings(),{});assert.doesNotThrow(()=>rememberTurnSettings(snapshot));
});
