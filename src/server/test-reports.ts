import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Projects } from '../projects.ts';

const array=<T>(value:T|T[]|undefined):T[]=>value===undefined?[]:Array.isArray(value)?value:[value];
const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode,code:'REPORT_ERROR'});

export async function parseTestReport(projects:Projects,projectId:string,snapshot:any,input:{commandItemId:string;relativePath:string;format:'junit'}){
  const turns=snapshot?.thread?.turns??[]; const turn=turns.find((candidate:any)=>(candidate.items??[]).some((item:any)=>item.type==='commandExecution'&&item.id===input.commandItemId)); const command=turn?.items.find((item:any)=>item.type==='commandExecution'&&item.id===input.commandItemId);
  if(!command)throw fail('Command item does not belong to this thread',404);
  const source=await projects.readReportFile(projectId,input.relativePath,5*1024*1024); const xml=source.bytes.toString('utf8');
  if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw fail('DTD and external entities are not allowed');
  if(XMLValidator.validate(xml)!==true)throw fail('Unable to parse JUnit report');
  let parsed:any; try{parsed=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_'}).parse(xml);}catch{throw fail('Unable to parse JUnit report');}
  const suites=array(parsed.testsuites?.testsuite??parsed.testsuite); if(!suites.length)throw fail('Unable to parse JUnit report');
  const cases:any[]=[]; let truncated=false;
  const visit=(suite:any,parents:string[])=>{const path=[...parents,String(suite['@_name']??'')].filter(Boolean);for(const item of array<any>(suite.testcase)){if(cases.length===10_000){truncated=true;return;}const hasFailure=Object.hasOwn(item,'failure'),hasError=Object.hasOwn(item,'error'),hasSkipped=Object.hasOwn(item,'skipped');const detail=hasFailure?item.failure:hasError?item.error:undefined;const seconds=Number(item['@_time']??0);cases.push({name:String(item['@_name']??''),suite:String(item['@_classname']??path.join(' / ')),status:hasFailure?'failed':hasError?'error':hasSkipped?'skipped':'passed',durationMs:Number.isFinite(seconds)&&seconds>=0?Math.round(seconds*1000):0,...(detail?.['@_message']||typeof detail==='string'&&detail?{message:String(detail?.['@_message']??detail)}:{})});}for(const child of array<any>(suite.testsuite)){if(truncated)return;visit(child,path);}};
  for(const suite of suites){visit(suite,[]);if(truncated)break;}
  const count=(status:string)=>cases.filter(c=>c.status===status).length;
  const startedAtMs=typeof command.startedAtMs==='number'?command.startedAtMs:undefined;
  const freshness=startedAtMs===undefined?'unknown':source.mtimeMs<startedAtMs?'stale':'fresh';
  return {reportId:createHash('sha256').update(`${input.commandItemId}\0`).update(source.bytes).digest('hex').slice(0,24),commandItemId:input.commandItemId,fileHash:createHash('sha256').update(source.bytes).digest('hex'),observedAt:Date.now(),summary:{passed:count('passed'),failed:count('failed'),skipped:count('skipped'),errors:count('error'),durationMs:cases.reduce((n,c)=>n+c.durationMs,0)},cases,truncated,source:{relativePath:source.path,stale:freshness!=='fresh',freshness}};
}
