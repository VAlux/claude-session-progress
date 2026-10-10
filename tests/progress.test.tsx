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

/** The bar's cells read back as text: its track glyphs and its label. */
function rasterText(cells: string): string {
  const bytes = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  let text = ''
  for (let i = 0; i < words.length; i += 3) text += String.fromCodePoint(words[i] ?? 0x20)
  return text
}

async function shows($: Engine, isWorking: boolean, text: RegExp) {
  const ui = await band($, isWorking)
  const found = await ui.find({ text })
  const bar = await ui.find({ key: 'bar', type: 'Raster' })
  await ui.unmount()
  return found !== undefined || (bar !== undefined && text.test(rasterText(String(bar.props.cells))))
}

const done = (turnId: string, durationMs: number) => ({ turnId, durationMs, answer: 'ok', isAborted: false, reason: 'answer' as const })

test('a short Q/A turn never shows the band', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'what is 2+2?', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/tmp/a.ts' })
  await clock.advance(5_000)
  expect(await shows($, true, /tool call/), 'shows /tool call/ (working=true)').toBe(false)
  await $.turn.complete(done('t1', 5_000))
  expect(await shows($, false, /Task complete/), 'shows /Task complete/ (working=false)').toBe(false)
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

  expect(await shows($, true, /Writing tests/), 'shows /Writing tests/ (working=true)').toBe(true)
  expect(await shows($, true, /63%/), 'shows /63%/ (working=true)').toBe(true)
  expect(await shows($, true, /2\/4 tasks/), 'shows /2\/4 tasks/ (working=true)').toBe(true)
  expect(await shows($, true, /1 file changed/), 'shows /1 file changed/ (working=true)').toBe(true)

  await $.turn.complete(done('t1', 95_000))
  await clock.advance(2_000) // the bar and its label fill to 100% as the finish plays
  expect(await shows($, false, /Task complete/), 'shows /Task complete/ (working=false)').toBe(true)
  expect(await shows($, false, /100%/), 'shows /100%/ (working=false)').toBe(true)
  expect(await shows($, false, /1m 35s/), 'shows /1m 35s/ (working=false)').toBe(true)

  await $.turn.start({ text: 'thanks', turnId: 't2' })
  expect(await shows($, true, /Task complete/), 'shows /Task complete/ (working=true)').toBe(false)
  expect(await shows($, true, /tool call/), 'shows /tool call/ (working=true)').toBe(false)
})

test('a long tool-heavy turn without a plan shows an indeterminate band', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'investigate', turnId: 't1' })
  for (const command of ['ls', 'git status', 'npm test']) await $.tool.call({ tool: 'Bash', command })
  await clock.advance(19_000)
  expect(await shows($, true, /3 tool calls/), 'shows /3 tool calls/ (working=true)').toBe(false)
  await clock.advance(2_000)
  expect(await shows($, true, /3 tool calls/), 'shows /3 tool calls/ (working=true)').toBe(true)
  expect(await shows($, true, /\$ npm test/), 'shows /\$ npm test/ (working=true)').toBe(true)
})

test('the finished bar settles full in the band tree itself, not only in blits', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'investigate', turnId: 't1' })
  for (const command of ['ls', 'git status', 'npm test']) await $.tool.call({ tool: 'Bash', command })
  await clock.advance(21_000)
  expect(await shows($, true, /3 tool calls/), 'shows /3 tool calls/ (working=true)').toBe(true)

  await $.turn.complete(done('t1', 42_000))
  await clock.advance(2_000) // the finish animation plays out and redraws once

  const ui = await band($, false)
  const bar = await ui.find({ key: 'bar', type: 'Raster' })
  await ui.unmount()
  expect(bar).toBeDefined()
  const text = rasterText(String(bar?.props.cells))
  expect(text.endsWith(' 100%')).toBe(true)
  const track = text.slice(0, -' 100%'.length)
  expect(track.length).toBeGreaterThan(8)
  expect([...track].every(g => g === '━')).toBe(true)
})

const todos = [
  { content: 'Write types', status: 'completed' as const, activeForm: 'Writing types' },
  { content: 'Write tests', status: 'in_progress' as const, activeForm: 'Writing tests' },
  { content: 'Validate', status: 'pending' as const, activeForm: 'Validating' },
]

async function plannedTurn($: Engine, on: On) {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', todos })
  await clock.advance(10_000)
}

test('by default a task list is not listed again under the bar: Claude Code draws its own', async ($, on) => {
  await plannedTurn($, on)
  expect(await shows($, true, /Writing tests/), 'the headline still names the active task').toBe(true)
  expect(await shows($, true, /1\/3 tasks/), 'the count stays').toBe(true)
  expect(await shows($, true, /Validate/), 'no step rows').toBe(false)
})

test('stepRows: always lists a task list under the bar', { options: { stepRows: 'always' } }, async ($, on) => {
  await plannedTurn($, on)
  expect(await shows($, true, /Validate/)).toBe(true)
})

test('stepRows: never lists nothing, not even a plan file', { options: { stepRows: 'never' } }, async ($, on) => {
  await plannedTurn($, on)
  expect(await shows($, true, /Validate/)).toBe(false)
  expect(await shows($, true, /Writing tests/)).toBe(true)
})

test('the band draws whatever is beneath it above itself, instead of hiding it', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'investigate', turnId: 't1' })
  for (const command of ['ls', 'git status', 'npm test']) await $.tool.call({ tool: 'Bash', command })
  await clock.advance(21_000)
  const ui = await band($, true)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  const below = texts.findIndex(t => /engine-band/.test(t))
  const stats = texts.findIndex(t => /3 tool calls/.test(t))
  expect(below).toBeGreaterThanOrEqual(0)
  expect(below).toBeLessThan(stats)
})

test('an indeterminate bar carries no clock of its own: the head row already shows it', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'investigate', turnId: 't1' })
  for (const command of ['ls', 'git status', 'npm test']) await $.tool.call({ tool: 'Bash', command })
  await clock.advance(21_000)
  const ui = await band($, true)
  const clocks = await ui.findAll({ type: 'Text', text: /21s/ })
  const bar = await ui.find({ key: 'bar', type: 'Raster' })
  await ui.unmount()
  expect(clocks.length, 'the head row shows the clock').toBeGreaterThan(0)
  expect(rasterText(String(bar?.props.cells)), 'the bar does not repeat it').not.toMatch(/\d+s/)
})
