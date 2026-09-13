import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionId, reconcileMessages, type Outgoing, type Submission } from '../src/web/submission.ts';
test('an ambiguous submission keeps its identity; an edited or confirmed new intent gets a new id',()=>{
  const ref:Submission={current:null};
  const first=submissionId(ref,{text:'task'});
  assert.equal(submissionId(ref,{text:'task'}),first);
  assert.notEqual(submissionId(ref,{text:'edited task'}),first);
  ref.current=null;
  assert.notEqual(submissionId(ref,{text:'task'}),first);
});
test('optimistic messages reconcile by native client id, never by repeated text',()=>{
  const messages:Outgoing[]=['first','second'].map(id=>({id,text:'same text',settings:{},attachments:[],status:'sending'}));
  assert.equal(reconcileMessages(messages,[{type:'agentMessage',clientId:'first'}]),messages);
  assert.equal(reconcileMessages(messages,[{type:'userMessage',clientId:null}]),messages);
  assert.deepEqual(reconcileMessages(messages,[{type:'userMessage',clientId:'first'}]),[messages[1]]);
});
