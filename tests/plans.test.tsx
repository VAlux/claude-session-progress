import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseCheckboxes } from '../hooks/frames'
import { stepsOf, tracksPlanTool } from '../hooks/register'

const PLUGIN = 'session-progress'

const plan = (checked: number) =>
  ['# Plan', '', '```md', '- [ ] not a step, inside a fence', '```', ...['Write the types', 'Write the hooks', 'Write the tests', 'Validate', 'Ship'].map(
    (step, i) => `- [${i < checked ? 'x' : ' '}] ${step}`,
  )].join('\n')

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

test('checkboxes are read outside fences only', () => {
  const items = parseCheckboxes(plan(2))
  expect(items.length).toBe(5)
  expect(items.filter(i => i.done).length).toBe(2)
})

// The share done is the bar without the countdown; with it, the bar follows the estimate (tests/eta-band.test.tsx).
test('a Markdown plan with checkboxes drives the bar when there is no task list', { options: { eta: 'off' } }, async ($, on) => {
  const file = { text: plan(2) }
  bottom(on, file)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'implement plan.md', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/docs/plan.md' })
  await clock.advance(9_000)

  expect(await shows($, /40%/)).toBe(true)
  expect(await shows($, /plan\.md · 2\/5 steps/)).toBe(true)
  expect(await shows($, /Write the tests/)).toBe(true)
  expect(await shows($, /Validate/), 'a plan file keeps its step rows by default: Claude Code lists nothing for it').toBe(true)

  file.text = plan(3)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/docs/plan.md', old_string: '- [ ] Write the tests', new_string: '- [x] Write the tests' })
  await clock.advance(1_000)
  expect(await shows($, /60%/)).toBe(true)
  expect(await shows($, /3\/5 steps/)).toBe(true)
})

// superpowers' executor hands each subagent a brief with its own `- [ ] Step N:` boxes, which nothing ever ticks.
test("a subagent reading its own checklist never replaces the main plan, but its edit to the main plan counts", { options: { eta: 'off' } }, async ($, on) => {
  const brief = ['# Task 10', '', '- [ ] **Step 1: Update the README**', '- [ ] **Step 2: Bump the version**', '- [ ] **Step 3: Commit**'].join('\n')
  const file = { text: plan(1) }
  bottom(on, file)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'implement plan.md', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/docs/plan.md' })
  file.text = brief
  await $.tool.call({ tool: 'Read', file_path: '/repo/.superpowers/sdd/task-10-brief.md', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/repo/.superpowers/sdd/task-10-report.md', content: brief, agentId: 'a1' } as never)
  await clock.advance(9_000)
  expect(await shows($, /plan\.md · 1\/5 steps/)).toBe(true)
  expect(await shows($, /Update the README/)).toBe(false)

  file.text = plan(2)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/docs/plan.md', old_string: '- [ ] Write the hooks', new_string: '- [x] Write the hooks', agentId: 'a1' } as never)
  await clock.advance(1_000)
  expect(await shows($, /plan\.md · 2\/5 steps/)).toBe(true)
})

test('a task list wins over a plan file', () => {
  const tasks = [
    { id: '1', subject: 'a', status: 'completed' as const },
    { id: '2', subject: 'b', status: 'pending' as const },
  ]
  const file = { path: '/p.md', name: 'p.md', items: parseCheckboxes(plan(0)) }
  expect(stepsOf(tasks, file).unit).toBe('tasks')
  expect(stepsOf(tasks, file).progress).toBe(0.5)
  expect(stepsOf([], file).unit).toBe('steps')
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
