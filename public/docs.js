// Docs page. Three jobs: fill every example with the reader's own key, let them
// copy it, and let them run the relay call from the page so "does my key work"
// is answered on the spot rather than after a round trip through a terminal.
//
// The key comes from localStorage under the same name the home page uses, so a
// reader who has been to the home page arrives here already set up.

const $ = (id) => document.getElementById(id)
const origin = location.origin
const PLACEHOLDER = 'YOUR_RELAYBEE_KEY'

// fanout_key is the pre-rename name: read it once so an existing key survives.
let relaybeeKey = localStorage.getItem('relaybee_key') || localStorage.getItem('fanout_key') || ''

// --- filling the examples --------------------------------------------------

// Snippets ship with __ORIGIN__/__KEY__ tokens in the markup. Keep the original
// text so a later mint can refill a block that has already been substituted.
const templates = new Map()
for (const pre of document.querySelectorAll('pre[data-fill]')) {
  templates.set(pre, pre.textContent)
}

function fill() {
  const key = relaybeeKey || PLACEHOLDER
  for (const [pre, tpl] of templates) {
    pre.textContent = tpl.split('__ORIGIN__').join(origin).split('__KEY__').join(key)
  }
  $('key').textContent = relaybeeKey || 'no key in this browser yet'
  $('btn-mint').hidden = Boolean(relaybeeKey)
  $('btn-copy').disabled = !relaybeeKey
  $('key-hint').textContent = relaybeeKey
    ? 'Read from this browser. It is the same key the home page gave you, and it is filled into every example below.'
    : 'Mint one and every example below fills itself in. Keys are free, unauthenticated, and last 90 days.'
}

// --- language tabs ---------------------------------------------------------

// One snippet visible per group instead of a stack. The choice is shared across
// groups and remembered, so a PowerShell reader who picks it once in section 1
// gets it again in section 4 and on their next visit. Groups do not all offer
// the same languages, so a group without the remembered one keeps its first tab.
const LANG_KEY = 'relaybee_docs_lang'

const lists = [...document.querySelectorAll('.tablist')]
const tabsIn = (list) => [...list.querySelectorAll('[role="tab"]')]
const labelOf = (tab) => tab.textContent.trim()

/** Select one tab within its own group. No persistence, no cross-group effect. */
function showTab(tab, focus = false) {
  for (const other of tabsIn(tab.parentElement)) {
    const on = other === tab
    other.setAttribute('aria-selected', String(on))
    // Roving tabindex: one stop for the whole group, arrows move within it.
    other.tabIndex = on ? 0 : -1
    document.getElementById(other.getAttribute('aria-controls')).hidden = !on
  }
  if (focus) tab.focus()
}

/** Switch every group that offers this language, and remember the choice.
 *  A reader who picks PowerShell in section 1 means it for section 4 as well,
 *  and a group that does not offer it keeps whatever it was showing. */
function chooseLang(label, focus = null) {
  for (const list of lists) {
    const match = tabsIn(list).find((t) => labelOf(t) === label)
    if (match) showTab(match, focus === list)
  }
  try { localStorage.setItem(LANG_KEY, label) } catch { /* private mode */ }
}

for (const list of lists) {
  list.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]')
    if (tab) chooseLang(labelOf(tab))
  })

  list.addEventListener('keydown', (e) => {
    const tabs = tabsIn(list)
    const i = tabs.indexOf(document.activeElement)
    if (i === -1) return
    const to = e.key === 'ArrowRight' ? i + 1
      : e.key === 'ArrowLeft' ? i - 1
      : e.key === 'Home' ? 0
      : e.key === 'End' ? tabs.length - 1
      : -1
    if (to === -1) return
    e.preventDefault()
    chooseLang(labelOf(tabs[(to + tabs.length) % tabs.length]), list)
  })
}

// Restore the remembered language. Do it per group rather than through
// chooseLang so a group that does not offer it is left on its own first tab
// instead of the preference being rewritten by whatever loaded last.
let preferred = ''
try { preferred = localStorage.getItem(LANG_KEY) || '' } catch { /* private mode */ }
if (preferred) {
  for (const list of lists) {
    const match = tabsIn(list).find((t) => labelOf(t) === preferred)
    if (match) showTab(match)
  }
}

// --- clipboard -------------------------------------------------------------

async function copy(btn, text) {
  try {
    await navigator.clipboard.writeText(text)
    const was = btn.textContent
    btn.textContent = 'copied'
    btn.classList.add('done')
    setTimeout(() => { btn.textContent = was; btn.classList.remove('done') }, 1200)
  } catch { /* clipboard denied, the text is selectable by hand */ }
}

for (const btn of document.querySelectorAll('.snippet .copy')) {
  btn.addEventListener('click', () => copy(btn, btn.parentElement.querySelector('pre').textContent))
}
$('btn-copy').addEventListener('click', (e) => copy(e.currentTarget, relaybeeKey))

// --- minting ---------------------------------------------------------------

$('btn-mint').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  btn.disabled = true
  try {
    const res = await fetch(origin + '/api/keys/issue', { method: 'POST' })
    const json = await res.json().catch(() => ({}))
    if (!json.key) throw new Error(json.error?.message || 'Could not mint a key.')
    relaybeeKey = json.key
    localStorage.setItem('relaybee_key', relaybeeKey)
    fill()
    startWatching()
  } catch (err) {
    $('key-hint').textContent = err.message
  }
  btn.disabled = false
})

// --- supporter presence ----------------------------------------------------

// Ten seconds, and stopped while the tab is hidden, for the same reason the home
// page does it: each poll is two Upstash commands against a 500K monthly budget
// and presence has a 45s server-side TTL, so faster buys no accuracy.
const STATUS_POLL_MS = 10_000
let statusTimer = null
let online = 0
let connected = false

// The light and the count answer different questions, because a job goes to its
// requester's own queue. "claude-code" is served only by nodes running under this
// same key, so `connected` is the whole answer for it. The global count is an
// upper bound on "claude-code/public" rather than a promise: this page polls the
// global count, and only some of those nodes opted into the shared pool.
function renderStatus(n, mine) {
  online = n
  connected = mine
  const box = $('status')
  box.classList.toggle('live', mine || n > 0)
  $('status-text').textContent = mine
    ? 'A node of your own is online, so claude-code is answered on your machine'
    : n > 0
      ? `No node of your own, so claude-code has nobody. ${n} node${n === 1 ? '' : 's'} online in total, and claude-code/public reaches whichever of them opted in`
      : 'Nothing is online, so neither claude-code nor claude-code/public has anybody to answer it'
  $('try-note').textContent = mine
    ? 'Goes to your own node, as claude-code.'
    : 'No node of your own, so this sends claude-code/public and a stranger answers it.'
}

async function pollStatus() {
  if (!relaybeeKey) return
  try {
    const res = await fetch(origin + '/api/work/status', { headers: { authorization: `Bearer ${relaybeeKey}` } })
    if (res.ok) {
      const status = await res.json()
      renderStatus(Number(status.online) || 0, Boolean(status.connected))
    }
  } catch { /* transient, the next tick retries */ }
}

function startWatching() {
  if (document.hidden || !relaybeeKey) return
  pollStatus()
  if (!statusTimer) statusTimer = setInterval(pollStatus, STATUS_POLL_MS)
}

function stopWatching() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopWatching()
  else startWatching()
})

// --- run it here -----------------------------------------------------------

// Streaming, for the reason the page gives: a buffered relay request has to give
// up at 20s to stay inside the platform's initial-response deadline, and real
// supporter answers routinely take longer than that.
//
// The model string picks the queue, so this is also where the demo either works
// or does not. Plain "claude-code" reaches only nodes running under the reader's
// own key, which almost no reader visiting the docs has, so it would sit out the
// whole streaming window and 504 for everybody the page is meant to convince. It
// falls back to the public pool, and the page and the note say so before Send.
const tryModel = () => (connected ? 'claude-code' : 'claude-code/public')

async function runTry() {
  const btn = $('btn-try')
  const out = $('try-out')
  const prompt = $('try-prompt').value.trim()

  if (!relaybeeKey) { show(out, 'Mint a key first.', true); return }
  if (!prompt) { show(out, 'Type a prompt first.', true); return }

  const model = tryModel()
  btn.disabled = true
  show(out, connected || online > 0
    ? `Waiting for an answer to ${model}…`
    : `Sending ${model}. Nothing is showing as online, so this may time out…`, false)

  try {
    const res = await fetch(origin + '/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${relaybeeKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!res.ok || !res.body) {
      const json = await res.json().catch(() => ({}))
      show(out, `${res.status}: ${json.error?.message || 'Request failed.'}`, true)
      btn.disabled = false
      return
    }

    let answer = ''
    for await (const frame of sseFrames(res.body)) {
      if (frame === '[DONE]') break
      let ev
      try { ev = JSON.parse(frame) } catch { continue }
      // The relay reports a timeout as an error frame inside a 200 stream: the
      // headers were already sent by the time it knew nobody would answer.
      if (ev.error) { show(out, ev.error.message, true); btn.disabled = false; return }
      const delta = ev.choices?.[0]?.delta?.content
      if (delta) { answer += delta; show(out, answer, false) }
    }
    if (!answer) show(out, 'The stream ended without an answer. Try again in a moment.', true)
  } catch (err) {
    show(out, err.message || 'Request failed.', true)
  }
  btn.disabled = false
}

function show(out, text, bad) {
  out.hidden = false
  out.textContent = text
  out.classList.toggle('bad', Boolean(bad))
}

/** Yields each SSE frame's data payload, tolerating chunk boundaries mid-frame. */
async function* sseFrames(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i)
      buf = buf.slice(i + 2)
      let data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (data) yield data
    }
  }
}

$('btn-try').addEventListener('click', runTry)

// --- init ------------------------------------------------------------------

fill()
startWatching()
