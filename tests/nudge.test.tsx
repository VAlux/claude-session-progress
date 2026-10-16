import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PROGRESS_TOOL } from '../hooks/report'

function engineBottom(on: On) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__session-progress__${e.name}` } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.blit', () => ({ value: {} }))
  on('tool.call', () => ({ result: 'engine' }) as never)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const } as never
  })
  mock.clock(on, { now: 1_000_000 })
}

type Ran = { result?: unknown; context?: readonly string[] }
const bash = async ($: Engine, command = 'ls') => (await $.tool.call({ tool: 'Bash', command })) as Ran
const report = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: PROGRESS_TOOL, ...input } as never)
/** `n` model rounds of the main loop, each with one Bash call; the reminders each call came back with. */
async function rounds($: Engine, n: number, from = 0): Promise<(readonly string[] | undefined)[]> {
  const out: (readonly string[] | undefined)[] = []
  for (let i = from; i < from + n; i++) {
    for await (const _ of $.turn.step({ turnId: 't1', index: i, model: 'claude-opus-5-5', messageCount: 1 } as never)) {
      // drain
    }
    out.push((await bash($, `round ${i}`)).context)
  }
  return out
}
/** The reminders each of `n` Bash calls came back with. */
async function contexts($: Engine, n: number): Promise<(readonly string[] | undefined)[]> {
  const out: (readonly string[] | undefined)[] = []
  for (let i = 0; i < n; i++) out.push((await bash($, `cmd ${i}`)).context)
  return out
}

test('the fifth call of a turn with nothing to count down carries one reminder to report, and only that call does', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  const seen = await contexts($, 7)
  expect(seen.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined])
  expect(seen[4]?.length).toBe(1)
  expect(seen[4]?.[0]).toContain(PROGRESS_TOOL)
  expect(seen.slice(5), 'once a turn').toEqual([undefined, undefined])
})

test('the reminder leaves the tool result as the engine gave it', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await contexts($, 4)
  expect((await bash($)).result).toBe('engine')
})

test('a turn that reported is not reminded', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await report($, { left: [{ do: 'look around', size: 's' }] })
  expect((await contexts($, 7)).every(c => c === undefined)).toBe(true)
})

test('a turn with a task list is not reminded', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'a', status: 'in_progress', activeForm: 'Doing a' }, { content: 'b', status: 'pending', activeForm: 'Doing b' }] } as never)
  expect((await contexts($, 7)).every(c => c === undefined)).toBe(true)
})

test('each turn can be reminded once', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await contexts($, 5)
  await $.turn.complete({ turnId: 't1', durationMs: 30_000, answer: 'ok', isAborted: false, reason: 'answer' } as never)
  await $.turn.start({ text: 'more', turnId: 't2' })
  expect((await contexts($, 5))[4]?.length).toBe(1)
})

test("a subagent's calls neither count toward the reminder nor carry it", async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  const sub: Ran[] = []
  for (let i = 0; i < 7; i++) sub.push((await $.tool.call({ tool: 'Bash', command: `sub ${i}`, agentId: 'a1' } as never)) as Ran)
  expect(sub.every(r => r.context === undefined)).toBe(true)
  expect((await contexts($, 4)).every(c => c === undefined)).toBe(true)
})

test('a report left unchanged for 8 rounds with items still listed brings one reminder naming the item in progress', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await report($, { left: [{ do: 'Repair poetry', size: 'm' }, { do: 'Write the probe', size: 'l' }, { do: 'Docs', size: 's' }] })
  const seen = await rounds($, 12)
  expect(seen.slice(0, 7).every(c => c === undefined)).toBe(true)
  expect(seen[7]?.length).toBe(1)
  expect(seen[7]?.[0]).toContain('"Repair poetry"')
  expect(seen[7]?.[0]).toContain('{done: 1}')
  expect(seen.slice(8).every(c => c === undefined), 'once a report').toBe(true)
})

test('each new report starts the count again, and can be reminded once more', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await report($, { left: [{ do: 'a', size: 'm' }, { do: 'b', size: 'm' }, { do: 'c', size: 'm' }] })
  expect((await rounds($, 8))[7]?.length).toBe(1)
  await report($, { done: 1 })
  const seen = await rounds($, 8, 8)
  expect(seen.slice(0, 7).every(c => c === undefined)).toBe(true)
  expect(seen[7]?.[0]).toContain('"b"')
})

test('a report kept current is never reminded', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await report($, { left: [{ do: 'a', size: 's' }, { do: 'b', size: 's' }, { do: 'c', size: 's' }, { do: 'd', size: 's' }] })
  const seen = [...(await rounds($, 5)), ...(await report($, { done: 1 }), await rounds($, 5, 5)), ...(await report($, { done: 1 }), await rounds($, 5, 10))]
  expect(seen.every(c => c === undefined)).toBe(true)
})

test('a report with nothing left is not reminded', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await report($, { left: [{ do: 'a', size: 's' }] })
  await report($, { done: 1 })
  expect((await rounds($, 12)).every(c => c === undefined)).toBe(true)
})

test('eta: off never reminds', { options: { eta: 'off' } }, async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  expect((await contexts($, 7)).every(c => c === undefined)).toBe(true)
})
