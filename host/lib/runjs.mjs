import vm from 'node:vm'

/** Most characters of a run_js result that go back to Claude. */
export const MAX_RESULT = 20000

/**
 * Builds the script for a run_js call. `code` is the body of an async function. The script
 * returns `{ json }` (the value as JSON) or `{ error }` (what the code threw in the page).
 */
export function wrapCode(code) {
  const script = `(async () => {
  try {
    const value = await (async () => {\n${code}\n})()
    return { json: JSON.stringify(value) }
  } catch (error) {
    return { error: String(error?.stack ?? error) }
  }
})()`
  // Check the script that Chrome runs, not only the code.
  try {
    new vm.Script(script)
  } catch (error) {
    throw new Error(`Syntax error in the code: ${error.message}`)
  }
  return script
}

/** The text for Claude: the JSON of the value, cut at `max` characters. */
export function formatResult({ json } = {}, max = MAX_RESULT) {
  const out = json ?? 'undefined (the code returned no value)'
  if (out.length <= max) return out
  return `${out.slice(0, max)}\n… cut at ${max} of ${out.length} characters. Return less: filter or slice in the code.`
}
