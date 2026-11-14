import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const label = (text: string) => () => ({ value: { isAnswered: true, text, usage: USAGE } })

function stubCommon(on: any, spawned: any[] = [], submitted: string[] = [], fills: any[] = [], logs: string[] = [], dropResubmit = false) {
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return dropResubmit && !e.turnId ? { drop: 'removed' } : { text: e.text, context: e.context } })
  on('prompt.fill', (_$: any, e: any) => { fills.push(e); return { isFilled: true } })
  on('session.messages', () => ({ value: [{ role: 'user', text: 'fix the parser', toolUses: [] }] }))
  on('agent.spawn', ($: any, e: any) => { spawned.push(e); return { model: 'test', result: { status: 'async_launched', agentId: 'ag' + spawned.length, description: 'd', prompt: 'p', outputFile: '/tmp/o' } } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
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
  stubCommon(on, spawned)
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
  stubCommon(on, [], [], fills)
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

test('side answer is logged and its hand-back is dropped from main', async ($, on) => {
  const clock = mock.clock(on)
  const logs: string[] = []
  on('model.complete', label('question'))
  stubCommon(on, [], [], [], logs)
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
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: '', durationMs: 1, isAborted: true, reason: 'answer' })
  const ui = await $.ui.mount(PANE_EVENT)
  expect(await ui.find({ type: 'Text', text: /where is foo\?/ })).toBeDefined()
  await ui.press({ key: 'send-1' })
  expect(submitted).toContain('where is foo?')
  expect(await ui.find({ key: 'send-1' })).toBeUndefined()
})

test('button comes back when the submit is dropped', async ($, on) => {
  const clock = mock.clock(on)
  on('model.complete', label('question'))
  stubCommon(on, [], [], [], [], true)
  on('turn.complete', () => ({ text: '' }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: '', durationMs: 1, isAborted: true, reason: 'answer' })
  const ui = await $.ui.mount(PANE_EVENT)
  await ui.press({ key: 'send-1' })
  await clock.advance(10)
  expect(await ui.find({ key: 'send-1' })).toBeDefined()
})

test('busy input with an attachment passes through even if it looks like a question', async ($, on) => {
  mock.clock(on)
  const spawned: any[] = []
  on('model.complete', label('question'))
  stubCommon(on, spawned)
  const r = await $.prompt.submit({ text: 'what is this?', origin: { kind: 'composer' }, wait: false, turnId: 't1', attachments: [{ id: 'a1' }] } as any)
  expect(r.text).toBe('what is this?')
  expect(spawned).toHaveLength(0)
})

test('explicitly queued prompt passes through', async ($, on) => {
  mock.clock(on)
  const spawned: any[] = []
  on('model.complete', label('question'))
  stubCommon(on, spawned)
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
  const ui = await $.ui.mount(PANE_EVENT)
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
  const ui = await $.ui.mount(PANE_EVENT)
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

test('pane draws the answer as Markdown', async ($, on) => {
  const clock = mock.clock(on)
  on('model.complete', label('question'))
  stubCommon(on)
  on('turn.complete', () => ({ text: '' }))
  await askOne($, clock)
  await $.turn.complete({ turnId: 's1', agentId: 'ag1', answer: 'see **src/foo.ts**', durationMs: 1, isAborted: false, reason: 'answer' })
  const ui = await $.ui.mount(PANE_EVENT)
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
})

test('session.start registers the read-only side agent', async ($, on) => {
  const regs: any[] = []
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('agent.register', (_$: any, e: any) => { regs.push(e); return { value: { isRegistered: true } } })
  on('command.register', () => ({ value: { isRegistered: true } }))
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true } as any)
  expect(regs).toHaveLength(1)
  expect(regs[0].tools).toEqual(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'])
})

test('main model is never offered the side agent', async ($) => {
  const r = await $.agent.offer({ agent: 'ask:side' } as any)
  expect(r.isOffered).toBe(false)
})
