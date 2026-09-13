#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 0 || ( $# == 1 && $1 == --start ) ]] || fail 'Usage: bash scripts/linux/install-startup.sh [--start]'
check_node
check_ready
systemctl --user show-environment >/dev/null || fail 'A working user systemd session is required. Foreground start-server.sh remains available.'
"$node" --input-type=module - "$repo" "$unit_file" "$marker" "$PATH" <<'JS'
import {mkdir,readFile,lstat,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
const [repo,file,marker,path]=process.argv.slice(2);
const previous=await lstat(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
if(previous && (previous.isSymbolicLink() || !(await readFile(file,'utf8')).startsWith(marker+'\n')))throw Error('Refusing to overwrite an unrelated systemd unit.');
const quote=value=>{if(/[\x00-\x1f\x7f]/.test(value))throw Error('Unsupported control character in service path');return '"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')+'"';};
const unit=`${marker}
[Unit]
Description=Codex Web
StartLimitIntervalSec=60
StartLimitBurst=3
[Service]
Type=simple
Environment=${quote('PATH='+path)}
EnvironmentFile=-${repo.replaceAll('%','%%')}/.local/web/service.env
ExecStart=/bin/bash ${quote(repo.replaceAll('$','$$')+'/scripts/linux/start-server.sh')}
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=15
UMask=0077
[Install]
WantedBy=default.target
`;
await mkdir(dirname(file),{recursive:true});
await writeFile(file+'.tmp',unit,{flag:'wx',mode:0o600});
await rename(file+'.tmp',file);
JS
systemctl --user daemon-reload
systemctl --user enable "$unit"
if [[ ${1:-} == --start ]]; then systemctl --user start "$unit"; fi
printf 'Installed %s\nStatus: systemctl --user status %s\nLogs: journalctl --user -u %s\n' "$unit" "$unit" "$unit"
