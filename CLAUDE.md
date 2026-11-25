# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**LAN Agents**: an Electron + TypeScript desktop app. Two or more machines on the same LAN (or several windows on one machine) find each other, pair, and chat. The agent on the *receiving* machine answers using a locally logged-in CLI (`claude`, Cursor `agent`, `codex`, `gemini`) or the built-in **Echo** runtime. There are no API key fields, and the app strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CURSOR_API_KEY` from child processes. The UI text, prompts, docs and commit messages are all in Vietnamese, so keep new user-facing strings in Vietnamese.

`docs/chat.md` is the detailed behavioural spec for chat: wire events, prompt assembly, two-agent dialogue turn counting, halt/epochs, file transfer and HTTP endpoints. Read it before changing chat flow. Some details there may lag behind the code. For example, Claude now gets the prompt on stdin, not as an argument, but it is still flattened to one line and clipped to 4000 characters (`oneLine()` in `agents.ts`).

## Commands

```bash
npm install
npm run dev:pair     # build, then launch two windows: --profile=A and --profile=B
npm run dev          # profile A only;  npm run dev:b → profile B only
npm start            # build + electron . (default profile)
npm run build        # esbuild bundles into dist/
npm run typecheck    # tsc --noEmit. This is the only static check; there is no linter
npm run smoke        # end-to-end test (see below)
npm run dist         # Windows NSIS installer → release/   (dist:mac for mac zip)
```

There is no unit-test framework. `scripts/smoke.mjs` is the only automated test. It builds, starts two Electron processes (A/B, `--auto-accept`, `--debug-port=9222/9223`), polls `GET /identity` on ports 3940–3969 until each sees the other, then drives A's renderer over the Chrome DevTools Protocol (via `ws`) to send a message and wait for B's Echo reply.

Useful launch flags (parsed in `src/main/index.ts`): `--profile=<name>` sets a separate userData dir `%APPDATA%/lan-agents/<profile>/` (holding `config.json`) and a separate port. `--auto-accept` auto-accepts pairing for this session. `--debug-port=N` enables remote debugging.

## Build layout

`scripts/build.mjs` runs esbuild with no tsc emit. Its outputs:
- `src/main/index.ts` → `dist/main.js` (node/cjs, `electron` and all packages external)
- `src/preload/preload.ts` → `dist/preload.js`
- three renderer entries (iife, browser): `renderer.ts` → `renderer.js` (main window), `previewWindow.ts` → `preview.js`, `codingWindow.ts` → `coding.js`
- `index.html`, `preview.html`, `coding.html` and `styles.css` are copied as-is.

When you add a new window or page, update `build.mjs`. `asar` is off and only `dist/**` and `package.json` are packaged.

## Architecture

**Process split**
- `src/main/index.ts`: Electron bootstrap, single-instance lock, windows (main, file preview, coding view), and IPC handlers. Each handler is registered through `expose()`, which reports errors via `core.noteError`.
- `src/main/core.ts` (`AppCore`, about 4.5k lines): almost all app logic. It runs the HTTP server plus the Socket.io server (inbound peers), Socket.io clients (outbound peers), pairing/tokens, per-peer chat sessions, the reply queue, dialogue turns, project briefs, group rooms, file transfer and access checks. It pushes `AppState` to the renderer.
- `src/preload/preload.ts`: exposes the typed `LanApi` over `contextBridge`. IPC channel names live in `IPC` in `src/shared/types.ts`. A new IPC call touches four places: `IPC` + the `LanApi` type (types.ts), preload, the `expose()` handler in index.ts, and the AppCore method.
- `src/renderer/renderer.ts`: a single-file vanilla DOM UI (no framework) that re-renders from `AppState`.
- `src/shared/*`: pure logic used by both main and renderer. Renderer code must not import Node-only modules (`discuss.ts`/`office.ts` use `zlib` and are main-side only).

**Networking**
- `discovery.ts`: UDP multicast announce on `239.255.77.77:41234`. The HTTP/Socket.io port starts at 3940 and is derived from the profile within a 30-port span (`basePort`).
- HTTP routes in `AppCore`: `/health`, `/identity`, `/peers` (no token); `/knock`, `/trigger` (Bearer token); `/inbox-file`; and the local-only `/relay-file/<peerId>`. The agent's prompt tells it to `curl` that last route to send a workdir file to the peer.
- The same peer events are wired twice: once on server-side sockets (`socket.on(...)` around core.ts:754) and once on client sockets (around core.ts:888). A new wire event must be added to both. Group events (`group-*`) are wired separately (around core.ts:3208). Large files go via `file-begin/chunk/end` events.
- Each peer has a serialized reply queue and an **epoch**. `halt` bumps the epoch, kills CLI processes (`taskkill /t /f` on Windows), and drops queued work from the old epoch.

**Agents** (`src/main/agents.ts`, `AgentHost`)
- `reply()` dispatches on `settings.provider` (`echo`, `claude-cli`, `cursor-cli`, `codex-cli`, `gemini-cli`). Each CLI has an ordered list of flag sets (`attempts`). If one is rejected, the next is tried, which keeps the app working across CLI versions. CLI sessions are resumed (`--resume`) when supported; `CliSessionLost` and `CliResumeUnsupported` trigger fallbacks.
- Streaming output is parsed from stream-json events. Partial text is pushed to the peer as `delta` (the full text so far, about every 80 ms).
- `cliDetect.ts` locates executables, including default install dirs. Cursor is launched via its bundled `node` + `index.js`, not via PowerShell.

**Feature layers on top of 1:1 chat**
- **Sessions**: several chat sessions per peer, synced by the `session` event. Only the open session is fed to the agent.
- **Project brief / topic** (`shared/brief.ts`): topic, goal, files and a turn limit for multi-turn agent work. **Coding mode** (`coding: true`) raises the turn cap (up to 200). It watches agent output for the markers `KẾT QUẢ` (final result, written to `ket-qua.md`) and `CẦN THÊM: N` (request more turns). Agents never stop to ask a human in coding mode; they log each judgement call in a `TỰ CHỐT … HẾT TỰ CHỐT` block. The result file must contain a `## Các điểm agent tự chốt` section: if the agent leaves it out, `withDecisions()` in core.ts appends one built from those blocks in the transcript (parser in `shared/brief.ts`). `codingTerm.ts` + `shared/codingLive.ts` + the coding window show live edit/shell steps.
- **Topic queue and run reports**: `store.topicQueues[sessionId]` holds the next topics. It is local to the machine where they were added and is never synced to peers. `watchRuns()` (called from `push`/`pushNow`) tracks every brief that is running. When a brief stops, `closeRun()` waits `RUN_SETTLE_MS`, then writes `briefs/<session>/ket-qua-NN.md` (status, times, turns, result, decisions). If that run ended with `KẾT QUẢ`, `advanceQueue()` starts the next topic in the same session via `startBrief(peerKey, sessionId)`. Every machine in the session writes its own reports.
- **Group rooms** (`shared/group.ts`): up to 5 members, keyed `group:<id>`. Turn order uses `TurnTicket`, @mentions route turns, and coding roles (PO, PM, BA, UX, SA, BE, FE, …) inject a role-duty line into the prompt.
- **Access control** (`shared/access.ts` + `access.json`): a catalog of capabilities in 4 risk levels. By default, levels 1–2 are granted. `deniedRoles()` matches regexes against the latest incoming request (`"request"` mode, before running) and against streamed tool calls (`"command"` mode, via `toolBlob`). A match throws `AccessDenied` and aborts the run. The machine owner (a self-mention turn) bypasses these checks. Permissions are re-announced to peers when a topic starts.
- `settings.confineWorkDir` restricts the agent and file sending to the working directory (Cursor `--sandbox`, etc.).

**Persistence**: `store.ts` keeps settings, the peer ID, trusted peers (tokens), sessions, briefs and groups in a single `config.json` in userData. All input from disk and the wire goes through the `sanitize*` / `clean*` helpers, so keep that pattern for new fields.

**Previews**: the custom `lan-file://` protocol (`main/preview.ts`) serves only paths explicitly allowed via `allowPreview()`. HTML previews render in a sandboxed iframe with no scripts. Markdown (agent replies, `.md` files, result cards) goes through `renderMarkdownHtml()` in `renderer/previewView.ts`, which uses markdown-it with `html: false`. Raw HTML from peers or agents is escaped. Images resolve only to local preview-able files, and only `http(s)` links stay clickable. `index.ts` sends those links to the system browser through `setWindowOpenHandler`/`will-navigate`. Text files (`txt`, `log`, `csv`, `json`) use the `text` preview kind and render as `<pre>`.
