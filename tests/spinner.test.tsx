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
