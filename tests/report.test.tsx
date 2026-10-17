import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PROGRESS_TOOL, applyReport, parseReport, workTasks } from '../hooks/report'

const PLUGIN = 'session-progress'

function engineBottom(on: On, registered: { name: string; isDeferred?: boolean }[] = [], descriptions: string[] = []) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('tool.register', ($, e) => {
    registered.push({ name: e.name, isDeferred: e.isDeferred })
    descriptions.push(e.description)
    return { value: { tool: `mcp__${PLUGIN}__${e.name}` } }
  })
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.blit', () => ({ value: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine-row</Text>
  })
  on('tool.call', () => ({ result: 'engine' }) as never)
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
/** A call of the mod's own tool: the kit's typed input knows only the built-in tools. */
const report = async ($: Engine, input: Record<string, unknown>) => (await $.tool.call({ tool: PROGRESS_TOOL, ...input } as never)) as { result?: unknown }
const base = { model: 'm', promptModel: 'm', surfaces: ['terminal' as const], outputStyle: null, traits: [] }

test('the mod registers its progress tool at session start, in the tool list rather than behind ToolSearch', async ($, on) => {
  const registered: { name: string; isDeferred?: boolean }[] = []
  const descriptions: string[] = []
  engineBottom(on, registered, descriptions)
  await start($)
  expect(registered).toEqual([{ name: 'progress', isDeferred: false }])
  // Subagents get no system-prompt line, so the tool's own description is what tells every loop when to report.
  expect(descriptions[0]).toContain('never on its own')
  // A `done` sent alone before the answer costs a whole request; the turn's end closes the list anyway.
  expect(descriptions[0]).toContain('Once the work is done, just answer')
  // Each report is output, and stays in the context every later request reads: short items, `done` rather than the list again.
  expect(descriptions[0]).toContain('5 at most')
  expect(descriptions[0]).toContain('not the list again')
})

test('eta: off registers no tool', { options: { eta: 'off' } }, async ($, on) => {
  const registered: { name: string; isDeferred?: boolean }[] = []
  engineBottom(on, registered)
  await start($)
  expect(registered).toEqual([])
})

test('the progress tool never asks for permission; other tools still do', async ($, on) => {
  engineBottom(on)
  expect((await $.tool.check({ tool: PROGRESS_TOOL, input: {} })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('ask')
})

test('a report is answered ok by the mod itself, a malformed one too', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  expect((await report($, { left: [{ do: 'read the code', size: 's' }] })).result).toBe('ok')
  expect((await report($, { left: 'nonsense', done: 'x' })).result).toBe('ok')
  const other = (await $.tool.call({ tool: 'Bash', command: 'ls' })) as { result?: unknown }
  expect(other.result, 'other tools still reach the engine').toBe('engine')
})

test('the system prompt asks for reports only when the tool is offered', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine', scope: 'shared' as const }] }))
  const offered = await $.prompt.compose({ ...base, tools: ['Bash', PROGRESS_TOOL] })
  const line = offered.sections.find(s => s.id === 'session-progress:eta')
  expect(line?.text).toContain(`report what is left with ${PROGRESS_TOOL}`)
  expect(line?.text, 'the first report comes with the first tool calls, not once the work is understood').toContain('first response that calls tools')
  // How to report is the tool's description, which every request carries already; the line does not repeat it.
  expect(line?.text).toContain('Its description says how')
  expect(line?.text).not.toContain('never on its own')
  const without = await $.prompt.compose({ ...base, tools: ['Bash'] })
  expect(without.sections.some(s => s.id === 'session-progress:eta')).toBe(false)
})

test('eta: off adds no prompt line, even with the tool listed', { options: { eta: 'off' } }, async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine', scope: 'shared' as const }] }))
  const offered = await $.prompt.compose({ ...base, tools: ['Bash', PROGRESS_TOOL] })
  expect(offered.sections.some(s => s.id === 'session-progress:eta')).toBe(false)
})

test('the transcript draws no row for a report, and still draws the others', async ($, on) => {
  engineBottom(on)
  const drawn = async (component: 'ToolUse' | 'ToolResult', tool: string) => {
    const props =
      component === 'ToolUse'
        ? { tool_use_id: 'u1', tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false }
        : { tool_use_id: 'u1', tool, output: 'ok', isErrored: false }
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component, props } as Parameters<Engine['ui']['mount']>[0])
    const found = await ui.find({ text: /engine-row/ })
    await ui.unmount()
    return found !== undefined
  }
  expect(await drawn('ToolUse', PROGRESS_TOOL)).toBe(false)
  expect(await drawn('ToolResult', PROGRESS_TOOL)).toBe(false)
  expect(await drawn('ToolUse', 'Bash')).toBe(true)
})

test('a report is not counted as a tool call', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'investigate', turnId: 't1' })
  for (const command of ['ls', 'git status', 'npm test']) await $.tool.call({ tool: 'Bash', command })
  await report($, { left: [{ do: 'look around', size: 's' }] })
  await report($, { done: 1 })
  await clock.advance(21_000)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const texts = (await ui.findAll({})).map(el => el.text)
  await ui.unmount()
  expect(texts.some(t => /^⚒ 3 tool calls$/.test(t))).toBe(true)
})

test('a report is read leniently: trimmed, clamped, sizes checked, a command winning over a size', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ do: `item ${i}`, size: 's' }))
  expect(parseReport({ left: many })).toEqual({ left: many.slice(0, 30) })
  expect(parseReport({ left: [{ do: `  ${'x'.repeat(100)}  ` }] })).toEqual({ left: [{ do: 'x'.repeat(80) }] })
  expect(parseReport({ left: [{ do: 'run it', size: 'm', run: ' npm test ' }] })).toEqual({ left: [{ do: 'run it', run: 'npm test' }] })
  expect(parseReport({ left: [{ do: 'odd', size: 'xl' }, { do: '' }, 'read the code', 7] })).toEqual({ left: [{ do: 'odd' }, { do: 'read the code' }] })
  expect(parseReport({ left: [] })).toEqual({ left: [] })
  expect(parseReport({ left: [7, ''] }), 'a list of nothing usable says nothing').toBeNull()
  expect(parseReport({ left: [{ task: 'x' }] })).toBeNull()
  expect(parseReport({ done: 2.7 })).toEqual({ done: 2 })
  expect(parseReport({ done: 0 })).toBeNull()
  expect(parseReport({ done: 'x' })).toBeNull()
  expect(parseReport({})).toBeNull()
  expect(parseReport({ left: [{ do: 'a' }], done: 1 }), 'the whole list wins over done').toEqual({ left: [{ do: 'a' }] })
})

const a = { do: 'read the code', size: 's' as const }
const b = { do: 'fix the parser', size: 'm' as const }
const c = { do: 'run the tests', run: 'npm test' }

test('the first report starts the list; done: 1 ends the top item and times it', () => {
  const first = applyReport(null, { left: [a, b] }, 100)
  expect(first).toEqual({ work: { items: [a, b], finished: [], topSince: 100 }, finished: null })
  const next = applyReport(first.work, { done: 1 }, 400)
  expect(next.work).toEqual({ items: [b], finished: ['read the code'], topSince: 400 })
  expect(next.finished).toEqual({ item: a, since: 100 })
})

test('done for several items, or more than the list holds, empties what it says and times nothing', () => {
  const work = { items: [a, b, c], finished: [], topSince: 100 }
  expect(applyReport(work, { done: 2 }, 400)).toEqual({ work: { items: [c], finished: ['read the code', 'fix the parser'], topSince: 400 }, finished: null })
  const all = applyReport({ items: [a, b], finished: [], topSince: 100 }, { done: 5 }, 400)
  expect(all.work?.items).toEqual([])
  expect(all.finished).toBeNull()
  expect(applyReport({ items: [a], finished: [], topSince: 100 }, { done: 5 }, 400).finished).toBeNull()
})

test('done before any list changes nothing', () => {
  expect(applyReport(null, { done: 1 }, 400)).toEqual({ work: null, finished: null })
  expect(applyReport({ items: [], finished: ['x'], topSince: 1 }, { done: 1 }, 400)).toEqual({ work: { items: [], finished: ['x'], topSince: 1 }, finished: null })
})

test('a new list without the top item ends it; one that keeps it keeps its clock; items dropped lower down are not finished', () => {
  const work = { items: [a, b, c], finished: [], topSince: 100 }
  const moved = applyReport(work, { left: [b, c] }, 400)
  expect(moved.work).toEqual({ items: [b, c], finished: ['read the code'], topSince: 400 })
  expect(moved.finished).toEqual({ item: a, since: 100 })
  expect(applyReport(work, { left: [a, c] }, 400)).toEqual({ work: { items: [a, c], finished: [], topSince: 100 }, finished: null })
  const reordered = applyReport(work, { left: [b, a] }, 400)
  expect(reordered.work?.topSince, 'another item on top starts its own clock').toBe(400)
  expect(reordered.finished).toBeNull()
  expect(applyReport({ items: [a], finished: [], topSince: 100 }, { left: [] }, 400).finished, 'an empty list ends the last item').toEqual({ item: a, since: 100 })
})

test('the band lists a work list as steps: finished, the one in progress, the rest', () => {
  expect(workTasks({ items: [b, c], finished: ['read the code'], topSince: 1 })).toEqual([
    { id: 'done-0', subject: 'read the code', status: 'completed' },
    { id: 'work-0', subject: 'fix the parser', status: 'in_progress' },
    { id: 'work-1', subject: 'run the tests', status: 'pending' },
  ])
})
