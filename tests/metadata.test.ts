import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../src/server/metadata.ts';

test('migrates old metadata once and supports favorite hidden and clear', async () => {
  const dir=await mkdtemp(join(tmpdir(),'metadata-')); const path=join(dir,'metadata.sqlite');
  const old=new DatabaseSync(path); old.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE session_meta(thread_id TEXT PRIMARY KEY,project_path TEXT,web_title TEXT,last_opened_at INTEGER NOT NULL,created_at INTEGER NOT NULL); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO session_meta VALUES('t1','p','old',1,1)");
  try {
    await writeFile(`${path}.v0.bak`,'prior failed backup');
    const store=new MetadataStore(path); old.close(); assert.equal(store.get('t1')?.favorite,false);
    const backupName=(await readdir(dir)).find(name=>name.startsWith('metadata.sqlite.v0-')&&name.endsWith('.bak'))!;
    const backup=new DatabaseSync(join(dir,backupName)); assert.equal(backup.prepare('SELECT web_title FROM session_meta WHERE thread_id=?').get('t1').web_title,'old'); backup.close();
    assert.equal(store.update('t1',{favorite:true,hidden:true}).hidden,true); store.close();
    const reopened=new MetadataStore(path); assert.equal(reopened.get('t1')?.favorite,true);
    reopened.clear('t1'); assert.equal(reopened.get('t1'),null); reopened.close();
    const check=new DatabaseSync(path); assert.equal(check.prepare('PRAGMA user_version').get().user_version,1); check.close();
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('closes the database when migration fails', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'metadata-fail-')); const path=join(dir,'metadata.sqlite');
  const broken=new DatabaseSync(path); broken.exec('CREATE TABLE session_meta(thread_id TEXT PRIMARY KEY,project_path TEXT,web_title TEXT,last_opened_at INTEGER NOT NULL,created_at INTEGER NOT NULL,favorite INTEGER)'); broken.close();
  assert.throws(()=>new MetadataStore(path));
  await rm(path);
  await rm(dir,{recursive:true,force:true});
});
