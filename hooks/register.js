// meanwhile: while Claude works, questions go to a read-only side agent; changes go to the main queue.
const AGENT = 'meanwhile:side'
const STEPS_SHOWN = 3
const STEP_POLL_MS = 1000

const CLASSIFY_SYSTEM = [
  'You route a message the user typed while a coding agent is busy. Reply with exactly one word.',
  'change: asks to modify files, code or config; gives the agent an instruction or a new direction; or tells it something it must know.',
  'question: only asks something (where, what, why, how, status) and requests no change.',
  'If unsure, reply change.',
].join('\n')

const SIDE_PROMPT = [
  'You answer a side question the user asked while the main agent keeps working.',
  'You can only read. Answer briefly and concretely, in the language of the question, citing file paths where useful.',
  'If answering would need a change to files, code or config, start your answer with "메인에 보낼 일:" and say what to change.',
].join('\n')

const entries = []
let seq = 0
// row ids must not repeat across module reloads: a reused id redraws the old row instead of adding one
const LOAD = Date.now().toString(36)
const rowId = (entry) => 'q-' + LOAD + '-' + entry.id
// answered side Q&A main has not seen yet
const unseen = []
let cwd = ''
// main's tool calls in flight, and those whose run-in-background pill is drawn. A row placed
// mid-call lands between the call and its pill, so questions wait under the pill instead.
const running = new Set()
const pills = new Set()
const PILL_WAIT_MS = 2000

// "Read src/foo.ts", the way Claude's own tool rows read
function stepOf(e) {
  const arg = String(e.file_path ?? e.pattern ?? e.query ?? e.url ?? '')
  return e.tool + ' ' + (cwd && arg.startsWith(cwd + '/') ? arg.slice(cwd.length + 1) : arg)
}

// The side agent's own tool events skip this mod (it runs under our origin), so its steps
// are read back from its conversation instead.
async function readSteps($, entry) {
  try {
    const msgs = await $.session.messages({ agentId: entry.agentId })
    if (!Array.isArray(msgs)) return
    const steps = msgs.flatMap((m) => m.toolUses || []).filter((u) => u.tool !== 'SubagentHandback')
      .map((u) => stepOf({ ...u.input, tool: u.tool }))
    if (steps.length !== entry.steps.length) {
      entry.steps = steps
      $.ui.invalidate('ui.render')
    }
  } catch {}
}

function watchSteps($, entry) {
  const timer = $.clock.every(STEP_POLL_MS, () => {
    if (entry.status !== 'running') return timer.cancel()
    return readSteps($, entry)
  })
}

async function classify($, text) {
  try {
    const r = await $.model.complete({ model: 'haiku', system: CLASSIFY_SYSTEM, prompt: text, maxTokens: 5, timeoutMs: 5000 })
    return r.isAnswered && r.text.trim().toLowerCase().startsWith('question') ? 'question' : 'change'
  } catch {
    return 'change'
  }
}

async function startSide($, entry) {
  let recent = ''
  try {
    const msgs = await $.session.messages()
    recent = msgs.slice(-30).map((m) => m.role + ': ' + m.text).join('\n').slice(-8000)
  } catch {}
  try {
    const r = await $.agent.spawn({
      subagentType: AGENT,
      description: 'side question',
      prompt: 'Main conversation so far (latest last):\n' + recent + '\n\nSide question: ' + entry.question,
    })
    if (r.deny) {
      entry.status = 'failed'
      entry.answer = r.deny
    } else {
      entry.agentId = r.agentId
      watchSteps($, entry)
    }
  } catch (err) {
    entry.status = 'failed'
    entry.answer = String((err && err.message) || err)
  }
  $.ui.invalidate('ui.render')
}

function place($, entry) {
  entry.waiting = false
  $.ui.place({ id: rowId(entry) }).then((r) => {
    entry.placed = r.isPlaced
    if (!r.isPlaced && entry.status !== 'running') $.ui.log('Q: ' + entry.question + '\nA: ' + entry.answer)
  }, () => {})
  $.ui.invalidate('ui.render')
}

function placeWaiting($) {
  for (const x of entries) if (x.waiting) place($, x)
}

async function clearInput($, text) {
  try {
    const box = await $.prompt.read()
    if (box.text.trim() === text.trim()) await $.prompt.fill({ text: '' })
  } catch {}
}

function resetSent($, entry) {
  entry.sent = false
  $.ui.invalidate('ui.render')
}

function sendToMain($, entry) {
  entry.sent = true
  // waits until main is idle, then runs as the user's own prompt; not awaited on purpose
  // a dropped or failed submit brings the button back
  $.prompt.submit({ text: entry.question, asUser: true })
    .then((r) => { if (r && r.drop) resetSent($, entry) }, () => resetSent($, entry))
  $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.agent.register({
        name: 'side',
        description: 'Answers side questions while the main agent works. Read-only.',
        prompt: SIDE_PROMPT,
        tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
      })
    } catch {}
    cwd = e.cwd || ''
    return next(e)
  })

  // The main model never dispatches our helper itself.
  on('agent.offer', { agent: AGENT }, () => ({ isOffered: false }))

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta) {
      // our side agent's hand-back would wake main; keep it out
      const ours = entries.some((x) => x.agentId && e.text.includes('from="' + x.agentId + '"'))
      return ours ? { drop: 'meanwhile: 옆 답변 완료' } : next(e)
    }
    if (!e.turnId) {
      if (e.command || e.origin.kind !== 'composer' || unseen.length === 0) return next(e)
      const notes = unseen.splice(0).map((x) => 'Q: ' + x.question + '\nA: ' + x.answer).join('\n\n')
      const ctx = 'While you were working, the user asked side questions that a read-only helper answered:\n\n' + notes
      return next({ ...e, context: [...(e.context ?? []), ctx] })
    }
    if (e.command || e.origin.kind !== 'composer' || e.attachments?.length || e.wait) return next(e)
    if ((await classify($, e.text)) !== 'question') return next(e)
    const entry = { id: ++seq, question: e.text, status: 'running', answer: '', steps: [], placed: false }
    entries.push(entry)
    // a row in the transcript, drawn like Claude's own turn; falls back to a log line at the end
    if (running.size) {
      entry.waiting = true
      // no pill to sit under (a quick or pill-less tool): place it anyway
      $.clock.after(PILL_WAIT_MS, () => { if (entry.waiting && !pills.size) place($, entry) })
    } else place($, entry)
    $.clock.after(0, () => startSide($, entry))
    // drop puts the text back in the prompt box; empty it once the drop lands
    $.clock.after(300, () => clearInput($, e.text))
    return { drop: 'meanwhile: 옆 질문으로 보냄' }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId || !e.tool_use_id) return next(e)
    running.add(e.tool_use_id)
    try {
      return await next(e)
    } finally {
      running.delete(e.tool_use_id)
      pills.delete(e.tool_use_id)
      if (!running.size) placeWaiting($)
    }
  })

  // /clear starts a new conversation; old side Q&A must not leak into it
  on('session.end', ($, e, next) => {
    unseen.length = 0
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const entry = e.agentId ? entries.find((x) => x.agentId === e.agentId) : undefined
    if (entry) {
      await readSteps($, entry)
      entry.status = e.isAborted || e.reason !== 'answer' || !e.answer ? 'failed' : 'done'
      entry.answer = e.answer || (e.isAborted ? '중단됨' : e.reason)
      if (entry.status === 'done') unseen.push(entry)
      if (!entry.placed && !entry.waiting) $.ui.log('Q: ' + entry.question + '\nA: ' + entry.answer)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    const x = e.props.plugin === $.plugin.name ? entries.find((y) => rowId(y) === e.props.id) : undefined
    if (!x) return next(e)
    return drawEntry($, $.ui.resolve(e), x)
  })

  // questions asked mid-call are drawn under the pill until the call ends
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (e.props.kind !== 'background_hint') return next(e)
    pills.add(e.props.tool_use_id)
    const waiting = entries.filter((x) => x.waiting)
    if (!waiting.length || e.props.tool_use_id !== pills.values().next().value) return next(e)
    const ui = $.ui.resolve(e)
    // the engine's own pill first, as it draws it
    const rows = [await next(e), ...waiting.map((x) => drawEntry($, ui, x))]
    return ui.Box({ flexDirection: 'column', children: rows })
  })
}

function drawEntry($, { Box, Text, Markdown, Button }, x) {
  const rows = [
    Box({ flexDirection: 'row', children: [
      Text({ dimColor: true, children: ['› '] }),
      Text({ wrap: 'wrap', children: [x.question] }),
      Text({ dimColor: true, children: ['  meanwhile'] }),
    ] }),
  ]
  const hidden = x.steps.length - STEPS_SHOWN
  if (hidden > 0) rows.push(Text({ dimColor: true, children: ['  ⎿  … +' + hidden] }))
  for (const step of x.steps.slice(-STEPS_SHOWN)) {
    rows.push(Text({ dimColor: true, wrap: 'truncate-end', children: ['  ⎿  ' + step] }))
  }
  if (x.status === 'running') rows.push(Text({ dimColor: true, children: ['  ⎿  …'] }))
  if (x.answer) {
    rows.push(Box({ flexDirection: 'row', children: [
      Text({ dimColor: x.status === 'failed', children: ['● '] }),
      Box({ flexDirection: 'column', flexShrink: 1, children: [Markdown({ text: x.answer, dimColor: x.status === 'failed' })] }),
    ] }))
  }
  // the side agent opens its answer with "메인에 보낼 일:" (maybe in markdown) when a change is needed
  const needsMain = x.status === 'failed' || /^[\s*_>#-]*메인에 보낼 일/.test(x.answer)
  if (needsMain && !x.sent) {
    rows.push(Box({ paddingLeft: 2, children: [Button({ key: 'send-' + x.id, label: '메인에 보내기', onPress: () => sendToMain($, x) })] }))
  }
  return Box({ flexDirection: 'column', marginTop: 1, children: rows })
}
