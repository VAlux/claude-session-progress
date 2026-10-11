import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'session-progress'

function engineBottom(on: On, blits: { n: number } = { n: 0 }) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.blit', () => {
    blits.n += 1
    return { value: {} }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine-band</Text>
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Agent') return { result: { agentId: 'a1', agentType: 'general-purpose' } } as never
    return { result: e.tool === 'TodoWrite' ? { oldTodos: [], newTodos: e.todos } : 'ok' } as never
  })
}

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

function mount($: Engine, surface: Surface, isWorking: boolean, view: { agentId?: string } = {}) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view },
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

/** Whether the band shows `text` on `surface`: in a Text, in the terminal's bar cells, or in the desktop bar's alt. */
async function shows($: Engine, surface: Surface, isWorking: boolean, text: RegExp, view: { agentId?: string } = {}) {
  const ui = await mount($, surface, isWorking, view)
  const found = await ui.find({ text })
  const rasters = await ui.findAll({ type: 'Raster' })
  const svgs = await ui.findAll({ type: 'Svg' })
  await ui.unmount()
  return (
    found !== undefined ||
    rasters.some(bar => text.test(rasterText(String(bar.props.cells)))) ||
    svgs.some(svg => text.test(String(svg.props.alt)))
  )
}

/** The desktop's bar: the Svg its alt names as progress (the spinner is the other one). */
async function bar$(ui: { findAll: (q: { type: 'Svg' }) => Promise<{ props: Record<string, unknown> }[]> }) {
  return (await ui.findAll({ type: 'Svg' })).find(svg => /^Progress/.test(String(svg.props.alt)))
}

const done = (turnId: string, durationMs: number, agentId?: string) => ({
  turnId,
  durationMs,
  answer: 'ok',
  isAborted: false,
  reason: 'answer' as const,
  ...(agentId === undefined ? {} : { agentId }),
})

const todos = [
  { content: 'Write types', status: 'completed' as const, activeForm: 'Writing types' },
  { content: 'Write hooks', status: 'completed' as const, activeForm: 'Writing hooks' },
  { content: 'Write tests', status: 'in_progress' as const, activeForm: 'Writing tests' },
  { content: 'Validate', status: 'pending' as const, activeForm: 'Validating' },
]

for (const surface of SURFACES) {
  test(`${surface}: a long planned turn shows progress, then a summary`, async ($, on) => {
    engineBottom(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.turn.start({ text: 'build the feature', turnId: 't1' })
    await $.tool.call({ tool: 'TodoWrite', todos })
    await $.tool.call({ tool: 'Edit', file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' })
    await clock.advance(10_000)

    expect(await shows($, surface, true, /Writing tests/), 'headline').toBe(true)
    expect(await shows($, surface, true, /63%/), 'percentage').toBe(true)
    expect(await shows($, surface, true, /2\/4 tasks/), 'task count').toBe(true)
    expect(await shows($, surface, true, /1 file changed/), 'stats').toBe(true)

    await $.turn.complete(done('t1', 95_000))
    await clock.advance(2_000)
    expect(await shows($, surface, false, /Task complete/), 'title').toBe(true)
    expect(await shows($, surface, false, /100%/), 'full bar').toBe(true)
    expect(await shows($, surface, false, /1m 35s/), 'no repeat of the turn time').toBe(false)
  })

  test(`${surface}: a subagent's transcript gets its own band`, async ($, on) => {
    engineBottom(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.turn.start({ text: 'review', turnId: 't1' })
    await $.tool.call({ tool: 'Agent', description: 'Review the diff', prompt: 'review', subagent_type: 'general-purpose' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/tmp/a.ts', agentId: 'a1' } as never)
    await clock.advance(3_000)
    expect(await shows($, surface, true, /Review the diff/, { agentId: 'a1' })).toBe(true)
    await $.turn.complete(done('t1', 3_000, 'a1'))
    expect(await shows($, surface, false, /Subagent complete/, { agentId: 'a1' })).toBe(true)
  })
}

test('desktop: the band draws no Raster, and its bar is vector markup', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', todos })
  await clock.advance(10_000)
  const ui = await mount($, 'desktop', true)
  const rasters = await ui.findAll({ type: 'Raster' })
  const bar = await bar$(ui)
  await ui.unmount()
  expect(rasters.length).toBe(0)
  expect(bar).toBeDefined()
  expect(String(bar?.props.source)).toMatch(/^<svg[\s\S]*<\/svg>$/)
  expect(String(bar?.props.alt)).toMatch(/63%/)
})

test('desktop: a bar with nothing to measure sweeps by its own animation, and a settled one is still', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'investigate', turnId: 't1' })
  for (const command of ['ls', 'git status', 'npm test']) await $.tool.call({ tool: 'Bash', command })
  await clock.advance(21_000)

  let ui = await mount($, 'desktop', true)
  let bar = await bar$(ui)
  const first = String(bar?.props.source)
  await clock.advance(1_000) // the clock ticks, so the band redraws
  bar = await bar$(ui)
  await ui.unmount()
  expect(first).toMatch(/<animate/)
  expect(bar?.props.isInteractive).toBe(true)
  expect(String(bar?.props.source), 'the markup holds no clock, so a redraw never restarts the sweep').toBe(first)

  await $.turn.complete(done('t1', 42_000))
  await clock.advance(2_000)
  ui = await mount($, 'desktop', false)
  bar = await bar$(ui)
  await ui.unmount()
  expect(String(bar?.props.source)).not.toMatch(/<animate/)
  expect(bar?.props.isInteractive).not.toBe(true)
  expect(String(bar?.props.alt)).toMatch(/100%/)
})

test('desktop: the frame loop never paints, since nothing there takes a blit', async ($, on) => {
  const blits = { n: 0 }
  engineBottom(on, blits)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'investigate', turnId: 't1' })
  for (const command of ['ls', 'git status', 'npm test']) await $.tool.call({ tool: 'Bash', command })
  await clock.advance(21_000)
  const ui = await mount($, 'desktop', true)
  await clock.advance(1_000)
  await $.turn.complete(done('t1', 22_000))
  await clock.advance(2_000)
  await ui.unmount()
  expect(blits.n).toBe(0)
})

test('desktop: the band yields to a survey', async ($, on) => {
  engineBottom(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', todos })
  await clock.advance(10_000)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: true, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  expect(texts).toEqual(['engine-band'])
})
