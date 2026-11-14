import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const label = (text: string) => () => ({ value: { isAnswered: true, text, usage: USAGE } })

// what each side agent has read so far, as $.session.messages({ agentId }) reports it
const agentReads: Record<string, string[]> = {}
const agentMessages = (id: string) => [{ role: 'assistant', text: '', toolUses: (agentReads[id] ?? []).map((f, i) => ({ tool_use_id: 'u' + i, tool: 'Read', input: { file_path: f } })) }]

type Stubs = { spawned?: any[], submitted?: string[], fills?: any[], logs?: string[], dropResubmit?: boolean, placeOk?: boolean }

function stubCommon(on: any, { spawned = [], submitted = [], fills = [], logs = [], dropResubmit = false, placeOk = true }: Stubs = {}) {
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return dropResubmit && !e.turnId ? { drop: 'removed' } : { text: e.text, context: e.context } })
  on('prompt.fill', (_$: any, e: any) => { fills.push(e); return { isFilled: true } })
  on('session.messages', (_$: any, e: any) => ({ value: e.agentId ? agentMessages(e.agentId) : [{ role: 'user', text: 'fix the parser', toolUses: [] }] }))
  on('agent.spawn', ($: any, e: any) => { spawned.push(e); return { model: 'test', result: { status: 'async_launched', agentId: 'ag' + spawned.length, description: 'd', prompt: 'p', outputFile: '/tmp/o' } } })
  on('ui.place', (_$: any, e: any) => ({ value: placeOk ? ((placedId = e.id), { isPlaced: true, requestId: 'r1' }) : { isPlaced: false, reason: 'no surface' } }))
  on('ui.log', (_$: any, e: any) => { logs.push(e.text); return { value: undefined } })
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
  stubCommon(on, { spawned })
  const r = await $.prompt.submit({ text: 'where is foo?', origin: { kind: 'composer' }, wait: false, turnId: 't1' })
  expect(r.drop).toBeDefined()
  await clock.advance(500)
  expect(spawned).toHaveLength(1)
  expect(spawned[0].subagent_type).toBe('ask:side')
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

async function dropThenBox(on: any, $: any, boxText: string) {
  const clock = mock.clock(on)
  const fills: any[] = []
  on('model.complete', label('question'))
  stubCommon(on, { fills })
  on('prompt.read', () => ({ value: { text: boxText, cursor: 0 } }))
  await $.prompt.submit({ text: 'where is foo?', origin: { kind: 'composer' }, wait: false, turnId: 't1' })
  await clock.advance(500)
  return fills
}

test('box still holding the dropped question is cleared', async ($, on) => {
  const fills = await dropThenBox(on, $, 'where is foo?')
  expect(fills).toHaveLength(1)
  expect(fills[0].text).toBe('')
})

test('text the user typed meanwhile is left alone', async ($, on) => {
  const fills = await dropThenBox(on, $, 'where is foo? and bar')
  expect(fills).toHaveLength(0)
})

async function askOne($: any, clock: any) {
  await $.prompt.submit({ text: 'where is foo?', origin: { kind: 'composer' }, wait: false, turnId: 't1' })
  await clock.advance(500)
}

test('with no row placed the answer is logged, and its hand-back is dropped from main', async ($, on) => {
  const clock = mock.clock(on)
  const logs: string[] = []
  on('model.complete', label('question'))
  stubCommon(on, { logs, placeOk: false })
  on('turn.complete', () => ({ text: '' }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: 'foo is in src/foo.ts', durationMs: 1, isAborted: false, reason: 'answer' })
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
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: 'foo is in src/foo.ts', durationMs: 1, isAborted: false, reason: 'answer' })
  const first = await $.prompt.submit({ text: 'continue', origin: { kind: 'composer' }, wait: false })
  expect((first.context ?? []).join('\n')).toContain('foo is in src/foo.ts')
  const second = await $.prompt.submit({ text: 'and then?', origin: { kind: 'composer' }, wait: false })
  expect(second.context ?? []).toHaveLength(0)
})

const ROW_EVENT = {
  plugin: 'ask', component: 'Placed', requestId: 'r1', surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: { id: 'q-1', plugin: 'ask', onScreen: true },
}
let placedId = 'q-1'
const rowEvent = () => ({ ...ROW_EVENT, props: { ...ROW_EVENT.props, id: placedId } })

test('row shows the question and a send button for a failed entry', async ($, on) => {
  const clock = mock.clock(on)
  const submitted: string[] = []
  on('model.complete', label('question'))
  stubCommon(on, { submitted })
  on('turn.complete', () => ({ text: '' }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: '', durationMs: 1, isAborted: true, reason: 'answer' })
  const ui = await $.ui.mount(rowEvent())
  expect(await ui.find({ type: 'Text', text: /where is foo\?/ })).toBeDefined()
  await ui.press({ key: 'send-1' })
  expect(submitted).toContain('where is foo?')
  expect(await ui.find({ key: 'send-1' })).toBeUndefined()
})

test('button comes back when the submit is dropped', async ($, on) => {
  const clock = mock.clock(on)
  on('model.complete', label('question'))
  stubCommon(on, { dropResubmit: true })
  on('turn.complete', () => ({ text: '' }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: '', durationMs: 1, isAborted: true, reason: 'answer' })
  const ui = await $.ui.mount(rowEvent())
  await ui.press({ key: 'send-1' })
  await clock.advance(10)
  expect(await ui.find({ key: 'send-1' })).toBeDefined()
})

test('busy input with an attachment passes through even if it looks like a question', async ($, on) => {
  mock.clock(on)
  const spawned: any[] = []
  on('model.complete', label('question'))
  stubCommon(on, { spawned })
  const r = await $.prompt.submit({ text: 'what is this?', origin: { kind: 'composer' }, wait: false, turnId: 't1', attachments: [{ id: 'a1' }] } as any)
  expect(r.text).toBe('what is this?')
  expect(spawned).toHaveLength(0)
})

test('explicitly queued prompt passes through', async ($, on) => {
  mock.clock(on)
  const spawned: any[] = []
  on('model.complete', label('question'))
  stubCommon(on, { spawned })
  const r = await $.prompt.submit({ text: 'where is foo?', origin: { kind: 'composer' }, wait: true, turnId: 't1' })
  expect(r.text).toBe('where is foo?')
  expect(spawned).toHaveLength(0)
})

test('errored side answer is failed, has a button and is not attached to main', async ($, on) => {
  const clock = mock.clock(on)
  on('model.complete', label('question'))
  stubCommon(on)
  on('turn.complete', () => ({ text: '' }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: '', durationMs: 1, isAborted: false, reason: 'error' })
  const ui = await $.ui.mount(rowEvent())
  expect(await ui.find({ key: 'send-1' })).toBeDefined()
  const next = await $.prompt.submit({ text: 'continue', origin: { kind: 'composer' }, wait: false })
  expect(next.context ?? []).toHaveLength(0)
})

test('markdown-bold "메인에 보낼 일" answer shows the send button', async ($, on) => {
  const clock = mock.clock(on)
  on('model.complete', label('question'))
  stubCommon(on)
  on('turn.complete', () => ({ text: '' }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: '**메인에 보낼 일:** rename foo', durationMs: 1, isAborted: false, reason: 'answer' })
  const ui = await $.ui.mount(rowEvent())
  expect(await ui.find({ key: 'send-1' })).toBeDefined()
})

test('/clear drops unseen side Q&A', async ($, on) => {
  const clock = mock.clock(on)
  on('model.complete', label('question'))
  stubCommon(on)
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: 'foo is in src/foo.ts', durationMs: 1, isAborted: false, reason: 'answer' })
  await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as any)
  const r = await $.prompt.submit({ text: 'continue', origin: { kind: 'composer' }, wait: false })
  expect(r.context ?? []).toHaveLength(0)
})

test('row draws the answer as Markdown', async ($, on) => {
  const clock = mock.clock(on)
  on('model.complete', label('question'))
  stubCommon(on)
  on('turn.complete', () => ({ text: '' }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: 'see **src/foo.ts**', durationMs: 1, isAborted: false, reason: 'answer' })
  const ui = await $.ui.mount(rowEvent())
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
})

test('session.start registers the read-only side agent', async ($, on) => {
  const regs: any[] = []
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('agent.register', (_$: any, e: any) => { regs.push(e); return { value: { isRegistered: true } } })
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true } as any)
  expect(regs).toHaveLength(1)
  expect(regs[0].tools).toEqual(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'])
})

test('main model is never offered the side agent', async ($) => {
  const r = await $.agent.offer({ agent: 'ask:side' } as any)
  expect(r.isOffered).toBe(false)
})

test('row shows the side agent tool steps like Claude does, last three only', async ($, on) => {
  const clock = mock.clock(on)
  on('model.complete', label('question'))
  stubCommon(on)
  await askOne($, clock)
  agentReads.ag1 = ['a.ts', 'b.ts', 'c.ts', 'README.md']
  await clock.advance(1000)
  agentReads.ag1 = []
  const ui = await $.ui.mount(rowEvent())
  expect(await ui.find({ type: 'Text', text: /⎿  Read README\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⎿  … \+1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /a\.ts/ })).toBeUndefined()
})

test('a placed answer is not logged again', async ($, on) => {
  const clock = mock.clock(on)
  const logs: string[] = []
  on('model.complete', label('question'))
  stubCommon(on, { logs })
  on('turn.complete', () => ({ text: '' }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: 'foo is in src/foo.ts', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(logs).toHaveLength(0)
})

test('an answer that only mentions "메인에 보낼 일" mid-text gets no button', async ($, on) => {
  const clock = mock.clock(on)
  on('model.complete', label('question'))
  stubCommon(on)
  on('turn.complete', () => ({ text: '' }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: 'The mod shows a button when the answer says "메인에 보낼 일".', durationMs: 1, isAborted: false, reason: 'answer' })
  const ui = await $.ui.mount(rowEvent())
  expect(await ui.find({ key: 'send-1' })).toBeUndefined()
})
