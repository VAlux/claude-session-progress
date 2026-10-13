import { atom, read, update } from 'claude-code'
import type { Color, Elements, EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRun, Detail, EtaPending, EtaTurn, Live, PlanFile, PlanTask, Spread, StatKind, Summary, Task, TaskStatus, Totals } from '../types'
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
  capitalize,
  countdownLabel,
  etaRange,
  etaValue,
  hex,
  isGrowing,
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
import {
  combine,
  commandKey,
  correction,
  emptyPending,
  estimate,
  freshEta,
  learnCommand,
  learnItem,
  learnTasks,
  paceOf,
  runningSince,
  tickEta,
  type EtaInput,
  type TaskKind,
} from './eta'
import { flushHistory, loadHistory, seeded, type History, type LogRow, type Store } from './history'
import { PROGRESS_SPEC, PROGRESS_TOOL, applyReport, etaLine, parseReport, workTasks } from './report'

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
const showAll = atom({ plugin: 'session-progress', key: 'showAll' } as const, false)
const etaTurn = atom({ plugin: 'session-progress', key: 'eta' } as const, null)

// What the settings turned on, read by the timers and hooks outside `register`. Module state: a reload sets it again.
const config = { eta: true }
// The countdown's history: read from the store when a session starts, refreshed by each write.
let history: History = seeded()
let project: string | null = null
// Writes to the store, one after another, so two loops ending at once never drop each other's samples.
let flushing: Promise<void> = Promise.resolve()

/** The part of `$.store` the history uses, spelled out here: the host lets a hooks module make only the `$` calls it can see it make. */
const storeOf = ($: Dollar): Store => ({ get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) })

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
  labelColor: MUTED,
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
    ...(config.eta ? { eta: freshEta(startedAt) } : {}),
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

/** Which samples a step list's entries take: a task list's, a plan's `### Task N:` headings', or a plan's boxes'. */
const taskKind = (steps: Steps): TaskKind => (steps.source === null ? 'task' : steps.unit === 'tasks' ? 'planTask' : 'planStep')

/** Reads the history once a session: at its start, or at a turn's when the session started before the mod. */
async function ensureHistory($: Dollar) {
  if (project !== null) return
  try {
    project = await $.session.root()
  } catch {
    project = ''
  }
  history = await loadHistory(storeOf($), project)
}

/** Writes a loop's samples after any write still under way. An interrupted loop's command times are not its commands' run times. */
async function flush($: Dollar, pending: EtaPending, isAborted: boolean, row: LogRow | null) {
  const kept = isAborted ? { ...pending, commands: {} } : pending
  flushing = flushing
    .then(async () => {
      const written = await flushHistory(storeOf($), project ?? '', kept, await $.clock.now(), row)
      if (written !== null) history = written
    })
    .catch(() => {})
  await flushing
}

/** One loop's countdown worked out again: its finished tasks learned, its estimate made, its bar moved on. */
function refreshed(eta: EtaTurn, detail: Detail, tasks: EtaInput['tasks'], rounds: number, now: number, waitedOn: readonly (Spread | null)[] | null): EtaTurn {
  const pace = paceOf(detail, eta.runs)
  const learned = tasks === null ? eta : learnTasks(eta, tasks.list, tasks.kind, now, pace, history.sizes)
  const own = estimate({
    now,
    pace,
    work: learned.work,
    runningSince: runningSince(detail, learned.work),
    tasks,
    since: learned.since,
    sizes: history.sizes,
    commands: history.commands,
    c: correction(learned.actual, learned.estimated),
    roundsSinceReport: rounds - learned.lastReportRound,
  })
  return tickEta(learned, waitedOn === null ? own : { ...own, estimate: combine(own.estimate, waitedOn) }, now)
}

/** Every loop's countdown, again: the subagents' first, since a main turn waiting on them shows the longest of theirs. */
async function refreshEta($: Dollar, now: number) {
  if (!config.eta) return
  await update($, agents, list =>
    list.map(run =>
      run.eta === undefined || !isRunning(run)
        ? run
        : { ...run, eta: refreshed(run.eta, detailOf(run), run.tasks.length > 0 ? { list: run.tasks, kind: 'task' } : null, run.steps, now, null) },
    ),
  )
  const l = await read($, live)
  const turnStart = (await read($, etaTurn))?.startedAt
  // While the turn is live, a subagent an earlier turn started is not its to wait on; after it, the ones still running are what the wait is.
  const waitedOn = (await read($, agents))
    .filter(run => run.dispatchedByMain && isRunning(run) && (l === null || turnStart === undefined || run.startedAt >= turnStart))
    .map(run => run.eta?.last ?? null)
  const steps = await readSteps($)
  await update($, etaTurn, eta => {
    if (eta === null) return eta
    // After the turn's own end, only the subagents it waits on are left to estimate.
    if (l === null) return tickEta(eta, { estimate: combine(null, waitedOn), items: [], source: null }, now)
    return refreshed(eta, detailOf(l), steps.list.length > 0 ? { list: steps.list, kind: taskKind(steps) } : null, l.steps, now, waitedOn)
  })
}

/** Takes in one of Claude's reports: its loop's list changes, a top item that finished is learned, the countdown is worked out again. */
async function takeReport($: Dollar, agentId: string | undefined, input: Record<string, unknown>) {
  const report = parseReport(input)
  if (report === null) return
  const now = await $.clock.now()
  const take = (eta: EtaTurn, detail: Detail, rounds: number): EtaTurn => {
    const { work, finished } = applyReport(eta.work, report, now)
    const added = 'left' in report ? report.left.flatMap(item => (item.run === undefined ? [] : [commandKey(item.run)])) : []
    const runs = [...new Set([...eta.runs, ...added])]
    const next = { ...eta, work, runs, lastReportRound: rounds }
    return finished === null ? next : learnItem(next, finished, now, paceOf(detail, runs), history.sizes)
  }
  if (agentId !== undefined) {
    await updateAgent($, agentId, now, run => ({ ...run, eta: take(run.eta ?? freshEta(run.startedAt), detailOf(run), run.steps) }))
  } else {
    const l = await read($, live)
    await update($, etaTurn, eta => (eta === null || l === null ? eta : take(eta, detailOf(l), l.steps)))
  }
  await refreshEta($, now)
}

/** A change to a task list or plan file is a report too, for the stale rule. */
async function markReport($: Dollar, agentId: string | undefined, now: number) {
  if (!config.eta) return
  if (agentId !== undefined) {
    await updateAgent($, agentId, now, run => (run.eta === undefined ? run : { ...run, eta: { ...run.eta, lastReportRound: run.steps } }))
  } else {
    const rounds = (await read($, live))?.steps ?? 0
    await update($, etaTurn, eta => (eta === null ? eta : { ...eta, lastReportRound: rounds }))
  }
  await refreshEta($, now)
}

/** Runs a change to the plan file, counted as a report only when the plan came out different (reading a README is no report). */
async function reportsPlanChange($: Dollar, now: number, change: () => Promise<unknown>) {
  if (!config.eta) {
    await change()
    return
  }
  const before = JSON.stringify(await read($, planFile))
  await change()
  if (JSON.stringify(await read($, planFile)) !== before) await markReport($, undefined, now)
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
  const labelColor = scene.showPct ? scene.palette.base : scene.labelColor
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
    // A Progress list of two or more items counts as a plan for when the band appears.
    const reported = (await read($, etaTurn))?.work?.items.length ?? 0
    let becameLong = false
    await update($, live, l => {
      if (l === null || l.isLong || !shouldShow(l, now, Math.max(plan.list.length, reported))) return l
      becameLong = true
      return { ...l, isLong: true }
    })
    if (becameLong) startFrames($)
    // A failure in the estimator must not skip the tick below, or the band's clock would freeze.
    await refreshEta($, now).catch(() => {})
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
  config.eta = options.eta !== 'off'
  // A fresh activation reads the history again, at the session's start or its first turn.
  project = null
  history = seeded()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The tool the countdown's reports come through; a reload registers it again, replacing it.
    if (config.eta) await $.tool.register(PROGRESS_SPEC).catch(() => {})
    // The history is read afresh whenever a session starts or the mod reloads: another session may have added to it.
    if (config.eta) {
      project = null
      await ensureHistory($)
    }
    // A reload mid-turn: the state survived, the timers did not.
    const current = await read($, live)
    if (current !== null || (await read($, agents)).some(isRunning)) startTicking($)
    if (current?.isLong) startFrames($)
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const lines = [
      { id: 'session-progress:task-list', text: taskListLine(e.tools) },
      { id: 'session-progress:eta', text: config.eta ? etaLine(e.tools) : null },
    ].filter((line): line is { id: string; text: string } => line.text !== null)
    if (lines.length === 0) return composed
    return { ...composed, sections: [...composed.sections, ...lines.map(line => ({ ...line, scope: 'session' as const }))] }
  }).catch(($, e, next) => next(e))

  // The mod's own tool runs without asking: it only feeds the band. The matcher spells the name out so the host's
  // scan can read it, and the check inside keeps every other tool's decision the engine's.
  on('tool.check', { tool: 'mcp__session-progress__progress' }, async ($, e, next) =>
    e.tool === PROGRESS_TOOL ? { decision: 'allow' as const } : next(e),
  ).catch(($, e, next) => next(e))

  // Claude's reports are answered here and never passed on: no other hook serves the mod's own tool.
  on('tool.call', { tool: 'mcp__session-progress__progress' }, async ($, e, next) => {
    if (e.tool !== PROGRESS_TOOL) return next(e)
    if (config.eta) await takeReport($, e.agentId, e as unknown as Record<string, unknown>)
    return { result: 'ok' }
  }).catch(() => ({ result: 'ok' }))

  // A report is for the band, not the transcript: its rows draw nothing.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== PROGRESS_TOOL) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  }).catch(($, e, next) => next(e))
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.tool !== PROGRESS_TOOL) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, summary, () => null)
    // A plan that finished last turn starts this one clean; an unfinished one carries on.
    await update($, tasks, list => (list.length > 0 && list.every(t => t.status === 'completed') ? [] : list))
    await update($, planFile, plan => (plan !== null && stepsOf([], plan).progress === 1 ? null : plan))
    await update($, live, () => freshLive(e.turnId, now))
    await ensureHistory($)
    // A Progress list belongs to its turn: unlike a plan, it does not carry over.
    await update($, etaTurn, () => (config.eta ? freshEta(now) : null))
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
      startedAt,
      durationMs: now - startedAt,
      tools: result.toolUses.filter(use => use.name !== PROGRESS_TOOL).map(use => shortToolName(use.name)),
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
    // The mod's own tool is answered by its own hook, and counts toward nothing.
    if (e.tool === PROGRESS_TOOL) return next(e)
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

    const command = config.eta && e.tool === 'Bash' && typeof input.command === 'string' && input.command.trim() !== '' ? commandKey(input.command) : null
    const call = {
      id: e.tool_use_id,
      tool: e.tool,
      label,
      agentId,
      startedAt: now,
      durationMs: null,
      status: 'running' as const,
      ...(command === null ? {} : { command }),
    }

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
    // A foreground command's time is how long it runs; a background one returns at once, and a refused one never ran.
    if (config.eta && command !== null && input.run_in_background !== true && ran.deny === undefined) {
      const ms = ended - now
      if (agentId !== undefined) await updateAgent($, agentId, ended, run => (run.eta === undefined ? run : { ...run, eta: learnCommand(run.eta, command, ms) }))
      else await update($, etaTurn, eta => (eta === null ? eta : learnCommand(eta, command, ms)))
    }
    if (agentId !== undefined && !failed && PLAN_TOOLS.has(e.tool)) await markReport($, agentId, ended)
    if (!isLive) return ran

    if (!failed && tracksPlanTool(e.tool, isSub)) {
      await update($, tasks, list => applyPlanTool(list, input, ran.result))
      await markReport($, undefined, ended)
    }
    if (!failed && e.tool === 'Bash') {
      const reported = bashReported(ran)
      if (reported.length > 0) {
        await reportsPlanChange($, ended, () => update($, planFile, plan => (plan === null ? plan : withCompleted(plan, reported))))
      }
    }
    if (!failed && PLAN_FILE_TOOLS.has(e.tool) && path !== null && isMarkdown(path)) {
      await reportsPlanChange($, ended, () => trackPlanFile($, path, e.tool === 'Write' && typeof input.content === 'string' ? input.content : null))
    }

    return ran
  }).catch(($, e, next) => next(e)) // an observer: its failure never blocks the call

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const now = await $.clock.now()
      const ended = (await read($, agents)).find(run => run.id === e.agentId)?.eta
      await updateAgent($, e.agentId, now, run => ({
        ...run,
        finishedAt: now,
        durationMs: e.durationMs,
        reason: e.reason,
        running: [],
        ...(run.eta === undefined ? {} : { eta: { ...run.eta, pending: emptyPending() } }),
      }))
      if (ended !== undefined) await flush($, ended.pending, e.reason === 'aborted', null)
      if ((await read($, live)) === null && !(await read($, agents)).some(isRunning)) stopTicking()
      return next(e)
    }
    await reconcileAgents($)
    const waiting = e.reason === 'answer' ? waitingOn(await read($, agents)) : 0
    if (waiting === 0) stopTicking()

    const l = await read($, live)
    const plan = await readSteps($)
    const eta = config.eta ? await read($, etaTurn) : null
    // The first estimate against what followed, for a turn that answered with nothing left running.
    const first = e.reason === 'answer' && waiting === 0 ? (eta?.first ?? null) : null
    const verdict =
      first === null ? null : { atMs: first.atMs, estimatedMs: first.ms, lowMs: first.lowMs, highMs: first.highMs, tookMs: Math.max(0, e.durationMs - first.atMs) }
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
          ...(eta !== null && eta.fill !== null ? { fill: eta.fill } : {}),
          ...(verdict === null ? {} : { eta: verdict }),
        }
        await update($, summary, () => done)
        // Handed off to a background subagent, the work is not done: the bar keeps what the plan says.
        scene.palette = waiting > 0 ? ACCENT : e.reason === 'answer' ? DONE : e.reason === 'aborted' ? WARN : FAIL
        scene.target = e.reason === 'answer' && waiting === 0 ? 1 : (eta?.fill ?? plan.progress ?? scene.shown)
        scene.finishFrom = scene.shown
        scene.finishFrames = 0
        scene.isFinishing = true
        startFrames($)
      } else {
        stopFrames()
      }
    }
    if (eta !== null) {
      const row: LogRow | null =
        first === null || verdict === null
          ? null
          : { at: await $.clock.now(), firstAtMs: verdict.atMs, estimatedMs: verdict.estimatedMs, lowMs: verdict.lowMs, highMs: verdict.highMs, tookMs: verdict.tookMs, source: first.source }
      await flush($, eta.pending, e.reason === 'aborted', row)
      // Waiting on subagents, the countdown goes on with theirs; otherwise it is done with.
      await update($, etaTurn, x => (x === null || waiting === 0 ? null : { ...x, pending: emptyPending() }))
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
    const isAll = await read($, showAll)
    const isTerminal = e.surface === 'terminal'
    const marks = e.surface === 'terminal' ? terminalMarks($.ui.resolve(e), width) : desktopMarks($.ui.resolve(e))

    /** Up to `room` rows of a step list, keeping the active step in view, then a `+N more` row; a row with a trail (its estimate) ends with it. */
    const stepRowsOf = (list: readonly Task[], room: number, trails: Readonly<Record<string, string>> = {}) => {
      const out: JSX.Element[] = []
      if (list.length === 0 || room <= 0) return out
      // Keep the active task in view: start from just before the first unfinished one.
      const firstOpen = Math.max(0, list.findIndex(task => task.status !== 'completed'))
      const start = Math.max(0, Math.min(firstOpen - 1, list.length - room))
      const visible = list.slice(start, start + room)
      for (const task of visible) {
        const isDone = task.status === 'completed'
        const isActive = task.status === 'in_progress'
        const row = (
          <Text key={`task-${task.id}`} wrap="truncate-end" dimColor={!isActive} strikethrough={false}>
            <Text color={isDone ? 'success' : isActive ? 'claude' : 'inactive'}>{isDone ? '  ✓ ' : isActive ? '  ◐ ' : '  ○ '}</Text>
            {isActive ? <Text bold>{task.subject}</Text> : task.subject}
          </Text>
        )
        const trail = trails[task.id]
        out.push(
          trail === undefined ? (
            row
          ) : (
            <Box key={`task-row-${task.id}`} flexDirection="row" justifyContent="space-between" width={marks.rowWidth}>
              <Box flexShrink={1}>{row}</Box>
              <Box flexShrink={0}>
                <Text dimColor>{` ${trail}`}</Text>
              </Box>
            </Box>
          ),
        )
      }
      const hidden = list.length - visible.length
      if (hidden > 0) out.push(<Text key="more" dimColor>{`    +${hidden} more`}</Text>)
      return out
    }

    /** Each listed item's estimate, as its row's trail. */
    const trailsOf = (items: readonly { key: string; ms: number }[] | undefined) => Object.fromEntries((items ?? []).map(item => [item.key, etaValue(item.ms)]))

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
          <Button key={`stat-${stat.kind}`} plain dimColor={!isOpen} onPress={() => {
            void update($, showAll, () => false)
            void update($, openStat, now => (now === stat.kind ? null : stat.kind))
          }}>
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
      // Pressing a `+N earlier` row lifts the cap: the list takes whatever room the band has.
      const lines = detailLines(opened, src, isAll ? room : Math.min(MAX_DETAIL_ROWS, room))
      const rows = lines.map(line => detailRow(line))
      if (isAll && lines.length > MAX_DETAIL_ROWS) {
        rows.push(
          <Button key="detail-fewer" plain dimColor onPress={() => void update($, showAll, () => false)}>
            {'  ▴ show fewer'}
          </Button>,
        )
      }
      return rows
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
      if (line.isMore === true && !isAll) {
        return (
          <Button key={`detail-${line.key}`} plain dimColor onPress={() => void update($, showAll, () => true)}>
            {`  ${line.text} ▸ show all`}
          </Button>
        )
      }
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
      const runEta = config.eta ? run.eta : undefined
      const work = runEta?.work ?? null
      // Claude Code draws no list for a subagent: its band lists its tasks, or its reports when it keeps no tasks.
      const usesWork = work !== null && run.tasks.length === 0
      const list = usesWork ? workTasks(work) : run.tasks
      const progress = isDone && run.reason === 'answer' ? 1 : config.eta ? (runEta?.fill ?? null) : planProgress(list)
      const palette = !isDone ? ACCENT : run.reason === 'answer' ? DONE : run.reason === 'aborted' ? WARN : FAIL
      const color = !isDone ? 'claude' : run.reason === 'answer' ? 'success' : run.reason === 'aborted' ? 'warning' : 'error'
      const current = list.find(task => task.status === 'in_progress')
      const named = current === undefined ? undefined : usesWork ? capitalize(current.subject) : (current.activeForm ?? current.subject)
      const headline = isDone
        ? run.reason === 'answer'
          ? 'Subagent complete'
          : run.reason === 'aborted'
            ? 'Subagent interrupted'
            : 'Subagent ended with an error'
        : (named ?? run.running[run.running.length - 1]?.label ?? run.lastActivity ?? 'Starting')
      const elapsed = isDone ? (run.durationMs ?? (run.finishedAt ?? now) - run.startedAt) : now - run.startedAt
      const doneCount = list.filter(task => task.status === 'completed').length
      const barWidth = Math.max(12, width - BAR_SLACK)
      const isUp = !isDone && isGrowing(runEta?.upUntil, now)
      // Running with the countdown on, the label counts down; finished, or without it, it is the share done.
      // A fill paced by time is no share, so with the countdown on only an answer names one.
      const label =
        config.eta && !isDone
          ? countdownLabel(runEta?.last ?? null, isUp, isTerminal, barWidth)
          : progress === null || (config.eta && run.reason !== 'answer')
            ? ''
            : pctLabel(progress)
      const labelColor = label === '' ? MUTED : isUp ? WARN.base : palette.base
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
            {run.description ?? run.type ?? 'subagent'} · {list.length > 0 ? `${doneCount}/${list.length} ${usesWork ? 'items' : 'tasks'} · ` : ''}
            {duration(elapsed)}
          </Text>
        </Box>,
        <Box key="bar-row" flexDirection="row" width={marks.rowWidth} flexShrink={0}>
          {marks.bar(AGENT_BAR_KEY, barWidth, progress, t, palette, { shimmer: !isDone, label, labelColor })}
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
      if (stepRows !== 'never') rows.push(...stepRowsOf(list, Math.max(0, Math.min(MAX_TASK_ROWS, maxRows - rows.length - 1)), usesWork ? trailsOf(runEta?.items) : {}))

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
      const eta = config.eta ? await read($, etaTurn) : null
      // With the countdown on, the bar follows its fill; without it, the share of the plan done.
      const progress = config.eta ? (eta?.fill ?? null) : steps.progress
      const isUp = isGrowing(eta?.upUntil, now)
      // With nothing to measure the bar goes unlabelled: the head row already shows the clock.
      const label = !config.eta ? (progress === null ? '' : pctLabel(progress)) : countdownLabel(eta?.last ?? null, isUp, isTerminal, barWidth)
      const labelColor = label === '' ? MUTED : isUp ? WARN.base : ACCENT.base
      // A last live draw can land after the turn ended: it must not repaint the finish orange.
      if (isTerminal && !scene.isFinishing) {
        scene.target = progress
        scene.palette = ACCENT
        scene.showPct = !config.eta && progress !== null
        scene.label = label
        scene.labelColor = labelColor
      }
      if (isTerminal) scene.barWidth = barWidth

      const work = eta?.work ?? null
      // Claude Code draws no list for Claude's reports, so the band lists them, unless a task list or plan file has the rows.
      const usesWork = work !== null && plan.length === 0
      const list = usesWork ? workTasks(work) : plan
      const unit = usesWork ? 'items' : steps.unit
      const current = list.find(task => task.status === 'in_progress')
      const named = current === undefined ? undefined : usesWork ? capitalize(current.subject) : (current.activeForm ?? current.subject)
      const headline = named ?? l.running[l.running.length - 1]?.label ?? l.lastActivity ?? 'Thinking'
      const done = list.filter(task => task.status === 'completed').length
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
        tasks: list,
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
            {list.length > 0 ? `${done}/${list.length} ${unit} · ` : ''}
            {duration(now - l.startedAt)}
          </Text>
        </Box>,
        // A fixed width, as the head row has: in a band laid out narrower than bodyColumns the bar would be squeezed and its last cells wrap.
        <Box key="bar-row" flexDirection="row" width={marks.rowWidth} flexShrink={0}>
          {marks.bar(BAR_KEY, barWidth, progress === null ? null : isTerminal ? scene.shown : progress, t, ACCENT, { shimmer: true, label, labelColor })}
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

      if (usesWork ? stepRows !== 'never' : showsStepRows(stepRows, steps.source !== null)) {
        rows.push(...stepRowsOf(list, Math.max(0, Math.min(MAX_TASK_ROWS, maxRows - rows.length - 1)), usesWork ? trailsOf(eta?.items) : {}))
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
    const eta = config.eta ? await read($, etaTurn) : null
    // With the countdown on, the bar stays where its fill got to; without it, at the plan's share done.
    const planned = sum.fill ?? (sum.tasksTotal > 0 ? sum.tasksDone / sum.tasksTotal : null)
    // Waiting on subagents, the fill goes on with their countdowns.
    const held = waiting > 0 ? (eta?.fill ?? planned) : planned
    const finalProgress = sum.reason === 'answer' && waiting === 0 ? 1 : held
    // The finish eases in on the terminal's frame loop; the desktop draws where it lands.
    const isEasing = isTerminal && scene.isFinishing
    // Waiting with nothing to measure, the bar sweeps rather than settle on a number it does not have.
    const barProgress = waiting > 0 && held === null ? null : isEasing ? scene.shown : (finalProgress ?? 0)
    // Only a wait counts down here, so a ↑ from it must not tint a settled finish.
    const isUp = waiting > 0 && isGrowing(eta?.upUntil, now)
    const waitLabel = waiting > 0 ? countdownLabel(eta?.last ?? null, isUp, isTerminal, barWidth) : ''
    // A wait with the countdown on shows the subagents' countdown or nothing: never a share it does not have.
    const isCounting = config.eta && waiting > 0
    // The same for a turn that did not answer: its fill is paced by time, so with the countdown on only the answer's 100% names a share.
    const showsPct = !isCounting && finalProgress !== null && (!config.eta || sum.reason === 'answer')
    if (isTerminal) {
      scene.barWidth = barWidth
      scene.palette = palette
      scene.showPct = showsPct
      scene.label = waitLabel
      scene.labelColor = isUp ? WARN.base : palette.base
    }
    const label = waitLabel !== '' ? waitLabel : !showsPct || barProgress === null ? '' : pctLabel(barProgress)
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
          {marks.bar(BAR_KEY, barWidth, barProgress, t, palette, { shimmer: isEasing || isCounting, label, labelColor: isUp ? WARN.base : palette.base })}
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
        {sum.eta !== undefined && (
          <Text key="eta" dimColor wrap="truncate-end">
            {`⏱ at ${duration(sum.eta.atMs)}: estimated ${etaValue(sum.eta.estimatedMs)} more${etaRange({ ms: sum.eta.estimatedMs, lowMs: sum.eta.lowMs, highMs: sum.eta.highMs }) ?? ''} · took ${duration(sum.eta.tookMs)} more`}
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
