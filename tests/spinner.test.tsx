import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'session-progress'

/** The engine beneath the mod; each blit the frame loop sends lands in `blits`. */
function engineBottom(on: On, blits: string[] = []) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.blit', ($, e) => {
    blits.push(e.key)
    return { value: {} }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine-spinner</Text>
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Agent') return { result: { agentId: 'a1', agentType: 'general-purpose' } } as never
    return { result: 'ok' } as never
  })
  return mock.clock(on, { now: 1_000_000 })
}

type Surface = 'terminal' | 'desktop' | 'vscode'

/** Whether the engine's own spinner line is drawn, for the main loop or the agent `requestId` names. */
async function engineSpinner($: Engine, surface: Surface = 'terminal', message: string | null = null, requestId = 'main') {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Spinner',
    requestId,
    props: { word: 'Sauteing', message, suffix: '…', mode: 'tool-use' },
  })
  const found = await ui.find({ text: /engine-spinner/ })
  await ui.unmount()
  return found !== undefined
}

/** The band drawn on `surface`, collapsed by the person or open. */
async function band($: Engine, surface: Surface, isCollapsed: boolean) {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  await ui.unmount()
}

/** A main turn long enough for the band to show. */
async function longTurn($: Engine, clock: { advance: (ms: number) => Promise<void> }) {
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await clock.advance(46_000)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the engine's spinner gives way while the band shows, and comes back when the turn ends`, async ($, on) => {
    const clock = engineBottom(on)
    await $.turn.start({ text: 'build it', turnId: 't1' })
    expect(await engineSpinner($, surface), 'before the band shows').toBe(true)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await clock.advance(46_000)
    expect(await engineSpinner($, surface), 'while the band shows').toBe(false)
    await $.turn.complete({ turnId: 't1', durationMs: 46_000, answer: 'ok', isAborted: false, reason: 'answer' } as never)
    expect(await engineSpinner($, surface), 'after the turn').toBe(true)
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a collapsed band hands the spinner back until it is opened again`, async ($, on) => {
    await longTurn($, engineBottom(on))
    await band($, surface, true)
    expect(await engineSpinner($, surface), 'collapsed').toBe(true)
    await band($, surface, false)
    expect(await engineSpinner($, surface), 'open again').toBe(false)
  })
}

test('the frame loop paints nothing into a collapsed band, and starts again when it opens', async ($, on) => {
  const blits: string[] = []
  const clock = engineBottom(on, blits)
  await longTurn($, clock)
  await band($, 'terminal', true)
  blits.length = 0
  await clock.advance(1_000)
  expect(blits, 'collapsed').toEqual([])
  await band($, 'terminal', false)
  await clock.advance(1_000)
  expect(blits.length, 'open again').toBeGreaterThan(0)
})

test("a spinner saying what state the turn is in is the engine's, band or not", async ($, on) => {
  await longTurn($, engineBottom(on))
  expect(await engineSpinner($, 'terminal', 'Compacting conversation')).toBe(true)
})

test('vscode draws no band, so it keeps the spinner', async ($, on) => {
  await longTurn($, engineBottom(on))
  expect(await engineSpinner($, 'vscode')).toBe(true)
})

test("a subagent's spinner is the engine's: it is not told where that one is drawn", async ($, on) => {
  const clock = engineBottom(on)
  await longTurn($, clock)
  await $.tool.call({ tool: 'Agent', description: 'look', prompt: 'look', subagent_type: 'general-purpose' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  expect(await engineSpinner($, 'terminal', null, 'a1')).toBe(true)
  expect(await engineSpinner($, 'terminal', null, 'main')).toBe(false)
})

test('spinner: keep leaves the spinner alone', { options: { spinner: 'keep' } }, async ($, on) => {
  await longTurn($, engineBottom(on))
  expect(await engineSpinner($)).toBe(true)
})
