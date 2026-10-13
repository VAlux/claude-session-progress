import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'session-progress'

function engineBottom(on: On) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.blit', () => ({ value: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine-band</Text>
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Agent') return { result: { agentId: 'a1', agentType: 'general-purpose' } } as never
    return { result: e.tool === 'TodoWrite' ? { oldTodos: [], newTodos: e.todos } : 'ok' } as never
  })
}

/** The bar's cells read back as text: its track glyphs and its label. */
function rasterText(cells: string): string {
  const bytes = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  let text = ''
  for (let i = 0; i < words.length; i += 3) text += String.fromCodePoint(words[i] ?? 0x20)
  return text
}

/** Whether the band shows `text`, with the main conversation in view or one agent's transcript. */
async function shows($: Engine, text: RegExp, view: { agentId?: string } = {}, isWorking = false) {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view },
  })
  const found = await ui.find({ text })
  const bars = await ui.findAll({ type: 'Raster' })
  await ui.unmount()
  return found !== undefined || bars.some(bar => text.test(rasterText(String(bar.props.cells))))
}

/** A tool call made in a subagent's loop: the kit's typed input leaves out the `agentId` a session's carries. */
function inAgent($: Engine, agentId: string, input: Record<string, unknown>) {
  return $.tool.call({ ...input, agentId } as never)
}

const done = (turnId: string, durationMs: number, agentId?: string) => ({
  turnId,
  durationMs,
  answer: 'ok',
  isAborted: false,
  reason: 'answer' as const,
  ...(agentId === undefined ? {} : { agentId }),
})

/** A long main turn that hands its work to one background subagent and ends. */
async function handOff($: Engine, clock: { advance: (ms: number) => Promise<void> }) {
  await $.turn.start({ text: 'review the branch', turnId: 't1' })
  for (const command of ['git status', 'git log', 'git diff']) await $.tool.call({ tool: 'Bash', command })
  await $.tool.call({ tool: 'Agent', description: 'Review the branch', prompt: 'Review it.', subagent_type: 'general-purpose' })
  await clock.advance(50_000)
  await $.turn.complete(done('t1', 50_000))
  await clock.advance(2_000)
}

const subagentPlan = [
  { content: 'Read the diff', status: 'completed' as const, activeForm: 'Reading the diff' },
  { content: 'Check the tests', status: 'in_progress' as const, activeForm: 'Checking the tests' },
  { content: 'Check the docs', status: 'pending' as const, activeForm: 'Checking the docs' },
  { content: 'Write the verdict', status: 'pending' as const, activeForm: 'Writing the verdict' },
]

test('a main turn that hands off to a background subagent does not claim the task complete', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await handOff($, clock)
  expect(await shows($, /Task complete/)).toBe(false)
  expect(await shows($, /100%/)).toBe(false)
  expect(await shows($, /Waiting for 1 subagent/)).toBe(true)
})

// The share done is the bar without the countdown; with it, the bar follows the estimate (tests/eta-band.test.tsx).
test("viewing a subagent's transcript shows that subagent's progress, not the main one's", { options: { eta: 'off' } }, async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await handOff($, clock)
  await inAgent($, 'a1', { tool: 'TodoWrite', todos: subagentPlan })
  await inAgent($, 'a1', { tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(5_000)

  const a1 = { agentId: 'a1' }
  expect(await shows($, /Review the branch/, a1)).toBe(true)
  expect(await shows($, /Checking the tests/, a1)).toBe(true)
  expect(await shows($, /1\/4 tasks/, a1)).toBe(true)
  expect(await shows($, /38%/, a1)).toBe(true)
  expect(await shows($, /2 tool calls/, a1)).toBe(true)
  expect(await shows($, /1 file \+1 −1/, a1)).toBe(true)
  expect(await shows($, /Waiting for/, a1), "the main turn's summary stays with the main view").toBe(false)
  expect(await shows($, /Check the docs/, a1), "a subagent's list is drawn nowhere else, so its band lists it").toBe(true)

  expect(await shows($, /Waiting for 1 subagent/), 'switching back shows the main view again').toBe(true)
  expect(await shows($, /Checking the tests/), "the subagent's list never replaces the main one").toBe(false)
})

test("a finished subagent's view shows it complete, and the main view stops waiting", async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await handOff($, clock)
  await inAgent($, 'a1', { tool: 'TodoWrite', todos: subagentPlan })
  await clock.advance(30_000)
  await $.turn.complete(done('a1-turn', 32_000, 'a1'))
  await clock.advance(1_000)

  expect(await shows($, /Subagent complete/, { agentId: 'a1' })).toBe(true)
  expect(await shows($, /100%/, { agentId: 'a1' })).toBe(true)
  expect(await shows($, /32s/, { agentId: 'a1' })).toBe(true)
  expect(await shows($, /Waiting for/)).toBe(false)
})

test('a subagent the band never saw shows none of the main band', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await handOff($, clock)
  expect(await shows($, /tool call|Waiting for|Task complete/, { agentId: 'unknown' })).toBe(false)
})

test("a subagent's indeterminate bar carries no clock of its own", async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await handOff($, clock)
  await inAgent($, 'a1', { tool: 'Bash', command: 'git diff' })
  await clock.advance(5_000)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: { agentId: 'a1' } },
  })
  const clocks = await ui.findAll({ type: 'Text', text: /\d+s/ })
  const bar = await ui.find({ key: 'agent-bar', type: 'Raster' })
  await ui.unmount()
  expect(clocks.length, 'the head row shows the clock').toBeGreaterThan(0)
  expect(rasterText(String(bar?.props.cells)), 'the bar does not repeat it').not.toMatch(/\d+s/)
})
