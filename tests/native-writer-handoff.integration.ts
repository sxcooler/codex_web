// Opt-in Windows native storage test. No auth, turn/start, prompt or model request.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Runtime} from '../src/codex/runtime.ts';
import {retainWriterLease} from '../src/codex/writer-lease.ts';
import {defaultCodexExecutable} from '../src/codex/executable.ts';
assert.equal(process.platform,'win32');
const home=await mkdtemp(join(resolve('.local'),'native-handoff-home-')),cwd=join(home,'workspace');
await mkdir(cwd);await writeFile(join(home,'config.toml'),'');process.env.CODEX_HOME=home;
const timestamp=new Date().toISOString(),day=timestamp.slice(0,10),ids={a:randomUUID(),b:randomUUID()},sessions=join(home,'sessions',...day.split('-'));
await mkdir(sessions,{recursive:true});
for(const id of Object.values(ids))await writeFile(join(sessions,`rollout-${day}T00-00-00-${id}.jsonl`),JSON.stringify({timestamp,type:'session_meta',payload:{session_id:id,id,timestamp,cwd,originator:'codex_remote_web',cli_version:'0.160.1',source:'appServer',model_provider:null,base_instructions:null}})+'\n');
const executable=defaultCodexExecutable(),events:any[]=[],diagnostics:any[]=[];
const report:any={startedAt:timestamp,version:execFileSync(executable,['--version'],{env:{...process.env},encoding:'utf8',windowsHide:true}).trim(),homeClass:'isolated-worktree-local',modelRequests:0,threads:ids,events,diagnostics};
const runtime=new Runtime({executable,cwd,diagnostic:event=>diagnostics.push(event)}),internal=runtime as any;
runtime.on('change',event=>{if(event.kind==='release')events.push({threadId:event.threadId,elapsedMs:Date.now()-start,ready:event.patch.state.release.handoffReady});});
const start=Date.now();let bLease:Awaited<ReturnType<typeof retainWriterLease>>|undefined;
try{
 await runtime.open(ids.a);await runtime.open(ids.b);
 const server=internal.server,pid=runtime.diagnosticState().native?.nativePid;report.nativePid=pid;
 bLease=await retainWriterLease(home,ids.b);assert.equal(await bLease.released(),false);
 const result=await runtime.release(ids.a);report.release=result;
 for(let i=0;i<100&&!internal.state(ids.a).handoffReady;i++)await new Promise(r=>setTimeout(r,20));
 assert.equal(internal.state(ids.a).handoffReady,true);assert.equal(internal.server,server);assert.equal(runtime.diagnosticState().native?.nativePid,pid);
 assert.equal(await bLease.released(),false);report.bWriterStillHeld=true;
 const loaded:any=await server.request('thread/loaded/list',{});assert.deepEqual(loaded.data,[ids.b]);report.loadedAfter=loaded.data;
 await runtime.cancelRelease(ids.a);await runtime.open(ids.a);
 assert.equal(internal.state(ids.a).handoffReady,false);assert.equal(internal.state(ids.a).released,false);
 const newA=await retainWriterLease(home,ids.a);try{assert.equal(await newA.released(),false);report.reacquiredWriterHeld=true;}finally{await newA.close();}
 await assert.rejects(newA.released(),/WRITER_CHECK_STOPPED/);report.closedHelperFailsClosed=true;
 report.passed=true;
}catch(error:any){report.passed=false;report.failure={name:error.name,code:error.code};process.exitCode=1;}
finally{await bLease?.close();await runtime.close();report.completedAt=new Date().toISOString();await writeFile(resolve('.local/native-writer-handoff-runtime.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
