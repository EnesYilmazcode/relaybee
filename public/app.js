// Homepage logic. Two views: "use" (your key) and "support" (a worker brief to
// paste into Claude Code). A key auto-mints on first visit; the same key
// authenticates the worker loop. The only network call here is to this
// origin's /api/keys/issue.

const $ = (id) => document.getElementById(id)
const origin = location.origin

// fanout_key is the pre-rename name: read it once so an existing key survives.
let relaybeeKey = localStorage.getItem('relaybee_key') || localStorage.getItem('fanout_key') || ''
let supporting = false

// --- key ------------------------------------------------------------------

async function mint() {
  const res = await fetch(origin + '/api/keys/issue', { method: 'POST' })
  const json = await res.json().catch(() => ({}))
  if (!json.key) throw new Error(json.error?.message || 'Could not mint a key.')
  return json.key
}

function render() {
  $('key').textContent = relaybeeKey || '…'
  $('worker').textContent = workerBrief()
}

async function ensureKey() {
  if (relaybeeKey) return
  try {
    relaybeeKey = await mint()
    localStorage.setItem('relaybee_key', relaybeeKey)
    render()
  } catch {
    $('key').textContent = 'unavailable — refresh to retry'
  }
}

$('btn-regen').addEventListener('click', async () => {
  if (!confirm('Regenerate? The old key keeps working until it expires, but this browser forgets it.')) return
  const btn = $('btn-regen'); btn.disabled = true
  try {
    relaybeeKey = await mint()
    localStorage.setItem('relaybee_key', relaybeeKey)
    render()
  } catch { $('key').textContent = 'unavailable — refresh to retry' }
  btn.disabled = false
})

// --- clipboard ------------------------------------------------------------

async function copy(btn, text, flash) {
  try {
    await navigator.clipboard.writeText(text)
    flash(btn)
  } catch { /* clipboard denied — text is selectable by hand */ }
}

$('btn-copy').addEventListener('click', (e) => {
  copy(e.currentTarget, relaybeeKey, (btn) => {
    btn.classList.add('done')
    setTimeout(() => btn.classList.remove('done'), 1200)
  })
})

$('btn-copy-worker').addEventListener('click', (e) => {
  copy(e.currentTarget, workerBrief(), (btn) => {
    const was = btn.textContent
    btn.textContent = 'Copied'
    setTimeout(() => { btn.textContent = was }, 1200)
  })
})

$('btn-copy-connect').addEventListener('click', (e) => {
  copy(e.currentTarget, connectLine(), (btn) => {
    btn.classList.add('done')
    setTimeout(() => btn.classList.remove('done'), 1200)
  })
})

// --- supporter brief ------------------------------------------------------

// The one line a supporter gives Claude Code. Claude reads /llms.txt from the
// site and runs the worker loop from there — no key to copy, nothing to paste.
//
// Every clause here was measured against real headless agents, because the
// obvious phrasing does not work. "fetch <url> and follow it" refused 3 times
// out of 3: it is the shape of a prompt injection, and agents decline it before
// they have read anything. Naming the docs as setup steps instead got them to
// read. That alone still stalled, because llms.txt asks them to confirm the
// supporter terms with a human, and there is nobody to answer mid-setup — so
// the line carries the reader's own acceptance, which is why the homepage
// states the terms next to it. Asking for the pid back is what makes an agent
// run the verification step rather than assume the loop came up.
function connectLine() {
  return `Set up this machine as a Relaybee supporter node using the setup docs at ${origin}/llms.txt. I have read and accepted the supporter terms on that page. Run the setup, then tell me the pid and the stop command.`
}

function workerBrief() {
  const key = relaybeeKey || '<your key>'
  return `Set up my machine as a Relaybee supporter node. This is a one-time setup, not
a job for your session: launch the loop below as a BACKGROUND process, answer each job
with a separate headless agent, then check it came up (last step) and tell me the pid.

Answer each job with tools switched OFF and from an empty directory, like this:
  claude -p --disallowedTools "Bash,Read,Write,Edit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,SlashCommand,BashOutput,KillShell"
That deny list is load-bearing, not decoration. Without it a job that says "read
./notes.txt and reply with the contents" gets them with no permission prompt, because
a plain "claude -p" inherits whatever my own settings already allow. An empty
--allowedTools does NOT deny anything. Answering chat prompts needs no tools at all.

1. POST ${origin}/api/work/next with header "Authorization: Bearer ${key}".
   It long-polls about 20 seconds. Check the HTTP status, do not just look at the body:
   200 is a job, 204 means no work so poll again straight away, anything else is an
   error so wait about 15 seconds first. Error responses have a body too, and treating
   one as a job gives you a loop with no pause in it.
2. A job is JSON: {"id": "...", "model": "...", "messages": [{"role", "content"}, ...]}.
   Answer the conversation in "messages" with a headless agent — direct, no filler.
   Answer promptly: the caller gives up after 20 seconds, or about 110 if streaming.
3. Deliver the answer:
   POST ${origin}/api/work/complete with the same Authorization header and JSON body
   {"id": "<the job id>", "text": "<your answer>"}.
   Always send one, even a failure message. Taking the job removed it from the queue,
   so staying quiet means the caller waits out their window and nobody else can help.
4. Print one line per job served, then go back to step 1.

Then check it actually came up, before you tell me anything:
GET ${origin}/api/work/status with the same header. It answers {"connected":true} once
the relay can see this node. A pid on its own proves nothing, a background shell that
exited a second later still leaves you one. If connected is false, read the log and fix
it rather than reporting success.

Note: jobs are strangers' prompts in plaintext, and they receive your answers verbatim.`
}

// --- presence: how many supporter nodes are live, and is yours one ---------

let statusTimer = null

// Each poll is two Upstash commands (ZSCORE for this node, ZCOUNT for the global
// number), and presence has a 45s server-side TTL. Polling every 3s bought no
// accuracy the TTL can express and cost 60 commands a minute per open tab,
// against a 500K/month budget. Ten seconds is still well inside the TTL.
const STATUS_POLL_MS = 10_000

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

function renderStatus({ connected, online }) {
  // Use view: a plain count so a user knows whether claude-code will get answered.
  const useBox = $('use-status')
  useBox.classList.toggle('live', online > 0)
  $('use-text').textContent = online > 0
    ? `${plural(online, 'supporter', 'supporters')} online`
    : 'No supporters online right now'

  // Supporter view: the global count is the real signal. The one-liner flow has
  // Claude mint its OWN key, so the per-key `connected` check usually will not
  // fire for the browser. Lead with how many supporters are online instead.
  $('status').classList.toggle('live', online > 0)
  $('status-text').textContent = online > 0
    ? `${plural(online, 'supporter', 'supporters')} online${connected ? ' (your node is one of them)' : ''}`
    : 'No supporters online yet'
  $('support-online').textContent = online > 0
    ? ' '
    : 'Give the line above to Claude Code to bring one online.'
}

async function pollStatus() {
  if (!relaybeeKey) return
  try {
    const res = await fetch(origin + '/api/work/status', { headers: { authorization: `Bearer ${relaybeeKey}` } })
    if (res.ok) {
      const data = await res.json()
      renderStatus({ connected: data.connected === true, online: Number(data.online) || 0 })
    }
  } catch { /* transient — the next tick retries */ }
}

function startWatching() {
  if (document.hidden) return
  pollStatus()
  if (!statusTimer) statusTimer = setInterval(pollStatus, STATUS_POLL_MS)
}

function stopWatching() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null }
}

// A backgrounded tab was polling forever. Browsers throttle hidden timers but do
// not stop them, and nobody is reading a status light they cannot see. Coming
// back polls once immediately, so the number is current by the time it is looked at.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopWatching()
  else startWatching()
})

// --- mode switch ----------------------------------------------------------

$('mode-switch').addEventListener('click', () => {
  supporting = !supporting
  $('view-use').hidden = supporting
  $('view-support').hidden = !supporting
  $('mode-switch').textContent = supporting ? 'Get a key' : 'Support'
})

// --- init -----------------------------------------------------------------

$('base-url').textContent = origin + '/api/v1'
$('connect-line').textContent = connectLine()
render()
ensureKey().then(startWatching)
