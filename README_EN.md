# Codex Web

[中文](README.md)

A lightweight web client for Codex running on your development machine, accessible locally or remotely. Use a desktop or mobile browser to manage projects, continue native Codex Threads, inspect live execution and Git changes, and respond to approvals. The official standalone Codex CLI handles agent execution and conversation history; the Web service uses the host user's Codex login.

## Features

- Select an existing project, use no-project mode, create a Git project or clone a repository; continue conversations, steer running tasks, interrupt, and release for handoff.
- Live incremental synchronization, paginated history, on-demand command output, safe Markdown, and original-text copying.
- Resizable, remembered three-pane layout; file previews, unified/split diffs, read-only Git history, and JUnit reports.
- Native model, reasoning, and approval choices; rename, favorite, hide from Web, and clear Web metadata.
- Private file/image attachments, Web Push, and a PWA that caches only the static shell.

## Platforms and prerequisites

| Host platform | Scope |
| --- | --- |
| Windows | Existing verification covers source execution, the Windows x64 portable package, and scheduled-task deployment; see the latest record for this round's regression status |
| Linux | Source execution, live tasks, and sandbox boundaries have been verified as a non-root user on WSL2 Ubuntu 22.04; no claim covers all distributions |
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

## Windows portable package

Extract into a writable directory and double-click `Start.cmd`; Node and runtime dependencies are included. First-run setup asks for the work root, CLI, port, and password. If Codex is missing, open the official page to install manually, explicitly consent to running the official installer, or specify an existing CLI. Setup detects the installed CLI again and continues; account sign-in remains a separate step. Keep the startup window open and press Ctrl+C to stop. The package is for Windows x64 only; see the [portable package guide](docs/guides/windows-portable.md).

## Usage and boundaries

Opening or refreshing a conversation only reads history; sending restores write access. Switching conversations or opening a new task requests release of the previous conversation, deferred until completion if it is running or awaiting approval. Manual “Release and close” leaves the page only after release is confirmed. Use one writer per Thread at a time. VS Code may retain ownership after a response completes; close the corresponding project window before returning to Web. The app does not forcibly take ownership. An empty Thread may not persist before its first message; releasing or restarting can lose the empty Thread while retaining project files.

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

Public examples use generalized usernames, paths, and conversation IDs. The original Git history still contains personal environment records. For publication, **create a new repository from a clean source archive without `.git`**. Do not upload `.local/`, native Codex data, credentials, attachments, databases, logs, screenshots, or test artifacts. See the [publishing guide](docs/guides/publishing.md) for the reviewed scope and its limits.
