export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = { id: string; subject: string; activeForm?: string; status: TaskStatus }

export type PlanItem = { text: string; done: boolean }

/** A `### Task N:` heading of a plan, with the boxes beneath it. */
export type PlanTask = { n: number; text: string; steps: number; stepsDone: number }

/**
 * A Markdown plan or spec whose `- [ ]` / `- [x]` boxes stand for the steps.
 * With two or more `### Task N:` headings its tasks are the steps instead, and `completed`
 * holds the ones a superpowers ledger reported done (its executor never ticks the boxes).
 * Both are absent on a plan kept from before they existed.
 */
export type PlanFile = { path: string; name: string; items: PlanItem[]; tasks?: PlanTask[]; completed?: number[] }

/** The kinds of work whose times the countdown learns, in round-equivalents: Claude's item sizes, and a task list's, a plan's tasks' and a plan's steps'. */
export type SampleKind = 's' | 'm' | 'l' | 'task' | 'planTask' | 'planStep'

/** A time in milliseconds with its likely range. */
export type Spread = { ms: number; lowMs: number; highMs: number }

/** Samples a loop gathered and has not yet written: round-equivalents by kind, and milliseconds by command key. */
export type EtaPending = { sizes: Partial<Record<SampleKind, number[]>>; commands: Record<string, number[]> }

/** One item of a `progress` report: sized, or named by the command that running is the item. */
export type WorkItem = { do: string; size?: 's' | 'm' | 'l'; run?: string }

/** A loop's Progress list: what is left in order, the item in progress first; what finished; and since when the top item has been on top. */
export type Work = { items: WorkItem[]; finished: string[]; topSince: number }

/** One loop's countdown, the main turn's or a subagent run's, kept whole so every band draws the same fill. */
export type EtaTurn = {
  /** When the loop started. */
  startedAt: number
  work: Work | null
  /** The command keys of every `run` item reported this turn, so a finished one's long round stays out of the pace. */
  runs: string[]
  /** When each task or plan entry came into progress, and the ones already learned: both keyed by each task's id and text (its `taskKey`). */
  since: Record<string, number>
  counted: string[]
  /** The estimate as last worked out, and each listed item's own: the time left on the one in progress, the median of the rest. */
  last: Spread | null
  items: { key: string; ms: number }[]
  /** The first estimate, for the summary: when it came, what it said, and what it rested on. */
  first: (Spread & { atMs: number; source: 'progress' | 'tasks' | 'plan' }) | null
  fill: number | null
  lastTickAt: number
  /** The loop's round count at its last report, for the stale rule. */
  lastReportRound: number
  /** Round-equivalents of the items finished so far, as they went and as estimated: what *c* is made of. */
  actual: number
  estimated: number
  /** The value the label last showed, and until when its `↑` shows. */
  shownMs: number | null
  upUntil: number | null
  pending: EtaPending
  /** Whether a call already reminded Claude to report this turn. Absent on a turn kept from before it existed. */
  nudged?: boolean
}

/** One tool call as a band's details list it; `agentId` marks a subagent's. */
export type CallRecord = {
  id: string
  tool: string
  label: string
  /** A Bash call's command key (a hash of its normalized text). Absent on other tools and on a record kept from before it existed. */
  command?: string
  agentId?: string
  startedAt: number
  durationMs: number | null
  status: 'running' | 'ok' | 'error'
  /** The first line of why it failed. */
  error?: string
}

/** Lines a file's writes added and removed; null where the change could not be measured (a notebook cell). */
export type FileChange = { path: string; added: number | null; removed: number | null }

/** One model request of a turn: what it asked to run and what it cost. `startedAt` is absent on a record kept from before it existed. */
export type StepRecord = { index: number; startedAt?: number; durationMs: number; tools: string[]; tokensIn: number; tokensOut: number; stopReason: string | null }

/** What a band's stats open onto: the calls, files, reads, steps and subagents of one turn or one subagent's run. */
export type Detail = {
  calls: CallRecord[]
  files: FileChange[]
  reads: string[]
  stepLog: StepRecord[]
  agentIds: string[]
}

/** Which stat's details the band lists under its stats row. */
export type StatKind = 'tools' | 'subagents' | 'files' | 'reads' | 'steps' | 'tokens' | 'errors' | 'tasks'

export type Live = {
  turnId: string
  startedAt: number
  isLong: boolean
  steps: number
  toolCalls: number
  subagentToolCalls: number
  subagents: number
  errors: number
  byTool: Record<string, number>
  running: { id: string; label: string }[]
  lastActivity: string | null
  tokensIn: number
  tokensCached: number
  /** Absent on a turn kept from before it existed. */
  tokensCacheWrite?: number
  tokensOut: number
  /** Estimated USD at list prices. Absent on a turn kept from before it existed. */
  cost?: number
  model: string | null
  /** Absent on a turn kept from before it existed. */
  detail?: Detail
}

export type Summary = {
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  durationMs: number
  steps: number
  toolCalls: number
  subagentToolCalls: number
  subagents: number
  errors: number
  topTools: [string, number][]
  files: number
  tasksDone: number
  tasksTotal: number
  stepsUnit: 'tasks' | 'steps'
  stepsSource: string | null
  tokensIn: number
  tokensCached: number
  tokensCacheWrite?: number
  tokensOut: number
  /** Estimated USD at list prices. */
  cost?: number
  model: string | null
  /** The finished turn's details, which its stats still open onto. */
  detail?: Detail
  /** Where the bar's fill got to, with the countdown on. */
  fill?: number
  /** The first estimate against what followed, for a turn that answered with nothing left running. */
  eta?: { atMs: number; estimatedMs: number; lowMs: number; highMs: number; tookMs: number }
}

/**
 * One subagent's run as the band saw it: what its transcript's band draws.
 * `dispatchedByMain` marks an agent the main loop's Agent call started, the ones a finished main turn waits for.
 */
export type AgentRun = {
  id: string
  description: string | null
  type: string | null
  parentId: string | null
  dispatchedByMain: boolean
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  reason: Summary['reason'] | null
  steps: number
  toolCalls: number
  errors: number
  running: { id: string; label: string }[]
  lastActivity: string | null
  tokensIn: number
  tokensOut: number
  /** Absent on a run kept from before it existed. */
  detail?: Detail
  /** Its own TodoWrite / TaskCreate list, which never replaces the main one. */
  tasks: Task[]
  /** Its countdown, with the countdown on. Absent on a run kept from before it existed. */
  eta?: EtaTurn
}

export type Totals = { turns: number; longTurns: number; totalMs: number; toolCalls: number; tokensIn: number; tokensOut: number; cost?: number }

declare module 'claude-code' {
  /** The mod's own tool, as the model calls it: Claude's report of the work left. Its input is read leniently, so it stays loose here. */
  interface McpToolInputs {
    'mcp__session-progress__progress': { left?: unknown; done?: unknown }
  }

  interface PluginState {
    'session-progress': {
      live: Live | null
      summary: Summary | null
      tasks: Task[]
      planFile: PlanFile | null
      totals: Totals
      tick: number
      agents: AgentRun[]
      /** The stat whose details are open under the stats row, in every band, until pressed again. */
      openStat: StatKind | null
      /** The open stat lists everything, not its latest few: set by pressing its `+N earlier` row. */
      showAll: boolean
      /** The main turn's countdown: made at `turn.start`, kept past its end while it waits on subagents. */
      eta: EtaTurn | null
    }
  }
}
