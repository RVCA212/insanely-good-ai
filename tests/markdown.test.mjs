import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdown } from '../extension/markdown.js'

test('escapes HTML, so page text cannot add tags', () => {
  const html = markdown('<img src=x onerror="alert(1)"> **<b>hi</b>**')
  assert.equal(html, '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; <strong>&lt;b&gt;hi&lt;/b&gt;</strong></p>')
})

test('renders the reply from the screenshot', () => {
  const html = markdown(
    'I wrote a dark theme.\n\n**To turn it on:** go to `chrome://extensions` and turn on **"Allow User Scripts"**.\n\n- **File:** `features/blind-review-dark.css`\n- **Scope:** only this page'
  )
  assert.equal(
    html,
    '<p>I wrote a dark theme.</p>' +
      '<p><strong>To turn it on:</strong> go to <code>chrome://extensions</code> and turn on <strong>&quot;Allow User Scripts&quot;</strong>.</p>' +
      '<ul><li><strong>File:</strong> <code>features/blind-review-dark.css</code></li><li><strong>Scope:</strong> only this page</li></ul>'
  )
})

test('keeps line breaks inside a paragraph', () => {
  assert.equal(markdown('one\ntwo'), '<p>one<br>two</p>')
})

test('code spans and code blocks keep their text as it is', () => {
  assert.equal(markdown('`**not bold**` and `a_b_c`'), '<p><code>**not bold**</code> and <code>a_b_c</code></p>')
  assert.equal(markdown('```css\nbody { color: red }\n<p>**x**</p>\n```\nafter'), '<pre><code>body { color: red }\n&lt;p&gt;**x**&lt;/p&gt;</code></pre><p>after</p>')
})

test('an unclosed code block (while text streams) is code to the end', () => {
  assert.equal(markdown('```js\nconst a = 1'), '<pre><code>const a = 1</code></pre>')
})

test('does not make emphasis from words with underscores or from math', () => {
  assert.equal(markdown('snake_case_name and 2 * 3 * 4'), '<p>snake_case_name and 2 * 3 * 4</p>')
  assert.equal(markdown('*one* and _two_ and ~~three~~'), '<p><em>one</em> and <em>two</em> and <del>three</del></p>')
})

test('links: only http(s) and mailto, and they open in a new tab', () => {
  assert.equal(
    markdown('[docs](https://a.com/x_y_z?a=1&b=2)'),
    '<p><a href="https://a.com/x_y_z?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">docs</a></p>'
  )
  assert.equal(markdown('[bad](javascript:alert(1))'), '<p>[bad](javascript:alert(1))</p>')
})

test('nested and ordered lists', () => {
  assert.equal(markdown('1. one\n   - a\n   - b\n2. two'), '<ol><li>one<ul><li>a</li><li>b</li></ul></li><li>two</li></ol>')
  assert.equal(markdown('3. three\n\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>')
  assert.equal(markdown('Steps:\n- a\n  more\ntext'), '<p>Steps:</p><ul><li>a<br>more</li></ul><p>text</p>')
})

test('headings, rules, quotes and tables', () => {
  assert.equal(markdown('## Done\n---\n> **note**'), '<h2>Done</h2><hr><blockquote><p><strong>note</strong></p></blockquote>')
  assert.equal(
    markdown('| File | Scope |\n|---|---|\n| `a.css` | page |'),
    '<div class="table"><table><thead><tr><th>File</th><th>Scope</th></tr></thead><tbody><tr><td><code>a.css</code></td><td>page</td></tr></tbody></table></div>'
  )
})
