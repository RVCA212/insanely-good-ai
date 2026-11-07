// Helpers for features. Chrome runs this file before each feature, in the USER_SCRIPT world.
// All features on a page share that world, so only the first copy sets up IGA.
if (!globalThis.IGA) {
  const format = (value) => {
    if (value instanceof Error) return value.stack || String(value)
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  const report = (featureId, level, values) => {
    try {
      chrome.runtime.sendMessage({ type: 'log', featureId, level, text: values.map(format).join(' ') })
    } catch {
      // The extension was reloaded; this page has an old copy.
    }
  }

  // Feature styles stay at the end of <head>, so they win over page styles with the same specificity.
  const styles = []
  let watchedHead = null
  const keepStylesLast = () => {
    const parent = document.head || document.documentElement
    const tail = [...parent.children].slice(-styles.length)
    if (tail.length === styles.length && tail.every((el, i) => el === styles[i])) return
    parent.append(...styles)
  }
  const observer = new MutationObserver(() => {
    if (document.head && document.head !== watchedHead) {
      watchedHead = document.head
      observer.observe(watchedHead, { childList: true })
    }
    keepStylesLast()
  })

  const style = (featureId, css) => {
    const el = document.createElement('style')
    el.dataset.iga = featureId
    el.textContent = css
    styles.push(el)
    if (styles.length === 1) observer.observe(document.documentElement, { childList: true })
    keepStylesLast()
  }

  const feature = async (featureId, run) => {
    const log = (level) => (...values) => report(featureId, level, values)
    const guard = (fn) => (...args) => {
      try {
        const result = fn(...args)
        if (result instanceof Promise) result.catch(log('error'))
      } catch (error) {
        log('error')(error)
      }
    }
    const api = {
      log: log('log'),
      warn: log('warn'),
      error: log('error'),
      waitFor: (selector, timeoutMs = 10000) =>
        new Promise((resolve, reject) => {
          const found = document.querySelector(selector)
          if (found) return resolve(found)
          const watcher = new MutationObserver(() => {
            const el = document.querySelector(selector)
            if (!el) return
            watcher.disconnect()
            clearTimeout(timer)
            resolve(el)
          })
          watcher.observe(document, { childList: true, subtree: true })
          const timer = setTimeout(() => {
            watcher.disconnect()
            reject(new Error(`waitFor timed out: ${selector}`))
          }, timeoutMs)
        }),
      onElement: (selector, fn) => {
        const seen = new WeakSet()
        const call = guard(fn)
        const scan = () => {
          for (const el of document.querySelectorAll(selector)) {
            if (seen.has(el)) continue
            seen.add(el)
            call(el)
          }
        }
        let queued = false
        new MutationObserver(() => {
          if (queued) return
          queued = true
          requestAnimationFrame(() => {
            queued = false
            scan()
          })
        }).observe(document, { childList: true, subtree: true })
        scan()
      },
      onUrlChange: (fn) => {
        const call = guard(fn)
        let last = location.href
        setInterval(() => {
          if (location.href === last) return
          last = location.href
          call(last)
        }, 300)
      },
      download: (filename, data) => {
        const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
        const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
        const link = Object.assign(document.createElement('a'), { href: url, download: filename })
        document.documentElement.append(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10000)
      }
    }
    try {
      await run(api)
    } catch (error) {
      report(featureId, 'error', [error])
    }
  }

  globalThis.IGA = { style, feature }
}
