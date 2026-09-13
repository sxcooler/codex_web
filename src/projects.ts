import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, readdir, realpath, open } from 'node:fs/promises';
import { basename, dirname, join, isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import sharp from 'sharp';

const run = promisify(execFile);
export const pathKey = (path: string, platform: string = process.platform) => platform === 'win32' ? path.toLowerCase() : path;
const fold = pathKey;
const sensitivePath = (path: string) => /(?:^|\/)\.git(?:\/|$)/i.test(path) || /(?:^|\/)\.env(?:\.|$)/i.test(path) || /(?:^|\/)(?:credentials?|secrets?)(?:\.|$)/i.test(path) || path === '.codex-uploads' || path.startsWith('.codex-uploads/');
const MAX_VIEW_BYTES = 1024 * 1024;
const MAX_VIEW_LINES = 20_000;
const MAX_PATCH_BYTES = 5 * 1024 * 1024;
const imagePath = (path: string) => /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(path);
const HISTORY_PAGE_SIZE = 100;
export type Project = { id: string; name: string; path: string };
function parsePatch(path: string, patch: string, extra: Record<string, unknown> = {}) {
  const binary=/Binary files |GIT binary patch/.test(patch); const hunks:any[]=[]; let h:any;
  let oldLine=0,newLine=0,count=0,truncated=Buffer.byteLength(patch)>MAX_VIEW_BYTES;
  let parsedBytes=0; for(const line of patch.split('\n')) {
    parsedBytes+=Buffer.byteLength(line)+1;if(parsedBytes>MAX_VIEW_BYTES){truncated=true;break;}
    const m=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if(m){h={oldStart:+m[1],oldLines:+(m[2]??1),newStart:+(m[3]),newLines:+(m[4]??1),lines:[]};hunks.push(h);oldLine=h.oldStart;newLine=h.newStart;continue;}
    if(!h||line.startsWith('\\ No newline'))continue; if(++count>MAX_VIEW_LINES){truncated=true;break;}
    if(line.startsWith('+'))h.lines.push({kind:'add',text:line.slice(1),newLine:newLine++});
    else if(line.startsWith('-'))h.lines.push({kind:'delete',text:line.slice(1),oldLine:oldLine++});
    else {h.lines.push({kind:'context',text:line.startsWith(' ')?line.slice(1):line,oldLine:oldLine++,newLine:newLine++});}
  }
  return {path,...extra,hunks,binary,truncated};
}
function problem(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, code: 'PROJECT_ERROR' });
}

export function validateFolder(name: string, platform: string = process.platform): string {
  if (typeof name !== 'string' || !name || name.startsWith('.') || name.length > 80 || /[\x00-\x1f/\\]/.test(name)
    || (platform === 'win32' && (/[<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|clock\$)(\.|$)/i.test(name)))) {
    throw problem('Invalid project folder name');
  }
  return name;
}

export function validateRepoUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\\]/.test(value)) throw problem('Invalid repository URL');
  if (/^[a-zA-Z0-9_.]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password || url.hash || url.search
      || (url.protocol === 'https:' && url.username) || !/^\/[a-zA-Z0-9_]/.test(url.pathname)) throw new Error();
    return value;
  } catch { throw problem('Use an HTTPS or SSH repository URL without embedded credentials'); }
}

function fetchProcess(cwd:string,args:string[],env:NodeJS.ProcessEnv,timeout:number,maxBuffer:number):Promise<Buffer>{
  return new Promise((resolve,reject)=>{
    const child=spawn('git',args,{cwd,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    const chunks:Buffer[]=[];let size=0,failure:Error|undefined;
    const stop=(error:Error)=>{
      if(failure)return;failure=error;const pid=child.pid;if(!pid)return;
      if(process.platform==='win32')void run('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,timeout:5000}).catch(()=>child.kill('SIGKILL'));
      else {try{process.kill(-pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
    };
    const timer=setTimeout(()=>stop(problem('Git fetch timed out',504)),timeout);
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBuffer)stop(problem('Git output exceeds the response limit',413));else chunks.push(chunk);});
    child.stderr.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBuffer)stop(problem('Git output exceeds the response limit',413));});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);if(failure)reject(failure);else if(code!==0)reject(problem('Git fetch failed',409));else resolve(Buffer.concat(chunks));});
  });
}

async function gitBytes(cwd: string, args: string[], timeout = 30_000, maxBuffer = 2 * 1024 * 1024, killTree = false): Promise<Buffer> {
  try {
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd), GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'never', GIT_OPTIONAL_LOCKS:'0', GIT_SSH_COMMAND:'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
    const command=['-c','core.fsmonitor=false',...args];
    if(killTree)return await fetchProcess(cwd,command,{...env,GIT_ASKPASS:'',SSH_ASKPASS:'',SSH_ASKPASS_REQUIRE:'never'},timeout,maxBuffer);
    return (await run('git',command,{cwd,env,windowsHide:true,timeout,maxBuffer,encoding:'buffer'})).stdout;
  } catch (error: any) {
    if(error.code==='PROJECT_ERROR')throw error;
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw problem('Git output exceeds the response limit; narrow changes locally', 413);
    throw problem(error.killed ? 'Git timed out; inspect the project before retrying' : 'Git failed; check the repository and local Git credentials', 409);
  }
}

async function git(cwd: string, args: string[], timeout = 30_000, maxBuffer = 2 * 1024 * 1024, killTree = false) {
  return (await gitBytes(cwd, args, timeout, maxBuffer, killTree)).toString('utf8');
}

export class Projects {
  root: string;
  #items = new Map<string, Project>();
  // One server process owns project refreshes; share work and briefly retain its result.
  #fetches = new Map<string, Promise<{skipped?:string;remotes:{name:string;status:'updated'|'failed'|'timeout';error?:string}[]}>>();
  constructor(root: string) { this.root = root; }

  async refresh(): Promise<Project[]> {
    this.root = await realpath(this.root);
    const next = new Map<string, Project>();
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const path = join(this.root, entry.name);
      try {
        await this.#check(path);
        const id = createHash('sha256').update(fold(path)).digest('hex').slice(0, 24);
        next.set(id, { id, name: this.#items.get(id)?.name ?? entry.name, path });
      } catch { /* Reparse points and unsafe directories are not selectable. */ }
    }
    this.#items = next;
    return [...next.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async list() { return this.refresh(); }

  async #check(path: string) {
    const info = await lstat(path);
    if (sensitivePath(basename(path)) || !info.isDirectory() || info.isSymbolicLink() || fold(dirname(await realpath(path))) !== fold(this.root)) {
      throw problem('Project is no longer within WORK_ROOT', 409);
    }
    const marker = await lstat(join(path, '.git')).catch((error:any) => { if(error.code==='ENOENT')return null; throw error; });
    if (marker && (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile()))) throw problem('Invalid Git repository', 409);
  }

  async resolve(id: string): Promise<Project> {
    if (!this.#items.has(id)) await this.refresh();
    const item = this.#items.get(id);
    if (!item) throw problem('Project not found', 404);
    try { await this.#check(item.path); } catch { throw problem('Project moved or is no longer a safe repository', 409); }
    return item;
  }

  async create(input: { name: string; folderName: string; repoUrl?: string }): Promise<Project> {
    const folder = validateFolder(input.folderName);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw problem('Invalid project name');
    if (input.repoUrl !== undefined) validateRepoUrl(input.repoUrl);
    this.root = await realpath(this.root);
    if ((await readdir(this.root)).some(name => fold(name) === fold(folder))) throw problem('Folder already exists', 409);
    const path = join(this.root, folder);
    try { await mkdir(path); } catch { throw problem('Cannot create project directory', 409); }
    try {
      if (input.repoUrl) await git(this.root, ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', 'clone', '--', input.repoUrl, path], 180_000);
      else await git(path, ['init']);
    } catch (error: any) {
      // Preserve a partial clone: never delete files that Git or the user may have created.
      error.partial = { path, folderName: folder };
      throw error;
    }
    const project = (await this.refresh()).find(item => fold(item.path) === fold(path))!;
    project.name = input.name.trim();
    return project;
  }

  async clone(input: { name: string; folderName: string; repoUrl: string }) { return this.create(input); }

  async fetchRemotes(id: string) {
    const project=await this.resolve(id),key=fold(project.path);
    let pending=this.#fetches.get(key);
    if(!pending){
      pending=this.#fetchRemotes(project.path);this.#fetches.set(key,pending);
      const expire=()=>{setTimeout(()=>{if(this.#fetches.get(key)===pending)this.#fetches.delete(key);},10_000).unref();};
      void pending.then(expire,expire);
    }
    return pending;
  }

  async #fetchRemotes(path: string) {
    const remotes:{name:string;status:'updated'|'failed'|'timeout';error?:string}[]=[];
    const deadline=Date.now()+60_000;
    if(!(await git(path,['rev-parse','--is-inside-work-tree'],5000).catch(()=>'')).trim())return {skipped:'not-repository',remotes};
    const names=(await git(path,['remote'],5000)).split('\n').filter(Boolean);
    if(!names.length)return {skipped:'no-remotes',remotes};
    for(const name of names){
      const remaining=deadline-Date.now();
      if(remaining<=0){remotes.push({name,status:'timeout',error:'获取超时，保留本地记录。'});continue;}
      try {
        if(name.startsWith('-')||/[\x00-\x20\x7f:*?\[\\]/.test(name))throw problem('Invalid remote');
        if(names.some(other=>other!==name&&(other.startsWith(name+'/')||name.startsWith(other+'/'))))throw problem('Overlapping remote namespaces');
        await git(path,['check-ref-format','refs/remotes/'+name+'/branch'],Math.min(5000,remaining));
        const prefix='refs/remotes/'+name+'/';
        const symbolic=(await git(path,['for-each-ref','--format=%(symref)',prefix],Math.max(1,Math.min(5000,deadline-Date.now())))).split('\n').filter(Boolean);
        if(symbolic.some(target=>!target.startsWith(prefix)))throw problem('Remote ref points outside its namespace');
        await git(path,[
          '-c','protocol.allow=never','-c','protocol.https.allow=always','-c','protocol.ssh.allow=always','-c','protocol.file.allow=always',
          '-c','core.askPass=','-c','credential.interactive=false','-c','fetch.pruneTags=false','-c','remote.'+name+'.pruneTags=false',
          'fetch','--quiet','--prune','--no-prune-tags','--no-tags','--no-recurse-submodules','--no-write-fetch-head','--no-auto-maintenance',
          '--refmap=','--',name,'+refs/heads/*:refs/remotes/'+name+'/*',
        ],Math.max(1,Math.min(30_000,deadline-Date.now())),2*1024*1024,true);
        remotes.push({name,status:'updated'});
      } catch(error:any){remotes.push({name,status:error.statusCode===504?'timeout':'failed',error:error.statusCode===504?'获取超时，保留本地记录。':'获取失败，请检查网络、远程配置和本机 Git 凭据。'});}
    }
    return {remotes};
  }

  async gitStatus(id: string) {
    const project = await this.resolve(id);
    const parts = (await git(project.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0');
    const entries: { path: string; index: string; worktree: string; originalPath?: string }[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      const entry = { index: part[0], worktree: part[1], path: part.slice(3), originalPath: undefined as string | undefined };
      if (/[RC]/.test(part.slice(0, 2))) entry.originalPath = parts[++i];
      entries.push(entry);
    }
    return { project, entries };
  }

  async gitDiff(id: string, staged = false) {
    const project = await this.resolve(id);
    const text = await git(project.path, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', ...(staged ? ['--cached'] : []), '--']);
    return { text, staged, untrackedIncluded: false };
  }

  async #safePath(id: string, value: string, file = false) {
    const project = await this.resolve(id);
    this.#validateRelative(value);
    const target = await realpath(value ? join(project.path, value) : project.path).catch(() => { throw problem('File not found', 404); });
    const rel = relative(await realpath(project.path), target);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw problem('Path escapes project', 403);
    const info = await lstat(target);
    if (info.isSymbolicLink() || (file ? !info.isFile() : !info.isDirectory())) throw problem(file ? 'Not a regular file' : 'Not a directory', 400);
    return { project, target, rel: rel.split(sep).join('/') };
  }

  #validateRelative(value: string) {
    const windows = process.platform === 'win32';
    if (typeof value !== 'string' || value.includes('\0') || isAbsolute(value) || /^[\\/]{2}|^[a-z]:[\\/]/i.test(value)
      || (value && value.split(windows ? /[\\/]/ : /\//).some(part => !part || part === '..'
        || (windows && (part.includes(':') || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)))))) {
      throw problem('Invalid project-relative path');
    }
  }
  async #safeGitPath(id:string,value:string){const project=await this.resolve(id);this.#validateRelative(value);const rel=value.split(sep).join('/');const parent=await realpath(dirname(join(project.path,rel))).catch(()=>{throw problem('Parent directory not found',404)});const inside=relative(await realpath(project.path),parent);if(inside.startsWith(`..${sep}`)||inside==='..'||isAbsolute(inside))throw problem('Path escapes project',403);return {project,rel};}

  async listFiles(id: string, directory = '') {
    const { project, target, rel } = await this.#safePath(id, directory, false);
    this.#checkVisible(rel);
    const files: { path: string; type: 'file'|'directory'; size: number }[] = [];
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === '.git' || /^\.env(?:\.|$)/i.test(entry.name)
        || /^(?:credentials?|secrets?)(?:\.|$)/i.test(entry.name) || entry.name === '.codex-uploads') continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(target, entry.name);
      const resolved = await realpath(full).catch(() => null); if (!resolved) continue;
      const inside = relative(await realpath(project.path), resolved); if (inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
      const info = await lstat(resolved); if (!info.isFile() && !info.isDirectory()) continue;
      files.push({ path, type: info.isDirectory() ? 'directory' : 'file', size: info.isFile() ? info.size : 0 });
    }
    return { files: files.sort((a,b) => a.path.localeCompare(b.path)) };
  }

  async readImage(id: string, path: string, revision?: string) {
    const limit = 10 * 1024 * 1024;
    let bytes: Buffer;
    if (revision !== undefined) {
      const project = await this.resolve(id), rel = this.#historyPath(path);
      if (revision !== 'index') {
        this.#historyCommit(revision);
        const commit = (await git(project.path, ['rev-parse','--verify',revision+'^{commit}']).catch(()=>'')).trim();
        if (commit !== revision.toLowerCase()) throw problem('Commit not found',404);
      }
      const listing = await git(project.path, revision === 'index'
        ? ['ls-files','--stage','-z','--',':(literal)'+rel]
        : ['--literal-pathspecs','ls-tree','-z',revision,'--',rel]);
      const entry = listing.split('\0').find(line => line.slice(line.indexOf('\t')+1) === rel);
      if (!entry) throw problem('Image version not found',404);
      const [mode, second, third] = entry.slice(0,entry.indexOf('\t')).split(' ');
      if (!['100644','100755'].includes(mode) || (revision === 'index' ? third !== '0' : second !== 'blob')) throw problem('Not a regular file version',400);
      const object = revision === 'index' ? second : third;
      if (!/^[0-9a-f]{40,64}$/.test(object)) throw problem('Invalid Git object',400);
      if (Number((await git(project.path,['cat-file','-s',object])).trim()) > limit) throw problem('Image exceeds 10 MiB',413);
      bytes = await gitBytes(project.path,['cat-file','blob',object],30_000,limit+1);
    } else {
      const { target, rel } = await this.#safePath(id, path, true);
      this.#checkVisible(rel);
      if ((await lstat(target)).size > limit) throw problem('Image exceeds 10 MiB',413);
      bytes = await this.#readBounded(target, limit);
    }
    if (bytes.length > limit) throw problem('Image exceeds 10 MiB', 413);
    try {
      const image = sharp(bytes, { limitInputPixels:40_000_000, failOn:'error' });
      const metadata = await image.metadata();
      if (!['png','jpeg','webp','gif','avif','heif','svg'].includes(metadata.format ?? '')) throw new Error('Unsupported image');
      // Rasterize SVG and the first animation frame; never serve executable source.
      return await image.rotate().resize({ width:2048, height:2048, fit:'inside', withoutEnlargement:true }).webp({ quality:85 }).toBuffer();
    } catch { throw problem('Image is invalid, unsupported or exceeds 40 megapixels', 415); }
  }

  async readFile(id: string, path: string) {
    const { project, target, rel } = await this.#safePath(id, path, true);
    this.#checkVisible(rel);
    const info = await lstat(target); const bytes = await this.#readBounded(target,MAX_VIEW_BYTES);
    const binary = bytes.subarray(0, 8192).includes(0);
    if (binary) return { path: rel, text: '', size: info.size, truncated: false, binary: true };
    const slice = bytes.subarray(0, MAX_VIEW_BYTES); let text:string; try{text=new TextDecoder('utf-8',{fatal:true}).decode(slice);}catch{return {path:rel,text:'',size:info.size,truncated:info.size>MAX_VIEW_BYTES,binary:true};}
    let truncated = info.size > MAX_VIEW_BYTES; const lines = text.split('\n');
    if (lines.length > MAX_VIEW_LINES) { text = lines.slice(0,MAX_VIEW_LINES).join('\n'); truncated = true; }
    return { path: rel, text, size: info.size, truncated, binary: false };
  }

  #checkVisible(rel:string){if(sensitivePath(rel))throw problem('Sensitive file is not readable',403);}
  async #readBounded(path:string,maxBytes:number){const handle=await open(path,'r');try{const bytes=Buffer.allocUnsafe(maxBytes+1);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);return bytes.subarray(0,bytesRead);}finally{await handle.close();}}
  async readReportFile(id:string,path:string,maxBytes:number){const {project,target,rel}=await this.#safePath(id,path,true);this.#checkVisible(rel);const info=await lstat(target);if(info.size>maxBytes)throw problem('Report exceeds size limit',413);return {path:rel,bytes:await this.#readBounded(target,maxBytes),mtimeMs:info.mtimeMs};}

  async #revision(projectPath: string) { try { return (await git(projectPath,['rev-parse','HEAD'])).trim(); } catch { return null; } }

  async gitFiles(id: string, staged = false) {
    const { project, entries } = await this.gitStatus(id); const files=[];
    for (const entry of entries) {
      const selected=staged?entry.index:entry.worktree;
      const status = entry.index==='?' ? (staged?'unchanged':'untracked') : selected.trim() ? selected : 'unchanged';
      if (status === 'unchanged') continue;
      const path = entry.path; let added=0, deleted=0, binary=false;
      if (status === 'untracked') { const content=await this.readFile(id,path); binary=content.binary; if (!binary) added=content.text.split('\n').length-(content.text.endsWith('\n')?1:0); }
      else {
        const stat=(await git(project.path,['diff','--numstat',...(staged?['--cached']:[]),'--',':(literal)'+path])).trim().split(/\s+/);
        if (stat[0]==='-') binary=true; else { added=Number(stat[0])||0; deleted=Number(stat[1])||0; }
      }
      files.push({path, ...(entry.originalPath?{oldPath:entry.originalPath}:{}), status: status === 'R' ? 'renamed' : status, added, deleted, binary});
    }
    return { files, revision: await this.#revision(project.path) };
  }

  async gitPatch(id: string, path: string, staged = false) {
    const { project, rel } = await this.#safeGitPath(id,path);
    const status=await this.gitStatus(id); const untracked=!staged&&status.entries.some(e=>e.path===rel&&e.index==='?');
    if (untracked) {
      const {target}=await this.#safePath(id,rel,true);this.#checkVisible(rel);const info=await lstat(target);if(info.size>MAX_PATCH_BYTES)throw problem('Patch exceeds 5 MiB',413);const bytes=await this.#readBounded(target,MAX_PATCH_BYTES);if(bytes.subarray(0,8192).includes(0))return '';let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return '';}const finalNewline=text.endsWith('\n');const lines=text.split('\n');if(finalNewline)lines.pop();const body=lines.map(line=>`+${line}`).join('\n');return `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}${finalNewline?'\n':'\n\\ No newline at end of file\n'}`;
    }
    const patch=await git(project.path,['diff','--no-ext-diff','--no-textconv','--no-color',...(staged?['--cached']:[]),'--',':(literal)'+rel],30_000,MAX_PATCH_BYTES+1);if(Buffer.byteLength(patch)>MAX_PATCH_BYTES)throw problem('Patch exceeds 5 MiB',413);return patch;
  }

  async gitFileDiff(id: string, path: string, staged = false) {
    const rel = this.#historyPath(path);
    if (imagePath(rel)) {
      const {project,entries} = await this.gitStatus(id);
      const entry = entries.find(item => item.path === rel), code = entry && (staged ? entry.index : entry.worktree);
      if (!entry || !code?.trim() || (staged && code === '?')) throw problem('Path is not a changed file');
      const head = await this.#revision(project.path);
      const oldPath = /[RC]/.test(code) && entry.originalPath ? this.#historyPath(entry.originalPath) : rel;
      return {path:rel,staged,revision:head,images:{
        before: code === 'A' || code === '?' || (staged && !head) ? null : {path:oldPath,revision:staged ? head : 'index'},
        after: code === 'D' ? null : {path:rel,...(staged ? {revision:'index'} : {})},
      }};
    }
    const { project } = await this.#safeGitPath(id,rel); const patch=await this.gitPatch(id,rel,staged);
    return parsePatch(rel,patch,{staged,revision:await this.#revision(project.path)});
  }

  async #historyRefs(projectPath:string) {
    const current=(await git(projectPath,['symbolic-ref','--quiet','HEAD']).catch(()=>'')).trim();
    const text=await git(projectPath,['for-each-ref','--format=%(objectname)%00%(refname)%00%(*objectname)%00%(symref)','refs/heads','refs/remotes','refs/tags']);
    const refs=new Map<string,string[]>(); const branches:{name:string;ref:string;current:boolean}[]=[];
    for(const line of text.split('\n')){if(!line)continue;const [object,ref,peeled,symbolic]=line.split('\0');const id=peeled||object;if(!refs.has(id))refs.set(id,[]);refs.get(id)!.push(ref);if(ref.startsWith('refs/heads/')||ref.startsWith('refs/remotes/')&&!symbolic)branches.push({name:ref.replace(/^refs\/(heads|remotes)\//,''),ref,current:ref===current});}
    if(current&&!branches.some(branch=>branch.ref===current))branches.push({name:current.slice(11),ref:current,current:true});
    return {refs,branches:branches.sort((a,b)=>a.name.localeCompare(b.name))};
  }

  #historyCommit(value:string) { if(!/^[0-9a-f]{40,64}$/i.test(value))throw problem('Invalid commit'); return value; }
  #historyPath(value:string,sensitive=true) { this.#validateRelative(value); const rel=value.split(sep).join('/'); if(sensitive&&this.#sensitiveHistoryPath(rel))throw problem('Sensitive file is not readable',403); return rel; }
  #sensitiveHistoryPath(rel:string){return sensitivePath(rel);}

  async gitLog(id:string,ref='HEAD',cursor?:string) {
    const {path}=await this.resolve(id);
    if(!(await git(path,['rev-parse','--is-inside-work-tree']).catch(()=>'' )).trim())return {repository:false,commits:[],branches:[],nextCursor:null};
    let tips:string[]; let skip=0;
    if(cursor){try{if(typeof cursor!=='string'||cursor.length>4096)throw new Error();const value=JSON.parse(inflateRawSync(Buffer.from(cursor,'base64url'),{maxOutputLength:64*1024}).toString());if(Object.keys(value).sort().join(',')!=='ref,skip,tips'||value.ref!==ref||!Array.isArray(value.tips)||value.tips.length>512||!value.tips.every((tip:any)=>/^[0-9a-f]{40,64}$/i.test(tip))||!Number.isSafeInteger(value.skip)||value.skip<1)throw new Error();({tips,skip}=value);}catch{throw problem('Invalid history cursor');}}
    else if(ref==='HEAD') { const head=(await git(path,['rev-parse','--verify','HEAD^{commit}']).catch(()=>'')).trim(); tips=head?[head]:[]; }
    else if(ref==='all') { tips=[...new Set((await git(path,['for-each-ref','--format=%(objectname)','refs/heads','refs/remotes','refs/tags'])).split(/\s+/).filter(Boolean))]; }
    else { if(!/^refs\/(?:heads|tags|remotes)\//.test(ref)||/[\x00-\x1f]/.test(ref))throw problem('Invalid Git ref');await git(path,['check-ref-format',ref]).catch(()=>{throw problem('Invalid Git ref')});const tip=(await git(path,['rev-parse','--verify',ref+'^{commit}']).catch(()=>'')).trim();if(!tip)throw problem('Git ref not found',404);tips=[tip]; }
    if(tips.length>512)throw problem('分支过多，请选择具体分支',409);
    const {refs,branches}=await this.#historyRefs(path);
    if(!tips.length)return {repository:true,commits:[],branches,nextCursor:null};
    const raw=await git(path,['log','--topo-order',`--max-count=${HISTORY_PAGE_SIZE+1}`,`--skip=${skip}`,'--format=%H%x00%P%x00%s%x00%an%x00%aI%x00',...tips]);
    const fields=raw.split('\0'); const commits:any[]=[];
    for(let i=0;i+4<fields.length;i+=5){const commitId=fields[i].replace(/^\s+/,'');if(!commitId)continue;commits.push({id:commitId,parents:fields[i+1].trim().split(/\s+/).filter(Boolean),subject:fields[i+2],author:fields[i+3],date:fields[i+4],refs:refs.get(commitId)??[]});}
    const more=commits.length>HISTORY_PAGE_SIZE; if(more)commits.length=HISTORY_PAGE_SIZE;
    const nextCursor=more?deflateRawSync(JSON.stringify({ref,tips,skip:skip+HISTORY_PAGE_SIZE})).toString('base64url'):null;if(nextCursor&&nextCursor.length>4096)throw problem('分支过多，请选择具体分支',409);return {repository:true,commits,branches,nextCursor};
  }

  async #commitInfo(projectPath:string,value:string) {
    const requested=this.#historyCommit(value);const id=(await git(projectPath,['rev-parse','--verify',`${requested}^{commit}`]).catch(()=>'')).trim();if(!id)throw problem('Commit not found',404);
    const raw=await git(projectPath,['show','-s','--format=%H%x00%P%x00%s%x00%B%x00%an%x00%aI%x00',id]);const [commitId,parents,subject,message,author,date]=raw.split('\0');const {refs}=await this.#historyRefs(projectPath);
    return {id:commitId,parents:parents.trim().split(/\s+/).filter(Boolean),subject,message:message.replace(/\n$/,''),author,date,refs:refs.get(commitId)??[]};
  }

  async #historyTreeConflict(projectPath:string,commit:string,parent:string|null,paths:string[]){for(const path of paths)for(const revision of [parent,commit])if(revision&&(await git(projectPath,['cat-file','-t',revision+':'+path]).catch(()=>'')).trim()==='tree')return true;return false;}

  async #historyPatch(projectPath:string,commit:string,parent:string|null,paths:string[]){const pathspecs=paths.map(path=>':(literal)'+path);return parent?git(projectPath,['diff','--no-ext-diff','--no-textconv','--no-color','-M',parent,commit,'--',...pathspecs],30_000,MAX_PATCH_BYTES+1):git(projectPath,['diff-tree','--root','--no-commit-id','-r','-p','--no-ext-diff','--no-textconv','--no-color',commit,'--',...pathspecs],30_000,MAX_PATCH_BYTES+1);}

  async gitCommit(id:string,commit:string,parent?:string) {
    const {path}=await this.resolve(id);const info=await this.#commitInfo(path,commit);const selected=parent===undefined?info.parents[0]??null:this.#historyCommit(parent);
    if(selected&&!info.parents.includes(selected))throw problem('Parent is not a parent of commit');
    const args=selected?['diff','--name-status','-z','-M',selected,info.id,'--']:['diff-tree','--root','--no-commit-id','-r','-z','--name-status','-M',info.id];
    const parts=(await git(path,args)).split('\0');const files:any[]=[];
    for(let i=0;i<parts.length;){const code=parts[i++];if(!code)continue;const statusCode=code[0];const oldPath=/^[RC]/.test(code)?parts[i++]:undefined;const filePath=parts[i++];const rel=this.#historyPath(filePath,false);const safeOld=oldPath?this.#historyPath(oldPath,false):undefined;if(this.#sensitiveHistoryPath(rel)||(safeOld&&this.#sensitiveHistoryPath(safeOld))||await this.#historyTreeConflict(path,info.id,selected,[...(safeOld?[safeOld]:[]),rel]))continue;const patch=await this.#historyPatch(path,info.id,selected,[...(safeOld?[safeOld]:[]),rel]);let added=0,deleted=0;for(const line of patch.split('\n')){if(line.startsWith('+')&&!line.startsWith('+++'))added++;else if(line.startsWith('-')&&!line.startsWith('---'))deleted++;}files.push({path:rel,...(oldPath?{oldPath}:{}),status:statusCode==='A'?'added':statusCode==='D'?'deleted':statusCode==='R'?'renamed':statusCode==='C'?'copied':'modified',added,deleted,binary:/Binary files |GIT binary patch/.test(patch)});}
    return {commit:info,parent:selected,files};
  }

  async gitCommitDiff(id:string,commit:string,parent:string|undefined,pathValue:string){const project=await this.resolve(id);const path=this.#historyPath(pathValue);const info=await this.#commitInfo(project.path,commit);const parentId=parent===undefined?info.parents[0]??null:this.#historyCommit(parent);if(parentId&&!info.parents.includes(parentId))throw problem('Parent is not a parent of commit');const changed=await this.gitCommit(id,info.id,parentId??undefined);const file=changed.files.find((item:any)=>item.path===path);if(!file)throw problem('Path is not a changed file');if(imagePath(path))return {path,commit:info.id,parent:parentId,images:{before:!parentId||file.status==='added'?null:{path:file.oldPath??path,revision:parentId},after:file.status==='deleted'?null:{path,revision:info.id}}};const patch=await this.#historyPatch(project.path,info.id,parentId,[...(file?.oldPath?[file.oldPath]:[]),path]);return parsePatch(path,patch,{commit:info.id,parent:parentId});}
}
