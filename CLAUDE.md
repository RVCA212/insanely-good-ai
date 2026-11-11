# Insanely Good AI

Open source Chrome extension with a Claude Code chat in the side panel. The chat's Claude writes features into `features/`; this file is for work on the core (extension, host, tools).

## Architecture

- `extension/panel.js`: chat UI. Holds the native messaging port (`com.insanely_good_ai.host`). On send, it captures the active tab (`snapshotPage`: DOM outline + theme CSS rules; screenshot; feature logs) and sends `{ type: 'chat', chatId, text, sessionId, context, devtools }`. `devtools` is the Chrome DevTools switch in the Settings view (`chrome.storage.local`, off when not set). Each chat is an object with its own id (`crypto.randomUUID()`), so chats can run at the same time: `running` maps chat id to the turn, and host messages go to their chat, on screen or in past chats. It answers host `request` messages (`applyAndCheck` and `openUrl` one at a time, `inspect`, `runJs` through the background). `openUrl` opens a tab (or loads the chat's tab), waits for the load, and returns the same context as a sent message.
- `extension/markdown.js`: renders Claude's replies in the chat as Markdown (re-rendered on each streamed delta). It escapes all text first, so its output has only the tags it makes; links must be http(s) or mailto. Tests in `tests/markdown.test.mjs`.
- `extension/background.js`: registers features with `chrome.userScripts` (one feature at a time, so a bad one does not stop the others), keeps a copy in `chrome.storage.local` so features work without the panel, and collects logs from features (`onUserScriptMessage`) in `chrome.storage.session`. `runJs` runs the host's `run_js` script with `chrome.userScripts.execute` in the tab's top frame (USER_SCRIPT world, so the page's CSP does not block it).
- `extension/toolkit.js`: `IGA` helpers, injected before each feature in the USER_SCRIPT world. `IGA.style` keeps feature styles last in `<head>`. `IGA.feature` gives each feature `log/warn/error/waitFor/onElement/onUrlChange/download` and reports errors.
- `host/host.mjs`: native messaging host. Chrome starts it when the panel connects and stops it when the panel closes. Runs one Agent SDK `query()` per message with `cwd` = project root, `settingSources: []`, tools Read/Glob/Grep/Write/Edit plus an in-process MCP server `browser` (`apply_and_check`, `inspect_page`, `run_js`, `open_url`) and, only when the chat message has `devtools: true`, the stdio MCP server `chrome-devtools` (`chrome-devtools-mcp --autoConnect`, set up in `host/lib/claude.mjs`) with `host/devtools.md` added to the prompt (when off, a short note tells Claude to point the user to the setting). It attaches to the user's Chrome at its first tool call, and Chrome asks the user to allow each new connection (so once per turn that uses it). `open_url` makes the opened tab the turn's tab and replaces the turn's snapshot. Chats run at the same time, one turn per chat (`turns`: chat id -> turn). Each turn has its own `browser` server (bound to its tab), its own snapshot folder `context/<chatId>/`, and the set of files it wrote; another chat may not write those files until the turn ends. `features/` is its own git repo, not part of the app's repo (`ensureRepo` runs `git init` there when it is missing); all git commands run in it. After each turn it commits `features/` (`chat: ...`): only the turn's own files while other chats still run, all of `features/` when it is the last. Git commands run one at a time (`inOrder`). Undo reverts the newest chat commit (`undo: <sha> ...`). A delete from the panel is also a `chat: delete <name>` commit, so undo brings the feature back. Undo and delete are refused while any chat runs.
- `host/lib/features.mjs`: parses feature headers (`@name`, `@match`, `@exclude`, `@run-at`) and builds the code strings that the extension registers. JS is wrapped in `IGA.feature(id, async (IGA) => { ... })` and syntax-checked with `vm.Script`.
- `host/lib/runjs.mjs`: `run_js`. `wrapCode` syntax-checks the code (the body of an async function) and wraps it so the page returns `{ json }` or `{ error }`; `formatResult` cuts the JSON at 20,000 characters.
- `host/lib/permissions.mjs`: the chat's tool policy (read the project, write only `features/*.js|css`, not a file that another running chat writes; `chrome-devtools` tools may use file paths only in `context/`) and `checkUrl` (`open_url` opens only full http(s) URLs).
- `host/instructions.md`: the system prompt append for the chat's Claude (feature format, scope rules, dark mode guidance, workflow). Change this to change how the chat behaves. `host/devtools.md`: the extra part for the `chrome-devtools` tools, added only when the setting is on.

## Protocol (panel <-> host, JSON over native messaging)

Panel to host: `hello`, `chat { chatId, text, sessionId, context, devtools }`, `stop { chatId }`, `undo`, `delete { id }`, `response { requestId, result | error }`.
Host to panel: `ready { ok, detail }`, `features { features }`, `session { chatId, id }`, `text { chatId, text }`, `tool { chatId, label }`, `error { chatId?, message, resetSession? }`, `done { chatId, sessionId, changed, features, reload, stopped }`, `undone { what, features }`, `deleted { id, name, features }`, `request { requestId, action, args }`. An `error` without `chatId` is not about one chat.

## Rules

- No build step. Plain JS (ES modules in the host), no bundler, no TypeScript.
- Host stdout is the message channel. Never write to it except through `send()`; `console.*` goes to `logs/host.log`.
- One message from the host to Chrome can be 1 MB at most.
- After a change in `extension/`, reload the extension in `chrome://extensions` and reopen the panel. After a change in `host/`, close and reopen the panel (Chrome starts a new host).
- If `extension/manifest.json` `key` changes, the extension ID changes: run `npm run install-host` again.

## Test

- `npm test`: unit tests for framing, feature parsing, permissions, `run_js` wrapping, git commits and undo.
- Debug the host with `logs/host.log`. Debug the panel with right-click > Inspect in the side panel; the background from `chrome://extensions` (service worker link).
