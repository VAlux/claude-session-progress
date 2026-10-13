import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { editLines, lineDelta, patchCount, shortPaths } from '../hooks/details'

const PLUGIN = 'session-progress'

function engineBottom(on: On) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.blit', () => ({ value: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine-band</Text>
  })
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: e.index === 0 ? [{ id: 'u1', name: 'Read', input: {} }, { id: 'u2', name: 'Read', input: {} }] : [],
      stopReason: e.index === 0 ? ('tool_use' as const) : ('end_turn' as const),
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' },
    } as never
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Agent') return { result: { agentId: 'a1', agentType: 'Explore' } } as never
    if (e.tool === 'Bash' && e.command === 'false') return { result: 'Exit code 1\nboom', isError: true } as never
    if (e.tool === 'Edit') {
      return {
        result: { structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-old', '+new', '+more'] }] },
      } as never
    }
    if (e.tool === 'Write') return { result: { type: 'create', structuredPatch: [], originalFile: null } } as never
    return { result: 'ok' } as never
  })
}

function mount($: Engine, surface: 'terminal' | 'desktop', isWorking: boolean) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
}

async function step($: Engine, index: number) {
  const s = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of s) {
    // drain
  }
  return s.result
}

async function busyTurn($: Engine, on: On) {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'work', turnId: 't1' })
  await step($, 0)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/b.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'old', new_string: 'new\nmore' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/docs/notes.md', content: 'one\ntwo\nthree\n' })
  await $.tool.call({ tool: 'Bash', command: 'false', description: 'Run the failing check' })
  await $.tool.call({ tool: 'Agent', description: 'Survey the repo', prompt: 'look', subagent_type: 'Explore' })
  await step($, 1)
  await clock.advance(30_000)
  return clock
}

const texts = async (ui: Awaited<ReturnType<typeof mount>>) => (await ui.findAll({})).map(el => el.text)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: each stat is a button with its icon, and the files stat counts lines`, async ($, on) => {
    await busyTurn($, on)
    const ui = await mount($, surface, true)
    for (const [key, text] of [
      ['stat-tools', /^⚒ 6 tool calls$/],
      ['stat-subagents', /^⑂ 1 subagent \(0 calls\)$/],
      ['stat-files', /^✎ 2 files \+5 −1$/],
      ['stat-reads', /^⌕ 2 read$/],
      ['stat-steps', /^↻ 2 steps$/],
      ['stat-errors', /^⚠ 1 error$/],
    ] as const) {
      const button = await ui.find({ type: 'Button', key })
      expect(button?.text, key).toMatch(text)
    }
    await ui.unmount()
  })

  test(`${surface}: pressing a stat lists its details, and pressing it again closes them`, async ($, on) => {
    await busyTurn($, on)
    const ui = await mount($, surface, true)
    expect((await texts(ui)).some(t => /notes\.md/.test(t)), 'closed at first').toBe(false)

    await ui.press({ key: 'stat-files' })
    const files = await texts(ui)
    expect(files.some(t => /^\s+a\.ts\s+\+2 −1$/.test(t)), 'a.ts with its lines').toBe(true)
    expect(files.some(t => /^\s+notes\.md\s+\+3 −0$/.test(t)), 'a new file counts every line').toBe(true)
    expect((await ui.find({ type: 'Button', key: 'stat-files' }))?.text).toMatch(/▾$/)

    await ui.press({ key: 'stat-files' })
    expect((await texts(ui)).some(t => /notes\.md/.test(t)), 'closed again').toBe(false)
    await ui.unmount()
  })
}

test('the tool calls stat lists each call with its outcome and a tally', async ($, on) => {
  await busyTurn($, on)
  const ui = await mount($, 'terminal', true)
  await ui.press({ key: 'stat-tools' })
  const rows = await texts(ui)
  await ui.unmount()
  expect(rows.some(t => /Read ×2, Edit, Write, Bash, Agent/.test(t)), 'the tally').toBe(true)
  expect(rows.some(t => /✓ reading a\.ts/.test(t))).toBe(true)
  expect(rows.some(t => /✗ \$ Run the failing check .*Exit code 1/.test(t)), 'a failure with its reason').toBe(true)
})

test('a `+N earlier` row opens the whole list, and `show fewer` takes it back', async ($, on) => {
  await busyTurn($, on)
  for (let i = 0; i < 12; i++) await $.tool.call({ tool: 'Read', file_path: `/repo/src/extra${i}.ts` })
  const ui = await mount($, 'terminal', true)
  await ui.press({ key: 'stat-tools' })
  const before = await texts(ui)
  expect(before.some(t => /^\s+\+\d+ earlier ▸ show all$/.test(t)), 'the cap hides the oldest calls').toBe(true)
  expect(before.some(t => /reading a\.ts/.test(t)), 'the first call is among them').toBe(false)

  await ui.press({ key: 'detail-more' })
  const all = await texts(ui)
  expect(all.some(t => /reading a\.ts/.test(t)), 'now the first call shows').toBe(true)
  expect(all.some(t => /earlier/.test(t))).toBe(false)

  await ui.press({ key: 'detail-fewer' })
  expect((await texts(ui)).some(t => /reading a\.ts/.test(t)), 'back to the latest').toBe(false)

  await ui.press({ key: 'detail-more' })
  await ui.press({ key: 'stat-tools' })
  await ui.press({ key: 'stat-tools' })
  expect((await texts(ui)).some(t => /reading a\.ts/.test(t)), 'reopening starts capped again').toBe(false)
  await ui.unmount()
})

test('the subagents, steps, errors and reads stats each open their own list', async ($, on) => {
  await busyTurn($, on)
  const ui = await mount($, 'terminal', true)

  await ui.press({ key: 'stat-subagents' })
  expect((await texts(ui)).some(t => /◐ Survey the repo \(Explore\)/.test(t))).toBe(true)

  await ui.press({ key: 'stat-steps' })
  const steps = await texts(ui)
  expect(steps.some(t => /#1 Read ×2 .*10k↑ 200↓/.test(t))).toBe(true)
  expect(steps.some(t => /#2 answered/.test(t))).toBe(true)
  expect(steps.some(t => /◐ Survey the repo/.test(t)), 'one list open at a time').toBe(false)

  await ui.press({ key: 'stat-errors' })
  expect((await texts(ui)).some(t => /✗ \$ Run the failing check/.test(t))).toBe(true)

  await ui.press({ key: 'stat-reads' })
  expect((await texts(ui)).some(t => /^\s+a\.ts\s+b\.ts$/.test(t))).toBe(true)
  await ui.unmount()
})

test('the finished summary keeps its details, and the token row opens a breakdown', async ($, on) => {
  await busyTurn($, on)
  await $.turn.complete({ turnId: 't1', durationMs: 20_000, answer: 'ok', isAborted: false, reason: 'answer', agentId: 'a1' } as never)
  await $.turn.complete({ turnId: 't1', durationMs: 30_000, answer: 'ok', isAborted: false, reason: 'answer' })
  const ui = await mount($, 'terminal', false)
  expect(await ui.find({ text: /Task complete/ })).toBeDefined()

  await ui.press({ key: 'stat-files' })
  expect((await texts(ui)).some(t => /notes\.md\s+\+3 −0/.test(t))).toBe(true)

  await ui.press({ key: 'stat-subagents' })
  expect((await texts(ui)).some(t => /✓ Survey the repo \(Explore\)/.test(t)), 'the subagent has finished').toBe(true)

  await ui.press({ key: 'stat-tokens' })
  const rows = await texts(ui)
  await ui.unmount()
  expect(rows.some(t => /↑ 20k in .*2\.0k fresh · 18k cache read \(90%\)/.test(t))).toBe(true)
  expect(rows.some(t => /↓ 400 out .*200 per step/.test(t))).toBe(true)
  expect(rows.some(t => /10k context/.test(t))).toBe(true)
})

test('line counts come from the tool\'s patch, else from what it was asked to write', () => {
  expect(patchCount([{ lines: [' a', '-b', '+c', '+d'] }])).toEqual({ added: 2, removed: 1 })
  expect(patchCount([])).toBeNull()
  expect(lineDelta('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ added: 1, removed: 1 })
  expect(editLines('Edit', { old_string: 'x', new_string: 'x\ny' }, 'ok')).toEqual({ added: 1, removed: 0 })
  expect(editLines('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: '' }] }, 'ok')).toEqual({
    added: 1,
    removed: 2,
  })
  expect(editLines('Write', { content: 'new\n' }, { type: 'update', structuredPatch: [], originalFile: 'old\n' })).toEqual({ added: 1, removed: 1 })
  expect(editLines('Write', { content: 'x' }, { type: 'update', structuredPatch: [], originalFile: null }), 'too large to diff').toBeNull()
  expect(editLines('NotebookEdit', { new_source: 'x' }, 'ok')).toBeNull()
})

test('files that share a name are told apart by their folder', () => {
  expect(shortPaths(['/r/src/index.ts', '/r/test/index.ts', '/r/README.md'])).toEqual(['src/index.ts', 'test/index.ts', 'README.md'])
})
