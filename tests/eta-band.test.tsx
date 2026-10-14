import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PROGRESS_TOOL } from '../hooks/report'

const PLUGIN = 'session-progress'

type Clock = { advance: (ms: number) => Promise<void> }

/** The engine beneath the mod. A `slow …` Bash call answers only when the test releases it, so it takes the clock time the test gives it. */
function engineBottom(on: On) {
  const held: (() => void)[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__${PLUGIN}__${e.name}` } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.blit', () => ({ value: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine-band</Text>
  })
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use' as const,
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
    } as never
  })
  on('tool.call', async ($, e) => {
    if (e.tool === 'Bash' && typeof e.command === 'string' && e.command.startsWith('slow')) await new Promise<void>(resolve => held.push(resolve))
    if (e.tool === 'Bash' && typeof e.command === 'string' && e.command.includes('refused')) return { deny: 'refused' } as never
    if (e.tool === 'Agent') return { result: { agentId: 'a1', agentType: 'general-purpose' } } as never
    if (e.tool === 'Bash' && typeof e.command === 'string' && e.command.startsWith('task-done')) {
      return { result: { stdout: 'ledger: Task 1: complete (commits a..b, tests: x → ok)', stderr: '', interrupted: false } } as never
    }
    return { result: e.tool === 'TodoWrite' ? { oldTodos: [], newTodos: e.todos } : 'ok' } as never
  })
  return { release: () => held.splice(0).forEach(resolve => resolve()) }
}

/** One model round: of the main loop's turn, or of a subagent's loop. */
async function round($: Engine, index: number, loop: { turnId?: string; agentId?: string } = {}) {
  const turnId = loop.turnId ?? loop.agentId ?? 't1'
  const args = { turnId, index, model: 'claude-opus-5-5', messageCount: 1, ...(loop.agentId === undefined ? {} : { agentId: loop.agentId }) }
  const s = $.turn.step(args as Parameters<Engine['turn']['step']>[0])
  for await (const _ of s) {
    // drain
  }
}

/** A turn with two rounds 10 s apart, so its pace is 10 s; the clock stands 10 s into the turn. */
async function pacedTurn($: Engine, on: On) {
  const { release } = engineBottom(on)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await round($, 0)
  await clock.advance(10_000)
  await round($, 1)
  return { clock, release }
}

/** Another turn on the same clock, its rounds 10 s apart too. */
async function pacedNext($: Engine, clock: Clock, turnId: string) {
  await $.turn.start({ text: 'go on', turnId })
  await round($, 0, { turnId })
  await clock.advance(10_000)
  await round($, 1, { turnId })
}

/** A Bash call that runs `ms` of the clock. */
async function slowBash($: Engine, clock: Clock, release: () => void, command: string, ms: number, isBackground = false) {
  const ran = $.tool.call({ tool: 'Bash', command, ...(isBackground ? { run_in_background: true } : {}) } as never)
  await clock.advance(0) // let the mod note the call's start before the clock moves
  await clock.advance(ms)
  release()
  await ran
}

/** A call of the mod's own tool, in the main loop or a subagent's. */
const report = async ($: Engine, input: Record<string, unknown>, agentId?: string) =>
  (await $.tool.call({ tool: PROGRESS_TOOL, ...input, ...(agentId === undefined ? {} : { agentId }) } as never)) as { result?: unknown }
const restart = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const done = (turnId: string, durationMs: number) => ({ turnId, durationMs, answer: 'ok', isAborted: false, reason: 'answer' as const })
const aborted = (turnId: string, durationMs: number) => ({ turnId, durationMs, answer: '', isAborted: true, reason: 'aborted' as const })
const MS = { m: { do: 'fix the parser', size: 'm' }, s: { do: 'update the tests', size: 's' }, l: { do: 'rework the cache', size: 'l' } }
const todos = [
  { content: 'Write types', status: 'completed' as const, activeForm: 'Writing types' },
  { content: 'Write tests', status: 'in_progress' as const, activeForm: 'Writing tests' },
  { content: 'Validate', status: 'pending' as const, activeForm: 'Validating' },
]

/** The bar's cells read back as text: its track glyphs and its label. */
function rasterText(cells: string): string {
  const bytes = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  let text = ''
  for (let i = 0; i < words.length; i += 3) text += String.fromCodePoint(words[i] ?? 0x20)
  return text
}

type Surface = 'terminal' | 'desktop'

const mountBand = ($: Engine, surface: Surface, isWorking: boolean, columns: number, view: { agentId?: string }) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 30, bodyColumns: columns, scroll: { offset: 0, bodyRows: 30 }, view },
  })

/** Everything a band shows: its elements' text, the terminal's bars read back, the desktop's bar described; and the colours of a `↑`. */
async function seen($: Engine, surface: Surface, isWorking = true, columns = 80, view: { agentId?: string } = {}) {
  const ui = await mountBand($, surface, isWorking, columns, view)
  const texts = (await ui.findAll({})).map(el => el.text)
  const bars = (await ui.findAll({ type: 'Raster' })).map(bar => rasterText(String(bar.props.cells)))
  const svgs = (await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt))
  const colors = (await ui.findAll({ type: 'Text', text: /↑/ })).map(el => String(el.props.color))
  await ui.unmount()
  return { all: [...texts, ...bars, ...svgs], bars, colors }
}
const has = (shown: { all: string[] }, re: RegExp) => shown.all.some(t => re.test(t))

/** The desktop bar's filled width, out of 1000; -1 for a bar with nothing to measure. */
async function fillWidth($: Engine) {
  const ui = await mountBand($, 'desktop', true, 80, {})
  const bar = (await ui.findAll({ type: 'Svg' })).find(svg => /^Progress/.test(String(svg.props.alt)))
  await ui.unmount()
  return Number(/<rect width="(\d+)" height="6" rx="3" fill="url\(#f\)"/.exec(String(bar?.props.source))?.[1] ?? -1)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a report puts the countdown on the bar, at this turn's pace`, async ($, on) => {
    const { clock } = await pacedTurn($, on)
    await report($, { left: [MS.m, MS.s] })
    await clock.advance(1_000)
    expect(has(await seen($, surface), /~1m 20s left/)).toBe(true)
  })

  test(`${surface}: a countdown that grows turns amber with ↑ for 5 s`, async ($, on) => {
    const { clock } = await pacedTurn($, on)
    await report($, { left: [MS.s, MS.s] })
    await clock.advance(1_000)
    await report($, { left: [MS.s, MS.s, MS.l] })
    const grown = await seen($, surface)
    expect(has(grown, /~3m left \(2–4m\) ↑/)).toBe(true)
    if (surface === 'desktop') expect(grown.colors).toContain('#d8a64a')
    await clock.advance(6_000)
    const later = await seen($, surface)
    expect(has(later, /~3m left/)).toBe(true)
    expect(has(later, /left( \([^)]*\))? ↑/), 'the label, not the token count (20↑ 20↓)').toBe(false)
  })
}

test('the countdown runs down as time passes', async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(31_000)
  expect(has(await seen($, 'terminal'), /~50s left/)).toBe(true)
})

test('a task list gets the countdown in place of its share done', async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await $.tool.call({ tool: 'TodoWrite', todos })
  await clock.advance(1_000)
  const shown = await seen($, 'terminal')
  expect(has(shown, /~1m 50s left/)).toBe(true)
  expect(has(shown, /%/)).toBe(false)
})

test('a sized item that finishes is learned, and the next session reads it back from the store', async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await report($, { left: [{ do: 'a', size: 's' }] })
  await clock.advance(200_000) // 20 rounds at this pace
  await report($, { done: 1 })
  await $.turn.complete(done('t1', 210_000))
  await restart($)
  await pacedNext($, clock, 't2')
  await report($, { left: [{ do: 'b', size: 's' }, { do: 'c', size: 's' }] })
  await clock.advance(1_000)
  // With the seeds alone this reads ~50s; the learned 20 rounds lift the median of an `s` to 2.5.
  expect(has(await seen($, 'terminal'), /~1m left/)).toBe(true)
})

test("a foreground command's time is learned for this project; a background one's is not", async ($, on) => {
  const { clock, release } = await pacedTurn($, on)
  await slowBash($, clock, release, 'slow 30', 30_000)
  await slowBash($, clock, release, 'slow 5', 5_000, true)
  await $.turn.complete(done('t1', 50_000))
  await restart($)
  await pacedNext($, clock, 't2')
  await report($, { left: [{ do: 'run it', run: 'slow 30' }, { do: 'run that', run: 'slow 5' }] })
  await clock.advance(1_000)
  // `slow 30` by its one run (30 s), `slow 5` as an `m` (50 s), and a round: 1m 30s.
  expect(has(await seen($, 'terminal'), /~1m 30s left/)).toBe(true)
})

test("an interrupted turn keeps no command times: an interrupted command's time is not its run time", async ($, on) => {
  const { clock, release } = await pacedTurn($, on)
  await slowBash($, clock, release, 'slow 30', 30_000)
  await $.turn.complete(aborted('t1', 40_000))
  await restart($)
  await pacedNext($, clock, 't2')
  await report($, { left: [{ do: 'run it', run: 'slow 30' }, MS.s] })
  await clock.advance(1_000)
  expect(has(await seen($, 'terminal'), /~1m 20s left/)).toBe(true)
})

test("a refused command's wait is not learned as its run time", async ($, on) => {
  const { clock, release } = await pacedTurn($, on)
  await slowBash($, clock, release, 'slow 30 refused', 30_000)
  await $.turn.complete(done('t1', 40_000))
  await restart($)
  await pacedNext($, clock, 't2')
  await report($, { left: [{ do: 'run it', run: 'slow 30 refused' }, MS.s] })
  await clock.advance(1_000)
  // As an `m` it reads 1m 20s; learned from the refusal it would read ~1m.
  expect(has(await seen($, 'terminal'), /~1m 20s left/)).toBe(true)
})

test("a finished run item's long round stays out of the pace", async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await report($, { left: [{ do: 'run it', run: 'npm test' }, MS.s] })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  // The round after the command takes 180 s of the clock; holding the call itself that long runs past the kit's budget for a hook.
  await clock.advance(180_000)
  await round($, 2)
  await report($, { done: 1 })
  await clock.advance(1_000)
  // The pace is still 10 s: the `s` item's 20 s less the second spent, and a round. With the long round counted it reads minutes.
  expect(has(await seen($, 'terminal'), /~30s left/)).toBe(true)
})

test('a plan file written in the default configuration gets its countdown, and keeps its rows', async ($, on) => {
  const { clock } = await pacedTurn($, on)
  const content = '# Plan\n\n- [x] Write the types\n- [ ] Write the hooks\n- [ ] Write the tests\n- [ ] Ship\n'
  await $.tool.call({ tool: 'Write', file_path: '/repo/docs/plan.md', content })
  await clock.advance(1_000)
  const shown = await seen($, 'terminal')
  expect(has(shown, /~3m left/)).toBe(true)
  expect(has(shown, /◐ Write the hooks/), 'a plan file keeps its rows').toBe(true)
})

/** Seventeen rounds on, 10 s apart, with no report: the one item reported is far past its range, and the countdown is gone. */
async function goStale($: Engine, clock: Clock) {
  for (let index = 2; index <= 18; index++) {
    await clock.advance(10_000)
    await round($, index)
  }
  await clock.advance(1_000)
}

test('reading a file that changes no plan does not count as a report', async ($, on) => {
  on('fs.read', () => ({ value: '# Readme\n\nNothing here to tick.\n' }))
  const { clock } = await pacedTurn($, on)
  await report($, { left: [MS.s] })
  await goStale($, clock)
  expect(has(await seen($, 'terminal'), /left/), 'stale first').toBe(false)
  await $.tool.call({ tool: 'Read', file_path: '/repo/README.md' })
  await clock.advance(1_000)
  expect(has(await seen($, 'terminal'), /left/)).toBe(false)
})

test('a ledger line for a task already reported done does not count as a report', async ($, on) => {
  const plan = ['# Plan', '### Task 1: Write the types', '- [ ] Step', '### Task 2: Write the hooks', '- [ ] Step', '### Task 3: Ship', '- [ ] Step'].join('\n')
  const { clock } = await pacedTurn($, on)
  await $.tool.call({ tool: 'Write', file_path: '/repo/docs/plan.md', content: plan })
  await $.tool.call({ tool: 'Bash', command: 'task-done plan.md 1' })
  await goStale($, clock)
  expect(has(await seen($, 'terminal'), /left/), 'stale first').toBe(false)
  await $.tool.call({ tool: 'Bash', command: 'task-done plan.md 1' })
  await clock.advance(1_000)
  expect(has(await seen($, 'terminal'), /left/)).toBe(false)
})

test('a reload mid-turn keeps the countdown', async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(1_000)
  await restart($)
  expect(has(await seen($, 'terminal'), /~1m 20s left/)).toBe(true)
})

test('down to its answer, yet still at work two rounds later, Claude loses its countdown', async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(1_000)
  await report($, { left: [] })
  expect(has(await seen($, 'terminal'), /~10s left/)).toBe(true)
  for (const index of [2, 3]) {
    await clock.advance(1_000)
    await round($, index)
  }
  await clock.advance(1_000)
  expect(has(await seen($, 'terminal'), /left/)).toBe(false)
})

test('done before any list is answered, and changes nothing', async ($, on) => {
  const { clock } = await pacedTurn($, on)
  expect((await report($, { done: 1 })).result).toBe('ok')
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(1_000)
  expect(has(await seen($, 'terminal'), /~1m 20s left/)).toBe(true)
})

test('eta: off keeps the share done and draws no countdown', { options: { eta: 'off' } }, async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await $.tool.call({ tool: 'TodoWrite', todos })
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(1_000)
  const shown = await seen($, 'terminal')
  expect(has(shown, /50%/)).toBe(true)
  expect(has(shown, /left/)).toBe(false)
})

test('a planned bar follows the countdown and never moves back when tasks are added', async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await $.tool.call({ tool: 'TodoWrite', todos })
  await clock.advance(1_000)
  const before = await fillWidth($)
  expect(before).toBeGreaterThan(0)
  const more = ['Document', 'Release', 'Announce'].map(content => ({ content, status: 'pending' as const, activeForm: content }))
  await $.tool.call({ tool: 'TodoWrite', todos: [...todos, ...more] })
  await clock.advance(1_000)
  expect((await fillWidth($)) >= before).toBe(true)
})

test('on a narrow terminal the label shortens so the bar keeps its 20 cells', async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(1_000)
  const { bars } = await seen($, 'terminal', true, 30)
  const bar = bars.find(text => text.length > 1) ?? ''
  expect(bar.endsWith(' ~1m 20s')).toBe(true)
  expect(bar).not.toMatch(/left/)
  expect(bar.length).toBeLessThan(30)
})

test("the band lists Claude's items with an estimate on each, and names the one in progress", async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(1_000)
  const before = await seen($, 'terminal')
  expect(has(before, /◐ fix the parser/)).toBe(true)
  expect(has(before, /○ update the tests/)).toBe(true)
  expect(has(before, /~50s/)).toBe(true)
  expect(has(before, /~20s/)).toBe(true)
  expect(has(before, /Fix the parser/)).toBe(true)
  expect(has(before, /0\/2 items/)).toBe(true)

  await report($, { done: 1 })
  await clock.advance(1_000)
  const after = await seen($, 'terminal')
  expect(has(after, /✓ fix the parser/)).toBe(true)
  expect(has(after, /Update the tests/)).toBe(true)
  expect(has(after, /1\/2 items/)).toBe(true)
})

test("an item's estimate sits in a box that cannot shrink, so the estimate never wraps", async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(1_000)
  const ui = await mountBand($, 'terminal', true, 30, {})
  const trails = await ui.findAll({ type: 'Box', text: /^ ~\d/ })
  await ui.unmount()
  expect(trails).toHaveLength(2)
  expect(trails.every(box => box.props.flexShrink === 0)).toBe(true)
})

test('stepRows: never lists no items, and the headline still names the one in progress', { options: { stepRows: 'never' } }, async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(1_000)
  const shown = await seen($, 'terminal')
  expect(has(shown, /◐ fix the parser/)).toBe(false)
  expect(has(shown, /Fix the parser/)).toBe(true)
})

test('a task list keeps its rows and count when Claude also reports: Claude Code draws its list', async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await $.tool.call({ tool: 'TodoWrite', todos })
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(1_000)
  const shown = await seen($, 'terminal')
  expect(has(shown, /1\/3 tasks/)).toBe(true)
  expect(has(shown, /Writing tests/)).toBe(true)
  expect(has(shown, /fix the parser/)).toBe(false)
  expect(has(shown, /~1m 20s left/), 'the report still drives the countdown').toBe(true)
})

/** A main turn that starts subagent a1, whose own rounds are 10 s apart; the clock stands 10 s in. */
async function withSubagent($: Engine, on: On) {
  engineBottom(on)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'review the branch', turnId: 't1' })
  for (const command of ['git status', 'git log', 'git diff']) await $.tool.call({ tool: 'Bash', command })
  await $.tool.call({ tool: 'Agent', description: 'Review the branch', prompt: 'Review it.', subagent_type: 'general-purpose' })
  await round($, 0, { agentId: 'a1' })
  await clock.advance(10_000)
  await round($, 1, { agentId: 'a1' })
  return clock
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a subagent's band counts down its own report and lists its items`, async ($, on) => {
    const clock = await withSubagent($, on)
    await report($, { left: [MS.m, MS.s] }, 'a1')
    await clock.advance(1_000)
    const shown = await seen($, surface, true, 80, { agentId: 'a1' })
    expect(has(shown, /~1m 20s left/)).toBe(true)
    expect(has(shown, /◐ fix the parser/)).toBe(true)
    expect(has(shown, /0\/2 items/)).toBe(true)
  })

  test(`${surface}: a main turn waiting on its subagent shows that subagent's countdown`, async ($, on) => {
    const clock = await withSubagent($, on)
    await report($, { left: [MS.l] }, 'a1')
    await clock.advance(11_000)
    await $.turn.complete(done('t1', 21_000))
    await clock.advance(2_000)
    const shown = await seen($, surface, false)
    expect(has(shown, /Waiting for 1 subagent/)).toBe(true)
    expect(has(shown, /~2m left/)).toBe(true)
  })
}

test('a main turn with its own countdown shows none once it waits on a subagent that has none', async ($, on) => {
  engineBottom(on)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'review the branch', turnId: 't1' })
  await round($, 0)
  await clock.advance(10_000)
  await round($, 1)
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(1_000)
  expect(has(await seen($, 'terminal'), /~1m 20s left/), 'its own countdown first').toBe(true)
  await $.tool.call({ tool: 'Agent', description: 'Review the branch', prompt: 'Review it.', subagent_type: 'general-purpose' })
  await clock.advance(1_000)
  expect(has(await seen($, 'terminal'), /left/)).toBe(false)
})

test("an earlier turn's background subagent does not hold this turn's countdown", async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await $.tool.call({ tool: 'Agent', description: 'Review the branch', prompt: 'Review it.', subagent_type: 'general-purpose' })
  await $.turn.complete(done('t1', 11_000))
  await clock.advance(1_000)
  await pacedNext($, clock, 't2')
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(1_000)
  // a1 runs on with no estimate, yet this turn did not start it.
  expect(has(await seen($, 'terminal'), /~1m 20s left/)).toBe(true)
})

test('the summary compares the first estimate with what followed', async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(60_000)
  await $.turn.complete(done('t1', 75_000))
  await clock.advance(2_000)
  expect(has(await seen($, 'terminal', false), /^⏱ at 10s: estimated ~1m 20s more · took 1m 05s more$/)).toBe(true)
})

test('an interrupted turn has no accuracy line', async ($, on) => {
  const { clock } = await pacedTurn($, on)
  await report($, { left: [MS.m, MS.s] })
  await clock.advance(60_000)
  await $.turn.complete(aborted('t1', 75_000))
  await clock.advance(2_000)
  const shown = await seen($, 'terminal', false)
  expect(has(shown, /⏱/)).toBe(false)
  expect(shown.bars.some(text => /%/.test(text)), 'a bar paced by time has no share to name').toBe(false)
})

for (const [name, ended, headline, shares] of [
  ['an interrupted subagent names no percentage', aborted, /Subagent interrupted/, false],
  ['an answering subagent shows 100%', done, /Subagent complete/, true],
] as const) {
  test(`a finished subagent's band: ${name}`, async ($, on) => {
    const clock = await withSubagent($, on)
    await report($, { left: [MS.m, MS.s] }, 'a1')
    await clock.advance(1_000)
    await $.turn.complete({ ...ended('a1-turn', 20_000), agentId: 'a1' } as never)
    await clock.advance(1_000)
    const shown = await seen($, 'terminal', false, 80, { agentId: 'a1' })
    expect(has(shown, headline)).toBe(true)
    expect(shown.bars.some(text => /100%/.test(text))).toBe(shares)
    expect(shown.bars.some(text => /%/.test(text))).toBe(shares)
  })
}
