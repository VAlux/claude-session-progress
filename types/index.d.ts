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

/** One tool call as a band's details list it; `agentId` marks a subagent's. */
export type CallRecord = {
  id: string
  tool: string
  label: string
  agentId?: string
  startedAt: number
  durationMs: number | null
  status: 'running' | 'ok' | 'error'
  /** The first line of why it failed. */
  error?: string
}

/** Lines a file's writes added and removed; null where the change could not be measured (a notebook cell). */
export type FileChange = { path: string; added: number | null; removed: number | null }

/** One model request of a turn: what it asked to run and what it cost. */
export type StepRecord = { index: number; durationMs: number; tools: string[]; tokensIn: number; tokensOut: number; stopReason: string | null }

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
}

export type Totals = { turns: number; longTurns: number; totalMs: number; toolCalls: number; tokensIn: number; tokensOut: number; cost?: number }

declare module 'claude-code' {
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
    }
  }
}
