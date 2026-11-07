import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkUrl, decideTool } from '../host/lib/permissions.mjs'

const root = '/p/insanely-good-ai'
const verdict = (name, input) => decideTool(name, input, root).behavior

test('reads are limited to the project', () => {
  assert.equal(verdict('Read', { file_path: `${root}/context/page.html` }), 'allow')
  assert.equal(verdict('Read', { file_path: 'context/screenshot.jpg' }), 'allow')
  assert.equal(verdict('Grep', { pattern: 'x' }), 'allow')
  assert.equal(verdict('Read', { file_path: '/Users/me/.ssh/id_rsa' }), 'deny')
  assert.equal(verdict('Glob', { pattern: '*', path: '/etc' }), 'deny')
})

test('writes are limited to .js and .css in features/', () => {
  assert.equal(verdict('Write', { file_path: `${root}/features/a.css` }), 'allow')
  assert.equal(verdict('Edit', { file_path: 'features/a.js' }), 'allow')
  assert.equal(verdict('Write', { file_path: `${root}/features/a.md` }), 'deny')
  assert.equal(verdict('Write', { file_path: `${root}/extension/panel.js` }), 'deny')
  assert.equal(verdict('Edit', { file_path: `${root}/features/../host/host.mjs` }), 'deny')
  assert.equal(verdict('Write', { file_path: `${root}/features-evil/a.js` }), 'deny')
})

test('a chat cannot write a file that another chat is writing', () => {
  const taken = new Set([`${root}/features/a.css`])
  assert.equal(decideTool('Edit', { file_path: 'features/a.css' }, root, taken).behavior, 'deny')
  assert.match(decideTool('Write', { file_path: `${root}/features/a.css` }, root, taken).message, /Another chat/)
  assert.equal(decideTool('Write', { file_path: `${root}/features/b.css` }, root, taken).behavior, 'allow')
  assert.equal(decideTool('Read', { file_path: `${root}/features/a.css` }, root, taken).behavior, 'allow')
})

test('browser tools are allowed, everything else is denied', () => {
  assert.equal(verdict('mcp__browser__apply_and_check', {}), 'allow')
  assert.equal(verdict('mcp__browser__open_url', { url: 'https://x.com' }), 'allow')
  assert.equal(verdict('Bash', { command: 'ls' }), 'deny')
  assert.equal(verdict('WebFetch', { url: 'https://x.com' }), 'deny')
})

test('chrome-devtools tools are allowed, but use files only in context/', () => {
  assert.equal(verdict('mcp__chrome-devtools__list_pages', {}), 'allow')
  assert.equal(verdict('mcp__chrome-devtools__evaluate_script', { function: '() => 1', pageId: 1 }), 'allow')
  assert.equal(verdict('mcp__chrome-devtools__take_snapshot', { pageId: 1, filePath: 'context/chat-1/a11y.txt' }), 'allow')
  assert.equal(verdict('mcp__chrome-devtools__upload_file', { pageId: 1, uid: '1', filePaths: [`${root}/context/chat-1/a.txt`] }), 'allow')
  assert.equal(verdict('mcp__chrome-devtools__evaluate_script', { function: '() => "x"', pageId: 1, filePath: `${root}/host/host.mjs` }), 'deny')
  assert.equal(verdict('mcp__chrome-devtools__take_screenshot', { pageId: 1, filePath: 'context/../extension/icon.png' }), 'deny')
  assert.equal(verdict('mcp__chrome-devtools__upload_file', { pageId: 1, uid: '1', filePaths: ['context/a.txt', '/Users/me/.ssh/id_rsa'] }), 'deny')
  assert.equal(verdict('mcp__chrome-devtools__lighthouse_audit', { pageId: 1, outputDirPath: '/tmp' }), 'deny')
})

test('open_url opens only full http and https URLs', () => {
  assert.equal(checkUrl('https://github.com'), 'https://github.com/')
  assert.equal(checkUrl('http://example.com/a?q=b c'), 'http://example.com/a?q=b%20c')
  assert.throws(() => checkUrl('github.com'), /full http or https URL/)
  assert.throws(() => checkUrl('javascript:alert(1)'))
  assert.throws(() => checkUrl('file:///etc/passwd'))
  assert.throws(() => checkUrl('chrome://settings'))
})
