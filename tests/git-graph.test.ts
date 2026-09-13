import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutGitGraph} from '../src/web/gitGraph.ts';
const commits=[{id:'merge',parents:['main','feature']},{id:'main',parents:['root']},{id:'feature',parents:['root']},{id:'root',parents:[]}];
test('graph preserves actual fork and merge lanes and marks unloaded ancestors',()=>{
 const graph=layoutGitGraph(commits);
 assert.equal(graph.columns,2);assert.deepEqual(graph.rows.map(row=>row.column),[0,0,1,0]);
 assert.deepEqual(graph.rows[0].lines.filter(line=>!line.incoming),[{from:0,to:0,incoming:false},{from:0,to:1,incoming:false}]);
 assert.ok(graph.rows[2].lines.some(line=>!line.incoming&&line.from===1&&line.to===0));
 assert.deepEqual(graph.pending,[]);
 const page=layoutGitGraph(commits.slice(0,2));assert.deepEqual(page.pending,['root','feature']);assert.deepEqual(page.rows,graph.rows.slice(0,2));
 assert.deepEqual(layoutGitGraph([]),{rows:[],columns:0,pending:[]});
});
