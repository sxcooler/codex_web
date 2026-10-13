export type GraphLine={from:number;to:number;incoming:boolean;toRow?:number;via?:number};
export function layoutGitGraph(commits:readonly {id:string;parents:readonly string[]}[]){
  const lanes:(string|null)[]=[],rows:{column:number;lines:GraphLine[]}[]=[],seen=new Map<string,number>();let columns=0;
  for(const commit of commits){
    const lines:GraphLine[]=[];let column=lanes.indexOf(commit.id);
    lanes.forEach((id,lane)=>{if(id!==null){lines.push({from:lane,to:lane,incoming:true});if(id!==commit.id)lines.push({from:lane,to:lane,incoming:false});}});
    if(column<0){column=lanes.indexOf(null);if(column<0)column=lanes.length;}
    lanes[column]=null;
    for(const parent of commit.parents){
      const above=seen.get(parent);
      if(above!==undefined){lines.push({from:column,to:rows[above].column,incoming:false,toRow:above});continue;}
      let target=lanes.indexOf(parent);
      if(target<0){target=lanes[column]===null?column:lanes.indexOf(null);if(target<0)target=lanes.length;lanes[target]=parent;}
      lines.push({from:column,to:target,incoming:false});
    }
    columns=Math.max(columns,column+1,lanes.length);seen.set(commit.id,rows.length);rows.push({column,lines});
  }
  // Route upward edges beside all node lanes so they cannot imply a link to intervening nodes.
  for(const row of rows)for(const line of row.lines)if(line.toRow!==undefined)line.via=columns++;
  return {rows,columns,pending:lanes.filter((id):id is string=>id!==null)};
}
