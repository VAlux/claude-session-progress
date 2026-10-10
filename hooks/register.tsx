import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Live, PlanFile, PlanTask, Summary, Task, TaskStatus, Totals } from '../types'
import {
  ACCENT,
  DONE,
  FAIL,
  WARN,
  activityLabel,
  barCells,
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
  tokens,
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

// What the frame loop paints between redraws. Module state: a reload refills it on the next draw.
const scene = {
  requestId: null as string | null,
  barWidth: 0,
  // What the bar's own label shows between redraws: the live percentage, or a fixed text (the clock).
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
    files: [],
    running: [],
    lastActivity: null,
    tokensIn: 0,
    tokensCached: 0,
    tokensOut: 0,
    model: null,
  }
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

async function trackPlan($: Dollar, e: { tool: string } & Record<string, unknown>, result: unknown) {
  if (e.tool === 'TodoWrite' && Array.isArray(e.todos)) {
    const todos = e.todos as { content: string; status: TaskStatus; activeForm?: string }[]
    await update($, tasks, () => todos.map((t, i) => ({ id: `todo-${i}`, subject: t.content, activeForm: t.activeForm, status: t.status })))
  } else if (e.tool === 'TaskCreate') {
    const id = (result as { task?: { id?: string } } | undefined)?.task?.id
    if (typeof id !== 'string') return
    const task: Task = {
      id,
      subject: String(e.subject ?? 'Task'),
      activeForm: typeof e.activeForm === 'string' ? e.activeForm : undefined,
      status: 'pending',
    }
    await update($, tasks, list => [...list.filter(t => t.id !== id), task])
  } else if (e.tool === 'TaskUpdate' && typeof e.taskId === 'string') {
    const status = (e.status as TaskStatus | 'deleted' | undefined) ?? undefined
    const subject = typeof e.subject === 'string' ? e.subject : undefined
    const activeForm = typeof e.activeForm === 'string' ? e.activeForm : undefined
    await update($, tasks, list => {
      const current = list.find(t => t.id === e.taskId)
      if (current === undefined) return list
      return setTaskStatus(list, e.taskId as string, status ?? current.status, subject, activeForm)
    })
  }
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
    if (current !== null) {
      startTicking($)
      if (current.isLong) startFrames($)
    }
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
    const result = yield* next(e)
    const usage = result.usage
    await update($, live, l => {
      if (l === null) return l
      return {
        ...l,
        steps: e.agentId === undefined ? l.steps + 1 : l.steps,
        tokensIn: l.tokensIn + (usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : 0),
        tokensCached: l.tokensCached + (usage?.cache_read_input_tokens ?? 0),
        tokensOut: l.tokensOut + (usage?.output_tokens ?? 0),
        model: e.agentId === undefined ? (usage?.model ?? e.model) : l.model,
      }
    })
    return result
  })

  on('tool.call', async ($, e, next) => {
    if ((await read($, live)) === null) return next(e)

    const input = e as unknown as { tool: string } & Record<string, unknown>
    const name = shortToolName(e.tool)
    const label = activityLabel(e.tool, input)
    const isSub = e.agentId !== undefined
    const isAgent = e.tool === 'Agent' || String(e.tool) === 'Task'

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
          },
    )

    const ran = await next(e)
    const failed = ran.deny !== undefined || ran.isError === true
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null

    await update($, live, l =>
      l === null
        ? l
        : {
            ...l,
            errors: failed ? l.errors + 1 : l.errors,
            running: l.running.filter(r => r.id !== e.tool_use_id),
            files: !failed && WRITE_TOOLS.has(e.tool) && path !== null && !l.files.includes(path) ? [...l.files, path].slice(-500) : l.files,
          },
    )
    if (!failed && tracksPlanTool(e.tool, isSub)) await trackPlan($, input, ran.result)
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
    if (e.agentId !== undefined) return next(e)
    stopTicking()

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
          files: l.files.length,
          tasksDone: plan.list.filter(t => t.status === 'completed').length,
          tasksTotal: plan.list.length,
          stepsUnit: plan.unit,
          stepsSource: plan.source,
          tokensIn,
          tokensCached: Math.max(l.tokensCached, usage?.cache_read_input_tokens ?? 0),
          tokensOut,
          model: usage?.model ?? l.model,
        }
        await update($, summary, () => done)
        scene.palette = e.reason === 'answer' ? DONE : e.reason === 'aborted' ? WARN : FAIL
        scene.target = e.reason === 'answer' ? 1 : (plan.progress ?? scene.shown)
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
    // The animated Raster bar is the terminal's alone.
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)

    const l = await read($, live)
    const s = await read($, summary)
    const steps = await readSteps($)
    const plan = steps.list
    await read($, tick) // redraw each second for the clock

    const showLive = l !== null && l.isLong
    const showSummary = !showLive && s !== null && !e.props.isWorking
    if (!showLive && !showSummary) return next(e)

    // Another mod's band beneath this one (factory-floor's strip, say) stays visible, drawn above ours.
    const below = await next(e)
    const maxRows = Math.max(1, e.props.maxRows - (below == null ? 0 : 2))

    const { Box, Text, Raster } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const now = await $.clock.now()
    const t = Date.now()

    scene.requestId = e.requestId

    if (showLive) {
      const progress = steps.progress
      // A last live draw can land after the turn ended: it must not repaint the finish orange.
      if (!scene.isFinishing) {
        scene.target = progress
        scene.palette = ACCENT
      }
      const label = progress === null ? duration(now - l.startedAt) : pctLabel(progress)
      if (!scene.isFinishing) {
        scene.showPct = progress !== null
        scene.label = label
      }
      scene.barWidth = Math.max(12, width - BAR_SLACK)

      const current = plan.find(task => task.status === 'in_progress')
      const headline = current?.activeForm ?? current?.subject ?? l.running[l.running.length - 1]?.label ?? l.lastActivity ?? 'Thinking'
      const done = plan.filter(task => task.status === 'completed').length
      const stats = [
        plural(l.toolCalls, 'tool call'),
        l.subagents > 0 ? `${plural(l.subagents, 'subagent')} (${l.subagentToolCalls} calls)` : null,
        l.files.length > 0 ? `${plural(l.files.length, 'file')} changed` : null,
        plural(l.steps, 'step'),
        l.tokensOut > 0 ? `${tokens(l.tokensIn)}↑ ${tokens(l.tokensOut)}↓` : null,
        l.errors > 0 ? plural(l.errors, 'error') : null,
      ].filter(Boolean)

      const rows = [
        <Box key="head-row" flexDirection="row" justifyContent="space-between" width={width}>
          <Box flexDirection="row" flexShrink={1}>
            <Raster key={SPINNER_KEY} columns={1} rows={1} cells={spinnerCells(t, ACCENT)} />
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
        <Box key="bar-row" flexDirection="row" width={width} flexShrink={0}>
          <Raster
            key={BAR_KEY}
            columns={scene.barWidth}
            rows={1}
            cells={barCells(scene.barWidth, progress === null ? null : scene.shown, t, ACCENT, {
              label,
              labelColor: progress === null ? MUTED : ACCENT.base,
            })}
          />
        </Box>,
        <Text key="stats" dimColor wrap="truncate-end">
          {stats.join('  ·  ')}
        </Text>,
      ]

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

      const room = Math.max(0, Math.min(MAX_TASK_ROWS, maxRows - rows.length - 1))
      if (plan.length > 0 && room > 0 && showsStepRows(stepRows, steps.source !== null)) {
        // Keep the active task in view: start from just before the first unfinished one.
        const firstOpen = Math.max(0, plan.findIndex(task => task.status !== 'completed'))
        const start = Math.max(0, Math.min(firstOpen - 1, plan.length - room))
        const visible = plan.slice(start, start + room)
        for (const task of visible) {
          const isDone = task.status === 'completed'
          const isActive = task.status === 'in_progress'
          rows.push(
            <Text key={`task-${task.id}`} wrap="truncate-end" dimColor={!isActive} strikethrough={false}>
              <Text color={isDone ? 'success' : isActive ? 'claude' : 'inactive'}>{isDone ? '  ✓ ' : isActive ? '  ◐ ' : '  ○ '}</Text>
              {isActive ? <Text bold>{task.subject}</Text> : task.subject}
            </Text>,
          )
        }
        const hidden = plan.length - visible.length
        if (hidden > 0) rows.push(<Text key="more" dimColor>{`    +${hidden} more`}</Text>)
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
    const palette: Palette = sum.reason === 'answer' ? DONE : sum.reason === 'aborted' ? WARN : FAIL
    const color = sum.reason === 'answer' ? 'success' : sum.reason === 'aborted' ? 'warning' : 'error'
    const mark = sum.reason === 'answer' ? '✓' : sum.reason === 'aborted' ? '■' : '✗'
    const title = sum.reason === 'answer' ? 'Task complete' : sum.reason === 'aborted' ? 'Interrupted' : sum.reason === 'refusal' ? 'Stopped (refusal)' : 'Ended with an error'
    const finalProgress = sum.reason === 'answer' ? 1 : sum.tasksTotal > 0 ? sum.tasksDone / sum.tasksTotal : null
    scene.barWidth = Math.max(12, width - BAR_SLACK)
    const barProgress = scene.isFinishing ? scene.shown : (finalProgress ?? 0)
    scene.palette = palette
    scene.showPct = finalProgress !== null
    scene.label = ''
    const label = finalProgress === null ? '' : pctLabel(barProgress)
    const cachePct = sum.tokensIn > 0 ? Math.round((sum.tokensCached / sum.tokensIn) * 100) : 0

    const work = [
      plural(sum.toolCalls, 'tool call'),
      sum.subagents > 0 ? `${plural(sum.subagents, 'subagent')} (${sum.subagentToolCalls} calls)` : null,
      sum.files > 0 ? `${plural(sum.files, 'file')} changed` : null,
      plural(sum.steps, 'model step'),
      sum.tasksTotal > 0
        ? `${sum.tasksDone}/${sum.tasksTotal} ${sum.stepsUnit} done${sum.stepsSource !== null ? ` (${sum.stepsSource})` : ''}`
        : null,
      sum.errors > 0 ? plural(sum.errors, 'failed call') : null,
    ].filter(Boolean)

    return (
      <Box flexDirection="column">
        {below}
        <Box key="head-row" flexDirection="row" justifyContent="space-between" width={width}>
          <Box flexDirection="row" flexShrink={1}>
            <Raster key={SPINNER_KEY} columns={1} rows={1} cells={glyphCells(mark, palette.base)} />
            <Text bold color={color}>
              {' '}
              {title}
            </Text>
            <Text dimColor> in {duration(sum.durationMs)}</Text>
          </Box>
          <Text dimColor>
            session: {plural(total.turns, 'turn')} · {duration(total.totalMs)}
          </Text>
        </Box>
        <Box key="bar-row" flexDirection="row" width={width} flexShrink={0}>
          <Raster
            key={BAR_KEY}
            columns={scene.barWidth}
            rows={1}
            cells={barCells(scene.barWidth, barProgress, t, palette, { shimmer: scene.isFinishing, label })}
          />
        </Box>
        <Text key="work" dimColor wrap="truncate-end">
          {work.join('  ·  ')}
        </Text>
        <Text key="tokens" dimColor wrap="truncate-end">
          {tokens(sum.tokensIn)} in ({cachePct}% cached) · {tokens(sum.tokensOut)} out
          {sum.model ? ` · ${sum.model}` : ''}
          {total.turns > 1 ? `  ·  session ${tokens(total.tokensIn)} in · ${tokens(total.tokensOut)} out · ${total.toolCalls} calls` : ''}
        </Text>
        {sum.topTools.length > 0 && (
          <Text key="tools" dimColor wrap="truncate-end">
            {sum.topTools.map(([tool, n]) => `${tool} ${n}`).join('  ')}
          </Text>
        )}
      </Box>
    )
  })
}
