// Mock-only API fixtures never wake a CLI or touch an official native home.
export function nativeProjects(home:string){
  const projects:any[]=[];
  return {projectContext:async()=>({home,epoch:'fixture'}),assertProjectContext:()=>{},configurationHome:async()=>home,listProjects:async()=>structuredClone(projects),createProject:async(input:any)=>{
    const project={id:'fixture-project-'+(projects.length+1),name:input.name,roots:input.roots};projects.push(project);return project;
  }};
}
