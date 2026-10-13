import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ledgerTasks, parsePlan } from '../hooks/frames'
import { stepsOf } from '../hooks/register'

const PLUGIN = 'session-progress'

// A superpowers-style plan: tasks under `### Task N:` headings, each with step checkboxes nobody ticks.
const PLAN = [
  '# Plan',
  '',
  '```md',
  '### Task 9: not a task, inside a fence',
  '```',
  '### Task 1: Write the types',
  '- [ ] **Step 1: Write the failing test**',
  '- [ ] **Step 2: Make it pass**',
  '### Task 2: Write the hooks',
  '- [ ] **Step 1: Write the failing test**',
  '- [ ] **Step 2: Make it pass**',
  '### Task 3: Ship',
  '- [ ] **Step 1: Release**',
].join('\n')

const LEDGER = [
  '# SDD ledger — plan: docs/superpowers/plans/plan.md',
  'Task 1: complete (commits 5766d22..1d6bffd, tests: claude plugin test . → Ran 8 tests)',
  'Task 2: Ruling: kept the port — cost if wrong: none',
].join('\n')

type Files = Record<string, string>

function bottom(on: On, files: Files) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.blit', () => ({ value: {} }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine-band</Text>
  })
  on('tool.call', ($, e) => ({ result: e.tool === 'Bash' ? { stdout: files['$stdout'] ?? '', stderr: '', interrupted: false } : 'ok' }) as never)
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

async function bash($: Engine, files: Files, stdout: string) {
  files['$stdout'] = stdout
  await $.tool.call({ tool: 'Bash', command: 'task-done plan.md 1 abc -- claude plugin test .' })
}

test('a plan with Task headings is read as tasks, each holding the checkboxes beneath it', () => {
  const plan = parsePlan(PLAN)
  expect(plan.items.length).toBe(5)
  expect(plan.tasks).toEqual([
    { n: 1, text: 'Write the types', steps: 2, stepsDone: 0 },
    { n: 2, text: 'Write the hooks', steps: 2, stepsDone: 0 },
    { n: 3, text: 'Ship', steps: 1, stepsDone: 0 },
  ])
})

test('ledger lines name the completed tasks; rulings and notes about a task do not', () => {
  expect(ledgerTasks(LEDGER)).toEqual([1])
  expect(ledgerTasks('ledger: Task 12: complete (commits a..b, tests: x → ok)')).toEqual([12])
  expect(ledgerTasks('Task 3 is complete')).toEqual([])
})

test('a task counts as done when the ledger says so or when all its boxes are ticked', () => {
  const ticked = PLAN.replace('- [ ] **Step 1: Release**', '- [x] **Step 1: Release**')
  const { items, tasks } = parsePlan(ticked)
  const steps = stepsOf([], { path: '/p/plan.md', name: 'plan.md', items, tasks, completed: [1] })
  expect(steps.unit).toBe('tasks')
  expect(steps.list.map(t => `${t.subject}:${t.status}`)).toEqual(['Write the types:completed', 'Write the hooks:in_progress', 'Ship:completed'])
  expect(steps.progress).toBe(2 / 3)
})

// The share done is the bar without the countdown; with it, the bar follows the estimate (tests/eta-band.test.tsx).
test("a task-done line in a Bash call's output moves the bar to the next task", { options: { eta: 'off' } }, async ($, on) => {
  const files: Files = { '/repo/docs/plan.md': PLAN }
  bottom(on, files)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'execute plan.md', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/docs/plan.md' })
  await clock.advance(9_000)
  expect(await shows($, /plan\.md · 0\/3 tasks/)).toBe(true)

  await bash($, files, 'Ran 8 tests across 1 file.\nledger: Task 1: complete (commits 5766d22..1d6bffd, tests: claude plugin test . → Ran 8 tests)')
  await clock.advance(1_000)
  expect(await shows($, /plan\.md · 1\/3 tasks/)).toBe(true)
  expect(await shows($, /33%/)).toBe(true)
  expect(await shows($, /Write the hooks/), 'the plan task now in progress heads the band and lists under the bar').toBe(true)

  await $.tool.call({ tool: 'Read', file_path: '/repo/docs/plan.md' })
  await clock.advance(1_000)
  expect(await shows($, /1\/3 tasks/), 'reading the plan again keeps what the ledger reported').toBe(true)
})

test('reading the ledger file catches up on tasks finished while the band was not watching', async ($, on) => {
  const files: Files = { '/repo/docs/superpowers/plans/plan.md': PLAN, '/repo/.superpowers/sdd/plan/progress.md': LEDGER }
  bottom(on, files)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'resume the plan', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/docs/superpowers/plans/plan.md' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/.superpowers/sdd/plan/progress.md' })
  await clock.advance(9_000)
  expect(await shows($, /plan\.md · 1\/3 tasks/)).toBe(true)
})

test("another plan's ledger never ticks this plan's tasks", async ($, on) => {
  const other = LEDGER.replace('plans/plan.md', 'plans/other.md')
  const files: Files = { '/repo/docs/superpowers/plans/plan.md': PLAN, '/repo/.superpowers/sdd/other/progress.md': other }
  bottom(on, files)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'resume the plan', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/docs/superpowers/plans/plan.md' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/.superpowers/sdd/other/progress.md' })
  await clock.advance(9_000)
  expect(await shows($, /plan\.md · 0\/3 tasks/)).toBe(true)
})
