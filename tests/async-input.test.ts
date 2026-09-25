import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {AsyncInputs} from '../src/server/async-input.ts';

test('async questions use native content, deduplicate concurrent answers and preserve uncertain submissions',async()=>{
  const db=new DatabaseSync(':memory:');let sends=0,release:()=>void=()=>{};
  const runtime:any={question:async()=>({questions:[{title:'Continue?',options:['Yes','No']}]}),snapshot:async()=>({thread:{turns:[]}}),send:async(_id:string,input:any)=>{sends++;assert.match(input.text,/Continue\?/);await new Promise<void>(r=>release=r);return {turnId:'t'};}};
  try{
    const inputs=new AsyncInputs(db,runtime),request={answers:['Yes'],clientRequestId:'answer-123',expectedTurnId:'t'};
    const first=inputs.answer('s','t','q',request);await new Promise(r=>setImmediate(r));
    await assert.rejects(inputs.answer('s','t','q',{...request,clientRequestId:'answer-456'}),/already|已经/);
    release();assert.equal((await first).status,'accepted');
    assert.equal((await inputs.answer('s','t','q',request)).status,'accepted');assert.equal(sends,1);
    assert.equal(new AsyncInputs(db,runtime).states('s')['t:q'].status,'accepted');
    runtime.send=async()=>{sends++;throw Object.assign(new Error('unknown'),{statusCode:504});};
    await assert.rejects(inputs.answer('s','t','q2',request),/unknown/);
    assert.equal(inputs.states('s')['t:q2'].status,'unknown');
    await assert.rejects(inputs.answer('s','t','q2',request),/already|已经/);assert.equal(sends,2);
    inputs.reconcile('s',{thread:{turns:[{items:[{type:'userMessage',clientId:'answer-123'}]}]}});
    assert.equal(inputs.states('s')['t:q2'].status,'accepted');assert.equal(sends,2);
    await assert.rejects(inputs.answer('s','t','q3',{...request,answers:[]}),/answer|回答/);
  }finally{db.close();}
});
