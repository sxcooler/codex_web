#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# -le 1 ]] || fail 'Usage: bash scripts/linux/configure-serve.sh [PORT]'
check_node
"$node" --input-type=module - "$data" "${1:-3000}" <<'JS'
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
const [dir,portText]=process.argv.slice(2),port=Number(portText);
if(!/^\d{1,5}$/.test(portText)||port<1||port>65535)throw Error('Invalid port');
function cli(args,inherit=false){const result=spawnSync('tailscale',args,{encoding:'utf8',stdio:inherit?'inherit':'pipe'});if(result.error||result.status!==0)throw Error('Tailscale command failed; check installation, login and operator permissions.');return result.stdout;}
const status=JSON.parse(cli(['status','--json'])),dns=status.Self?.DNSName?.replace(/\.$/,'');
if(status.BackendState!=='Running'||typeof dns!=='string'||!/^[a-zA-Z0-9.-]+\.ts\.net$/.test(dns))throw Error('Tailscale is not running with a valid DNS name.');
const serve=JSON.parse(cli(['serve','status','--json']));
if(!serve||typeof serve!=='object'||Array.isArray(serve)||Object.keys(serve).length)throw Error('Existing Serve configuration was not overwritten.');
await mkdir(dir,{recursive:true});
const file=join(dir,'config.json'),temporary=file+'.serve-'+process.pid;
const config=JSON.parse(await readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return '{}';throw e;}));
if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Invalid Web configuration');
await writeFile(temporary,JSON.stringify({...config,origin:'https://'+dns,port},null,2)+'\n',{flag:'wx',mode:0o600});
try{cli(['serve','--bg','--https=443',`http://127.0.0.1:${port}`],true);await rename(temporary,file);}
finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
console.log(`Configured private HTTPS at https://${dns}. Restart the Web server to use this origin.`);
JS
