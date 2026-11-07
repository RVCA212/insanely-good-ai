// The chat. It holds the connection to the native host, sends a snapshot of the tab with each
// message, and does the host's browser requests (load features, reload, screenshot, inspect).

import { markdown } from './markdown.js'

const HOST = 'com.insanely_good_ai.host'
const $ = (id) => document.getElementById(id)
const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const canChange = (url) => /^(https?|file):/.test(url ?? '')

async function bg(message) {
  const response = await chrome.runtime.sendMessage(message)
  if (response?.error) throw new Error(response.error)
  return response
}

let port = null
// A chat: { id, sessionId, updatedAt, transcript, title }. A transcript entry: { role: 'user' | 'assistant' | 'tool' | 'note' | 'error', text }.
// updatedAt: the time of the last entry. title: set when the chat goes to the past chats.
// The id is the panel's own, because a new chat gets its session id only when Claude starts.
const newChat = () => ({ id: crypto.randomUUID(), sessionId: null, updatedAt: Date.now(), transcript: [] })
let current = newChat() // the chat on screen
let pastChats = [] // newest first
const PAST_CHATS_LIMIT = 30
// The chats that Claude works on now, on screen or not: chat id -> { chat, bubble, tabId }.
// bubble: the assistant entry that gets the streamed text. tabId: the tab of the turn.
const running = new Map()
const elements = new WeakMap()
let features = []
let disabled = []
let registerErrors = {}
const issues = {}

// ---------- Transcript ----------

let saveTimer
let pastChanged = false
/** Saves the chat on screen. `past`: also save the past chats, because one of them or the list changed. */
function save(past = false) {
  pastChanged ||= past
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const data = { chatId: current.id, transcript: current.transcript.slice(-200), sessionId: current.sessionId, updatedAt: current.updatedAt }
    if (pastChanged) data.pastChats = pastChats.map((chat) => ({ ...chat, transcript: chat.transcript.slice(-200) }))
    pastChanged = false
    chrome.storage.local.set(data)
  }, 200)
}

function scrollDown(force) {
  const log = $('log')
  if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight
}

function render(entry) {
  $('log').querySelector('.empty')?.remove()
  const node = el('div', `msg ${entry.role}`, entry.text)
  if (entry.role === 'assistant') node.innerHTML = markdown(entry.text)
  elements.set(entry, node)
  $('log').append(node)
  scrollDown(entry.role === 'user')
}

function add(role, text, chat = current) {
  const entry = { role, text }
  chat.transcript.push(entry)
  chat.updatedAt = Date.now()
  if (chat === current) render(entry)
  save(chat !== current)
  return entry
}

function stream(run, text) {
  if (!run.bubble) run.bubble = add('assistant', '', run.chat)
  run.bubble.text += text
  if (run.chat === current) {
    elements.get(run.bubble).innerHTML = markdown(run.bubble.text)
    scrollDown()
  }
  save(run.chat !== current)
}

function showEmpty() {
  if (!current.transcript.length) $('log').replaceChildren(el('div', 'empty', 'Open a page and ask for a change. For example: "make this page dark mode".'))
}

// ---------- Past chats ----------

/**
 * Puts the current chat in the past chats, so the user can open it again. The caller saves.
 * The same object goes there, so a chat that Claude still works on keeps getting its messages.
 */
function archiveCurrent() {
  // A chat without a session id cannot resume, unless Claude works on it now and the id is still to come.
  if (!current.transcript.length || !(current.sessionId || running.has(current.id))) return
  const first = current.transcript.find((entry) => entry.role === 'user')
  current.title = first?.text.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Untitled chat'
  pastChats = [current, ...pastChats.filter((c) => c.id !== current.id)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, PAST_CHATS_LIMIT)
}

/** Shows a past chat. The next message resumes its Claude Code session. */
function openChat(chat) {
  showPastChats(false)
  showView('chat')
  archiveCurrent()
  pastChats = pastChats.filter((c) => c.id !== chat.id)
  current = chat
  $('log').replaceChildren()
  for (const entry of current.transcript) render(entry)
  showEmpty()
  scrollDown(true)
  updateButtons()
  save(true)
}

function renderPastChats() {
  if (!pastChats.length) {
    $('history').replaceChildren(el('div', 'history-empty', 'No past chats yet. When you start a new chat, the old chat goes here.'))
    return
  }
  $('history').replaceChildren(
    ...pastChats.map((chat) => {
      const item = el('button', 'history-item', '')
      item.type = 'button'
      const when = new Date(chat.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      const count = chat.transcript.filter((entry) => entry.role === 'user').length
      const title = el('div', 'history-title', chat.title)
      if (running.has(chat.id)) {
        const dot = el('span', 'history-running', '')
        dot.title = 'Claude is working'
        dot.setAttribute('role', 'img')
        dot.setAttribute('aria-label', 'Claude is working')
        title.prepend(dot)
      }
      item.append(title, el('div', 'history-meta', `${when} · ${count} ${count === 1 ? 'message' : 'messages'}`))
      item.title = chat.title
      item.addEventListener('click', () => openChat(chat))
      return item
    })
  )
}

function showPastChats(open) {
  if (open) renderPastChats()
  $('history').hidden = !open
  $('history-button').setAttribute('aria-expanded', String(open))
}

// ---------- Status ----------

function setIssue(key, issue) {
  if (issue) issues[key] = issue
  else delete issues[key]
  $('banners').replaceChildren(
    ...Object.values(issues).map((item) => {
      const banner = el('div', 'banner', '')
      banner.append(el('span', '', item.text))
      if (item.action) {
        const button = el('button', '', item.action.label)
        button.type = 'button'
        button.addEventListener('click', item.action.run)
        banner.append(button)
      }
      return banner
    })
  )
}

function setDot(state, title) {
  $('dot').className = `dot ${state}`
  $('dot').title = title
}

/** Send is Stop while Claude works on the chat on screen. Undo and delete wait until all chats are done. */
function updateButtons() {
  $('send').textContent = running.has(current.id) ? 'Stop' : 'Send'
  $('undo').disabled = running.size > 0
  for (const button of $('feature-list').querySelectorAll('button')) button.disabled = running.size > 0
  if (!$('history').hidden) renderPastChats()
}

async function checkUserScripts() {
  const { userScripts } = await bg({ type: 'status' })
  if (userScripts) {
    if (issues.userScripts) {
      setIssue('userScripts', null)
      await bg({ type: 'register' })
    }
    return
  }
  setIssue('userScripts', {
    text: 'Features cannot run yet. Open the extension details and turn on "Allow User Scripts".',
    action: { label: 'Open', run: () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }) }
  })
}

async function showTarget() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) return
  let text = 'Chrome does not let extensions change this page.'
  if (canChange(tab.url)) {
    const url = new URL(tab.url)
    text = `Page: ${url.host || url.pathname}`
  }
  $('target').textContent = text
}

// ---------- Features ----------

const TRASH_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>'

/** Each word in the search must be in the feature's name, id, files or match patterns. */
function matchesSearch(feature, terms) {
  const text = [feature.name, feature.id, ...feature.files, ...feature.matches].join(' ').toLowerCase()
  return terms.every((term) => text.includes(term))
}

function renderFeatures() {
  $('feature-count').textContent = features.length ? `(${features.length})` : ''
  const query = $('feature-search').value.trim()
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = features.filter((feature) => matchesSearch(feature, terms))
  if (!shown.length) {
    const text = features.length ? `No features match "${query}".` : 'No features yet. Ask in the chat for a change to a page.'
    $('feature-list').replaceChildren(el('li', 'feature-empty', text))
    return
  }
  $('feature-list').replaceChildren(
    ...shown.map((feature) => {
      const item = document.createElement('li')
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !disabled.includes(feature.id) })
      box.addEventListener('change', () => toggleFeature(feature.id, box.checked))
      const info = el('div', 'feature-info', '')
      info.append(el('div', 'feature-name', feature.name), el('div', 'feature-meta', `${feature.files.join(' + ')} · ${feature.matches.join(', ')}`))
      const error = feature.error ?? registerErrors[feature.id]
      if (error) info.append(el('div', 'feature-error', error))
      const remove = el('button', 'icon feature-delete', '')
      Object.assign(remove, { type: 'button', title: `Delete "${feature.name}"`, disabled: running.size > 0, innerHTML: TRASH_ICON })
      remove.setAttribute('aria-label', `Delete "${feature.name}"`)
      remove.addEventListener('click', () => deleteFeature(feature.id))
      item.append(box, info, remove)
      return item
    })
  )
}

function showView(name) {
  const open = name === 'features'
  $('chat-view').hidden = open
  $('features-view').hidden = !open
  $('features-button').setAttribute('aria-pressed', String(open))
  if (open) $('feature-search').focus()
}

async function applyFeatures(list) {
  features = list
  const result = await bg({ type: 'setFeatures', features: list })
  registerErrors = result.errors
  renderFeatures()
  return result
}

async function toggleFeature(id, on) {
  disabled = on ? disabled.filter((d) => d !== id) : [...disabled, id]
  const result = await bg({ type: 'setDisabled', disabled })
  registerErrors = result.errors
  renderFeatures()
  await reloadActiveTab()
}

/** No confirm step: the delete is a git commit, so Undo brings the feature back. */
function deleteFeature(id) {
  if (running.size) return
  if (!port) connect()
  port?.postMessage({ type: 'delete', id })
}

async function reloadActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab && canChange(tab.url)) await chrome.tabs.reload(tab.id)
}

// ---------- Browser requests from the host ----------

function reloadAndWait(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const finish = () => {
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve()
    }
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish()
    }
    const timer = setTimeout(finish, timeoutMs)
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.reload(tabId).catch(finish)
  })
}

async function screenshot(tab) {
  if (!tab.active) return { note: 'The tab is not in front, so there is no screenshot.' }
  try {
    return { data: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 }) }
  } catch (error) {
    return { note: `No screenshot: ${error.message}` }
  }
}

async function applyAndCheck({ tabId, features: list }) {
  const applied = await applyFeatures(list)
  await bg({ type: 'clearLogs', tabId })
  await reloadAndWait(tabId)
  await sleep(1500) // time for document_idle features and waitFor
  const tab = await chrome.tabs.get(tabId)
  const shot = await screenshot(tab)
  const logs = await bg({ type: 'logs', tabId })
  const notes = [shot.note]
  if (!applied.userScripts) notes.push('No features are loaded: the user must turn on "Allow User Scripts" for the extension.')
  return { url: tab.url, registerErrors: applied.errors, logs, screenshot: shot.data, note: notes.filter(Boolean).join(' ') }
}

// Checks and opens run one at a time: each one loads a tab and takes a screenshot, and two chats can act at once.
let checks = Promise.resolve()
function oneAtATime(fn) {
  const run = checks.then(fn)
  checks = run.catch(() => {})
  return run
}

/** Opens `url` in a new tab, or in tab `tabId`, and waits until it loads (at most 15 s). Returns the tab id. */
async function openAndWait(url, tabId, timeoutMs = 15000) {
  const loaded = new Set() // a new tab can load before its id is known
  const listener = (id, info) => info.status === 'complete' && loaded.add(id)
  chrome.tabs.onUpdated.addListener(listener)
  try {
    const tab = tabId === null ? await chrome.tabs.create({ url }) : await chrome.tabs.update(tabId, { url, active: true })
    for (let waited = 0; !loaded.has(tab.id) && waited < timeoutMs; waited += 100) await sleep(100)
    return tab.id
  } finally {
    chrome.tabs.onUpdated.removeListener(listener)
  }
}

async function openUrl({ chatId, url, tabId }) {
  const id = await openAndWait(url, tabId)
  const run = running.get(chatId)
  if (run) run.tabId = id // the tab to reload when the turn ends
  await sleep(1500) // time for the page and its features to render
  return tabContext(await chrome.tabs.get(id))
}

async function inspect({ tabId, selector, limit, properties }) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: inspectElements, args: [selector, limit, properties ?? null] })
  if (result?.error) throw new Error(result.error)
  return result
}

async function answer({ requestId, action, args }) {
  try {
    let result
    if (action === 'applyAndCheck') result = await oneAtATime(() => applyAndCheck(args))
    else if (action === 'openUrl') result = await oneAtATime(() => openUrl(args))
    else if (action === 'inspect') result = await inspect(args)
    else throw new Error(`Unknown request: ${action}`)
    port?.postMessage({ type: 'response', requestId, result })
  } catch (error) {
    port?.postMessage({ type: 'response', requestId, error: error.message })
  }
}

// ---------- Host connection ----------

async function onHostMessage(message) {
  // Messages about a turn carry its chat id. That chat can be on screen or in the past chats.
  const run = running.get(message.chatId)
  const chat = run?.chat ?? current
  switch (message.type) {
    case 'ready':
      setDot(message.ok ? 'on' : 'warn', message.detail)
      setIssue('claude', message.ok ? null : { text: message.detail })
      break
    case 'features':
      await applyFeatures(message.features)
      break
    case 'session':
      chat.sessionId = message.id
      save(chat !== current)
      break
    case 'text':
      stream(run, message.text)
      break
    case 'tool':
      run.bubble = null
      add('tool', message.label, chat)
      break
    case 'request':
      answer(message)
      break
    case 'error':
      if (run) run.bubble = null
      if (message.resetSession) chat.sessionId = null
      add('error', message.message, chat)
      break
    case 'done':
      running.delete(message.chatId)
      if (message.sessionId) chat.sessionId = message.sessionId
      if (message.stopped) add('note', 'Stopped.', chat)
      if (message.changed.length) add('note', `Changed: ${message.changed.map((f) => f.replace(/^features\//, '')).join(', ')}`, chat)
      await applyFeatures(message.features)
      if (message.reload && run.tabId !== null) chrome.tabs.reload(run.tabId).catch(() => {})
      updateButtons()
      save(chat !== current)
      break
    case 'undone':
      add('note', message.what ? `Undid: ${message.what}` : 'Nothing to undo.')
      await applyFeatures(message.features)
      if (message.what) await reloadActiveTab()
      break
    case 'deleted':
      add('note', `Deleted: ${message.name}. Undo brings it back.`)
      // A new feature with the same id must not start turned off.
      disabled = disabled.filter((d) => d !== message.id)
      await chrome.storage.local.set({ disabled })
      await applyFeatures(message.features)
      await reloadActiveTab()
      break
  }
}

function connect() {
  port = chrome.runtime.connectNative(HOST)
  port.onMessage.addListener((message) => onHostMessage(message).catch((error) => add('error', error.message)))
  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message ?? 'The host stopped.'
    port = null
    setDot('off', reason)
    const notInstalled = /not found|forbidden/i.test(reason)
    setIssue('host', {
      text: notInstalled
        ? `${reason} In Terminal, run: cd ~/insanely-good-ai && npm run install-host`
        : `Lost the connection to Claude Code: ${reason}`,
      action: { label: 'Reconnect', run: connect }
    })
    if (running.size) {
      for (const run of running.values()) add('error', 'The connection closed, so the answer stopped.', run.chat)
      running.clear()
      updateButtons()
    }
  })
  setIssue('host', null)
  setDot('', 'Connecting')
  port.postMessage({ type: 'hello' })
}

async function captureContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab ? tabContext(tab) : null
}

/** What Claude gets about a tab: URL, title, DOM outline, page info, screenshot, feature logs. */
async function tabContext(tab) {
  const context = { tabId: tab.id, url: tab.url ?? '(a Chrome page)', title: tab.title ?? '' }
  if (!canChange(tab.url)) {
    context.unavailable = 'Chrome does not let extensions read or change this page.'
    return context
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: snapshotPage })
    context.outline = result.outline
    context.info = result.info
  } catch (error) {
    context.unavailable = `The extension could not read this page: ${error.message}`
  }
  context.screenshot = (await screenshot(tab)).data
  context.logs = await bg({ type: 'logs', tabId: tab.id })
  return context
}

async function send() {
  const text = $('input').value.trim()
  const chat = current // the user can open another chat while the context loads
  if (!text || running.has(chat.id)) return
  if (!port) connect()
  $('input').value = ''
  const run = { chat, bubble: null, tabId: null }
  running.set(chat.id, run)
  add('user', text)
  updateButtons()
  const context = await captureContext()
  run.tabId = context?.tabId ?? null
  if (!port) {
    add('error', 'Not connected to Claude Code.', chat)
    running.delete(chat.id)
    updateButtons()
    return
  }
  port.postMessage({ type: 'chat', chatId: chat.id, text, sessionId: chat.sessionId, context })
}

// ---------- Page functions (Chrome runs these inside the tab, so they use no outside names) ----------

function snapshotPage() {
  const MAX_LINES = 3000
  const cut = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text)
  const attrs = (node) =>
    [...node.attributes].map((a) => ` ${a.name}="${cut(a.value.startsWith('data:') ? 'data:…' : a.value, 120)}"`).join('')
  const lines = []
  const walk = (parent, depth) => {
    for (const node of parent.childNodes) {
      if (lines.length >= MAX_LINES) return
      const pad = '  '.repeat(Math.min(depth, 30))
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.replace(/\s+/g, ' ').trim()
        if (text) lines.push(pad + cut(text, 200))
        continue
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue
      const tag = node.localName
      if (tag === 'script' || tag === 'noscript' || tag === 'template') continue
      if (tag === 'style') {
        lines.push(`${pad}<style> (${node.textContent.length} chars)`)
        continue
      }
      lines.push(`${pad}<${tag}${attrs(node)}>`)
      if (tag === 'svg' || tag === 'iframe') continue
      if (node.shadowRoot) {
        lines.push(`${pad}  #shadow-root`)
        walk(node.shadowRoot, depth + 2)
      }
      walk(node, depth + 1)
    }
  }
  const root = document.documentElement
  lines.push(`<${root.localName}${attrs(root)}>`)
  walk(root, 1)
  if (lines.length >= MAX_LINES) lines.push(`… cut at ${MAX_LINES} lines. Use inspect_page for more.`)

  // CSS rules that set theme variables: the fastest way to restyle a site.
  const THEME = /:root|^html|^body|theme|dark|light|color-mode|scheme/i
  const themeRules = []
  let varCount = 0
  let unreadableStylesheets = 0
  const collect = (rules, media) => {
    for (const rule of rules) {
      if (varCount >= 500) return
      if (rule.style && THEME.test(rule.selectorText ?? '')) {
        const vars = {}
        for (const name of Array.from(rule.style)) {
          if (!name.startsWith('--')) continue
          vars[name] = cut(rule.style.getPropertyValue(name).trim(), 100)
          varCount++
        }
        if (Object.keys(vars).length) themeRules.push({ selector: rule.selectorText, ...(media && { media }), vars })
      }
      if (rule.cssRules) collect(rule.cssRules, rule.conditionText ?? media)
    }
  }
  for (const sheet of document.styleSheets) {
    try {
      collect(sheet.cssRules, null)
    } catch {
      unreadableStylesheets++ // cross-origin
    }
  }

  const htmlStyle = getComputedStyle(root)
  const bodyStyle = document.body ? getComputedStyle(document.body) : null
  return {
    outline: lines.join('\n'),
    info: {
      url: location.href,
      title: document.title,
      selection: cut(String(getSelection() ?? ''), 2000),
      viewport: { width: innerWidth, height: innerHeight },
      colorScheme: htmlStyle.colorScheme,
      systemDarkMode: matchMedia('(prefers-color-scheme: dark)').matches,
      htmlBackground: htmlStyle.backgroundColor,
      bodyBackground: bodyStyle?.backgroundColor,
      bodyColor: bodyStyle?.color,
      themeRules,
      unreadableStylesheets
    }
  }
}

function inspectElements(selector, limit, properties) {
  const props = properties ?? ['color', 'background-color', 'background-image', 'border-color', 'fill', 'filter', 'opacity', 'display']
  let all
  try {
    all = document.querySelectorAll(selector)
  } catch (error) {
    return { error: `Bad selector: ${error.message}` }
  }
  return {
    count: all.length,
    elements: [...all].slice(0, limit).map((node) => {
      const style = getComputedStyle(node)
      const box = node.getBoundingClientRect()
      return {
        tag: node.localName,
        id: node.id || undefined,
        class: (node.getAttribute('class') ?? '').slice(0, 200) || undefined,
        text: (node.innerText ?? node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || undefined,
        box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
        styles: Object.fromEntries(props.map((p) => [p, style.getPropertyValue(p)])),
        html: node.outerHTML.slice(0, 400)
      }
    })
  }
}

// ---------- Start ----------

$('form').addEventListener('submit', (event) => {
  event.preventDefault()
  if (running.has(current.id)) port?.postMessage({ type: 'stop', chatId: current.id })
  else send()
})
$('input').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  send()
})
$('undo').addEventListener('click', () => {
  if (!port) connect()
  port?.postMessage({ type: 'undo' })
})
$('new').addEventListener('click', () => {
  showView('chat')
  archiveCurrent()
  current = newChat()
  showEmpty()
  updateButtons()
  save(true)
})
$('history-button').addEventListener('click', () => showPastChats($('history').hidden))
$('features-button').addEventListener('click', () => showView($('features-view').hidden ? 'features' : 'chat'))
$('feature-search').addEventListener('input', () => renderFeatures())
document.addEventListener('click', (event) => {
  if (!$('history').hidden && !event.target.closest('#history, #history-button')) showPastChats(false)
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || $('history').hidden) return
  showPastChats(false)
  $('history-button').focus()
})
window.addEventListener('focus', () => checkUserScripts())
chrome.tabs.onActivated.addListener(() => showTarget())
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') showTarget()
})

const stored = await chrome.storage.local.get(['chatId', 'transcript', 'sessionId', 'updatedAt', 'pastChats', 'disabled', 'features'])
current = {
  id: stored.chatId ?? crypto.randomUUID(),
  sessionId: stored.sessionId ?? null,
  updatedAt: stored.updatedAt ?? Date.now(),
  transcript: stored.transcript ?? []
}
// Past chats saved before chats had ids: the session id is the id.
pastChats = (stored.pastChats ?? []).map((chat) => ({ id: chat.sessionId, ...chat }))
disabled = stored.disabled ?? []
features = stored.features ?? []
for (const entry of current.transcript) render(entry)
showEmpty()
renderFeatures()
showTarget()
checkUserScripts()
connect()
