# Insanely Good AI

A Chrome extension with a Claude Code chat in the side panel. Ask for a change to the page you are on ("make this page dark mode"), and Claude Code writes a small feature into this project. The extension loads it and reloads the tab.

## Setup (one time)

1. `npm install`.
2. `npm run install-host`. This registers the native host with Chrome. Run it again if `node` or `claude` moves.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `extension/` folder.
4. On the extension's **Details** page, turn on **Allow User Scripts**. (The panel shows a button for this when it is off.)
5. Pin the extension. Click its icon to open the chat.

Claude Code must be installed and signed in (`claude auth status`). The chat uses your own login and plan.

It runs on macOS (`install.sh` registers the host for Chrome on macOS). It needs Chrome 138 or later and Node.js.

## Use

- Open a page, click the icon, and type a request. Say "this page", "this site" or "all websites" to set the scope.
- Claude sees the page (outline, screenshot, theme colors, feature errors). It writes `features/<id>.css` or `.js`, reloads the tab, and checks a new screenshot.
- The **Features** tab lists all features, with a search box at the top. Use the check boxes to turn one off. Use the trash button to delete one.
- **Undo** reverts the last change from the chat or the last delete (each message and each delete is one git commit of `features/`).
- **New chat** starts a new Claude Code session. It works while Claude is still busy: the old chat continues in the background, in **Past chats**. Two chats cannot write the same feature file at the same time. Undo and delete wait until all chats are done.

## How it works

```
Side panel (chat)  ── native messaging ──>  host/host.mjs  ── Agent SDK ──>  claude (your login)
      │                                          │
      │ registers features (chrome.userScripts)  │ reads/writes features/, context/, git
      ▼                                          ▼
background.js ──> pages                     Claude edits features/ only
```

- Features live outside the extension package. The host reads them and sends them to the extension, which registers them as user scripts. So a new feature needs only a tab reload, and the chat stays open.
- Claude in the chat can read this project, and it can write only `.js` and `.css` files in `features/`. It has no shell and no web access, because page text can contain prompt injection.
- To change the chat itself, the host, or the tools, use Claude Code in Terminal in this folder. See `CLAUDE.md`.

## Files

- `extension/`: what Chrome loads (manifest, background, side panel, feature toolkit).
- `host/`: the native messaging host, its rules for Claude (`instructions.md`) and `install.sh`.
- `features/`: the features that the chat writes. It is its own git repo (the host makes it), so your features and their history are not part of this repo.
- `context/<chat>/`: the snapshot of the tab for each chat (not in git). The host removes them when it starts.
- `logs/host.log`: the host log (not in git).
