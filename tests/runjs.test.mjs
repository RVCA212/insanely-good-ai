import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { formatResult, wrapCode } from '../host/lib/runjs.mjs'

// Runs the wrapped script as Chrome does: the script's value is a promise, and Chrome waits for it.
// The copy gives the result this realm's Object prototype, so deepEqual can compare it.
const run = async (code) => ({ ...(await vm.runInNewContext(wrapCode(code))) })

test('returns the value as JSON, and await works', async () => {
  assert.deepEqual(await run('return 1 + 1'), { json: '2' })
  assert.deepEqual(await run('const x = await Promise.resolve({ a: [1, "b"] })\nreturn x'), { json: '{"a":[1,"b"]}' })
})

test('code with no return gives no JSON', async () => {
  assert.deepEqual(await run('const x = 1'), { json: undefined })
  assert.equal(formatResult({}), 'undefined (the code returned no value)')
})

test('an error in the code comes back as { error }', async () => {
  const result = await run('throw new TypeError("nope")')
  assert.match(result.error, /TypeError: nope/)
  assert.match((await run('const a = {}; a.self = a; return a')).error, /circular/i)
})

test('a syntax error is refused before the code goes to Chrome', () => {
  assert.throws(() => wrapCode('return (1'), /^Error: Syntax error in the code: /)
  assert.throws(() => wrapCode('return 1 }'), /Syntax error/)
})

test('cuts long results', () => {
  assert.equal(formatResult({ json: '"short"' }, 10), '"short"')
  const cut = formatResult({ json: 'x'.repeat(25) }, 10)
  assert.ok(cut.startsWith(`${'x'.repeat(10)}\n… cut at 10 of 25 characters.`))
})
