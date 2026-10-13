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
test('graph connects newer parents above their children without leaving them pending',()=>{
 const graph=layoutGitGraph([{id:'parent',parents:[]},{id:'middle',parents:['older']},{id:'child',parents:['parent','middle','missing']},{id:'older',parents:[]}]);
 assert.deepEqual(graph.pending,['missing']);
 const upward=graph.rows[2].lines.filter(line=>line.toRow!==undefined);
 assert.deepEqual(upward.map(line=>[line.from,line.to,line.toRow]),[[graph.rows[2].column,graph.rows[0].column,0],[graph.rows[2].column,graph.rows[1].column,1]]);
 assert.ok(upward.every(line=>line.via!>Math.max(...graph.rows.map(row=>row.column))));
 assert.equal(new Set(upward.map(line=>line.via)).size,upward.length);
 assert.ok(graph.rows[1].lines.some(line=>!line.incoming&&line.toRow===undefined));
});
test('upward edges bypass unrelated nodes in the same lane',()=>{
 const graph=layoutGitGraph([{id:'newer-parent',parents:[]},{id:'unrelated',parents:[]},{id:'child',parents:['newer-parent']}]);
 assert.deepEqual(graph.rows.map(row=>row.column),[0,0,0]);
 assert.deepEqual(graph.rows[2].lines,[{from:0,to:0,incoming:false,toRow:0,via:1}]);
 assert.equal(graph.columns,2);assert.deepEqual(graph.pending,[]);
});
