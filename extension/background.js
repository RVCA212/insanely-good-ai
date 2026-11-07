// Registers the features as user scripts, and keeps their logs.
// Features come from the host through the panel. A copy stays in storage, so they work without the panel.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

const MAX_LOGS = 300
const logsReady = chrome.storage.session.get('logs').then((result) => result.logs ?? [])

/** False until the user turns on "Allow User Scripts" for this extension. */
function userScriptsOn() {
  try {
    chrome.userScripts.getScripts()
    return true
  } catch {
    return false
  }
}

async function register() {
  if (!userScriptsOn()) return { errors: {}, userScripts: false }
  const { features = [], disabled = [] } = await chrome.storage.local.get(['features', 'disabled'])
  await chrome.userScripts.configureWorld({ messaging: true })
  await chrome.userScripts.unregister()
  const errors = {}
  // One feature at a time: a bad match pattern must not stop the others.
  for (const feature of features) {
    if (feature.error || disabled.includes(feature.id)) continue
    try {
      await chrome.userScripts.register(
        feature.scripts.map((script) => ({
          id: `${feature.id}:${script.key}`,
          matches: feature.matches,
          excludeMatches: feature.excludes,
          runAt: script.runAt,
          world: 'USER_SCRIPT',
          js: [{ file: 'toolkit.js' }, { code: script.code }]
        }))
      )
    } catch (error) {
      errors[feature.id] = error.message
    }
  }
  return { errors, userScripts: true }
}

// Registrations must not overlap, or the ids clash.
let queue = Promise.resolve()
function registerAll() {
  const run = queue.then(register)
  queue = run.catch(() => {})
  return run
}

chrome.runtime.onInstalled.addListener(() => registerAll())
chrome.runtime.onStartup.addListener(() => registerAll())

const handlers = {
  status: async () => ({ userScripts: userScriptsOn() }),
  register: () => registerAll(),
  setFeatures: async ({ features }) => {
    await chrome.storage.local.set({ features })
    return registerAll()
  },
  setDisabled: async ({ disabled }) => {
    await chrome.storage.local.set({ disabled })
    return registerAll()
  },
  logs: async ({ tabId }) => (await logsReady).filter((entry) => entry.tabId === tabId),
  clearLogs: async ({ tabId }) => {
    const logs = await logsReady
    for (let i = logs.length - 1; i >= 0; i--) if (logs[i].tabId === tabId) logs.splice(i, 1)
    await chrome.storage.session.set({ logs })
    return {}
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type]
  if (!handler) return false
  handler(message).then(sendResponse, (error) => sendResponse({ error: error.message }))
  return true
})

chrome.runtime.onUserScriptMessage.addListener((message, sender) => {
  if (message?.type !== 'log') return
  logsReady.then((logs) => {
    logs.push({
      tabId: sender.tab?.id ?? null,
      url: sender.url ?? '',
      featureId: String(message.featureId),
      level: String(message.level),
      text: String(message.text).slice(0, 2000),
      time: Date.now()
    })
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
    chrome.storage.session.set({ logs })
  })
})
