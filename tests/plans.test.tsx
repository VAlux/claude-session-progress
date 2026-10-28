import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tracksPlanTool } from '../hooks/register'

const PLUGIN = 'session-progress'

function bottom(on: On, file: { text: string }) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.blit', () => ({ value: {} }))
  on('fs.read', () => ({ value: file.text }))
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

// A story's acceptance criteria are `- [ ]` boxes, and nobody ticks them: read as a plan, they took over the band for good.
test('a Markdown file with checkboxes is not a plan', { options: { eta: 'off' } }, async ($, on) => {
  const story = ['# Story', '## Acceptance Criteria', '- [ ] Given the CLI is installed, when a user runs it, then it works', '- [ ] Given a webhook, when it fails, then it says so'].join('\n')
  const file = { text: story }
  bottom(on, file)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'write the story', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/docs/stories/story.md', content: story })
  await $.tool.call({ tool: 'Read', file_path: '/repo/docs/stories/story.md' })
  file.text = story.replace('- [ ] Given the CLI', '- [x] Given the CLI')
  await $.tool.call({ tool: 'Edit', file_path: '/repo/docs/stories/story.md', old_string: '- [ ] Given the CLI', new_string: '- [x] Given the CLI' })
  await clock.advance(46_000)

  expect(await shows($, /\d+s/), 'the band shows').toBe(true)
  expect(await shows($, /Given the CLI/)).toBe(false)
  expect(await shows($, /story\.md ·/)).toBe(false)
  expect(await shows($, /\d+\/\d+ (steps|tasks)/)).toBe(false)
  expect(await shows($, /50%/)).toBe(false)
})

test('a task list drives the bar without the countdown', { options: { eta: 'off' } }, async ($, on) => {
  bottom(on, { text: '' })
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
