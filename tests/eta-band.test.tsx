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
    if (e.tool === 'Agent') return { result: { agentId: 'a1', agentType: 'general-purpose' } } as never
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
