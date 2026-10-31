import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tracksPlanTool } from '../hooks/register'

const PLUGIN = 'session-progress'

function bottom(on: On) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.blit', () => ({ value: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine-band</Text>
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
}

/** The bar's cells read back as text: its track glyphs and its label. */
function rasterText(cells: string): string {
  const bytes = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  let text = ''
  for (let i = 0; i < words.length; i += 3) text += String.fromCodePoint(words[i] ?? 0x20)
  return text
}

async function shows($: Engine, text: RegExp) {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const found = await ui.find({ text })
  const bar = await ui.find({ key: 'bar', type: 'Raster' })
  await ui.unmount()
  return found !== undefined || (bar !== undefined && text.test(rasterText(String(bar.props.cells))))
}

test('a task list drives the bar without the countdown', { options: { eta: 'off' } }, async ($, on) => {
  bottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  const todos = [
    { content: 'Write types', status: 'completed', activeForm: 'Writing types' },
    { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
  ]
  await $.tool.call({ tool: 'TodoWrite', todos } as never)
  await clock.advance(9_000)
  expect(await shows($, /75%/)).toBe(true)
  expect(await shows($, /Writing tests/)).toBe(true)
  expect(await shows($, /1\/2 tasks/)).toBe(true)
})

test("a subagent's own list never replaces the main one, but its TaskUpdate still counts", () => {
  expect(tracksPlanTool('TodoWrite', false)).toBe(true)
  expect(tracksPlanTool('TodoWrite', true)).toBe(false)
  expect(tracksPlanTool('TaskCreate', true)).toBe(false)
  expect(tracksPlanTool('TaskUpdate', true)).toBe(true)
  expect(tracksPlanTool('Bash', false)).toBe(false)
})

test('the system prompt asks for a task list when a task tool is available', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine', scope: 'shared' as const }] }))
  const base = { model: 'm', promptModel: 'm', surfaces: ['terminal' as const], outputStyle: null, traits: [] }
  const withTasks = await $.prompt.compose({ ...base, tools: ['Bash', 'TaskCreate', 'TaskUpdate'] })
  const last = withTasks.sections[withTasks.sections.length - 1]
  expect(last?.id).toBe('session-progress:task-list')
  expect(last?.text).toContain('TaskCreate and TaskUpdate')
  const without = await $.prompt.compose({ ...base, tools: ['Bash'] })
  expect(without.sections.length).toBe(1)
})
