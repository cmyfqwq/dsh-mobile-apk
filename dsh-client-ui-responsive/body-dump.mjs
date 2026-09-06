// body-dump.mjs — body childNodes 结构
const list = await (await fetch(process.env.CDP_HTTP ?? 'http://127.0.0.1:29225/json')).json()
const page = list.find((p) => p.type === 'page' && p.url.includes('3080'))
const WebSocket = (await import('ws')).default
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
let id = 0
const pending = new Map()
ws.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
await new Promise((r) => ws.on('open', r))
const ev = async (expr) => {
  const mid = ++id
  const p = new Promise((res) => pending.set(mid, res))
  ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
  const r = await p
  if (r.result?.exceptionDetails) return { EXCEPTION: r.result.exceptionDetails.exception?.description?.slice(0, 300) }
  return r.result?.result?.value
}
console.log('body childNodes:', await ev(`
  JSON.stringify([...document.body.childNodes].map(n => ({
    type: n.nodeType, name: n.nodeName,
    text: (n.textContent || '').slice(0, 120),
    tag: n.tagName || undefined
  })))
`))
console.log('--- scripts in body ---')
console.log(await ev(`
  JSON.stringify([...document.body.querySelectorAll('script')].map(s => ({
    src: s.src || null, len: (s.textContent || '').length,
    head: (s.textContent || '').slice(0, 100)
  })))
`))
console.log('--- theme bootstrap origin (first text node parent) ---')
console.log(await ev(`
  (() => {
    const t = [...document.body.childNodes].find(n => n.nodeType === 3 && (n.textContent||'').includes('preference'));
    if (!t) return 'not found';
    return 'parent=' + t.parentElement?.tagName + ' | parentHTML head=' + (t.parentElement?.innerHTML || '').slice(0, 300);
  })()
`))
ws.close()
