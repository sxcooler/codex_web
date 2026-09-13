import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Projects } from '../src/projects.ts';
import { parseTestReport } from '../src/server/test-reports.ts';

test('imports bounded JUnit only for a command item in the same snapshot', async()=>{
 const root=await mkdtemp(join(tmpdir(),'reports-'));
 try { const projects=new Projects(root); const p=await projects.create({name:'p',folderName:'p'});
  await writeFile(join(p.path,'junit.xml'),'<?xml version="1.0"?><testsuite name="unit" tests="2" failures="1" time="0.3"><testcase name="ok" time="0.1"/><testcase name="bad" time="0.2"><failure message="nope"/></testcase></testsuite>');
  const snapshot:any={thread:{turns:[{startedAt:(Date.now()-10_000)/1000,items:[{type:'commandExecution',id:'cmd-1',status:'completed'}]}]}};
  const report=await parseTestReport(projects,p.id,snapshot,{commandItemId:'cmd-1',relativePath:'junit.xml',format:'junit'});
  assert.deepEqual(report.summary,{passed:1,failed:1,skipped:0,errors:0,durationMs:300}); assert.equal(report.cases[1].message,'nope');
  assert.equal(report.source.stale,true); assert.equal(report.source.freshness,'unknown');
  snapshot.thread.turns[0].items[0].startedAtMs=Date.now()+10_000;
  const stale=await parseTestReport(projects,p.id,snapshot,{commandItemId:'cmd-1',relativePath:'junit.xml',format:'junit'}); assert.equal(stale.source.freshness,'stale');
  snapshot.thread.turns[0].items[0].startedAtMs=0;
  const fresh=await parseTestReport(projects,p.id,snapshot,{commandItemId:'cmd-1',relativePath:'junit.xml',format:'junit'}); assert.equal(fresh.source.stale,false); assert.equal(fresh.source.freshness,'fresh');
  await assert.rejects(parseTestReport(projects,p.id,snapshot,{commandItemId:'other',relativePath:'junit.xml',format:'junit'}));
  await writeFile(join(p.path,'evil.xml'),'<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuite/>');
  await assert.rejects(parseTestReport(projects,p.id,snapshot,{commandItemId:'cmd-1',relativePath:'evil.xml',format:'junit'}));
  await writeFile(join(p.path,'.gitignore'),'ignored.xml\n'); await writeFile(join(p.path,'ignored.xml'),'<testsuite/>');
  assert.equal((await parseTestReport(projects,p.id,snapshot,{commandItemId:'cmd-1',relativePath:'ignored.xml',format:'junit'})).cases.length,0);
  await writeFile(join(p.path,'.env.xml'),'<testsuite/>'); await assert.rejects(parseTestReport(projects,p.id,snapshot,{commandItemId:'cmd-1',relativePath:'.env.xml',format:'junit'}));
  await writeFile(join(p.path,'nested.xml'),'<testsuites><testsuite name="outer"><testsuite name="inner"><testcase name="nested"/></testsuite></testsuite></testsuites>');
  const nested=await parseTestReport(projects,p.id,snapshot,{commandItemId:'cmd-1',relativePath:'nested.xml',format:'junit'}); assert.equal(nested.cases[0].suite,'outer / inner');
  await writeFile(join(p.path,'empty-nodes.xml'),'<testsuite><testcase name="failed" time="NaN"><failure/></testcase><testcase name="errored" time="-2"><error/></testcase></testsuite>');
  const emptyNodes=await parseTestReport(projects,p.id,snapshot,{commandItemId:'cmd-1',relativePath:'empty-nodes.xml',format:'junit'});
  assert.deepEqual(emptyNodes.cases.map(c=>[c.status,c.durationMs]),[['failed',0],['error',0]]);
  await writeFile(join(p.path,'malformed.xml'),'<testsuite><testcase></testsuite>');
  await assert.rejects(parseTestReport(projects,p.id,snapshot,{commandItemId:'cmd-1',relativePath:'malformed.xml',format:'junit'}),/Unable to parse/);
 } finally {await rm(root,{recursive:true,force:true});}
});
