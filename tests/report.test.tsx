import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PROGRESS_TOOL } from '../hooks/report'

const PLUGIN = 'session-progress'

function engineBottom(on: On, registered: { name: string; isDeferred?: boolean }[] = []) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('tool.register', ($, e) => {
    registered.push({ name: e.name, isDeferred: e.isDeferred })
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
  engineBottom(on, registered)
  await start($)
  expect(registered).toEqual([{ name: 'progress', isDeferred: false }])
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
  expect(line?.text).toContain('never on its own')
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
