// ask: while Claude works, questions go to a read-only side agent; changes go to the main queue.
const PANE = 'asks'
const AGENT = 'ask:side'

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
    }
  } catch (err) {
    entry.status = 'failed'
    entry.answer = String((err && err.message) || err)
  }
  $.ui.invalidate('ui.render')
}

async function clearInput($, text) {
  try {
    const box = await $.prompt.read()
    if (box.text.trim() === text.trim()) await $.prompt.fill({ text: '' })
  } catch {}
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
    return next(e)
  })

  // The main model never dispatches our helper itself.
  on('agent.offer', { agent: AGENT }, () => ({ isOffered: false }))

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || !e.turnId || e.command || e.origin.kind !== 'composer') return next(e)
    if ((await classify($, e.text)) !== 'question') return next(e)
    const entry = { id: ++seq, question: e.text, status: 'running', answer: '' }
    entries.push(entry)
    $.clock.after(0, () => startSide($, entry))
    // drop puts the text back in the prompt box; empty it once the drop lands
    $.clock.after(300, () => clearInput($, e.text))
    return { drop: 'ask: 옆 질문으로 보냄' }
  })
}
