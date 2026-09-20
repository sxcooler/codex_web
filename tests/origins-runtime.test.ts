import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeAuth } from '../src/server/auth.ts';

test('real backend loads additional origins from config and serves both login paths', {timeout:20000},async()=>{
  const data=await mkdtemp(join(tmpdir(),'codex-origins-'));
  const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=(listener.address() as any).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
  const local=`http://localhost:${port}`,remote='https://device.example.test',password='Origin-runtime-test-only-4567';
  await initializeAuth(data,password);
  await writeFile(join(data,'config.json'),JSON.stringify({origin:local,allowedOrigins:[remote],port,workRoot:data,codexBin:process.execPath}));
  const env={...process.env,WEB_DATA_DIR:data};for(const key of ['WEB_ORIGIN','PORT','WORK_ROOT','CODEX_BIN'])delete env[key];
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/server/main.ts',import.meta.url))],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const closed=once(child,'close');
  const call=(host:string,path:string,method='GET',headers:Record<string,string>={},body?:unknown)=>new Promise<any>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,method,headers:{Host:host,...headers},timeout:1000},res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(text)});}catch(error){reject(error);}});
    });req.on('error',reject);req.on('timeout',()=>req.destroy());req.end(body===undefined?undefined:JSON.stringify(body));
  });
  try{
    let ready=false;for(let i=0;i<80;i++){if(child.exitCode!==null)assert.fail(output);try{ready=(await call(new URL(local).host,'/api/auth/session')).status===200;}catch{}if(ready)break;await delay(100);}
    assert.ok(ready,output);
    for(const origin of [local,remote]){
      const host=new URL(origin).host,session=await call(host,'/api/auth/session');assert.equal(session.status,200);
      const signed=await call(host,'/api/auth/login','POST',{Origin:origin,Cookie:session.headers['set-cookie'][0].split(';')[0],'x-csrf-token':session.body.csrfToken,'Content-Type':'application/json'},{password});
      assert.equal(signed.status,200);assert.equal(signed.headers['set-cookie'][0].includes('; Secure'),origin===remote);
      const push=await call(host,'/api/push/public-key','GET',{Cookie:signed.headers['set-cookie'][0].split(';')[0]});
      assert.equal(push.status,origin===remote?200:503);
    }
    assert.equal((await call('unknown.example','/api/auth/session')).status,403);
    assert.equal(output.includes(password),false);
  }finally{child.kill();await closed;await rm(data,{recursive:true,force:true});}
});
