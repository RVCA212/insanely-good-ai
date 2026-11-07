import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
export const WRITE_TOOLS = new Set(['Write', 'Edit'])

export function isInside(dir, target) {
  const rel = relative(dir, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * The chat's tool policy. Page text can carry prompt injection, and features run on
 * all of the user's sites, so Claude reads only this project and writes only
 * .js and .css files in features/. No shell, no web.
 * The chrome-devtools tools act on all of the user's tabs. They can save to and upload
 * local files, so their file paths (any `...Path` or `...Paths` input) must be in context/.
 * `taken`: absolute paths that other chats are writing now. Two chats must not write one file.
 */
export function decideTool(name, input, root, taken = new Set()) {
  const allow = { behavior: 'allow', updatedInput: input }
  if (name.startsWith('mcp__browser__')) return allow
  if (name.startsWith('mcp__chrome-devtools__')) {
    const context = join(root, 'context')
    const paths = Object.entries(input).filter(([key]) => /Paths?$/.test(key)).flatMap(([, value]) => value)
    if (paths.every((path) => isInside(context, resolve(root, String(path))))) return allow
    return { behavior: 'deny', message: `${name} can only use files in ${context}.` }
  }
  const target = input.file_path ?? input.path
  if (READ_TOOLS.has(name)) {
    if (target === undefined || isInside(root, resolve(root, String(target)))) return allow
    return { behavior: 'deny', message: `${name} is limited to the project folder (${root}).` }
  }
  if (WRITE_TOOLS.has(name)) {
    const file = resolve(root, String(target ?? ''))
    const features = join(root, 'features')
    if (!isInside(features, file) || file === features || !['.js', '.css'].includes(extname(file))) {
      return { behavior: 'deny', message: `${name} can only write .js and .css files in ${features}.` }
    }
    if (taken.has(file)) {
      return { behavior: 'deny', message: `Another chat is changing ${relative(root, file)} now. Do not change it here. Tell the user to wait until the other chat is done.` }
    }
    return allow
  }
  return { behavior: 'deny', message: `${name} is not available in this chat.` }
}

/** The URL that open_url opens: a full http or https URL, so no javascript:, file: or chrome: pages. */
export function checkUrl(url) {
  const parsed = URL.canParse(url) ? new URL(url) : null
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`open_url needs a full http or https URL, such as https://example.com/. Got: ${url}`)
  }
  return parsed.href
}
