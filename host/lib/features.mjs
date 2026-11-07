import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

const ID = /^[a-z0-9][a-z0-9-]*$/
const RUN_AT = new Set(['document_start', 'document_end', 'document_idle'])
const PATTERN = /^(?:<all_urls>|(?:\*|https?|wss?|ftp|file|urn):\/\/(?:\*|(?:\*\.)?[^/*:]+(?::(?:\*|\d+))?)?\/.*)$/

/** Reads the `@key value` lines from the comment block at the top of a file. */
export function parseHeader(source) {
  const header = { match: [], exclude: [] }
  const block = source.match(/^\s*(?:\/\*[\s\S]*?\*\/|(?:[ \t]*\/\/[^\n]*\n?)+)/)
  if (!block) return header
  for (const raw of block[0].split('\n')) {
    const line = raw.replace(/^\s*(?:\/\/+|\/\*+|\*+)?/, '').replace(/\*\/\s*$/, '').trim()
    const found = line.match(/^@([\w-]+)\s+(.+)$/)
    if (!found) continue
    const [, key, value] = found
    if (key === 'match' || key === 'exclude') header[key].push(value.trim())
    else header[key] = value.trim()
  }
  return header
}

/**
 * Turns the files of one feature into what the extension registers. The code strings are
 * built here, in one place, so the syntax check sees the same code that Chrome runs.
 */
export function buildFeature(id, { js, css }) {
  const cssHead = css === undefined ? null : parseHeader(css)
  const jsHead = js === undefined ? null : parseHeader(js)
  const merged = (key) => [...new Set([...(cssHead?.[key] ?? []), ...(jsHead?.[key] ?? [])])]
  const runAt = jsHead?.['run-at'] ?? 'document_idle'
  const feature = {
    id,
    name: jsHead?.name ?? cssHead?.name ?? id,
    matches: merged('match'),
    excludes: merged('exclude'),
    files: [css !== undefined && `${id}.css`, js !== undefined && `${id}.js`].filter(Boolean),
    scripts: []
  }
  const problems = []
  if (!ID.test(id)) problems.push(`The name "${id}" must use only a-z, 0-9 and "-".`)
  if (!feature.matches.length) problems.push('Add at least one @match line.')
  for (const pattern of [...feature.matches, ...feature.excludes]) {
    if (!PATTERN.test(pattern)) problems.push(`"${pattern}" is not a valid match pattern.`)
  }
  if (!RUN_AT.has(runAt)) problems.push('@run-at must be document_start, document_end or document_idle.')
  if (css !== undefined) {
    feature.scripts.push({ key: 'css', runAt: 'document_start', code: `IGA.style(${JSON.stringify(id)}, ${JSON.stringify(css)});` })
  }
  if (js !== undefined) {
    const code = `IGA.feature(${JSON.stringify(id)}, async (IGA) => {\n${js}\n});\n//# sourceURL=features/${id}.js`
    try {
      new vm.Script(code)
    } catch (error) {
      problems.push(`Syntax error in ${id}.js: ${error.message}`)
    }
    feature.scripts.push({ key: 'js', runAt, code })
  }
  if (problems.length) feature.error = problems.join(' ')
  return feature
}

/** All features in `dir`. A feature is `<id>.css`, `<id>.js`, or both. */
export async function loadFeatures(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const groups = new Map()
  for (const name of names.sort()) {
    const found = name.match(/^([^.].*)\.(js|css)$/)
    if (!found) continue
    const [, id, kind] = found
    if (!groups.has(id)) groups.set(id, {})
    groups.get(id)[kind] = await readFile(join(dir, name), 'utf8')
  }
  return [...groups].map(([id, files]) => buildFeature(id, files))
}
