import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'

const TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit']

/** The user's own `claude`. Chrome starts the host with a short PATH, so also look in the usual install folders. */
export function findClaude(path = process.env.PATH ?? '') {
  const dirs = [...path.split(delimiter), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of dirs.filter(Boolean)) {
    try {
      accessSync(join(dir, 'claude'), constants.X_OK)
      return join(dir, 'claude')
    } catch {
      // not in this folder
    }
  }
  return null
}

/** Use the plan login of the user's own Claude Code, as in Terminal. */
export function claudeEnv(base = process.env) {
  const env = { ...base, CLAUDE_AGENT_SDK_CLIENT_APP: 'insanely-good-ai/0.1.0' }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

export function loginStatus(claudePath) {
  return new Promise((resolve) => {
    execFile(claudePath, ['auth', 'status', '--json'], { env: claudeEnv(), timeout: 15000 }, (_error, stdout) => {
      try {
        const status = JSON.parse(stdout)
        if (!status.loggedIn) resolve({ ok: false, detail: 'Claude Code is not signed in. Run "claude auth login" in Terminal.' })
        else resolve({ ok: true, detail: `Signed in${status.subscriptionType ? ` (${status.subscriptionType})` : ''}` })
      } catch {
        resolve({ ok: false, detail: 'Could not read the Claude Code sign-in status.' })
      }
    })
  })
}

export function describeTool(name, input = {}) {
  switch (name) {
    case 'Read':
      return `Reading ${basename(String(input.file_path ?? ''))}`
    case 'Write':
    case 'Edit':
      return `Writing ${basename(String(input.file_path ?? ''))}`
    case 'Glob':
      return `Listing files ${input.pattern ?? ''}`
    case 'Grep':
      return `Searching for "${input.pattern ?? ''}"`
    case 'mcp__browser__apply_and_check':
      return 'Reloading the page to check the result'
    case 'mcp__browser__inspect_page':
      return `Inspecting ${input.selector ?? 'the page'}`
    case 'mcp__browser__open_url':
      return `Opening ${input.url ?? 'a page'}`
    default:
      return name
  }
}

/** Runs one turn. Returns the session id to resume next time. */
export async function runTurn({ claudePath, root, prompt, resume, instructions, browserServer, canUseTool, signal, emit }) {
  const abortController = new AbortController()
  signal.addEventListener('abort', () => abortController.abort(), { once: true })
  let sessionId = resume
  const run = query({
    prompt,
    options: {
      cwd: root,
      pathToClaudeCodeExecutable: claudePath,
      env: claudeEnv(),
      // Isolation: none of the user's ~/.claude settings, CLAUDE.md, skills, plugins or MCP servers.
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { browser: browserServer },
      settings: { autoMemoryEnabled: false },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions },
      tools: TOOLS,
      permissionMode: 'default',
      canUseTool,
      includePartialMessages: true,
      resume,
      abortController
    }
  })
  for await (const message of run) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id
      emit({ type: 'session', id: sessionId })
    } else if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
      const event = message.event
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') emit({ type: 'text', text: event.delta.text })
    } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') emit({ type: 'tool', label: describeTool(block.name, block.input) })
      }
    } else if (message.type === 'result') {
      sessionId = message.session_id
      if (message.subtype !== 'success') throw new Error(message.errors?.join('\n') || message.subtype)
      if (message.is_error) throw new Error(message.result)
    }
  }
  return sessionId
}
