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
  mock.clock(on, { now: 1_000_000 })
}

type Ran = { result?: unknown; context?: readonly string[] }
const bash = async ($: Engine, command = 'ls') => (await $.tool.call({ tool: 'Bash', command })) as Ran
const report = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: PROGRESS_TOOL, ...input } as never)
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

test('eta: off never reminds', { options: { eta: 'off' } }, async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  expect((await contexts($, 7)).every(c => c === undefined)).toBe(true)
})
