import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PROGRESS_TOOL } from '../hooks/report'

const PLUGIN = 'session-progress'

type Clock = { advance: (ms: number) => Promise<void> }

/**
 * The engine beneath the mod. A foreground Agent call answers only once the test releases it, as the real one answers when its
 * subagent does; a background one answers at once, with the subagent last spawned. Spawns start `a1`, `a2`, ...
 */
/** Frames the band took since the last `framesOf`, by Raster key. */
const blits: Record<string, number> = {}

function engineBottom(on: On) {
  const held: (() => void)[] = []
  const spawned: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__${PLUGIN}__${e.name}` } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.blit', ($, e) => {
    const key = String((e as { key?: unknown }).key)
    blits[key] = (blits[key] ?? 0) + 1
    return { value: {} }
  })
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
  on('agent.spawn', () => {
    spawned.push(`a${spawned.length + 1}`)
    return { model: 'claude-opus-5-5', agentId: spawned[spawned.length - 1] } as never
  })
  on('tool.call', async ($, e) => {
    if (e.tool !== 'Agent') return { result: 'ok' } as never
    if ((e as { run_in_background?: boolean }).run_in_background === true) return { result: { agentId: spawned[spawned.length - 1], agentType: 'general-purpose' } } as never
    await new Promise<void>(resolve => held.push(resolve))
    return { result: 'ok' } as never
  })
  return { release: () => held.splice(0).forEach(resolve => resolve()) }
}

/** One model round: of the main loop's turn, or of a subagent's loop. */
async function round($: Engine, index: number, agentId?: string) {
  const args = { turnId: agentId ?? 't1', index, model: 'claude-opus-5-5', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) }
  for await (const _ of $.turn.step(args as Parameters<Engine['turn']['step']>[0])) {
    // drain
  }
}

/**
 * The main loop's Agent call and the spawn it makes: left running when it is a foreground one; a background one answers with its id.
 * The subagent's loop then starts its own turn, as the engine's does.
 */
async function dispatch($: Engine, clock: Clock, n: number, isBackground = false) {
  const spawn = async () => {
    const started = (await $.agent.spawn({
      tool_use_id: `call-${n}`,
      prompt: 'Do it.',
      description: `Task ${n}`,
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
    } as never)) as { agentId?: string }
    await $.turn.start({ text: 'Do it.', turnId: `${started.agentId}-turn`, agentId: started.agentId } as never)
  }
  if (isBackground) await spawn()
  const call = $.tool.call({
    tool: 'Agent',
    tool_use_id: `call-${n}`,
    description: `Task ${n}`,
    prompt: 'Do it.',
    subagent_type: 'general-purpose',
    ...(isBackground ? { run_in_background: true } : {}),
  } as never)
  await clock.advance(0) // let the mod note the call before the engine spawns from inside it
  if (!isBackground) await spawn()
  if (isBackground) await call
  // A call still held when the test ends is dropped with it.
  else call.catch(() => {})
  // Wrapped: an async function's returned promise would be awaited with it.
  return { call }
}

const done = (turnId: string, durationMs: number, agentId?: string) => ({
  turnId,
  durationMs,
  answer: 'ok',
  isAborted: false,
  reason: 'answer' as const,
  ...(agentId === undefined ? {} : { agentId }),
})

const report = ($: Engine, input: Record<string, unknown>, agentId?: string) =>
  $.tool.call({ tool: PROGRESS_TOOL, ...input, ...(agentId === undefined ? {} : { agentId }) } as never)

/** A main turn 10 s in, at a 10 s pace, that has dispatched `n` subagents; then 50 s go by, so its band shows. */
async function waitingTurn($: Engine, on: On, n: number, isBackground = false) {
  const ids = Array.from({ length: n }, (_, i) => `a${i + 1}`)
  const { release } = engineBottom(on)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'fan out', turnId: 't1' })
  await round($, 0)
  await clock.advance(10_000)
  await round($, 1)
  const calls = []
  for (let i = 1; i <= n; i++) calls.push((await dispatch($, clock, i, isBackground)).call)
  for (const id of ids) await round($, 0, id)
  await clock.advance(50_000)
  return { clock, ids, release, calls }
}

/** Everything a band shows: its elements' text and the terminal's bars read back; and the desktop bar's fill, out of 1000. */
async function seen($: Engine, surface: 'terminal' | 'desktop', isWorking = true) {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 30, bodyColumns: 80, scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  const texts = (await ui.findAll({})).map(el => el.text)
  const bars = (await ui.findAll({ type: 'Raster' })).map(bar => rasterText(String(bar.props.cells)))
  const svgs = (await ui.findAll({ type: 'Svg' })).map(svg => ({ alt: String(svg.props.alt), source: String(svg.props.source) }))
  await ui.unmount()
  const bar = svgs.find(svg => /^Progress/.test(svg.alt))
  const fill = Number(/<rect width="(\d+)" height="6" rx="3" fill="url\(#f\)"/.exec(bar?.source ?? '')?.[1] ?? -1)
  return { all: [...texts, ...bars, ...svgs.map(svg => svg.alt)], fill }
}
/** The frames the terminal band takes over one second after it is drawn, by Raster key. */
async function framesOf($: Engine, clock: Clock, view: { agentId?: string } = {}, isWorking = false) {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 30, bodyColumns: 80, scroll: { offset: 0, bodyRows: 30 }, view },
  })
  for (const key of Object.keys(blits)) delete blits[key]
  for (let i = 0; i < 14; i++) await clock.advance(70)
  const taken = { ...blits }
  await ui.unmount()
  return taken
}

const has = (shown: { all: string[] }, re: RegExp) => shown.all.some(t => re.test(t))

function rasterText(cells: string): string {
  const bytes = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  let text = ''
  for (let i = 0; i < words.length; i += 3) text += String.fromCodePoint(words[i] ?? 0x20)
  return text
}

test('a main turn blocked on parallel subagents counts them done out of dispatched', async ($, on) => {
  const { clock } = await waitingTurn($, on, 3)
  let shown = await seen($, 'terminal')
  expect(has(shown, /Waiting for 3 subagents/)).toBe(true)
  expect(has(shown, /0\/3 subagents/)).toBe(true)

  await $.turn.complete(done('a1', 40_000, 'a1'))
  await clock.advance(1_000)
  shown = await seen($, 'terminal')
  expect(has(shown, /Waiting for 2 subagents/)).toBe(true)
  expect(has(shown, /1\/3 subagents/)).toBe(true)
})

test("the bar fills by the share of subagents done while the main turn waits on them", async ($, on) => {
  const { clock } = await waitingTurn($, on, 4)
  await $.turn.complete(done('a1', 40_000, 'a1'))
  await $.turn.complete(done('a2', 41_000, 'a2'))
  await clock.advance(1_000)
  expect((await seen($, 'desktop')).fill).toBe(500)
})

test("the wait's label is the longest countdown, though another subagent has none", async ($, on) => {
  const { clock } = await waitingTurn($, on, 2)
  await round($, 1, 'a1')
  await report($, { left: [{ do: 'rework the cache', size: 'l' }] }, 'a1')
  await clock.advance(1_000)
  expect(has(await seen($, 'terminal'), /left/)).toBe(true)
})

test('one subagent waited on fills the bar with its own countdown, not a share of one', async ($, on) => {
  const { clock } = await waitingTurn($, on, 1)
  await round($, 1, 'a1')
  await report($, { left: [{ do: 'rework the cache', size: 'l' }] }, 'a1')
  await clock.advance(5_000)
  const shown = await seen($, 'desktop')
  expect(has(shown, /left/)).toBe(true)
  expect(shown.fill).toBeGreaterThan(0)
})

test('the wait counts no subagent an earlier turn started', async ($, on) => {
  const { clock, release, calls } = await waitingTurn($, on, 2)
  await $.turn.complete(done('a1', 40_000, 'a1'))
  await $.turn.complete(done('a2', 41_000, 'a2'))
  release()
  await Promise.all(calls)
  await $.turn.complete(done('t1', 70_000))
  await $.turn.start({ text: 'again', turnId: 't2' })
  await round($, 0, undefined)
  await dispatch($, clock, 3)
  await clock.advance(50_000)
  expect(has(await seen($, 'terminal'), /0\/1 subagent/)).toBe(true)
})

test('a turn that ended waiting on background subagents counts them done out of dispatched', async ($, on) => {
  const { clock } = await waitingTurn($, on, 2, true)
  await $.turn.complete(done('t1', 60_000))
  await $.turn.complete(done('a1', 40_000, 'a1'))
  await clock.advance(1_000)
  const shown = await seen($, 'desktop', false)
  expect(has(shown, /Waiting for 1 subagent/)).toBe(true)
  expect(has(shown, /1\/2 subagents/)).toBe(true)
  expect(shown.fill).toBe(500)
})

test('without the countdown, a wait still fills by subagents done and names no time', { options: { eta: 'off' } }, async ($, on) => {
  const { clock } = await waitingTurn($, on, 2)
  await $.turn.complete(done('a1', 40_000, 'a1'))
  await clock.advance(1_000)
  const shown = await seen($, 'desktop')
  expect(shown.fill).toBe(500)
  expect(has(shown, /left/)).toBe(false)
})

/** A quick main turn that sends `n` subagents to the background and ends at once, as Claude Code's Agent calls do by default. */
async function quickFanOut($: Engine, on: On, n: number) {
  engineBottom(on)
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'fan out', turnId: 't1' })
  await round($, 0)
  for (let i = 1; i <= n; i++) await dispatch($, clock, i, true)
  await clock.advance(3_000)
  await $.turn.complete(done('t1', 3_000))
  return { clock }
}

test('a quick turn that hands off to two or more background subagents shows the wait 8 s in, as a plan of two does', async ($, on) => {
  const { clock } = await quickFanOut($, on, 3)
  await clock.advance(2_000)
  expect(has(await seen($, 'terminal', false), /Waiting for/), 'not before 8 s').toBe(false)
  await clock.advance(4_000)
  const shown = await seen($, 'terminal', false)
  expect(has(shown, /Waiting for 3 subagents/)).toBe(true)
  expect(has(shown, /0\/3 subagents/)).toBe(true)
})

test("the wait carries on through Claude's short turns between subagents' answers", async ($, on) => {
  const { clock } = await quickFanOut($, on, 3)
  await clock.advance(20_000)
  await $.turn.complete(done('a1', 22_000, 'a1'))
  // Claude Code tells Claude the subagent answered: a short turn of its own.
  await $.turn.start({ text: 'Agent "Task 1" finished', turnId: 't2' })
  await round($, 0, undefined)
  await clock.advance(2_000)
  expect(has(await seen($, 'terminal', true), /1\/3 subagents/), 'during that turn').toBe(true)
  await $.turn.complete(done('t2', 2_000))
  await clock.advance(1_000)
  const shown = await seen($, 'desktop', false)
  expect(has(shown, /Waiting for 2 subagents/)).toBe(true)
  expect(has(shown, /1\/3 subagents/)).toBe(true)
  expect(shown.fill).toBe(333)
})

test("a quick turn's wait leaves no band once every subagent has answered", async ($, on) => {
  const { clock } = await quickFanOut($, on, 2)
  await clock.advance(20_000)
  await $.turn.complete(done('a1', 22_000, 'a1'))
  await $.turn.complete(done('a2', 23_000, 'a2'))
  await clock.advance(1_000)
  expect(has(await seen($, 'terminal', false), /Waiting for|Task complete/)).toBe(false)
})

test('a quick hand-off to one background subagent shows the wait only 20 s in', async ($, on) => {
  const { clock } = await quickFanOut($, on, 1)
  await clock.advance(12_000)
  expect(has(await seen($, 'terminal', false), /Waiting for/), 'not at 15 s').toBe(false)
  await clock.advance(6_000)
  expect(has(await seen($, 'terminal', false), /Waiting for 1 subagent/)).toBe(true)
})

test('subagents that all answer within 8 s never raise the band', async ($, on) => {
  const { clock } = await quickFanOut($, on, 2)
  await clock.advance(2_000)
  await $.turn.complete(done('a1', 7_000, 'a1'))
  await $.turn.complete(done('a2', 8_000, 'a2'))
  await clock.advance(20_000)
  expect(has(await seen($, 'terminal', false), /Waiting for|Task complete/)).toBe(false)
})

test("a subagent's own turn start does not restart the main turn", async ($, on) => {
  const { clock } = await waitingTurn($, on, 2)
  await $.turn.start({ text: 'Again.', turnId: 'a1-turn-2', agentId: 'a1' } as never)
  await clock.advance(1_000)
  const shown = await seen($, 'terminal')
  expect(has(shown, /2 tool calls/)).toBe(true)
  expect(has(shown, /1m 01s/), "the main turn's clock").toBe(true)
})

test("a quick hand-off's wait keeps its bar moving between the band's once-a-second redraws", async ($, on) => {
  const { clock } = await quickFanOut($, on, 3)
  await clock.advance(10_000)
  expect((await framesOf($, clock)).bar ?? 0).toBeGreaterThan(7)
})

test('a long turn that ended waiting on background subagents keeps its bar moving, its mark still', async ($, on) => {
  const { clock } = await waitingTurn($, on, 2, true)
  await $.turn.complete(done('t1', 60_000))
  await clock.advance(5_000)
  const frames = await framesOf($, clock)
  expect(frames.bar ?? 0).toBeGreaterThan(7)
  expect(frames.spin ?? 0, 'the head row shows a mark, not a spinner').toBe(0)
})

test("a running subagent's band in its transcript moves between redraws", async ($, on) => {
  const { clock } = await waitingTurn($, on, 2, true)
  const frames = await framesOf($, clock, { agentId: 'a1' }, true)
  expect(frames['agent-bar'] ?? 0).toBeGreaterThan(7)
  expect(frames['agent-spin'] ?? 0).toBeGreaterThan(7)
  expect(frames.bar ?? 0, "the main bar's frames go nowhere").toBe(0)
})

test('once the last subagent has answered and the bar settled, the frame loop stops', async ($, on) => {
  const { clock } = await waitingTurn($, on, 2, true)
  await $.turn.complete(done('t1', 60_000))
  await $.turn.complete(done('a1', 61_000, 'a1'))
  await $.turn.complete(done('a2', 62_000, 'a2'))
  await clock.advance(3_000)
  expect(await framesOf($, clock)).toEqual({})
})
