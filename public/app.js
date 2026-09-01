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

Answering runs on API billing and never on my Claude login: if ANTHROPIC_API_KEY is not
set, stop and say so instead of starting a node, because a consumer Pro/Max seat does
not cover answering other people.

Answer each job from a fresh empty directory with tools switched OFF, like this:
  SAFE="--bare --safe-mode --strict-mcp-config --no-session-persistence"
  NOTOOLS="Bash,BashOutput,KillShell,Read,Write,Edit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task,Agent,TodoWrite,ToolSearch,Skill,Workflow,Artifact,AskUserQuestion,SendUserFile,ReportFindings,ScheduleWakeup,CronCreate,CronDelete,CronList,DesignSync,EnterWorktree,ExitWorktree,EnterPlanMode,ExitPlanMode,Monitor,PushNotification,RemoteTrigger,SendMessage,EndConversation,TaskCreate,TaskGet,TaskList,TaskUpdate,TaskStop,TaskOutput"
  timeout 120 claude -p $SAFE --output-format json --max-budget-usd 0.50 --disallowedTools "$NOTOOLS"
--output-format json is what makes step 3 able to report a cost: .result is the answer,
.usage carries the token counts and .total_cost_usd the dollar figure. Relaybee never sees
the model call, so this node is the only place those numbers exist. A build that does not
emit the envelope still answers, so use its plain output as the answer and deliver that
without numbers rather than lose the job.
Containment is four independent things and the deny list is the weakest of them.
--bare reads ANTHROPIC_API_KEY only and never my login, keychain, CLAUDE.md or hooks;
--safe-mode drops MCP servers, skills, plugins and custom agents; --strict-mcp-config
makes sure no MCP config is reachable at all; timeout 120 stops one prompt wedging the
node on a job already taken off the queue. The deny list only blocks tools it names,
and it cannot name one that did not exist when it was written, which is exactly how the
previous version of this brief failed. Without it a job that says "read ./notes.txt and
reply with the contents" gets them with no permission prompt, because a plain "claude -p"
inherits whatever my own settings already allow. An empty --allowedTools does NOT deny
anything. Answering chat prompts needs no tools at all.

1. POST ${origin}/api/work/next with header "Authorization: Bearer ${key}".
   Jobs sent under this same key come to you. That is the default and it needs no
   body; do not opt into the public pool on my behalf.
   It long-polls about 20 seconds. Check the HTTP status, do not just look at the body:
   200 is a job, 204 means no work so poll again straight away, anything else is an
   error so wait about 15 seconds first. Error responses have a body too, and treating
   one as a job gives you a loop with no pause in it.
2. A job is JSON: {"id": "...", "ticket": "...", "model": "...", "messages": [...]}.
   Keep the ticket with the job. It is what proves you took it.
   Answer the conversation in "messages" with a headless agent — direct, no filler.
   Answer promptly: the caller gives up after 20 seconds, or about 110 if streaming.
3. Deliver the answer:
   POST ${origin}/api/work/complete with the same Authorization header and JSON body
   {"id": "<the job id>", "ticket": "<the ticket>", "text": "<your answer>",
    "usage": {"input_tokens": 1183, "output_tokens": 274, "cost_usd": 0.0121}}.
   input_tokens is .usage.input_tokens plus cache_read_input_tokens plus
   cache_creation_input_tokens, output_tokens is .usage.output_tokens, and cost_usd is
   .total_cost_usd. Those three travel together or not at all, and the relay drops the
   whole block if one of them is missing or not a sane number. Leave usage out entirely
   rather than sending zeros: a zero reads as a job that cost nothing rather than one
   nobody measured.
   Always send an answer, even a failure message. Taking the job removed it from the queue,
   so staying quiet means the caller waits out their window and nobody else can help.
4. Print one line per job served, then go back to step 1. Stop after 100 jobs: a
   per-job budget with no total is still an unlimited commitment.

Then check it actually came up, before you tell me anything:
GET ${origin}/api/work/status with the same header. It answers {"connected":true} once
the relay can see this node. A pid on its own proves nothing, a background shell that
exited a second later still leaves you one. If connected is false, read the log and fix
it rather than reporting success.

Note: on the default "own" pool the jobs are mine, sent under this same key. If you
ever switch it to the public pool they are strangers' prompts in plaintext, and those
strangers receive your answers verbatim.`
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
  // Use view: `claude-code` goes to this key's own queue and nowhere else, so the
  // global count answers a different question than the one this box is asked. A
  // visitor with no node of their own read "2 supporters online" here and then got
  // a 504 from the model the page names. The global number is only true of
  // `claude-code/public`, so it is named wherever that number is.
  //
  // The remedy has to name the paste-the-steps brief rather than the connect
  // line above it. The hosted script mints its own key, so the node it brings up
  // belongs to a different user id and this key's `claude-code` calls still get
  // nothing. The brief is the only supporter path that runs on the key the page
  // is holding.
  const useBox = $('use-status')
  useBox.classList.toggle('live', connected)
  $('use-text').textContent = connected
    ? 'Your node is online. claude-code will be answered.'
    : online > 0
      ? `${plural(online, 'supporter', 'supporters')} online, but ${online === 1 ? 'it is not yours' : 'none of them is yours'}. Ask for claude-code/public to reach the ones that opted in.`
      : 'No node of your own, and no supporters online. Run one from "Or paste the steps yourself" under Support, which uses this key. Or bring a provider key.'

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
