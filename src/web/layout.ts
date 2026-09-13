export type Layout = {left:number;center:number;right:number};
export const defaultLayout:Layout = {left:.18,center:.60,right:.22};
export const layoutKey='codex-web:layout:v1';
export function parseLayout(raw:string|null):Layout|null {
  try {const value=JSON.parse(raw??'null');if(value?.version!==1)return null;
    const {left,center,right}=value;if(![left,center,right].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0)||Math.abs(left+center+right-1)>1e-6)return null;
    return {left,center,right};
  } catch {return null;}
}
export function fitLayout(layout:Layout,total:number):[number,number,number] {
  const mins=[180,420,240],ratios=[layout.left,layout.center,layout.right];
  if(total<840)return ratios.map(r=>r*Math.max(0,total)) as [number,number,number];
  const values=ratios.map((r,i)=>Math.max(mins[i],r*total));
  const excess=values.reduce((a,b)=>a+b,0)-total,room=values.reduce((sum,n,i)=>sum+n-mins[i],0);
  return values.map((n,i)=>n-(room?excess*(n-mins[i])/room:0)) as [number,number,number];
}
export function resizeLayout(layout:Layout,total:number,boundary:'left'|'right',delta:number,rightVisible:boolean,leftVisible=true):Layout {
  if(total<840||!Number.isFinite(delta)||(boundary==='left'&&!leftVisible)||(boundary==='right'&&!rightVisible))return layout;
  if(!leftVisible){if(1-layout.left<660/total)return layout;const right=Math.max(240/total,Math.min(1-layout.left-420/total,layout.right-delta/total));return {...layout,right,center:1-layout.left-right};}
  const [left,center,right]=fitLayout(layout,total);
  if(!rightVisible){if(1-layout.right<600/total)return layout;const next=Math.max(180,Math.min(total-420,layout.left*total+delta))/total;
    const bounded=Math.min(1-layout.right-420/total,next);return {...layout,left:Math.max(180/total,bounded),center:1-layout.right-Math.max(180/total,bounded)};}
  const movement=boundary==='left'?Math.max(180-left,Math.min(center-420,delta)):Math.max(420-center,Math.min(right-240,delta));
  return boundary==='left'?{left:(left+movement)/total,center:(center-movement)/total,right:right/total}:{left:left/total,center:(center+movement)/total,right:(right-movement)/total};
}
