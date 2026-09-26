# Codex Web

[中文](README.md)

A lightweight web client for Codex running on your development machine, accessible locally or remotely. Use a desktop or mobile browser to manage projects, continue native Codex Threads, inspect live execution and Git changes, and respond to approvals. The official standalone Codex CLI handles agent execution and conversation history; the Web service uses the host user's Codex login.

## Features

- Select an existing project, use no-project mode, create a Git project or clone a repository; continue conversations, steer running tasks, interrupt, and release for handoff.
- Live incremental synchronization, paginated history, on-demand command output, safe Markdown, and original-text copying.
- Resizable, remembered three-pane layout; text, Markdown, and image previews, unified/split diffs, read-only Git history, and JUnit reports.
- Native model, reasoning, and approval choices; rename, favorite, hide from Web, and clear Web metadata.
- Private file/image attachments, Web Push, and a PWA that caches only the static shell.
- Account limits, automatic reset times, and reset credits in the top bar; using a credit requires confirmation, and interrupted operations retain their identity for verification.

## Screenshots

**Desktop**

![Codex Web desktop: project list, conversation, and project sidebar](docs/assets/screenshots/desktop.png)

**Mobile**

<img src="docs/assets/screenshots/mobile.png" alt="Codex Web mobile: conversation history and message composer" width="360">

## Platforms and prerequisites

| Host platform | Scope |
| --- | --- |
| Windows | Source execution, Windows x64 portable packages, and current-user logon startup; compatible with built-in PowerShell 5.1 |
| Linux | An x64 glibc portable package is available; source execution, live tasks, and sandbox boundaries have been verified as a non-root user on WSL2 Ubuntu 22.04; no claim covers all distributions |
| macOS | Not adapted or verified in this round |

Running from source requires Node **>=24.20.0**, npm, the official standalone Codex CLI, and Git for project/Git features. `.node-version` declares the baseline; it does not switch Node automatically. Install and sign in using the [official Codex instructions](https://learn.chatgpt.com/docs/codex/cli). Linux/WSL must use the Linux CLI and its own environment's login. Do not rely on binaries inside the VS Code extension's private directory.

## Run from source

Create the default work root `~/work` (`%USERPROFILE%\work` on Windows), or set `WORK_ROOT` to an existing directory; the service does not create it automatically. Then run in the project directory:

```sh
npm ci
npm run build
npm run auth:setup
npm start
```

Skip setup if a password already exists. Set a 12–256-character password in your local interactive terminal. The default URL is `http://localhost:3000`; the service listens only on `127.0.0.1`. `npm run dev` starts only the frontend development server; use build + start for the complete service. See the [deployment guide](docs/guides/deployment.md) for remote access, configuration, and upgrades.

The default work root is the current user's `~/work` (`%USERPROFILE%\work` on Windows); only immediate project directories are discovered. `.local/web/config.json` configures `origin`, `port`, `workRoot`, and `codexBin`. The corresponding `WEB_ORIGIN`, `PORT`, `WORK_ROOT`, and `CODEX_BIN` environment variables take precedence; `WEB_DATA_DIR` changes the data directory. Windows defaults to the official standalone CLI installation location; Linux defaults to `codex` on PATH.

Deployment scripts are organized into [`scripts/windows/` and `scripts/linux/`](scripts/README.md). After building and setting a password, Linux users can run `bash scripts/linux/start-server.sh` in the foreground, or install a user systemd service with `bash scripts/linux/install-startup.sh --start`. See the deployment guide for stopping, logs, and Tailscale configuration.

On Windows, double-click `scripts/windows/start-server.cmd` to start a source deployment in the background. Logs are written to `.local/web/server.log`; closing the launcher window does not stop the service. Double-click `stop-server.cmd` to stop it. CMD launchers prefer an existing PowerShell 7 installation and otherwise use built-in Windows PowerShell 5.1; no extra PowerShell installation is required. Matching CMD launchers also configure startup and network access.

The Files, Changes, and Git History tabs preview PNG, JPEG, WebP, GIF, AVIF, and SVG images, scaled to fit the panel. Changes show before/after images from the actual worktree, index, or commit, including additions, deletions, and renames. SVG is rasterized and animations show their first frame. Limits are 10 MiB and 40 megapixels per image, with a preview long edge of at most 2048 pixels. Files also lists and reads files excluded by `.gitignore`; project boundaries, authentication, and sensitive-file protection still apply. The Changes list follows Git tracking rules and clears selections that disappear after a successful refresh.

Git History uses icons and short names for local branches, remote-tracking branches, and tags. You can select branches such as `origin/main`; All branches also includes remote-only history. All three tabs share the Refresh button beside Project: local content reloads immediately while fetch runs in the background, then the graph updates. Browsing and chat remain available; failures retain local content and show a message. Fetch is skipped when no remote exists. Concurrent requests for a project are merged, with results reused for 10 seconds; limits are 30 seconds per remote and 60 seconds overall. Only remote-tracking branches are updated or pruned; local branches, tags, the index, and working files remain unchanged. Automatic refreshes and tab switches do not trigger fetch. See the [workspace design](docs/design/workspace-panels.md).

## Local and cross-device access

Recommended daily setup: **run Codex Web in the background on a Windows development machine, then continue tasks from your phone over private Tailscale HTTPS**. Code, execution, and Codex credentials stay on the host; the phone needs only Tailscale and a browser. Run the following commands in PowerShell from the project or portable package root.

### 1. Get local access working first

Use the source setup above or extract a portable package and run `Start.cmd`. Complete native Codex login, work-root setup, and Web password setup. Confirm that you can sign in and finish a task at `http://localhost:3000` (use your actual port if different). Choose background mode for portable packages; source deployments use `scripts/windows/start-server.cmd`.

### 2. Give your phone a private HTTPS address

[Install Tailscale](https://tailscale.com/download) on the host and phone, sign in with the same account to join the same tailnet, and keep both connected. If you customize access policies, allow the phone to reach the host's HTTPS port. On the host, run:

```powershell
.\scripts\windows\configure-serve.cmd -Port 3000
```

Match the Web service's port. On first use, follow any Tailscale HTTPS / Serve enablement prompt, then rerun the script. It maps HTTPS to the local loopback service, writes the actual hostname to `.local/web/config.json`, and preserves the previous address for local access. If Serve already has configuration, the script stops for inspection rather than overwriting it; do not clear existing mappings just to bypass this check.

After tasks finish, restart Web (`Stop.cmd` → `Start.cmd` for portable packages, `stop-server.cmd` → `start-server.cmd` for source). On your phone, open the actual HTTPS address printed by the script, shaped like `https://device.tailnet-name.ts.net`, and sign in with your **Web password**. HTTPS and localhost require separate browser logins. Use the browser's “Add to Home Screen” option for convenient access.

[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) exposes this endpoint only to authorized tailnet devices; no router port forwarding or public Funnel is needed. The script creates a persistent background mapping that resumes when Tailscale restarts. Web still listens on `127.0.0.1`; entering the host's Tailscale IP alone does not replace this HTTPS endpoint.

### 3. Start at logon and hand off tasks

```powershell
.\scripts\windows\install-startup.cmd
```

This starts Web **when the current Windows user logs in**, not before login as a system service. The startup entry uses the Codex Web name and icon; remove it with `uninstall-startup.cmd`. Keep the host powered on, connected, and awake, with Tailscale and any required proxy running. Disconnecting the phone does not itself stop a task; reconnect to check progress. You cannot send messages offline.

When CLI, VS Code, Codex App, and Web share the same host user's native sessions, release a conversation in the previous client before handing it off. Keep one writer per conversation. The phone needs neither Codex installed nor a copy of the host's credentials.

### 4. If outbound access needs a proxy: use it for HTTP and WebSocket

**Tailscale connects the phone to the host; the outbound proxy connects Codex on the host to the model service.** These are separate connections. Skip this section if direct model access already works.

For v2rayN or a similar Windows proxy, enable its system-proxy setting and confirm that Windows points to the actual listener, for example `127.0.0.1:10808` (an example only; use your own port). Running the proxy application alone does not configure the system proxy.

Back up the native Codex user config at `%USERPROFILE%\.codex\config.toml`, then add this setting to the existing `[features]` section. Create the section only if absent; **do not replace the whole file or duplicate the section**:

```toml
[features]
respect_system_proxy = true
```

This is native Codex configuration, not Web's `config.json`. Standalone CLI, the VS Code extension, and Codex App can share it under the same Windows user and `CODEX_HOME`. Custom `CODEX_HOME` values, other OS users, and WSL require checking their own configurations. Check that the CLI you use supports and reads the option:

```powershell
codex features list | Select-String respect_system_proxy
```

Expect `true`; use the standalone CLI's actual path if it is not on PATH. Once active tasks finish, restart Web and the native processes for any affected VS Code / Codex App instances, then verify with a short message. The launcher's `-NoProfile` skips the PowerShell profile, not Codex's system-proxy lookup. This setup needs no profile-based proxy variables or changes to Codex filesystem permissions or login mode.

CLI **0.156.1** still marks this feature `under development`. That version and the native **0.155.0-alpha.16.3 / 0.155.0-alpha.16.4** executables bundled with VS Code / Codex App were verified to establish WebSocket connections and receive model responses through the system proxy. This does not establish support for every version or platform; recheck after upgrades. See [Codex 0.156.1 proxy selection](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/http-client/src/outbound_proxy.rs). If it regresses, undo only the added setting and restart affected clients, preserving other configuration and credentials.

### 5. Identify which connection failed

| Symptom | Check first |
| --- | --- |
| Local Web access also fails | Service status and port: portable `Status.cmd`, source `scripts/windows/status-server.cmd` |
| Local access works, phone access fails | Tailscale on both devices, access policy, host sleep, and the HTTPS address / target port in `tailscale serve status` |
| Web works, but Codex repeats `Reconnecting… 5/5` | Model connection details, proxy availability, and effective native config; existing `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` may also affect routing |
| Model requests return `401 Unauthorized` | Native account and provider / API key configuration; this is not a normal WebSocket fallback notice and the proxy flag does not fix it |

Exhausted WebSocket retries can fall back to HTTP streaming, explaining a long wait followed by a successful response. This is only one possible cause; `5/5` alone does not diagnose a proxy problem. Local use needs no Tailscale. See the [deployment guide](docs/guides/deployment.md#网络访问方式) for Linux, other networking options, and further troubleshooting.

## Portable packages

Download the appropriate package from [GitHub Releases](https://github.com/sxcooler/codex_web/releases) and fully extract it into a writable directory:

| Package | Start |
| --- | --- |
| `codex-web-VERSION-win-x64.zip` | Double-click `Start.cmd` |
| `codex-web-VERSION-linux-x64.tar.gz` | Run `tar -xzf PACKAGE.tar.gz`, enter the extracted directory, then run `bash Start.sh` |
| `codex-web-VERSION-source.zip` | Platform-independent clean source; follow the source setup above |

Portable packages include Node and platform-specific production dependencies; Node/npm installation is unnecessary. Git and Codex CLI are separate prerequisites. First-run setup asks for the work root, local port, optional domain, CLI, and password. Since 0.1.4, the `allowedOrigins` array in config.json accepts additional full site addresses, allowing localhost and HTTPS domains to work together with separate browser logins. DNS and proxy setup remain separate. If Codex is missing, install manually using the official page or explicitly consent to running the official installer for your platform. Account sign-in remains separate. The first interactive run also asks whether future launches should run in the background. Once ready, the launcher can close; use `Stop.cmd` / `bash Stop.sh` to stop and `Status.cmd` / `bash Status.sh` to inspect the instance. Override with `--foreground` / `--background`, change the saved preference with `--configure-startup`, or suppress the browser with `--no-browser`. Background mode does not enable logon startup.

For Windows source deployments, use `scripts/windows/start-server.cmd`. Optional `scripts/windows/install-startup.cmd` uses the current user’s logon startup entry, without Task Scheduler, administrator privileges, or PowerShell 7. Remove it with `uninstall-startup.cmd`. Linux logon startup continues to use user-level systemd.

The Linux package targets x64 glibc systems, with WSL2 Ubuntu 22.04 as the verification environment. ARM64, Alpine/musl, and macOS packages are not provided. Do not copy `node_modules` between platforms. Build natively with `npm ci` followed by `npm run package:portable`; artifacts are written to `releases/`. See the [portable package guide](docs/guides/portable.md) for configuration, upgrades, build prerequisites, and verification.

## Usage and boundaries

Conversation menus support native archiving; switch the sidebar to Archived to restore a thread. Hide from Web only changes Web preferences. User message blocks align right, with available native turn start/completion times beside role names. Missing timestamps and individual steering-message times are not inferred. Long filenames, commit entries, source and diffs scroll horizontally within their panels; Markdown prose still wraps.

Opening or manually refreshing a conversation checks native write ownership before sending. Web holds the conversation after a successful resume; another app holding the writer triggers an early notice and Retry button while history remains readable. The check sends no model message; automatic history synchronization does not reacquire ownership. Switching conversations or opening a new task requests release of the previous conversation, deferred until completion if it is running or awaiting approval. Manual “Release and close” leaves the page only after release is confirmed. Use one writer per Thread at a time. VS Code may retain ownership after a response completes; close the corresponding project window before returning to Web. The app does not forcibly take ownership. An empty Thread may not persist before its first message; releasing or restarting can lose the empty Thread while retaining project files.

A timeout or lost connection can leave a submission's outcome unknown. Check native history before explicitly retrying; refreshing never resends a task. Drafts survive within the current page lifecycle, but a full reload does not guarantee retention. Project context does not replace native Codex permissions. Web file and Git APIs remain restricted to validated project boundaries; there is no arbitrary shell/RPC REST endpoint. See the [session guide](docs/guides/sessions.md).

Web Push requires HTTPS, browser support, and explicit user permission. Physical-phone background delivery and real VS Code handoff for phase-two features still have verification gaps. The PWA does not cache APIs, conversations, or credentials; tasks cannot be submitted offline.

## Documentation and verification

Detailed documentation is currently in Chinese:

[Documentation index](docs/README.md) · [Architecture](docs/design/architecture.md) · [Latest Linux verification](docs/verification/2026-09-13-linux.md) · [Phase-two verification](docs/verification/2026-09-11-phase2.md) · [Historical MVP verification](docs/verification/2026-09-09-mvp.md)

```sh
npm test
npm run build
npm run protocol:generate
npm run probe -- doctor
```

After upgrading the CLI, regenerate the protocol, review differences, and verify compatibility. Generated files live in the ignored `.local/` directory. `probe -- read` only reads an existing test Thread. start/verify/reverse/interrupt/approval consume the existing account's usage and leave native history. verify refuses to resend after an attempt; do not delete attempt records to bypass that protection. Historical records retain their dates and versions and do not prove deployment on your machine. Updating source does not update an already-running service.

## Public releases

Public examples use generalized usernames, paths, and conversation IDs. Source archives **exclude `.git` and local runtime data**. Before pushing a repository, also review the Git history being published; deleting a current file does not remove its history. Do not upload `.local/`, native Codex data, credentials, attachments, databases, logs, unredacted screenshots, or test artifacts. Reviewed, redacted showcase images in `docs/assets/screenshots/` may be published with the documentation. See the [publishing guide](docs/guides/publishing.md) for the reviewed scope and its limits.
