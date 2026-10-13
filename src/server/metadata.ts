import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {pathKey} from '../projects.ts';

export type SessionMetadata={thread_id:string;project_path:string|null;web_title:string|null;last_opened_at:number;created_at:number;favorite:boolean;hidden:boolean;updated_at:number|null};
export type ProjectSync={native_project_id:string|null;idempotency_key:string;suppressed:boolean};

export class MetadataStore {
  readonly db:DatabaseSync;
  constructor(path:string){
    this.db=new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode=WAL');
      const exists=this.db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='session_meta'").get();
      if(exists && Number((this.db.prepare('PRAGMA user_version').get() as any).user_version)<1){
        const backup=`${path}.v0-${randomUUID()}.bak`;
        this.db.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`); this.db.exec('BEGIN EXCLUSIVE');
        try { this.db.exec('ALTER TABLE session_meta ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0; ALTER TABLE session_meta ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0; ALTER TABLE session_meta ADD COLUMN updated_at INTEGER; PRAGMA user_version=1; COMMIT'); }
        catch(error){this.db.exec('ROLLBACK');throw error;}
      } else if(!exists) this.db.exec(`CREATE TABLE session_meta(thread_id TEXT PRIMARY KEY,project_path TEXT,web_title TEXT,last_opened_at INTEGER NOT NULL,created_at INTEGER NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,hidden INTEGER NOT NULL DEFAULT 0,updated_at INTEGER); PRAGMA user_version=1`);
      this.db.exec('CREATE TABLE IF NOT EXISTS known_forks(seq INTEGER PRIMARY KEY AUTOINCREMENT,thread_id TEXT NOT NULL UNIQUE,header TEXT NOT NULL,confirmed_at INTEGER NOT NULL)');
      this.db.exec('CREATE TABLE IF NOT EXISTS project_sync(native_home TEXT NOT NULL,workspace_id TEXT NOT NULL,native_project_id TEXT,idempotency_key TEXT NOT NULL,suppressed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(native_home,workspace_id))');
    } catch(error) { this.db.close(); throw error; }
  }
  get(id:string):SessionMetadata|null { const row=this.db.prepare('SELECT * FROM session_meta WHERE thread_id=?').get(id) as any; return row?{...row,favorite:!!row.favorite,hidden:!!row.hidden}:null; }
  projectSync(home:string,workspaceId:string):ProjectSync{
    this.db.prepare('INSERT OR IGNORE INTO project_sync(native_home,workspace_id,idempotency_key) VALUES(?,?,?)').run(home,workspaceId,randomUUID());
    const row=this.db.prepare('SELECT native_project_id,idempotency_key,suppressed FROM project_sync WHERE native_home=? AND workspace_id=?').get(home,workspaceId) as any;
    return {...row,suppressed:!!row.suppressed};
  }
  saveProjectSync(home:string,workspaceId:string,value:ProjectSync){this.db.prepare('UPDATE project_sync SET native_project_id=?,idempotency_key=?,suppressed=? WHERE native_home=? AND workspace_id=?').run(value.native_project_id,value.idempotency_key,value.suppressed?1:0,home,workspaceId);}
  save(id:string,projectPath:string|null,title:string|null){const now=Date.now();this.db.prepare(`INSERT INTO session_meta(thread_id,project_path,web_title,last_opened_at,created_at,favorite,hidden,updated_at) VALUES(?,?,?,?,?,0,0,?) ON CONFLICT(thread_id) DO UPDATE SET last_opened_at=excluded.last_opened_at,project_path=excluded.project_path,web_title=COALESCE(session_meta.web_title,excluded.web_title),updated_at=excluded.updated_at`).run(id,projectPath,title,now,now,now);return this.get(id)!;}
  update(id:string,patch:{favorite?:boolean;hidden?:boolean;webTitle?:string|null}){const current=this.get(id)??this.save(id,null,null);this.db.prepare('UPDATE session_meta SET favorite=?,hidden=?,web_title=?,updated_at=? WHERE thread_id=?').run(patch.favorite??current.favorite?1:0,patch.hidden??current.hidden?1:0,patch.webTitle===undefined?current.web_title:patch.webTitle,Date.now(),id);return this.get(id)!;}
  registerFork(thread:any):'hard'|'soft'|false{
    if(typeof thread?.id!=='string'||typeof thread.forkedFromId!=='string'||!thread.forkedFromId||thread.parentThreadId||(thread.source&&typeof thread.source==='object'&&(Object.hasOwn(thread.source,'subAgent')||Object.hasOwn(thread.source,'subagent'))))return false;
    const {turns,...header}=thread;
    const serialized=JSON.stringify(header),previous=this.db.prepare('SELECT header FROM known_forks WHERE thread_id=?').get(thread.id) as {header:string}|undefined;
    const oldHeader=previous?JSON.parse(previous.header):undefined,savedHeader=JSON.parse(serialized);
    const meaning=(value:any)=>{const {status,release,updatedAt,recencyAt,...fields}=value;for(const key of ['cwd','path'])if(typeof fields[key]==='string')fields[key]=pathKey(fields[key]);return fields;};
    const changed=!previous||!isDeepStrictEqual(meaning(oldHeader),meaning(savedHeader))?'hard':oldHeader.updatedAt!==savedHeader.updatedAt||oldHeader.recencyAt!==savedHeader.recencyAt?'soft':false;
    this.db.prepare('INSERT INTO known_forks(thread_id,header,confirmed_at) VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET header=excluded.header,confirmed_at=excluded.confirmed_at').run(thread.id,serialized,Date.now());
    return changed;
  }
  knownForks(before=Number.MAX_SAFE_INTEGER){return (this.db.prepare('SELECT seq,thread_id,header FROM known_forks WHERE seq<? ORDER BY seq DESC LIMIT 32').all(before) as Array<{seq:number;thread_id:string;header:string}>).map(row=>({seq:row.seq,id:row.thread_id,header:JSON.parse(row.header)}));}
  hasForksBefore(before:number){return !!this.db.prepare('SELECT 1 FROM known_forks WHERE seq<? LIMIT 1').get(before);}
  clear(id:string){this.db.prepare('DELETE FROM session_meta WHERE thread_id=?').run(id);}
  close(){this.db.close();}
}
