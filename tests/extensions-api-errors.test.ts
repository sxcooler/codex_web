import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/codex/runtime.ts';
import {Projects} from '../src/projects.ts';
import {initializeAuth} from '../src/server/auth.ts';
import {buildServer} from '../src/server/app.ts';

test('extension policy conflicts and uncertain writes keep their HTTP status without replay',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'extensions-errors-')),root=join(dir,'work');await mkdir(root);
 const runtime=new Runtime({executable:'unused',cwd:root}),dataDir=join(dir,'data');
 let failure={statusCode:409,code:'EXTENSION_READ_ONLY',message:'Managed configuration'},calls=0;
 t.mock.method(runtime,'changeExtension',async()=>{calls++;throw Object.assign(new Error(failure.message),failure);});
 await initializeAuth(dataDir,'extensions-test-password');
 const app=await buildServer({dataDir,origin:'http://localhost:3000',projects:new Projects(root),runtime});
 t.after(async()=>{await app.close();await runtime.close();assert.ok(dir.startsWith(join(tmpdir(),'extensions-errors-')));await rm(dir,{recursive:true,force:true});});
 const csrf=await app.inject({url:'/api/auth/session',headers:{host:'localhost:3000'}});
 const headers:any={host:'localhost:3000',origin:'http://localhost:3000','x-csrf-token':csrf.json().csrfToken,cookie:String(csrf.headers['set-cookie']).split(';')[0]};
 const login=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{password:'extensions-test-password'}});headers.cookie+='; '+String(login.headers['set-cookie']).split(';')[0];
 for(const state of [{statusCode:409,code:'EXTENSION_READ_ONLY',message:'Managed configuration'},{statusCode:504,code:'EXTENSION_WRITE_UNKNOWN',message:'Outcome uncertain'}]){
  failure=state;
  const response=await app.inject({method:'POST',url:'/api/codex/extensions/action',headers,payload:{action:'mcp.reload'}});
  assert.equal(response.statusCode,state.statusCode);assert.equal(response.json().code,state.code);
 }
 assert.equal(calls,2);
});
