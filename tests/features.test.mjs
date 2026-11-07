import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildFeature, loadFeatures, parseHeader } from '../host/lib/features.mjs'

test('reads a CSS block header', () => {
  const header = parseHeader('/*\n@name  GitHub dark\n@match *://github.com/*\n * @match *://*.github.com/*\n*/\nbody{}')
  assert.equal(header.name, 'GitHub dark')
  assert.deepEqual(header.match, ['*://github.com/*', '*://*.github.com/*'])
})

test('reads a JS line-comment header and stops at the first code line', () => {
  const header = parseHeader('// @name Hide shorts\n// @match *://www.youtube.com/*\n// @run-at document_start\nconst x = 1 // @match nope\n')
  assert.equal(header.name, 'Hide shorts')
  assert.equal(header['run-at'], 'document_start')
  assert.deepEqual(header.match, ['*://www.youtube.com/*'])
})

test('a one-line CSS header works', () => {
  assert.deepEqual(parseHeader('/* @match <all_urls> */ a{}').match, ['<all_urls>'])
})

test('merges matches from both files and builds the scripts', () => {
  const f = buildFeature('site-dark', { css: '/* @match *://a.com/* */ body{color:red}', js: '// @name Site dark\n// @match *://b.com/*\nIGA.log(1)' })
  assert.equal(f.error, undefined)
  assert.equal(f.name, 'Site dark')
  assert.deepEqual(f.matches, ['*://a.com/*', '*://b.com/*'])
  assert.deepEqual(f.files, ['site-dark.css', 'site-dark.js'])
  assert.deepEqual(f.scripts.map((s) => [s.key, s.runAt]), [['css', 'document_start'], ['js', 'document_idle']])
  assert.match(f.scripts[0].code, /^IGA\.style\("site-dark", /)
})

test('reports a missing match, a bad pattern, a bad id and a syntax error', () => {
  assert.match(buildFeature('x', { css: 'body{}' }).error, /at least one @match/)
  assert.match(buildFeature('x', { css: '/* @match github.com */' }).error, /not a valid match pattern/)
  assert.match(buildFeature('Bad_Name', { css: '/* @match <all_urls> */' }).error, /a-z, 0-9/)
  assert.match(buildFeature('x', { js: '// @match <all_urls>\nif (' }).error, /Syntax error in x\.js/)
})

test('a feature line comment at the end does not break the wrapper', () => {
  assert.equal(buildFeature('x', { js: '// @match <all_urls>\nIGA.log(1) // done' }).error, undefined)
})

test('accepts valid match patterns', () => {
  for (const p of ['<all_urls>', '*://*/*', 'https://example.com/a/b*', 'http://localhost:3000/*', 'file:///Users/*', '*://*.example.co.uk/*']) {
    assert.equal(buildFeature('x', { js: `// @match ${p}\n` }).error, undefined, p)
  }
})

test('loads features from a folder and skips other files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iga-'))
  await writeFile(join(dir, 'a.css'), '/* @match <all_urls> */')
  await writeFile(join(dir, 'a.js'), '// @match <all_urls>\n')
  await writeFile(join(dir, 'b.css'), '/* @match <all_urls> */')
  await writeFile(join(dir, '.gitkeep'), '')
  await writeFile(join(dir, 'notes.md'), '')
  const features = await loadFeatures(dir)
  assert.deepEqual(features.map((f) => [f.id, f.files]), [['a', ['a.css', 'a.js']], ['b', ['b.css']]])
})
