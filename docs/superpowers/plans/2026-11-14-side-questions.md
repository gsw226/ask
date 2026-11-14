# ask (side-question mod) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code mod that, while the main agent is working, routes the user's questions to a read-only side agent and lets change requests pass through to the main queue.

**Architecture:** One hooks module (`hooks/register.js`). `prompt.submit` classifies busy-time input with Haiku. Questions are dropped from main and handed to a registered read-only agent type (`ask:side`). Answers arrive on that agent's `turn.complete`, are shown in a pane and in the transcript, and are attached as `context` to the next idle main prompt.

**Tech Stack:** Claude Code mods (CLI ≥ 2.1.325, ES module JS), `claude plugin test` (TS tests, `claude-code/testing`), `claude plugin validate`.

## Global Constraints

- Fail open: on any classifier error, timeout, or uncertain label, call `next(e)`. A user's input must never be lost.
- Busy = `e.turnId` is present. Only `e.origin.kind === 'composer'`, non-meta, non-command input is ever classified.
- The side agent has no write tools: `tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']`.
- Pane shows status mark + question + answer only. No other labels or badges.
- Validation rules: write `$` calls in full (`$.ns.method`), pass `$` only to top-level functions, event names as string literals.
- Commit messages in English, no AI attribution.
- Spike facts (spec §스파이크 결과) are ground truth; the generated `.claude-plugin/types/claude-code/index.d.ts` wins over this plan if they disagree.

## File Structure

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             { "modules": ["./register.js"] }
hooks/register.js            all logic
tests/ask.test.ts            claude plugin test
.gitignore                   .claude-plugin/types/ (generated per build)
```

---

### Task 1: Scaffold + routing (classify, drop, clear input, spawn)

**Files:**
- Create: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.js`, `tests/ask.test.ts`, `.gitignore`

**Interfaces:**
- Produces (module-level in `register.js`): `entries` array of `{ id: number, question: string, status: 'running'|'done'|'failed', answer: string, agentId?: string, sent?: boolean }`; constants `PANE = 'asks'`, `AGENT = 'ask:side'`; top-level `classify($, text) → Promise<'question'|'change'>`, `startSide($, entry) → Promise<void>`, `clearInput($) → Promise<void>`.

- [ ] **Step 1: Scaffold files**

`.claude-plugin/plugin.json`:
```json
{
  "name": "ask",
  "version": "0.1.0",
  "description": "While Claude works, questions go to a read-only side agent; change requests go to the main queue",
  "author": { "name": "gsw226" }
}
```

`hooks/hooks.json`:
```json
{ "modules": ["./register.js"] }
```

`.gitignore`:
```
.claude-plugin/types/
tsconfig.json
```

- [ ] **Step 2: Write failing tests** — `tests/ask.test.ts`

```typescript
import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const label = (text: string) => () => ({ value: { isAnswered: true, text, usage: USAGE } })

function stubCommon(on: any, spawned: any[] = [], submitted: string[] = []) {
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text, context: e.context } })
  on('prompt.fill', () => ({ isFilled: true }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'fix the parser', toolUses: [] }] }))
  on('agent.spawn', ($: any, e: any) => { spawned.push(e); return { model: 'test', agentId: 'ag' + spawned.length } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
}

test('idle input passes through untouched, no classification', async ($, on) => {
  let classified = 0
  on('model.complete', () => { classified++; return label('question')() })
  stubCommon(on)
  const r = await $.prompt.submit({ text: 'where is foo?', origin: { kind: 'composer' }, wait: false })
  expect(r.text).toBe('where is foo?')
  expect(classified).toBe(0)
})

test('busy question is dropped from main and spawns the side agent', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: any[] = []
  on('model.complete', label('question'))
  stubCommon(on, spawned)
  const r = await $.prompt.submit({ text: 'where is foo?', origin: { kind: 'composer' }, wait: false, turnId: 't1' })
  expect(r.drop).toBeDefined()
  await clock.advance(500)
  expect(spawned).toHaveLength(1)
  expect(spawned[0].subagentType).toBe('ask:side')
  expect(spawned[0].prompt).toContain('where is foo?')
  expect(spawned[0].prompt).toContain('fix the parser')
})

test('busy change request passes through', async ($, on) => {
  on('model.complete', label('change'))
  stubCommon(on)
  const r = await $.prompt.submit({ text: 'also rename foo to bar', origin: { kind: 'composer' }, wait: false, turnId: 't1' })
  expect(r.text).toBe('also rename foo to bar')
})

test('classifier failure passes through', async ($, on) => {
  on('model.complete', () => ({ deny: 'boom' }))
  stubCommon(on)
  const r = await $.prompt.submit({ text: 'where is foo?', origin: { kind: 'composer' }, wait: false, turnId: 't1' })
  expect(r.text).toBe('where is foo?')
})
```

- [ ] **Step 3: Run tests, expect failure**

Run: `claude plugin test`
Expected: FAIL (module missing / no hooks).

- [ ] **Step 4: Implement** — `hooks/register.js`

```javascript
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

async function clearInput($) {
  try {
    await $.prompt.fill({ text: '' })
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
    $.clock.after(300, () => clearInput($))
    return { drop: 'ask: 옆 질문으로 보냄' }
  })
}
```

- [ ] **Step 5: Run tests + validate**

Run: `claude plugin test && claude plugin validate .`
Expected: 4 pass; validation passes. If a stub shape is wrong the kit says `returned neither { value } nor { deny }` or `no implementation for <name>`: fix the stub per `.claude-plugin/types/claude-code/index.d.ts`, not the module.

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json hooks tests .gitignore
git commit -m "feat: route busy-time questions to a read-only side agent"
```

---

### Task 2: Answers, hand-back suppression, transcript record, main context

**Files:**
- Modify: `hooks/register.js`
- Modify: `tests/ask.test.ts`

**Interfaces:**
- Consumes: `entries`, `startSide` from Task 1.
- Produces: module-level `unseen` array (entries answered but not yet given to main); `turn.complete` hook fills `entry.status` / `entry.answer`.

- [ ] **Step 1: Write failing tests** (append to `tests/ask.test.ts`)

```typescript
async function askOne($: any, clock: any) {
  await $.prompt.submit({ text: 'where is foo?', origin: { kind: 'composer' }, wait: false, turnId: 't1' })
  await clock.advance(500)
}

test('side answer is logged and its hand-back is dropped from main', async ($, on) => {
  const clock = mock.clock(on)
  const logs: string[] = []
  on('model.complete', label('question'))
  stubCommon(on)
  on('ui.log', ($: any, e: any) => { logs.push(e.text); return { value: undefined } })
  on('turn.complete', () => ({ text: '' }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: 'foo is in src/foo.ts', durationMs: 1, isAborted: false, usage: null })
  expect(logs.join('\n')).toContain('foo is in src/foo.ts')
  const back = await $.prompt.submit({ text: '<agent-message from="ag1">\n  foo is in src/foo.ts\n</agent-message>', origin: { kind: 'peer' }, wait: false, isMeta: true })
  expect(back.drop).toBeDefined()
})

test('another agent hand-back passes through', async ($, on) => {
  stubCommon(on)
  const r = await $.prompt.submit({ text: '<agent-message from="zzz">hi</agent-message>', origin: { kind: 'peer' }, wait: false, isMeta: true })
  expect(r.text).toContain('zzz')
})

test('next idle main prompt carries the side Q&A once', async ($, on) => {
  const clock = mock.clock(on)
  on('model.complete', label('question'))
  stubCommon(on)
  on('turn.complete', () => ({ text: '' }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: 'foo is in src/foo.ts', durationMs: 1, isAborted: false, usage: null })
  const first = await $.prompt.submit({ text: 'continue', origin: { kind: 'composer' }, wait: false })
  expect((first.context ?? []).join('\n')).toContain('foo is in src/foo.ts')
  const second = await $.prompt.submit({ text: 'and then?', origin: { kind: 'composer' }, wait: false })
  expect(second.context ?? []).toHaveLength(0)
})
```

- [ ] **Step 2: Run, expect the 3 new tests to fail**

Run: `claude plugin test`

- [ ] **Step 3: Implement** — in `hooks/register.js`

Add below `let seq = 0`:
```javascript
// answered side Q&A main has not seen yet
const unseen = []
```

Replace the `prompt.submit` hook's first line with:
```javascript
    if (e.isMeta) {
      // our side agent's hand-back would wake main; keep it out
      const ours = entries.some((x) => x.agentId && e.text.includes('from="' + x.agentId + '"'))
      return ours ? { drop: 'ask: 옆 답변 도착 (/asks)' } : next(e)
    }
    if (!e.turnId) {
      if (e.command || e.origin.kind !== 'composer' || unseen.length === 0) return next(e)
      const notes = unseen.splice(0).map((x) => 'Q: ' + x.question + '\nA: ' + x.answer).join('\n\n')
      const ctx = 'While you were working, the user asked side questions that a read-only helper answered:\n\n' + notes
      return next({ ...e, context: [...(e.context ?? []), ctx] })
    }
    if (e.command || e.origin.kind !== 'composer') return next(e)
```

Add a hook inside `register`:
```javascript
  on('turn.complete', async ($, e, next) => {
    const entry = e.agentId ? entries.find((x) => x.agentId === e.agentId) : undefined
    if (entry) {
      entry.status = e.isAborted ? 'failed' : 'done'
      entry.answer = e.answer || (e.isAborted ? '중단됨' : '')
      if (entry.status === 'done') unseen.push(entry)
      $.ui.log('Q: ' + entry.question + '\nA: ' + entry.answer)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })
```

- [ ] **Step 4: Run tests + validate** — `claude plugin test && claude plugin validate .` → all pass.

- [ ] **Step 5: Commit**

```bash
git add hooks/register.js tests/ask.test.ts
git commit -m "feat: record side answers and keep hand-backs out of main"
```

---

### Task 3: Pane, /asks, send-to-main button

**Files:**
- Modify: `hooks/register.js`, `tests/ask.test.ts`

**Interfaces:**
- Consumes: `entries`, `PANE`.
- Produces: top-level `sendToMain($, entry)`; pane `requestId === 'asks'`; button keys `send-<id>`.

- [ ] **Step 1: Write failing tests** (append)

```typescript
const PANE_EVENT = {
  plugin: 'ask', component: 'Pane', requestId: 'asks', surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: { title: 'ask', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('pane lists question, answer and a send button for failed entries', async ($, on) => {
  const clock = mock.clock(on)
  const submitted: string[] = []
  on('model.complete', label('question'))
  stubCommon(on, [], submitted)
  on('turn.complete', () => ({ text: '' }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: '', durationMs: 1, isAborted: true, usage: null })
  const ui = await $.ui.mount(PANE_EVENT)
  expect(await ui.find({ type: 'Text', text: /where is foo\?/ })).toBeDefined()
  await ui.press({ key: 'send-1' })
  expect(submitted).toContain('where is foo?')
})
```

> Note: `$.prompt.submit` from the mod reaches the test's `prompt.submit` stub only after the mod's own `prompt.submit` hook passes it on (origin is the plugin, no `turnId`, so it passes). If the kit routes it differently, assert on a `prompt.submit` stub registered with `{ plugin: 'ask' }` per the types file.

- [ ] **Step 2: Run, expect failure** — `claude plugin test`

- [ ] **Step 3: Implement** — in `hooks/register.js`

Top-level function:
```javascript
function sendToMain($, entry) {
  entry.sent = true
  // waits until main is idle, then runs as the user's own prompt; not awaited on purpose
  $.prompt.submit({ text: entry.question, asUser: true })
  $.ui.invalidate('ui.render')
}
```

In `session.start`, after the agent registration `try` block:
```javascript
    try {
      await $.command.register({ name: 'asks', description: 'Show side-question answers', immediate: true })
    } catch {}
```

In `prompt.submit`, right before `return { drop: 'ask: 옆 질문으로 보냄' }`:
```javascript
    $.ui.open({ id: PANE, title: 'ask' }).catch(() => {})
```

New hooks inside `register`:
```javascript
  on('command.run', { command: 'asks' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'ask', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const mark = { running: '⏳', done: '✓', failed: '✗' }
    const rows = []
    for (const x of entries.slice().reverse()) {
      rows.push(Text({ bold: true, wrap: 'wrap', children: [mark[x.status] + ' ' + x.question] }))
      if (x.answer) rows.push(Text({ wrap: 'wrap', dimColor: x.status === 'failed', children: [x.answer] }))
      const needsMain = x.status === 'failed' || x.answer.startsWith('메인에 보낼 일')
      if (needsMain && !x.sent) {
        rows.push(Button({ key: 'send-' + x.id, label: '메인에 보내기', onPress: () => sendToMain($, x) }))
      }
      rows.push(Text({ children: [' '] }))
    }
    return Box({ flexDirection: 'column', children: rows })
  })
```

- [ ] **Step 4: Run tests + validate** → all pass. If validation rejects `sendToMain($, x)` inside `onPress`, inline its body into the arrow (`$.prompt.submit(...)` written in full).

- [ ] **Step 5: Commit**

```bash
git add hooks/register.js tests/ask.test.ts
git commit -m "feat: side-question pane with send-to-main"
```

---

### Task 4: Live check + README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Live run via cmux-cua** — launch Terminal with `claude --plugin-dir .` from a scratch `.command` script. Give main `Run this in the foreground with Bash: python3 -c "import time; time.sleep(45)" and then reply with just DONE.` While it runs, send:
  1. `이 저장소에 뭐 있어?` → expect: input clears, `Prompt dropped by a hook: ask: 옆 질문으로 보냄`, pane opens, answer appears, yellow `ask: 옆 답변 도착 (/asks)` line, main still ends with just `DONE`.
  2. `README.md 파일 만들어줘` → expect: passes to main queue (main acts on it after the sleep).
  3. After main is idle, type `방금 옆에서 뭐 물어봤지?` → expect main answers from the attached context.
  Record anything that differs and fix before continuing.

- [ ] **Step 2: README.md**

```markdown
# ask

A Claude Code mod. While Claude is working, type as usual:

- **Questions** go to a read-only side agent. The answer shows up in the `ask` pane (`/asks`) and in the transcript, and main Claude gets it as context on your next prompt.
- **Change requests** go to the main queue as they always do.

Classification uses Haiku. Any failure falls back to the normal behavior (the input goes to main).

## Run

    claude --plugin-dir /path/to/ask

Tested with Claude Code 2.1.325.

## Test

    claude plugin test
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```
