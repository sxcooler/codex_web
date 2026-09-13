import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type SessionMetadata={thread_id:string;project_path:string|null;web_title:string|null;last_opened_at:number;created_at:number;favorite:boolean;hidden:boolean;updated_at:number|null};

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
    } catch(error) { this.db.close(); throw error; }
  }
  get(id:string):SessionMetadata|null { const row=this.db.prepare('SELECT * FROM session_meta WHERE thread_id=?').get(id) as any; return row?{...row,favorite:!!row.favorite,hidden:!!row.hidden}:null; }
  save(id:string,projectPath:string|null,title:string|null){const now=Date.now();this.db.prepare(`INSERT INTO session_meta(thread_id,project_path,web_title,last_opened_at,created_at,favorite,hidden,updated_at) VALUES(?,?,?,?,?,0,0,?) ON CONFLICT(thread_id) DO UPDATE SET last_opened_at=excluded.last_opened_at,project_path=excluded.project_path,web_title=COALESCE(session_meta.web_title,excluded.web_title),updated_at=excluded.updated_at`).run(id,projectPath,title,now,now,now);return this.get(id)!;}
  update(id:string,patch:{favorite?:boolean;hidden?:boolean;webTitle?:string|null}){const current=this.get(id)??this.save(id,null,null);this.db.prepare('UPDATE session_meta SET favorite=?,hidden=?,web_title=?,updated_at=? WHERE thread_id=?').run(patch.favorite??current.favorite?1:0,patch.hidden??current.hidden?1:0,patch.webTitle===undefined?current.web_title:patch.webTitle,Date.now(),id);return this.get(id)!;}
  clear(id:string){this.db.prepare('DELETE FROM session_meta WHERE thread_id=?').run(id);}
  close(){this.db.close();}
}
