// Native messaging host. Chrome starts it when the side panel connects, and stops it when the
// panel closes. It runs Claude Code turns in this project folder and talks to the panel over stdio.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, watch } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { findClaude, loginStatus, runTurn } from './lib/claude.mjs'
import { buildPrompt, formatLogs, saveContext } from './lib/context.mjs'
import { loadFeatures } from './lib/features.mjs'
import { createDecoder, encode } from './lib/framing.mjs'
import { commitFeatures, deleteFiles, ensureRepo, undoLast } from './lib/git.mjs'
import { checkUrl, decideTool, WRITE_TOOLS } from './lib/permissions.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const FEATURES = join(ROOT, 'features')
const CONTEXT = join(ROOT, 'context')
const LOG_FILE = join(ROOT, 'logs', 'host.log')
const INSTRUCTIONS = readFileSync(join(HERE, 'instructions.md'), 'utf8')
// The Chrome DevTools tools are a setting in the panel, off by default.
const DEVTOOLS_ON = `${INSTRUCTIONS}\n${readFileSync(join(HERE, 'devtools.md'), 'utf8')}`
const DEVTOOLS_OFF = `${INSTRUCTIONS}\n## Chrome DevTools\n\nThe Chrome DevTools tools are off. When a request needs them (console errors, network requests, page JS, clicks, performance), tell the user to turn on "Chrome DevTools" in the settings of the panel.\n`
const MAX_MESSAGE = 1024 * 1024 // Chrome's limit for one message from the host

mkdirSync(dirname(LOG_FILE), { recursive: true })
// Each chat has a snapshot folder in context/. No turn runs yet, so remove the old ones.
rmSync(CONTEXT, { recursive: true, force: true })

function log(...values) {
  const text = values.map((v) => (v instanceof Error ? v.stack : typeof v === 'string' ? v : JSON.stringify(v))).join(' ')
  appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`)
}
// stdout carries the messages to Chrome. Any other output there breaks the channel.
console.log = console.info = console.warn = console.debug = log

function send(message) {
  const frame = encode(message)
  if (frame.length - 4 > MAX_MESSAGE) {
    log(`Dropped a ${message.type} message of ${frame.length} bytes`)
    send({ type: 'error', message: `A "${message.type}" message is larger than Chrome's 1 MB limit.` })
    return
  }
  process.stdout.write(frame)
}

// Requests to the panel, for the browser tools. The panel answers with { type: 'response' }.
const pending = new Map()
let nextRequestId = 1
function request(action, args, timeoutMs = 45000) {
  const requestId = nextRequestId++
  send({ type: 'request', requestId, action, args })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`The extension did not answer "${action}" in time.`))
    }, timeoutMs)
    pending.set(requestId, { resolve, reject, timer })
  })
}

const claudePath = findClaude()
// Chats can work at the same time. One turn per chat: chat id -> { chatId, ctrl, tabId, dir, files }.
// `dir`: the snapshot folder (from ROOT). `files`: absolute paths that the turn wrote.
const turns = new Map()
let lastApplied = null // JSON of the features that the tab has now
let undone = [] // undos since the last message, so Claude knows why a feature is gone
let deleted = [] // features the user deleted from the panel since the last message

const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], isError })
const noTab = () => text('There is no tab to use. The user sent this message from a page that the extension cannot read.', true)

async function applyAndCheck(turn) {
  if (!turn.tabId) return noTab()
  const features = await loadFeatures(FEATURES)
  lastApplied = JSON.stringify(features)
  const result = await request('applyAndCheck', { tabId: turn.tabId, features })
  const lines = [`Reloaded the tab: ${result.url}`]
  for (const f of features) if (f.error) lines.push(`features/${f.id}: NOT LOADED. ${f.error}`)
  for (const [id, error] of Object.entries(result.registerErrors ?? {})) lines.push(`features/${id}: Chrome refused it: ${error}`)
  lines.push(result.logs.length ? `Feature logs:\n${formatLogs(result.logs)}` : 'No feature logs or errors.')
  if (result.note) lines.push(result.note)
  const content = [{ type: 'text', text: lines.join('\n') }]
  if (result.screenshot) {
    const data = result.screenshot.split(',')[1]
    await writeFile(join(ROOT, turn.dir, 'after.jpg'), Buffer.from(data, 'base64'))
    content.push({ type: 'image', data, mimeType: 'image/jpeg' })
  }
  return { content }
}

async function inspectPage(turn, { selector, limit = 10, properties }) {
  if (!turn.tabId) return noTab()
  const result = await request('inspect', { tabId: turn.tabId, selector, limit, properties })
  return text(JSON.stringify(result, null, 1))
}

/** Opens the URL, and the opened tab becomes the tab of the turn, with a new snapshot. */
async function openUrl(turn, { url, newTab = true }) {
  const context = await request('openUrl', { chatId: turn.chatId, url: checkUrl(url), tabId: newTab ? null : turn.tabId })
  turn.tabId = context.tabId
  const files = await saveContext(ROOT, turn.dir, context)
  const lines = [`Opened ${JSON.stringify(context.title)} ${context.url}. inspect_page and apply_and_check now use this tab.`]
  if (context.unavailable) lines.push(context.unavailable)
  if (files.length) lines.push('New snapshot of the tab (read the files when you need them):', ...files.map((f) => `- ${f}`))
  const content = [{ type: 'text', text: lines.join('\n') }]
  if (context.screenshot) content.push({ type: 'image', data: context.screenshot.split(',')[1], mimeType: 'image/jpeg' })
  return { content }
}

/** Tool errors go back to Claude as text, so it can react. */
const safe = (handler) => async (args) => {
  try {
    return await handler(args)
  } catch (error) {
    log(error)
    return text(error.message, true)
  }
}

/** One server per turn, so the tools act on the tab of that turn. */
const browserServer = (turn) => createSdkMcpServer({
  name: 'browser',
  version: '0.1.0',
  tools: [
    tool(
      'apply_and_check',
      "Load the files in features/ into Chrome, reload the user's tab, and return a screenshot of the visible part plus feature errors and logs. Call it after each change to check the result.",
      {},
      safe(() => applyAndCheck(turn)),
      { alwaysLoad: true }
    ),
    tool(
      'inspect_page',
      "Read elements in the user's live tab: tag, id, classes, short text, size, computed styles, and the start of the HTML. Use it to find selectors and real colors.",
      {
        selector: z.string().describe('CSS selector'),
        limit: z.number().int().min(1).max(50).optional().describe('Most elements to return. Default 10.'),
        properties: z
          .array(z.string())
          .optional()
          .describe('CSS properties to read. Default: color, background-color, background-image, border-color, fill, filter, opacity, display.')
      },
      safe((args) => inspectPage(turn, args)),
      { alwaysLoad: true }
    ),
    tool(
      'open_url',
      "Open a URL in the user's Chrome and show it to the user. Waits for the page to load, then returns a screenshot and a new snapshot of the page. After this, inspect_page and apply_and_check use the opened tab.",
      {
        url: z.string().describe('Full http or https URL, for example https://github.com/'),
        newTab: z.boolean().optional().describe('Open a new tab. Default true. Use false to load the URL in the tab of this chat.')
      },
      safe((args) => openUrl(turn, args)),
      { alwaysLoad: true }
    )
  ]
})

async function pushFeatures() {
  send({ type: 'features', features: await loadFeatures(FEATURES) })
}

// Git commands share one index, so they must not overlap.
let gitQueue = Promise.resolve()
function inOrder(fn) {
  const run = gitQueue.then(fn)
  gitQueue = run.catch(() => {})
  return run
}

/** The files that the other running chats write. */
function takenBy(turn) {
  return new Set([...turns.values()].filter((other) => other !== turn).flatMap((other) => [...other.files]))
}

async function chat({ chatId, text: userText, sessionId, context, devtools = false }) {
  // Messages about this turn carry the chat id, so the panel can show them in the right chat.
  const emit = (message) => send({ ...message, chatId })
  if (turns.has(chatId)) return emit({ type: 'error', message: 'Claude is still working on the last message in this chat.' })
  const ctrl = new AbortController()
  // The chat id names a folder, so keep only safe characters.
  const turn = { chatId, ctrl, tabId: context?.tabId ?? null, dir: `context/${String(chatId).replace(/[^\w-]/g, '_')}`, files: new Set() }
  turns.set(chatId, turn)
  let newSession = sessionId
  try {
    if (!claudePath) throw new Error('Claude Code was not found. Install it, then run "npm run install-host" again.')
    const files = await saveContext(ROOT, turn.dir, context)
    let prompt = buildPrompt(userText, context, files)
    if (undone.length) prompt = `Since the last message, the user undid these changes from the panel: ${undone.map((u) => JSON.stringify(u)).join(', ')}.\n\n${prompt}`
    undone = []
    if (deleted.length) prompt = `Since the last message, the user deleted these features from the panel: ${deleted.join(', ')}.\n\n${prompt}`
    deleted = []
    newSession = await runTurn({
      claudePath,
      root: ROOT,
      prompt,
      resume: sessionId || undefined,
      instructions: devtools ? DEVTOOLS_ON : DEVTOOLS_OFF,
      browserServer: browserServer(turn),
      devtools,
      canUseTool: async (name, input) => {
        const decision = decideTool(name, input, ROOT, takenBy(turn))
        if (decision.behavior === 'allow' && WRITE_TOOLS.has(name)) turn.files.add(resolve(ROOT, String(input.file_path)))
        return decision
      },
      signal: ctrl.signal,
      emit
    })
  } catch (error) {
    if (!ctrl.signal.aborted) {
      log(error)
      emit({ type: 'error', message: error.message, resetSession: /No conversation found/i.test(error.message) })
    }
  } finally {
    turns.delete(chatId)
  }
  // While other chats work, commit only the files of this turn. The last chat to finish commits all.
  const paths = turns.size ? [...turn.files].filter((file) => existsSync(file)).map((file) => relative(FEATURES, file)) : undefined
  let changed = []
  try {
    changed = await inOrder(() => commitFeatures(FEATURES,`chat: ${userText.replace(/\s+/g, ' ').trim().slice(0, 72)}`, paths))
  } catch (error) {
    log(error)
    emit({ type: 'error', message: `Could not save the change in git: ${error.message}` })
  }
  const features = await loadFeatures(FEATURES)
  const json = JSON.stringify(features)
  emit({ type: 'done', sessionId: newSession, changed, features, reload: json !== lastApplied, stopped: ctrl.signal.aborted })
  lastApplied = json
}

async function undo() {
  if (turns.size) return send({ type: 'error', message: 'Wait until all chats are done, then undo.' })
  const target = await inOrder(() => undoLast(FEATURES))
  if (target) undone.push(target.subject.slice(6))
  const features = await loadFeatures(FEATURES)
  lastApplied = JSON.stringify(features)
  send({ type: 'undone', what: target ? target.subject.slice(6) : null, features })
}

async function deleteFeature({ id }) {
  if (turns.size) return send({ type: 'error', message: 'Wait until all chats are done, then delete.' })
  const feature = (await loadFeatures(FEATURES)).find((f) => f.id === id)
  if (!feature) return send({ type: 'error', message: `There is no feature "${id}" to delete.` })
  const files = feature.files.map((file) => `features/${file}`)
  await inOrder(() => deleteFiles(FEATURES, feature.files, `chat: delete ${feature.name}`))
  deleted.push(`${JSON.stringify(feature.name)} (${files.join(', ')})`)
  const features = await loadFeatures(FEATURES)
  lastApplied = JSON.stringify(features)
  send({ type: 'deleted', id, name: feature.name, features })
}

async function handle(message) {
  switch (message.type) {
    case 'hello': {
      const status = claudePath ? await loginStatus(claudePath) : { ok: false, detail: 'Claude Code was not found.' }
      send({ type: 'ready', ...status })
      const features = await loadFeatures(FEATURES)
      lastApplied = JSON.stringify(features)
      return send({ type: 'features', features })
    }
    case 'chat':
      return chat(message)
    case 'stop':
      return turns.get(message.chatId)?.ctrl.abort()
    case 'undo':
      return undo()
    case 'delete':
      return deleteFeature(message)
    case 'response': {
      const entry = pending.get(message.requestId)
      if (!entry) return
      pending.delete(message.requestId)
      clearTimeout(entry.timer)
      return message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result)
    }
  }
}

// Edits from outside the chat (for example Claude Code in Terminal) reach Chrome at once.
let watcher
let watchTimer
function watchFeatures() {
  mkdirSync(FEATURES, { recursive: true })
  watcher?.close()
  watcher = watch(FEATURES, () => {
    clearTimeout(watchTimer)
    watchTimer = setTimeout(() => pushFeatures().catch(log), 300)
  })
}
watchFeatures()
inOrder(() => ensureRepo(FEATURES)).catch(log)

process.stdin.on(
  'data',
  createDecoder((message) =>
    handle(message).catch((error) => {
      log(error)
      send({ type: 'error', message: error.message })
    })
  )
)
process.stdin.on('end', () => {
  for (const turn of turns.values()) turn.ctrl.abort()
  process.exit(0)
})
log(`Host started. claude: ${claudePath ?? 'not found'}`)
