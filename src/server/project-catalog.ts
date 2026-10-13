import {randomUUID} from 'node:crypto';
import {posix,win32} from 'node:path';
import type {Runtime,NativeProject,NativeProjectContext} from '../codex/runtime.ts';
import type {Projects,Project} from '../projects.ts';
import type {MetadataStore} from './metadata.ts';

export type CatalogProject={id:string;name:string;roots:Array<{path:string;workspaceId:string|null;available:boolean}>};
export type CatalogWorkspace={workspaceId:string;nativeProjectId:string|null;status:'syncing'|'synced'|'failed'|'removed'|'ambiguous';error?:string;matches?:string[]};
export type CatalogSnapshot={state:'ready'|'loading'|'unavailable';updatedAt:number|null;projects:CatalogProject[];workspaces:CatalogWorkspace[];error?:string;sessionSync?:{pending:number;failed:number}};
export function rootKey(path:string,platform=process.platform):string{
  if(platform==='win32'){
    const normal=path.replaceAll('/','\\').replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\/,'');
    return win32.normalize(normal).replace(/\\+$/,'').toLowerCase();
  }
  return posix.normalize(path).replace(/\/+$/,'')||'/';
}
const failure=(statusCode:number,message:string)=>Object.assign(new Error(message),{statusCode,code:'RUNTIME_PROJECT_SYNC_FAILED'});

// Native names and roots stay authoritative; SQLite stores only synchronization identity.
export class ProjectCatalog {
  private value:CatalogSnapshot={state:'loading',updatedAt:null,projects:[],workspaces:[]};
  private native:NativeProject[]=[];
  private home?:string;
  private context?:NativeProjectContext;
  private job?:Promise<void>;
  private maintenance?:Promise<void>;
  private timer?:ReturnType<typeof setInterval>;
  private rescanRequested=false;
  private closed=false;
  private runtime:Runtime;
  private projects:Projects;
  private metadata:MetadataStore;
  private changed:()=>void;
  constructor(runtime:Runtime,projects:Projects,metadata:MetadataStore,changed:()=>void){this.runtime=runtime;this.projects=projects;this.metadata=metadata;this.changed=changed;}
  snapshot():CatalogSnapshot{return structuredClone(this.value);}
  start(){if(this.closed||this.timer)return;this.timer=setInterval(()=>void this.maintain(),60_000);this.timer.unref();void this.maintain();}
  maintain():Promise<void>{
    if(this.closed)return Promise.resolve();
    if(this.maintenance)return this.maintenance;
    this.maintenance=this.synchronizeSessions().catch(()=>{if(!this.closed){this.value.sessionSync={pending:0,failed:1};this.publish();}}).finally(()=>{this.maintenance=undefined;});
    return this.maintenance;
  }
  private async synchronizeSessions(){
    await this.sync();if(this.closed||this.value.state!=='ready'||!this.context)return;
    const context=this.context,workspaces=await this.projects.list(),byRoot=new Map(workspaces.map(p=>[rootKey(p.path),p]));
    const candidates=new Map<string,{id:string;cwd:string;root:string;workspaceId:string;projectId:string}>();
    // Finish reading the filtered pages before writes can change their membership.
    for(const archived of [false,true]){
      let cursor:string|undefined;const seen=new Set<string>();
      do{
        if(this.closed)return;this.runtime.assertProjectContext(context);
        const page=await this.runtime.list(cursor,archived,'created_at',undefined,null);this.runtime.assertProjectContext(context);
        for(const thread of page.data){
          if(thread.projectId!==null||typeof thread.id!=='string'||typeof thread.cwd!=='string')continue;
          const root=this.metadata.get(thread.id)?.project_path||thread.cwd,workspace=byRoot.get(rootKey(root));
          const status=this.value.workspaces.find(row=>row.workspaceId===workspace?.id);
          if(workspace&&status?.status==='synced'&&status.nativeProjectId)candidates.set(thread.id,{id:thread.id,cwd:thread.cwd,root:rootKey(root),workspaceId:workspace.id,projectId:status.nativeProjectId});
        }
        cursor=page.nextCursor??undefined;if(cursor){if(seen.has(cursor))throw failure(503,'原生会话分页重复。');seen.add(cursor);}
      }while(cursor);
    }
    let next=0,pending=0,failed=0;const rows=[...candidates.values()];
    await Promise.all(Array.from({length:Math.min(2,rows.length)},async()=>{
      while(next<rows.length&&!this.closed){
        const row=rows[next++];
        try{
          this.runtime.assertProjectContext(context);
          await this.projects.resolve(row.workspaceId);if(this.closed)return;
          this.runtime.assertProjectContext(context);
          const assertCurrent=()=>{const status=this.value.workspaces.find(item=>item.workspaceId===row.workspaceId);if(this.closed||rootKey(this.metadata.get(row.id)?.project_path||row.cwd)!==row.root||status?.status!=='synced'||status.nativeProjectId!==row.projectId)throw failure(409,'项目目录归属在同步前变化。');};
          assertCurrent();
          await this.runtime.setThreadProject(row.id,row.projectId,{cwd:row.cwd,context,assertCurrent});
        }catch(error){pending++;if((error as any)?.statusCode!==409)failed++;}
      }
    }));
    if(!this.closed){this.value.sessionSync={pending,failed};this.publish();}
  }
  sync():Promise<void>{
    if(this.closed)return Promise.resolve();
    if(this.job){this.rescanRequested=true;return this.job;}
    this.job=(async()=>{
      let restarts=0;
      do{
        this.rescanRequested=false;
        try{await this.synchronize();}
        catch(error){
          if((error as any)?.code!=='RUNTIME_SYNC_RESTARTED'||++restarts>2)throw error;
          this.value={state:'loading',updatedAt:null,projects:[],workspaces:[]};this.native=[];this.context=undefined;
          continue;
        }
        if(this.closed||!this.rescanRequested||this.value.state!=='ready')break;
        const workspaces=await this.projects.list(),known=new Set(this.value.workspaces.map(row=>row.workspaceId));
        if(workspaces.length===known.size&&workspaces.every(row=>known.has(row.id)))break;
      }while(!this.closed);
    })().catch(error=>{if(!this.closed){this.value.state='unavailable';this.value.error=error instanceof Error?error.message:'原生项目目录不可用。';this.publish();}}).finally(()=>{this.job=undefined;});
    return this.job;
  }
  async refreshNative(){if(this.job)await this.job;await this.sync();}
  private publish(){if(!this.closed)this.changed();}
  private render(workspaces:Project[]){
    const byRoot=new Map(workspaces.map(workspace=>[rootKey(workspace.path),workspace.id]));
    this.value.projects=this.native.map(project=>({id:project.id,name:project.name,roots:project.roots.map(root=>{const workspaceId=byRoot.get(rootKey(root.path))??null;return {path:root.path,workspaceId,available:workspaceId!==null};})}));
  }
  private async synchronize(){
    this.value.state='loading';this.publish();
    try{
      const context=await this.runtime.projectContext(),home=context.home,homeKey=rootKey(home);
      this.runtime.assertProjectContext(context);
      if(this.home!==rootKey(home)){this.value={state:'loading',updatedAt:null,projects:[],workspaces:[]};this.home=rootKey(home);this.native=[];}
      const native=await this.runtime.listProjects(context),workspaces=await this.projects.list();
      this.runtime.assertProjectContext(context);
      // Persist keys before RPC for response-loss retries; defer identity/suppression until the whole cycle is fenced.
      const updates:Array<{workspaceId:string;record:ReturnType<MetadataStore['projectSync']>}>=[];
      if(this.closed)return;
      this.native=native;this.render(workspaces);
      const ids=new Set(native.map(project=>project.id)),byRoot=new Map<string,string[]>();
      for(const project of native)for(const root of project.roots){const key=rootKey(root.path),matches=byRoot.get(key)??[];if(!matches.includes(project.id))matches.push(project.id);byRoot.set(key,matches);}
      const pending:Array<{workspace:Project;status:CatalogWorkspace}>=[];
      this.value.workspaces=workspaces.map(workspace=>{
        const record=this.metadata.projectSync(homeKey,workspace.id),matches=byRoot.get(rootKey(workspace.path))??[];
        if(record.native_project_id&&!ids.has(record.native_project_id)){record.suppressed=true;}
        const status:CatalogWorkspace={workspaceId:workspace.id,nativeProjectId:record.native_project_id,status:'syncing'};
        if(record.suppressed){status.status='removed';status.nativeProjectId=null;}
        else if(matches.length>1){status.status='ambiguous';status.nativeProjectId=null;status.matches=matches;}
        else if(matches.length===1){status.status='synced';status.nativeProjectId=matches[0];record.native_project_id=matches[0];}
        else{status.nativeProjectId=null;pending.push({workspace,status});}
        updates.push({workspaceId:workspace.id,record});return status;
      });
      this.value.updatedAt=Date.now();this.value.error=undefined;this.publish();
      let next=0,contextChanged=false;
      await Promise.all(Array.from({length:Math.min(2,pending.length)},async()=>{
        while(next<pending.length&&!this.closed&&!contextChanged){
          const {workspace,status}=pending[next++],record=updates.find(row=>row.workspaceId===workspace.id)!.record;
          try{
            await this.projects.resolve(workspace.id);
            this.runtime.assertProjectContext(context);
            const project=await this.runtime.createProject({idempotencyKey:record.idempotency_key,name:workspace.name,roots:[{path:workspace.path}]},context);
            this.runtime.assertProjectContext(context);
            if(this.closed)return;
            if(!project.roots.some(root=>rootKey(root.path)===rootKey(workspace.path)))throw failure(503,'原生项目返回的目录不匹配。');
            record.native_project_id=project.id;
            if(!this.native.some(row=>row.id===project.id))this.native.push(project);
            status.nativeProjectId=project.id;status.status='synced';this.render(workspaces);
          }catch(error){if((error as any)?.code==='RUNTIME_SYNC_RESTARTED'){contextChanged=true;return;}status.status='failed';status.error=error instanceof Error?error.message:'原生项目添加失败。';}
          this.publish();
        }
      }));
      this.runtime.assertProjectContext(context);
      if(contextChanged)throw Object.assign(new Error('Native project process changed during synchronization'),{code:'RUNTIME_SYNC_RESTARTED'});
      for(const update of updates)this.metadata.saveProjectSync(homeKey,update.workspaceId,update.record);
      this.context=context;this.value.state='ready';this.publish();
    }catch(error){if((error as any)?.code==='RUNTIME_SYNC_RESTARTED')throw error;if(!this.closed){this.value.state='unavailable';this.value.error=error instanceof Error?error.message:'原生项目目录不可用。';this.publish();}}
  }
  async retry(workspaceId:string){
    await this.projects.resolve(workspaceId);await this.sync();
    if(!this.home||this.value.state!=='ready')throw failure(503,'原生项目目录不可用，请稍后重试。');
    if(!this.context)throw failure(503,'原生项目目录不可用，请稍后重试。');
    this.runtime.assertProjectContext(this.context);
    const record=this.metadata.projectSync(this.home,workspaceId);
    if(record.suppressed){record.suppressed=false;record.native_project_id=null;record.idempotency_key=randomUUID();this.metadata.saveProjectSync(this.home,workspaceId,record);}
    await this.sync();return this.snapshot();
  }
  async resolve(workspaceId?:string,nativeProjectId?:string|null):Promise<string|null>{
    if(workspaceId)await this.projects.resolve(workspaceId);
    if(!workspaceId&&!nativeProjectId)return null;
    await this.sync();
    if(this.value.state!=='ready')throw failure(503,'原生项目目录不可用，尚未创建会话。');
    const status=this.value.workspaces.find(row=>row.workspaceId===workspaceId);
    if(nativeProjectId){
      const project=this.value.projects.find(row=>row.id===nativeProjectId);
      if(!project)throw failure(404,'原生项目不存在。');
      if(!workspaceId||!project.roots.some(root=>root.workspaceId===workspaceId&&root.available))throw failure(409,'请选择该项目已开放的工作目录。');
      return nativeProjectId;
    }
    if(nativeProjectId===null)return null;
    if(status?.status==='ambiguous')throw failure(409,'该目录属于多个原生项目，请明确选择项目。');
    if(status?.status==='removed')throw failure(409,'该项目已从官方移除，请先重新添加。');
    if(status?.status!=='synced')throw failure(503,status?.error??'原生项目尚未同步，尚未创建会话。');
    return status.nativeProjectId;
  }
  async close(){this.closed=true;clearInterval(this.timer);await Promise.allSettled([this.job,this.maintenance]);}
}
