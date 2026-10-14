import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeAuth} from '../src/server/auth.ts';
import {buildServer} from '../src/server/app.ts';

test('auth and generic HTTP failures add stable display codes while keeping original messages and statuses',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'i18n-auth-'));await initializeAuth(dir,'fixture-password-long-enough');
 const app=await buildServer({dataDir:dir,origin:'http://localhost:3000'});
 try{
  const denied=await app.inject({url:'/api/auth/session',headers:{host:'invalid.test'}});
  assert.equal(denied.statusCode,403);assert.deepEqual(denied.json(),{error:'Forbidden',code:'REQUEST_FORBIDDEN'});
  const missing=await app.inject({url:'/api/missing',headers:{host:'localhost:3000'}});
  assert.equal(missing.statusCode,404);assert.deepEqual(missing.json(),{error:'Not found',code:'ROUTE_NOT_FOUND'});
  const csrf=await app.inject({url:'/api/auth/session',headers:{host:'localhost:3000'}});
  const headers={host:'localhost:3000',origin:'http://localhost:3000','x-csrf-token':csrf.json().csrfToken,cookie:String(csrf.headers['set-cookie']).split(';')[0]};
  const malformed=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{password:123}});
  assert.equal(malformed.statusCode,400);assert.deepEqual(malformed.json(),{error:'Invalid request',code:'REQUEST_VALIDATION_FAILED'});
  const invalid=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{password:'wrong-password-long-enough'}});
  assert.equal(invalid.statusCode,401);assert.deepEqual(invalid.json(),{error:'Invalid credentials',code:'AUTH_INVALID_CREDENTIALS'});
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
