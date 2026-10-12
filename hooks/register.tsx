import { atom, read, update } from 'claude-code'
import type { Color, Elements, EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRun, Detail, Live, PlanFile, PlanTask, StatKind, Summary, Task, TaskStatus, Totals } from '../types'
import {
  ICONS,
  detailLines,
  detailOf,
  editLines,
  emptyDetail,
  errorText,
  finishCall,
  withAgent,
  withCall,
  withFile,
  withRead,
  withStep,
  type DetailLine,
  type DetailSource,
} from './details'
import {
  ACCENT,
  DONE,
  FAIL,
  WARN,
  activityLabel,
  barCells,
  barSvg,
  hex,
  MUTED,
  pctLabel,
  duration,
  glyphCells,
  isMarkdown,
  ledgerPlanName,
  ledgerTasks,
  parsePlan,
  plural,
  shortToolName,
  spinnerCells,
  spinnerSvg,
  stepCost,
  tokens,
  usd,
  type Palette,
} from './frames'

const live = atom({ plugin: 'session-progress', key: 'live' } as const, null)
const summary = atom({ plugin: 'session-progress', key: 'summary' } as const, null)
const tasks = atom({ plugin: 'session-progress', key: 'tasks' } as const, [])
const planFile = atom({ plugin: 'session-progress', key: 'planFile' } as const, null)
const totals = atom({ plugin: 'session-progress', key: 'totals' } as const, {
  turns: 0,
  longTurns: 0,
  totalMs: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
})
const tick = atom({ plugin: 'session-progress', key: 'tick' } as const, 0)
const agents = atom({ plugin: 'session-progress', key: 'agents' } as const, [])
const openStat = atom({ plugin: 'session-progress', key: 'openStat' } as const, null)

// When a turn earns the band: a quick answer or a short Q/A never does.
const SHOW_AFTER_MS = 20_000
const SHOW_AFTER_TOOLS = 3
const SHOW_WITH_PLAN_AFTER_MS = 8_000
const SHOW_ALWAYS_AFTER_MS = 45_000

const FRAME_MS = 70
const FINISH_MS = 1_400
const SPINNER_KEY = 'spin'
const BAR_KEY = 'bar'
const MAX_TASK_ROWS = 5
const MAX_DETAIL_ROWS = 8
// A subagent's band draws its own Raster keys, so the main bar's frame loop never paints into it.
const AGENT_SPINNER_KEY = 'agent-spin'
const AGENT_BAR_KEY = 'agent-bar'
const MAX_AGENTS = 30
// Spare columns after the bar's label: a row that fills the band exactly wraps on some terminals.
const BAR_SLACK = 2

const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const PLAN_FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write'])

/** A subagent's own TodoWrite/TaskCreate list never replaces the main one; its TaskUpdate may tick main tasks. */
export function tracksPlanTool(tool: string, isSubagent: boolean): boolean {
  return PLAN_TOOLS.has(tool) && (!isSubagent || tool === 'TaskUpdate')
}

function taskListLine(tools: readonly string[]): string | null {
  const how = tools.includes('TaskCreate') ? 'TaskCreate and TaskUpdate' : tools.includes('TodoWrite') ? 'TodoWrite' : null
  if (how === null) return null
  return (
    `When a task has several known steps, such as implementing a spec or a plan, keep a task list with ${how}: ` +
    'one entry per step before you start, marked in progress when you begin it and completed as soon as it is done. ' +
    'Skip the list for quick questions and single-step changes.'
  )
}

type Dollar = EngineInterface

type BarLook = { shimmer: boolean; label: string; labelColor: number }

/** What draws the band's spinner, marks and bar on one surface; the rows around them are the same on both. */
type Marks = {
  /** A row's width: the terminal lays the band out in cells, the desktop to its page. */
  rowWidth: number | string
  spinner(key: string, palette: Palette, t: number): JSX.Element
  mark(key: string, glyph: string, palette: Palette): JSX.Element
  bar(key: string, columns: number, progress: number | null, t: number, palette: Palette, look: BarLook): JSX.Element
}

/** Raster cells, which the frame loop repaints between redraws by their keys. */
function terminalMarks({ Raster }: Elements['terminal'], width: number): Marks {
  return {
    rowWidth: width,
    spinner: (key, palette, t) => <Raster key={key} columns={1} rows={1} cells={spinnerCells(t, palette)} />,
    mark: (key, glyph, palette) => <Raster key={key} columns={1} rows={1} cells={glyphCells(glyph, palette.base)} />,
    bar: (key, columns, progress, t, palette, look) => (
      <Raster key={key} columns={columns} rows={1} cells={barCells(columns, progress, t, palette, look)} />
    ),
  }
}

/** SVG that animates itself: the desktop takes no blits, so nothing repaints it between redraws. */
function desktopMarks({ Box, Text, Svg }: Elements['desktop']): Marks {
  return {
    rowWidth: '100%',
    spinner: (key, palette) => <Svg key={key} source={spinnerSvg(palette)} alt="Working" width={12} height={12} isInteractive />,
    mark: (key, glyph, palette) => (
      <Text key={key} bold color={hex(palette.base)}>
        {glyph}
      </Text>
    ),
    bar: (key, _columns, progress, _t, palette, { shimmer, label, labelColor }) => {
      const { source, isAnimated } = barSvg(progress, palette, { shimmer })
      const pct = label.trim()
      return (
        <Box flexDirection="row" flexGrow={1} alignItems="center" gap={1}>
          <Box flexGrow={1}>
            <Svg key={key} source={source} alt={pct === '' ? 'Progress: working' : `Progress: ${pct}`} height={6} isInteractive={isAnimated} />
          </Box>
          {pct !== '' && <Text color={hex(labelColor)}>{pct}</Text>}
        </Box>
      )
    },
  }
}

// What the frame loop paints between redraws. Module state: a reload refills it on the next draw.
const scene = {
  requestId: null as string | null,
  barWidth: 0,
  // What the bar's own label shows between redraws: the live percentage, or a fixed text (none while nothing is measured).
  showPct: false,
  label: '',
  target: null as number | null,
  shown: 0,
  palette: ACCENT,
  isFinishing: false,
  finishFrom: 0,
  finishFrames: 0,
}
let frameTimer: Timer | null = null
let tickTimer: Timer | null = null

function freshLive(turnId: string, startedAt: number): Live {
  return {
    turnId,
    startedAt,
    isLong: false,
    steps: 0,
    toolCalls: 0,
    subagentToolCalls: 0,
    subagents: 0,
    errors: 0,
    byTool: {},
    running: [],
    lastActivity: null,
    tokensIn: 0,
    tokensCached: 0,
    tokensCacheWrite: 0,
    tokensOut: 0,
    cost: 0,
    model: null,
    detail: emptyDetail(),
  }
}

function freshAgent(id: string, startedAt: number): AgentRun {
  return {
    id,
    description: null,
    type: null,
    parentId: null,
    dispatchedByMain: false,
    startedAt,
    finishedAt: null,
    durationMs: null,
    reason: null,
    steps: 0,
    toolCalls: 0,
    errors: 0,
    running: [],
    lastActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    detail: emptyDetail(),
    tasks: [],
  }
}

const isRunning = (run: AgentRun) => run.finishedAt === null

/** The subagents a finished main turn still waits on: the ones its own Agent calls started that have not answered. */
export function waitingOn(runs: readonly AgentRun[]): number {
  return runs.filter(run => run.dispatchedByMain && isRunning(run)).length
}

/** Applies `change` to an agent's run, adding the run first if the band has not seen that agent yet. */
async function updateAgent($: Dollar, id: string, now: number, change: (run: AgentRun) => AgentRun) {
  await update($, agents, list => {
    const i = list.findIndex(run => run.id === id)
    if (i >= 0) return list.map((run, j) => (j === i ? change(run) : run))
    return [...list, change(freshAgent(id, now))].slice(-MAX_AGENTS)
  })
}

const ENDED: Record<string, Summary['reason']> = { completed: 'answer', failed: 'error', killed: 'aborted' }

/** Marks the runs the engine says have ended, for an agent whose own end the band missed. */
async function reconcileAgents($: Dollar) {
  let known: { id: string; status: string }[]
  try {
    known = await $.agent.list()
  } catch {
    return
  }
  const ended = new Map(known.filter(a => ENDED[a.status] !== undefined).map(a => [a.id, ENDED[a.status]!]))
  if (ended.size === 0) return
  const now = await $.clock.now()
  await update($, agents, list =>
    list.map(run => (isRunning(run) && ended.has(run.id) ? { ...run, finishedAt: now, reason: ended.get(run.id)!, running: [] } : run)),
  )
}

function planProgress(list: readonly Task[]): number | null {
  if (list.length === 0) return null
  const done = list.filter(t => t.status === 'completed').length
  const active = list.filter(t => t.status === 'in_progress').length
  return (done + active * 0.5) / list.length
}

type Steps = { list: Task[]; progress: number | null; unit: 'tasks' | 'steps'; source: string | null }

export function stepsOf(taskList: readonly Task[], plan: PlanFile | null): Steps {
  if (taskList.length > 0) return { list: [...taskList], progress: planProgress(taskList), unit: 'tasks', source: null }
  if (plan === null) return { list: [], progress: null, unit: 'tasks', source: null }
  const headed = plan.tasks ?? []
  if (headed.length >= 2) {
    // A task is done when a ledger reported it or all its boxes are ticked: superpowers' executor only does the first.
    const completed = new Set(plan.completed ?? [])
    const isDone = (task: PlanTask) => completed.has(task.n) || (task.steps > 0 && task.stepsDone === task.steps)
    const firstOpen = headed.findIndex(task => !isDone(task))
    const list = headed.map((task, i): Task => ({
      id: `plan-task-${task.n}`,
      subject: task.text,
      status: isDone(task) ? 'completed' : i === firstOpen ? 'in_progress' : 'pending',
    }))
    return { list, progress: headed.filter(isDone).length / headed.length, unit: 'tasks', source: plan.name }
  }
  if (plan.items.length < 2) return { list: [], progress: null, unit: 'tasks', source: null }
  const firstOpen = plan.items.findIndex(item => !item.done)
  const list = plan.items.map((item, i): Task => ({
    id: `plan-${i}`,
    subject: item.text,
    status: item.done ? 'completed' : i === firstOpen ? 'in_progress' : 'pending',
  }))
  const done = plan.items.filter(item => item.done).length
  return { list, progress: done / plan.items.length, unit: 'steps', source: plan.name }
}

async function readSteps($: Dollar): Promise<Steps> {
  return stepsOf(await read($, tasks), await read($, planFile))
}

async function trackPlanFile($: Dollar, path: string, written: string | null) {
  let text = written
  if (text === null) {
    try {
      text = await $.fs.read(path)
    } catch {
      return
    }
  }
  const { items, tasks: headed } = parsePlan(text)
  const reported = ledgerTasks(text)
  const name = path.split('/').pop() || path
  await update($, planFile, current => {
    if (items.length < 2) {
      // A superpowers ledger read on its own ticks the plan it names (or the current one, if it names none).
      if (reported.length > 0 && current !== null && current.path !== path) {
        const of = ledgerPlanName(text)
        if (of === null || of === current.name) return withCompleted(current, reported)
      }
      return current?.path === path ? null : current
    }
    // Another file only takes over while it still has open steps (a finished checklist read for reference does not).
    const isOpen = items.some(item => !item.done)
    if (current !== null && current.path !== path && !isOpen && current.items.some(item => !item.done)) return current
    return { path, name, items, tasks: headed, completed: current?.path === path ? (current.completed ?? []) : [] }
  })
}

function withCompleted(plan: PlanFile, numbers: readonly number[]): PlanFile {
  const known = plan.completed ?? []
  const added = numbers.filter(n => !known.includes(n))
  return added.length === 0 ? plan : { ...plan, completed: [...known, ...added] }
}

/** The tasks a Bash call reports complete in its output, as superpowers' task-done prints them. */
function bashReported(ran: unknown): number[] {
  const r = ran as { result?: { stdout?: unknown }; text?: unknown }
  const out = typeof r.result?.stdout === 'string' ? r.result.stdout : typeof r.text === 'string' ? r.text : ''
  return ledgerTasks(out)
}

export function shouldShow(l: Live, now: number, planSize: number): boolean {
  const elapsed = now - l.startedAt
  if (elapsed >= SHOW_ALWAYS_AFTER_MS) return true
  if (planSize >= 2 && elapsed >= SHOW_WITH_PLAN_AFTER_MS) return true
  return elapsed >= SHOW_AFTER_MS && l.toolCalls + l.subagentToolCalls >= SHOW_AFTER_TOOLS
}

// A frame that did not land (the band collapsed or redrawing) is simply skipped.
const skipFrame = () => {}

function paint($: Dollar) {
  const t = Date.now()
  if (scene.isFinishing) {
    // A timed ease-out that lands exactly on the target, then one redraw so the
    // band's own tree (what a collapse and reopen shows) holds the settled bar.
    scene.finishFrames += 1
    const k = Math.min(1, (scene.finishFrames * FRAME_MS) / FINISH_MS)
    const to = scene.target ?? scene.finishFrom
    scene.shown = scene.finishFrom + (to - scene.finishFrom) * (1 - (1 - k) ** 3)
    if (k >= 1) return settle($)
  } else if (scene.target !== null) {
    scene.shown += (scene.target - scene.shown) * 0.12
  }
  if (scene.requestId === null || scene.barWidth <= 0) return
  const progress = scene.target === null ? null : scene.shown
  const label = scene.showPct ? pctLabel(scene.shown) : scene.label
  const labelColor = scene.showPct ? scene.palette.base : MUTED
  const cells = barCells(scene.barWidth, progress, t, scene.palette, { shimmer: true, label, labelColor })
  $.ui.blit({ requestId: scene.requestId, key: BAR_KEY, cells }).catch(skipFrame)
  if (!scene.isFinishing) {
    $.ui.blit({ requestId: scene.requestId, key: SPINNER_KEY, cells: spinnerCells(t, scene.palette) }).catch(skipFrame)
  }
}

function settle($: Dollar) {
  stopFrames()
  scene.isFinishing = false
  scene.shown = scene.target ?? scene.shown
  void update($, tick, n => n + 1)
}

function startFrames($: Dollar) {
  if (frameTimer === null) frameTimer = $.clock.every(FRAME_MS, () => paint($))
}

function stopFrames() {
  frameTimer?.cancel()
  frameTimer = null
}

function startTicking($: Dollar) {
  if (tickTimer !== null) return
  tickTimer = $.clock.every(1000, async () => {
    const now = await $.clock.now()
    const plan = await readSteps($)
    let becameLong = false
    await update($, live, l => {
      if (l === null || l.isLong || !shouldShow(l, now, plan.list.length)) return l
      becameLong = true
      return { ...l, isLong: true }
    })
    if (becameLong) startFrames($)
    await update($, tick, n => n + 1)
  })
}

function stopTicking() {
  tickTimer?.cancel()
  tickTimer = null
}

function setTaskStatus(list: readonly Task[], id: string, status: TaskStatus | 'deleted', subject?: string, activeForm?: string): Task[] {
  if (status === 'deleted') return list.filter(t => t.id !== id)
  return list.map(t => (t.id === id ? { ...t, status, subject: subject ?? t.subject, activeForm: activeForm ?? t.activeForm } : t))
}

/** A task list after one TodoWrite, TaskCreate or TaskUpdate call. */
function applyPlanTool(list: Task[], e: { tool: string } & Record<string, unknown>, result: unknown): Task[] {
  if (e.tool === 'TodoWrite' && Array.isArray(e.todos)) {
    const todos = e.todos as { content: string; status: TaskStatus; activeForm?: string }[]
    return todos.map((t, i) => ({ id: `todo-${i}`, subject: t.content, activeForm: t.activeForm, status: t.status }))
  } else if (e.tool === 'TaskCreate') {
    const id = (result as { task?: { id?: string } } | undefined)?.task?.id
    if (typeof id !== 'string') return list
    const task: Task = {
      id,
      subject: String(e.subject ?? 'Task'),
      activeForm: typeof e.activeForm === 'string' ? e.activeForm : undefined,
      status: 'pending',
    }
    return [...list.filter(t => t.id !== id), task]
  } else if (e.tool === 'TaskUpdate' && typeof e.taskId === 'string') {
    const status = (e.status as TaskStatus | 'deleted' | undefined) ?? undefined
    const subject = typeof e.subject === 'string' ? e.subject : undefined
    const activeForm = typeof e.activeForm === 'string' ? e.activeForm : undefined
    const current = list.find(t => t.id === e.taskId)
    if (current === undefined) return list
    return setTaskStatus(list, e.taskId, status ?? current.status, subject, activeForm)
  }
  return list
}

/** One count under the bar, drawn with its kind's icon; pressed, it opens that kind's details. */
type Stat = { kind: StatKind; text: string; color?: Color; lines?: { added: number; removed: number } }

const stat = (kind: StatKind, text: string, color?: Color): Stat => (color === undefined ? { kind, text } : { kind, text, color })

/** Files changed, with the lines added and removed where every write could be measured. */
export function filesStat(detail: Detail, count = detail.files.length): Stat {
  const measured = detail.files.length > 0 && detail.files.every(f => f.added !== null && f.removed !== null)
  if (!measured) return stat('files', `${plural(count, 'file')} changed`)
  const lines = detail.files.reduce((sum, f) => ({ added: sum.added + (f.added ?? 0), removed: sum.removed + (f.removed ?? 0) }), { added: 0, removed: 0 })
  return { kind: 'files', text: plural(count, 'file'), lines }
}

type StepRows = 'auto' | 'always' | 'never'

/** Whether the band lists the steps: in `auto`, only a plan file's, since Claude Code draws its own task list. */
export function showsStepRows(setting: StepRows, fromPlanFile: boolean): boolean {
  return setting === 'always' || (setting === 'auto' && fromPlanFile)
}

export const register: Register = (on, options) => {
  const stepRows: StepRows = options.stepRows === 'always' || options.stepRows === 'never' ? options.stepRows : 'auto'

  on('session.start', async ($, e, next) => {
    // A reload mid-turn: the state survived, the timers did not.
    const current = await read($, live)
    if (current !== null || (await read($, agents)).some(isRunning)) startTicking($)
    if (current?.isLong) startFrames($)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = taskListLine(e.tools)
    if (text === null) return composed
    return { ...composed, sections: [...composed.sections, { id: 'session-progress:task-list', text, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, summary, () => null)
    // A plan that finished last turn starts this one clean; an unfinished one carries on.
    await update($, tasks, list => (list.length > 0 && list.every(t => t.status === 'completed') ? [] : list))
    await update($, planFile, plan => (plan !== null && stepsOf([], plan).progress === 1 ? null : plan))
    await update($, live, () => freshLive(e.turnId, now))
    stopFrames()
    scene.isFinishing = false
    scene.palette = ACCENT
    scene.shown = 0
    startTicking($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    const stepIn = usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : 0
    const stepOut = usage?.output_tokens ?? 0
    const now = await $.clock.now()
    const step = {
      index: e.index,
      durationMs: now - startedAt,
      tools: result.toolUses.map(use => shortToolName(use.name)),
      tokensIn: stepIn,
      tokensOut: stepOut,
      stopReason: result.stopReason,
    }
    if (e.agentId !== undefined) {
      await updateAgent($, e.agentId, now, run => ({
        ...run,
        steps: run.steps + 1,
        tokensIn: run.tokensIn + stepIn,
        tokensOut: run.tokensOut + stepOut,
        detail: withStep(detailOf(run), step),
      }))
    }
    await update($, live, l => {
      if (l === null) return l
      return {
        ...l,
        steps: e.agentId === undefined ? l.steps + 1 : l.steps,
        tokensIn: l.tokensIn + stepIn,
        tokensCached: l.tokensCached + (usage?.cache_read_input_tokens ?? 0),
        tokensCacheWrite: (l.tokensCacheWrite ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
        tokensOut: l.tokensOut + stepOut,
        cost: (l.cost ?? 0) + stepCost(usage?.model ?? e.model, usage),
        model: e.agentId === undefined ? (usage?.model ?? e.model) : l.model,
        detail: e.agentId === undefined ? withStep(detailOf(l), step) : l.detail,
      }
    })
    return result
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    const isSub = agentId !== undefined
    // A background subagent goes on after the main turn ends: its calls still count toward its own run.
    const isLive = (await read($, live)) !== null
    if (!isLive && !isSub) return next(e)

    const input = e as unknown as { tool: string } & Record<string, unknown>
    const name = shortToolName(e.tool)
    const label = activityLabel(e.tool, input)
    const isAgent = e.tool === 'Agent' || String(e.tool) === 'Task'
    const now = await $.clock.now()

    const call = { id: e.tool_use_id, tool: e.tool, label, agentId, startedAt: now, durationMs: null, status: 'running' as const }

    if (agentId !== undefined) {
      await updateAgent($, agentId, now, run => ({
        ...run,
        finishedAt: null,
        reason: null,
        toolCalls: run.toolCalls + 1,
        running: [...run.running, { id: e.tool_use_id, label }],
        lastActivity: label,
        detail: withCall(detailOf(run), { ...call, agentId: undefined }),
      }))
      startTicking($)
    }

    await update($, live, l =>
      l === null
        ? l
        : {
            ...l,
            toolCalls: isSub ? l.toolCalls : l.toolCalls + 1,
            subagentToolCalls: isSub ? l.subagentToolCalls + 1 : l.subagentToolCalls,
            subagents: isAgent ? l.subagents + 1 : l.subagents,
            byTool: isSub ? l.byTool : { ...l.byTool, [name]: (l.byTool[name] ?? 0) + 1 },
            running: isSub ? l.running : [...l.running, { id: e.tool_use_id, label }],
            lastActivity: isSub ? l.lastActivity : label,
            detail: withCall(detailOf(l), call),
          },
    )

    const ran = await next(e)
    const failed = ran.deny !== undefined || ran.isError === true
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
    const ended = await $.clock.now()
    const finished = { durationMs: ended - now, status: failed ? ('error' as const) : ('ok' as const), error: failed ? errorText(ran) : undefined }
    const wrote = !failed && WRITE_TOOLS.has(e.tool) && path !== null
    const lines = wrote ? editLines(e.tool, input, ran.result) : null
    const isRead = !failed && e.tool === 'Read' && path !== null
    const started = (ran.result as { agentId?: unknown; agentType?: unknown } | undefined) ?? {}
    const startedId = !failed && isAgent && typeof started.agentId === 'string' ? started.agentId : null
    /** What this call adds to a turn's or a run's details once it has run. */
    const ranInto = (d: Detail): Detail => {
      let out = finishCall(d, e.tool_use_id, finished)
      if (path !== null && wrote) out = withFile(out, path, lines)
      if (path !== null && isRead) out = withRead(out, path)
      if (startedId !== null) out = withAgent(out, startedId)
      return out
    }

    await update($, live, l =>
      l === null
        ? l
        : {
            ...l,
            errors: failed ? l.errors + 1 : l.errors,
            running: l.running.filter(r => r.id !== e.tool_use_id),
            detail: ranInto(detailOf(l)),
          },
    )
    if (agentId !== undefined) {
      await updateAgent($, agentId, now, run => ({
        ...run,
        errors: failed ? run.errors + 1 : run.errors,
        running: run.running.filter(r => r.id !== e.tool_use_id),
        detail: ranInto(detailOf(run)),
        tasks: !failed && PLAN_TOOLS.has(e.tool) ? applyPlanTool(run.tasks, input, ran.result) : run.tasks,
      }))
    }
    if (startedId !== null) {
      await updateAgent($, startedId, now, run => ({
        ...run,
        description: typeof input.description === 'string' ? input.description : run.description,
        type: typeof started.agentType === 'string' ? started.agentType : typeof input.subagent_type === 'string' ? input.subagent_type : run.type,
        parentId: agentId ?? null,
        dispatchedByMain: !isSub,
      }))
    }
    if (!isLive) return ran

    if (!failed && tracksPlanTool(e.tool, isSub)) await update($, tasks, list => applyPlanTool(list, input, ran.result))
    if (!failed && e.tool === 'Bash') {
      const reported = bashReported(ran)
      if (reported.length > 0) await update($, planFile, plan => (plan === null ? plan : withCompleted(plan, reported)))
    }
    if (!failed && PLAN_FILE_TOOLS.has(e.tool) && path !== null && isMarkdown(path)) {
      await trackPlanFile($, path, e.tool === 'Write' && typeof input.content === 'string' ? input.content : null)
    }

    return ran
  }).catch(($, e, next) => next(e)) // an observer: its failure never blocks the call

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const now = await $.clock.now()
      await updateAgent($, e.agentId, now, run => ({ ...run, finishedAt: now, durationMs: e.durationMs, reason: e.reason, running: [] }))
      if ((await read($, live)) === null && !(await read($, agents)).some(isRunning)) stopTicking()
      return next(e)
    }
    await reconcileAgents($)
    const waiting = e.reason === 'answer' ? waitingOn(await read($, agents)) : 0
    if (waiting === 0) stopTicking()

    const l = await read($, live)
    const plan = await readSteps($)
    if (l !== null) {
      const usage = e.usage
      const tokensIn = Math.max(l.tokensIn, usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : 0)
      const tokensOut = Math.max(l.tokensOut, usage?.output_tokens ?? 0)
      await update($, totals, (t): Totals => ({
        turns: t.turns + 1,
        longTurns: t.longTurns + (l.isLong ? 1 : 0),
        totalMs: t.totalMs + e.durationMs,
        toolCalls: t.toolCalls + l.toolCalls + l.subagentToolCalls,
        tokensIn: t.tokensIn + tokensIn,
        tokensOut: t.tokensOut + tokensOut,
        cost: (t.cost ?? 0) + (l.cost ?? 0),
      }))

      if (l.isLong) {
        const done: Summary = {
          reason: e.reason,
          durationMs: e.durationMs,
          steps: l.steps,
          toolCalls: l.toolCalls,
          subagentToolCalls: l.subagentToolCalls,
          subagents: l.subagents,
          errors: l.errors,
          topTools: Object.entries(l.byTool)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6),
          files: detailOf(l).files.length,
          tasksDone: plan.list.filter(t => t.status === 'completed').length,
          tasksTotal: plan.list.length,
          stepsUnit: plan.unit,
          stepsSource: plan.source,
          tokensIn,
          tokensCached: Math.max(l.tokensCached, usage?.cache_read_input_tokens ?? 0),
          tokensCacheWrite: Math.max(l.tokensCacheWrite ?? 0, usage?.cache_creation_input_tokens ?? 0),
          tokensOut,
          cost: l.cost ?? 0,
          model: usage?.model ?? l.model,
          detail: detailOf(l),
        }
        await update($, summary, () => done)
        // Handed off to a background subagent, the work is not done: the bar keeps what the plan says.
        scene.palette = waiting > 0 ? ACCENT : e.reason === 'answer' ? DONE : e.reason === 'aborted' ? WARN : FAIL
        scene.target = e.reason === 'answer' && waiting === 0 ? 1 : (plan.progress ?? scene.shown)
        scene.finishFrom = scene.shown
        scene.finishFrames = 0
        scene.isFinishing = true
        startFrames($)
      } else {
        stopFrames()
      }
    }
    await update($, live, () => null)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The band is raised on the terminal and the desktop alone.
    if ((e.surface !== 'terminal' && e.surface !== 'desktop') || e.props.hasSurvey) return next(e)

    await read($, tick) // redraw each second for the clock
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const opened = await read($, openStat)
    const isTerminal = e.surface === 'terminal'
    const marks = e.surface === 'terminal' ? terminalMarks($.ui.resolve(e), width) : desktopMarks($.ui.resolve(e))

    /** Up to `room` rows of a step list, keeping the active step in view, then a `+N more` row. */
    const stepRowsOf = (list: readonly Task[], room: number) => {
      const out: JSX.Element[] = []
      if (list.length === 0 || room <= 0) return out
      // Keep the active task in view: start from just before the first unfinished one.
      const firstOpen = Math.max(0, list.findIndex(task => task.status !== 'completed'))
      const start = Math.max(0, Math.min(firstOpen - 1, list.length - room))
      const visible = list.slice(start, start + room)
      for (const task of visible) {
        const isDone = task.status === 'completed'
        const isActive = task.status === 'in_progress'
        out.push(
          <Text key={`task-${task.id}`} wrap="truncate-end" dimColor={!isActive} strikethrough={false}>
            <Text color={isDone ? 'success' : isActive ? 'claude' : 'inactive'}>{isDone ? '  ✓ ' : isActive ? '  ◐ ' : '  ○ '}</Text>
            {isActive ? <Text bold>{task.subject}</Text> : task.subject}
          </Text>,
        )
      }
      const hidden = list.length - visible.length
      if (hidden > 0) out.push(<Text key="more" dimColor>{`    +${hidden} more`}</Text>)
      return out
    }

    /** One stat as a Button that opens its details under the row, or closes them when they are open. */
    const statButton = (stat: Stat) => {
      const isOpen = opened === stat.kind
      const iconColor = stat.color ?? (isOpen ? 'claude' : undefined)
      const parts: (string | JSX.Element)[] = [
        iconColor === undefined ? <Text key="icon">{ICONS[stat.kind]}</Text> : <Text key="icon" color={iconColor}>{ICONS[stat.kind]}</Text>,
        ` ${stat.text}`,
      ]
      if (stat.lines !== undefined) {
        parts.push(' ', <Text key="added" color="success">{`+${stat.lines.added}`}</Text>, ' ', <Text key="removed" color="error">{`−${stat.lines.removed}`}</Text>)
      }
      if (isOpen) parts.push(' ▾')
      return (
        <Box key={`stat-box-${stat.kind}`} flexShrink={0}>
          <Button key={`stat-${stat.kind}`} plain dimColor={!isOpen} onPress={() => void update($, openStat, now => (now === stat.kind ? null : stat.kind))}>
            {parts}
          </Button>
        </Box>
      )
    }

    /** A row of stats, wrapping onto a second line rather than cutting one off. */
    const statsRow = (key: string, items: readonly (Stat | false)[]) => (
      <Box key={key} flexDirection="row" flexWrap="wrap" columnGap={2} width={marks.rowWidth}>
        {items.filter((item): item is Stat => item !== false).map(statButton)}
      </Box>
    )

    /** The open stat's details, when this band draws that stat. */
    const detailRowsOf = (items: readonly (Stat | false)[], src: DetailSource, room: number) => {
      if (opened === null || !items.some(item => item !== false && item.kind === opened)) return []
      return detailLines(opened, src, Math.min(MAX_DETAIL_ROWS, room)).map(line => detailRow(line))
    }

    const detailRow = (line: DetailLine) => {
      const parts: (string | JSX.Element)[] = ['  ']
      if (line.glyph !== undefined) {
        parts.push(line.color === undefined ? `${line.glyph} ` : <Text key="glyph" color={line.color}>{`${line.glyph} `}</Text>)
      }
      parts.push(line.text)
      if (line.lines !== undefined) {
        parts.push('  ', <Text key="added" color="success">{`+${line.lines.added}`}</Text>, ' ', <Text key="removed" color="error">{`−${line.lines.removed}`}</Text>)
      }
      if (line.trail !== undefined) parts.push(<Text key="trail" dimColor>{`  ${line.trail}`}</Text>)
      return line.isNote ? (
        <Text key={`detail-${line.key}`} dimColor wrap="truncate-end">
          {parts}
        </Text>
      ) : (
        <Text key={`detail-${line.key}`} wrap="truncate-end">
          {parts}
        </Text>
      )
    }

    // A subagent's transcript in view: its own run, never the main conversation's.
    const viewed = e.props.view.agentId
    if (viewed !== undefined) {
      const run = (await read($, agents)).find(a => a.id === viewed)
      if (run === undefined) return next(e)
      const below = await next(e)
      const maxRows = Math.max(1, e.props.maxRows - (below == null ? 0 : 2))
      const now = await $.clock.now()
      const t = Date.now()
      const isDone = !isRunning(run)
      const list = run.tasks
      const progress = isDone && run.reason === 'answer' ? 1 : planProgress(list)
      const palette = !isDone ? ACCENT : run.reason === 'answer' ? DONE : run.reason === 'aborted' ? WARN : FAIL
      const color = !isDone ? 'claude' : run.reason === 'answer' ? 'success' : run.reason === 'aborted' ? 'warning' : 'error'
      const current = list.find(task => task.status === 'in_progress')
      const headline = isDone
        ? run.reason === 'answer'
          ? 'Subagent complete'
          : run.reason === 'aborted'
            ? 'Subagent interrupted'
            : 'Subagent ended with an error'
        : (current?.activeForm ?? current?.subject ?? run.running[run.running.length - 1]?.label ?? run.lastActivity ?? 'Starting')
      const elapsed = isDone ? (run.durationMs ?? (run.finishedAt ?? now) - run.startedAt) : now - run.startedAt
      const doneCount = list.filter(task => task.status === 'completed').length
      const barWidth = Math.max(12, width - BAR_SLACK)
      // With nothing to measure the bar goes unlabelled: the head row already shows the clock.
      const label = progress === null ? '' : pctLabel(progress)
      const detail = detailOf(run)
      const stats = [
        stat('tools', plural(run.toolCalls, 'tool call')),
        detail.files.length > 0 && filesStat(detail),
        detail.reads.length > 0 && stat('reads', `${detail.reads.length} read`),
        run.steps > 0 && stat('steps', plural(run.steps, 'step')),
        run.tokensOut > 0 && stat('tokens', `${tokens(run.tokensIn)}↑ ${tokens(run.tokensOut)}↓`),
        run.errors > 0 && stat('errors', plural(run.errors, 'error'), 'error'),
      ]
      const src: DetailSource = {
        detail,
        agents: [],
        tasks: list,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        model: null,
        now,
        columns: width,
      }
      const mark = !isDone ? null : run.reason === 'answer' ? '✓' : run.reason === 'aborted' ? '■' : '✗'

      const rows = [
        <Box key="head-row" flexDirection="row" justifyContent="space-between" width={marks.rowWidth}>
          <Box flexDirection="row" flexShrink={1}>
            {mark === null ? marks.spinner(AGENT_SPINNER_KEY, palette, t) : marks.mark(AGENT_SPINNER_KEY, mark, palette)}
            <Text bold color={color} wrap="truncate-end">
              {' '}
              {headline}
            </Text>
          </Box>
          <Text dimColor>
            {run.description ?? run.type ?? 'subagent'} · {list.length > 0 ? `${doneCount}/${list.length} tasks · ` : ''}
            {duration(elapsed)}
          </Text>
        </Box>,
        <Box key="bar-row" flexDirection="row" width={marks.rowWidth} flexShrink={0}>
          {marks.bar(AGENT_BAR_KEY, barWidth, progress, t, palette, { shimmer: !isDone, label, labelColor: progress === null ? MUTED : palette.base })}
        </Box>,
        statsRow('stats', stats),
      ]
      rows.push(...detailRowsOf(stats, src, maxRows - rows.length - 1))
      if (!isDone && run.running.length > 1) {
        rows.push(
          <Text key="running" dimColor wrap="truncate-end">
            ↳ {plural(run.running.length, 'call')} running: {run.running.map(r => r.label).join(', ')}
          </Text>,
        )
      } else if (!isDone && current !== undefined && run.lastActivity !== null) {
        rows.push(
          <Text key="running" dimColor wrap="truncate-end">
            ↳ {run.lastActivity}
          </Text>,
        )
      }
      // Claude Code draws no list for a subagent, so its band lists it unless step rows are off.
      if (stepRows !== 'never') rows.push(...stepRowsOf(list, Math.max(0, Math.min(MAX_TASK_ROWS, maxRows - rows.length - 1))))

      return (
        <Box flexDirection="column">
          {below}
          {rows.slice(0, Math.max(1, maxRows))}
        </Box>
      )
    }

    const l = await read($, live)
    const s = await read($, summary)
    const steps = await readSteps($)
    const plan = steps.list

    const showLive = l !== null && l.isLong
    const showSummary = !showLive && s !== null && !e.props.isWorking
    if (!showLive && !showSummary) return next(e)

    // Another mod's band beneath this one (factory-floor's strip, say) stays visible, drawn above ours.
    const below = await next(e)
    const maxRows = Math.max(1, e.props.maxRows - (below == null ? 0 : 2))

    const now = await $.clock.now()
    const t = Date.now()

    // The frame loop paints the terminal's band alone; the desktop's draws are whole each time.
    if (isTerminal) scene.requestId = e.requestId
    const barWidth = Math.max(12, width - BAR_SLACK)

    if (showLive) {
      const progress = steps.progress
      // With nothing to measure the bar goes unlabelled: the head row already shows the clock.
      const label = progress === null ? '' : pctLabel(progress)
      // A last live draw can land after the turn ended: it must not repaint the finish orange.
      if (isTerminal && !scene.isFinishing) {
        scene.target = progress
        scene.palette = ACCENT
        scene.showPct = progress !== null
        scene.label = label
      }
      if (isTerminal) scene.barWidth = barWidth

      const current = plan.find(task => task.status === 'in_progress')
      const headline = current?.activeForm ?? current?.subject ?? l.running[l.running.length - 1]?.label ?? l.lastActivity ?? 'Thinking'
      const done = plan.filter(task => task.status === 'completed').length
      const detail = detailOf(l)
      const stats = [
        stat('tools', plural(l.toolCalls, 'tool call')),
        l.subagents > 0 && stat('subagents', `${plural(l.subagents, 'subagent')} (${l.subagentToolCalls} calls)`),
        detail.files.length > 0 && filesStat(detail),
        detail.reads.length > 0 && stat('reads', `${detail.reads.length} read`),
        stat('steps', plural(l.steps, 'step')),
        l.tokensOut > 0 && stat('tokens', `${tokens(l.tokensIn)}↑ ${tokens(l.tokensOut)}↓${(l.cost ?? 0) > 0 ? ` · ${usd(l.cost ?? 0)}` : ''}`),
        l.errors > 0 && stat('errors', plural(l.errors, 'error'), 'error'),
      ]
      const src: DetailSource = {
        detail,
        agents: await read($, agents),
        tasks: plan,
        tokensIn: l.tokensIn,
        tokensOut: l.tokensOut,
        tokensCached: l.tokensCached,
        tokensCacheWrite: l.tokensCacheWrite,
        model: l.model,
        now,
        columns: width,
      }

      const rows = [
        <Box key="head-row" flexDirection="row" justifyContent="space-between" width={marks.rowWidth}>
          <Box flexDirection="row" flexShrink={1}>
            {marks.spinner(SPINNER_KEY, ACCENT, t)}
            <Text bold color="claude" wrap="truncate-end">
              {' '}
              {headline}
            </Text>
          </Box>
          <Text dimColor>
            {steps.source !== null ? `${steps.source} · ` : ''}
            {plan.length > 0 ? `${done}/${plan.length} ${steps.unit} · ` : ''}
            {duration(now - l.startedAt)}
          </Text>
        </Box>,
        // A fixed width, as the head row has: in a band laid out narrower than bodyColumns the bar would be squeezed and its last cells wrap.
        <Box key="bar-row" flexDirection="row" width={marks.rowWidth} flexShrink={0}>
          {marks.bar(BAR_KEY, barWidth, progress === null ? null : isTerminal ? scene.shown : progress, t, ACCENT, {
            shimmer: true,
            label,
            labelColor: progress === null ? MUTED : ACCENT.base,
          })}
        </Box>,
        statsRow('stats', stats),
      ]
      rows.push(...detailRowsOf(stats, src, maxRows - rows.length - 1))

      if (l.running.length > 1) {
        rows.push(
          <Text key="running" dimColor wrap="truncate-end">
            ↳ {plural(l.running.length, 'call')} running: {l.running.map(r => r.label).join(', ')}
          </Text>,
        )
      } else if (current !== undefined && l.lastActivity !== null) {
        rows.push(
          <Text key="running" dimColor wrap="truncate-end">
            ↳ {l.lastActivity}
          </Text>,
        )
      }

      if (showsStepRows(stepRows, steps.source !== null)) {
        rows.push(...stepRowsOf(plan, Math.max(0, Math.min(MAX_TASK_ROWS, maxRows - rows.length - 1))))
      }

      return (
        <Box flexDirection="column">
          {below}
          {rows.slice(0, Math.max(1, maxRows))}
        </Box>
      )
    }

    const sum = s as Summary
    const total = await read($, totals)
    const waiting = sum.reason === 'answer' ? waitingOn(await read($, agents)) : 0
    const palette: Palette = waiting > 0 ? ACCENT : sum.reason === 'answer' ? DONE : sum.reason === 'aborted' ? WARN : FAIL
    const color = waiting > 0 ? 'claude' : sum.reason === 'answer' ? 'success' : sum.reason === 'aborted' ? 'warning' : 'error'
    const mark = waiting > 0 ? '◐' : sum.reason === 'answer' ? '✓' : sum.reason === 'aborted' ? '■' : '✗'
    const title =
      waiting > 0
        ? `Waiting for ${plural(waiting, 'subagent')}`
        : sum.reason === 'answer'
          ? 'Task complete'
          : sum.reason === 'aborted'
            ? 'Interrupted'
            : sum.reason === 'refusal'
              ? 'Stopped (refusal)'
              : 'Ended with an error'
    const planned = sum.tasksTotal > 0 ? sum.tasksDone / sum.tasksTotal : null
    const finalProgress = sum.reason === 'answer' && waiting === 0 ? 1 : planned
    // The finish eases in on the terminal's frame loop; the desktop draws where it lands.
    const isEasing = isTerminal && scene.isFinishing
    // Waiting with no plan to measure, the bar sweeps rather than settle on a number it does not have.
    const barProgress = waiting > 0 && planned === null ? null : isEasing ? scene.shown : (finalProgress ?? 0)
    if (isTerminal) {
      scene.barWidth = barWidth
      scene.palette = palette
      scene.showPct = finalProgress !== null
      scene.label = ''
    }
    const label = finalProgress === null || barProgress === null ? '' : pctLabel(barProgress)
    const cachePct = sum.tokensIn > 0 ? Math.round((sum.tokensCached / sum.tokensIn) * 100) : 0

    const detail = detailOf(sum)
    const work = [
      stat('tools', plural(sum.toolCalls, 'tool call')),
      sum.subagents > 0 && stat('subagents', `${plural(sum.subagents, 'subagent')} (${sum.subagentToolCalls} calls)`),
      sum.files > 0 && filesStat(detail, sum.files),
      detail.reads.length > 0 && stat('reads', `${detail.reads.length} read`),
      stat('steps', plural(sum.steps, 'model step')),
      sum.tasksTotal > 0 &&
        stat('tasks', `${sum.tasksDone}/${sum.tasksTotal} ${sum.stepsUnit} done${sum.stepsSource !== null ? ` (${sum.stepsSource})` : ''}`),
      sum.errors > 0 && stat('errors', plural(sum.errors, 'failed call'), 'error'),
    ]
    const usage = [stat('tokens', `${tokens(sum.tokensIn)} in (${cachePct}% cached) · ${tokens(sum.tokensOut)} out${(sum.cost ?? 0) > 0 ? ` · ${usd(sum.cost ?? 0)} this task` : ''}${sum.model ? ` · ${sum.model}` : ''}`)]
    const src: DetailSource = {
      detail,
      agents: await read($, agents),
      tasks: plan,
      tokensIn: sum.tokensIn,
      tokensOut: sum.tokensOut,
      tokensCached: sum.tokensCached,
      tokensCacheWrite: sum.tokensCacheWrite,
      model: sum.model,
      now,
      columns: width,
    }
    // The open stat's details sit under the row it belongs to.
    const workDetail = detailRowsOf(work, src, maxRows - 4)
    const usageDetail = detailRowsOf(usage, src, maxRows - 4)

    return (
      <Box flexDirection="column">
        {below}
        <Box key="head-row" flexDirection="row" justifyContent="space-between" width={marks.rowWidth}>
          <Box flexDirection="row" flexShrink={1}>
            {marks.mark(SPINNER_KEY, mark, palette)}
            {/* No turn time: the engine's closing line (`Brewed for 5m 59s`) or the desktop's footer already says it. */}
            <Text bold color={color}>
              {' '}
              {title}
            </Text>
          </Box>
        </Box>
        <Box key="bar-row" flexDirection="row" width={marks.rowWidth} flexShrink={0}>
          {marks.bar(BAR_KEY, barWidth, barProgress, t, palette, { shimmer: isEasing, label, labelColor: palette.base })}
        </Box>
        {statsRow('work', work)}
        {workDetail}
        {statsRow('tokens', usage)}
        {usageDetail}
        {sum.topTools.length > 0 && (
          <Text key="tools" dimColor wrap="truncate-end">
            {sum.topTools.map(([tool, n]) => `${tool} ${n}`).join('  ')}
          </Text>
        )}
        {/* After one turn the session's totals are that turn's. */}
        {total.turns > 1 && (
          <Text key="session" dimColor wrap="truncate-end">
            Σ session: {plural(total.turns, 'turn')} · {duration(total.totalMs)} · {tokens(total.tokensIn)} in · {tokens(total.tokensOut)} out ·{' '}
            {(total.cost ?? 0) > 0 ? `${usd(total.cost ?? 0)} · ` : ''}
            {plural(total.toolCalls, 'call')}
          </Text>
        )}
      </Box>
    )
  })
}
