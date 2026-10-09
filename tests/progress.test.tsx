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
  on('tool.call', ($, e) => ({ result: e.tool === 'TodoWrite' ? { oldTodos: [], newTodos: e.todos } : 'ok' }) as never)
}

async function band($: Engine, isWorking: boolean) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
}

async function shows($: Engine, isWorking: boolean, text: RegExp) {
  const ui = await band($, isWorking)
  const found = await ui.find({ text })
  await ui.unmount()
  return found !== undefined
}

const done = (turnId: string, durationMs: number) => ({ turnId, durationMs, answer: 'ok', isAborted: false, reason: 'answer' as const })

test('a short Q/A turn never shows the band', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'what is 2+2?', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/tmp/a.ts' })
  await clock.advance(5_000)
  expect(await shows($, true, /tool call/)).toBe(false)
  await $.turn.complete(done('t1', 5_000))
  expect(await shows($, false, /Task complete/)).toBe(false)
})

test('a long planned turn shows progress, then a summary, then hides on the next turn', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'build the feature', turnId: 't1' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Write types', status: 'completed', activeForm: 'Writing types' },
      { content: 'Write hooks', status: 'completed', activeForm: 'Writing hooks' },
      { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      { content: 'Validate', status: 'pending', activeForm: 'Validating' },
    ],
  })
  await $.tool.call({ tool: 'Edit', file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(10_000)

  expect(await shows($, true, /Writing tests/)).toBe(true)
  expect(await shows($, true, /63%/)).toBe(true)
  expect(await shows($, true, /2\/4 tasks/)).toBe(true)
  expect(await shows($, true, /1 file changed/)).toBe(true)

  await $.turn.complete(done('t1', 95_000))
  expect(await shows($, false, /Task complete/)).toBe(true)
  expect(await shows($, false, /100%/)).toBe(true)
  expect(await shows($, false, /1m 35s/)).toBe(true)

  await $.turn.start({ text: 'thanks', turnId: 't2' })
  expect(await shows($, true, /Task complete/)).toBe(false)
  expect(await shows($, true, /tool call/)).toBe(false)
})

test('a long tool-heavy turn without a plan shows an indeterminate band', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'investigate', turnId: 't1' })
  for (const command of ['ls', 'git status', 'npm test']) await $.tool.call({ tool: 'Bash', command })
  await clock.advance(19_000)
  expect(await shows($, true, /3 tool calls/)).toBe(false)
  await clock.advance(2_000)
  expect(await shows($, true, /3 tool calls/)).toBe(true)
  expect(await shows($, true, /\$ npm test/)).toBe(true)
})

function glyphs(cells: string): number[] {
  const bin = atob(cells)
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  return Array.from(words.filter((_, i) => i % 3 === 0))
}

test('the finished bar settles full in the band tree itself, not only in blits', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'investigate', turnId: 't1' })
  for (const command of ['ls', 'git status', 'npm test']) await $.tool.call({ tool: 'Bash', command })
  await clock.advance(21_000)
  expect(await shows($, true, /3 tool calls/)).toBe(true)

  await $.turn.complete(done('t1', 42_000))
  await clock.advance(2_000) // the finish animation plays out and redraws once

  const ui = await band($, false)
  const bar = await ui.find({ key: 'bar', type: 'Raster' })
  await ui.unmount()
  expect(bar).toBeDefined()
  const cells = glyphs(String(bar?.props.cells))
  expect(cells.length).toBeGreaterThan(8)
  expect(cells.every(g => g === 0x2501)).toBe(true)
})
