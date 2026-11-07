// Small Markdown renderer for Claude's replies in the chat. It escapes the text first, so the only
// tags in the output are the ones it makes. Links must be http(s) or mailto and open in a new tab.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escape = (text) => text.replace(/[&<>"']/g, (c) => ESCAPES[c])

const FENCE = /^\s*(`{3,}|~{3,})/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function emphasis(html) {
  return html
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '<strong>$2</strong>')
    .replace(/(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, '<em>$1</em>')
    .replace(/(?<!\w)_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, '<em>$1</em>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<del>$1</del>')
}

function inline(text) {
  // Code spans and links are kept aside, so emphasis does not change their content or URLs.
  const kept = []
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`
  const html = escape(text)
    .replace(/`([^`]+)`/g, (_, code) => keep(`<code>${code}</code>`))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label, url) =>
      /^(https?:|mailto:)/i.test(url) ? keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${emphasis(label)}</a>`) : all
    )
  const restore = (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => restore(kept[i]))
  return restore(emphasis(html))
}

function list(items) {
  let html = ''
  const open = [] // { indent, tag }
  for (const item of items) {
    const tag = item.ordered ? 'ol' : 'ul'
    const top = () => open.at(-1)
    while (open.length && (item.indent < top().indent || (item.indent === top().indent && tag !== top().tag))) html += `</li></${open.pop().tag}>`
    if (open.length && item.indent === top().indent) html += '</li>'
    else {
      html += item.ordered && item.start !== 1 ? `<ol start="${item.start}">` : `<${tag}>`
      open.push({ indent: item.indent, tag })
    }
    html += `<li>${item.lines.map(inline).join('<br>')}`
  }
  while (open.length) html += `</li></${open.pop().tag}>`
  return html
}

function table(head, rows) {
  const cells = (row, tag) => row.map((cell) => `<${tag}>${inline(cell)}</${tag}>`).join('')
  const body = rows.map((row) => `<tr>${cells(row, 'td')}</tr>`).join('')
  return `<div class="table"><table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${body}</tbody></table></div>`
}

const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())

/** Markdown text to an HTML string. Unfinished text (while it streams) renders as far as it goes. */
export function markdown(text) {
  const lines = text.replace(/\u0000/g, '').split(/\r?\n/)
  const out = []
  let paragraph = []
  const flush = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`)
    paragraph = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(FENCE)
    const heading = line.match(/^\s*(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/)
    if (fence) {
      flush()
      const close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`)
      const code = []
      while (++i < lines.length && !close.test(lines[i])) code.push(lines[i])
      out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`)
    } else if (!line.trim()) {
      flush()
    } else if (heading) {
      flush()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
    } else if (RULE.test(line)) {
      flush()
      out.push('<hr>')
    } else if (/^\s*>/.test(line)) {
      flush()
      const quote = []
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*> ?/, ''))
      i--
      out.push(`<blockquote>${markdown(quote.join('\n'))}</blockquote>`)
    } else if (ITEM.test(line)) {
      flush()
      const items = []
      for (; i < lines.length; i++) {
        const next = lines[i]
        const item = next.match(ITEM)
        if (item && !RULE.test(next)) {
          items.push({ indent: item[1].length, ordered: /\d/.test(item[2]), start: parseInt(item[2], 10), lines: [item[3]] })
        } else if (next.trim() && /^\s/.test(next) && !FENCE.test(next)) {
          items.at(-1).lines.push(next.trim()) // an indented line continues the item
        } else if (!next.trim() && ITEM.test(lines[i + 1] ?? '')) {
          continue // a blank line between items
        } else break
      }
      i--
      out.push(list(items))
    } else if (line.includes('|') && (lines[i + 1] ?? '').includes('|') && TABLE_DIVIDER.test(lines[i + 1])) {
      flush()
      const head = splitRow(line)
      const rows = []
      for (i += 2; i < lines.length && lines[i].includes('|'); i++) rows.push(splitRow(lines[i]))
      i--
      out.push(table(head, rows))
    } else {
      paragraph.push(line.trim())
    }
  }
  flush()
  return out.join('')
}
