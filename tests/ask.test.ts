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
