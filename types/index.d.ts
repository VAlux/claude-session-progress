export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = { id: string; subject: string; activeForm?: string; status: TaskStatus }

export type PlanItem = { text: string; done: boolean }

/** A Markdown plan or spec whose `- [ ]` / `- [x]` boxes stand for the steps. */
export type PlanFile = { path: string; name: string; items: PlanItem[] }

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
  files: string[]
  running: { id: string; label: string }[]
  lastActivity: string | null
  tokensIn: number
  tokensCached: number
  tokensOut: number
  model: string | null
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
  tokensOut: number
  model: string | null
}

export type Totals = { turns: number; longTurns: number; totalMs: number; toolCalls: number; tokensIn: number; tokensOut: number }

declare module 'claude-code' {
  interface PluginState {
    'session-progress': {
      live: Live | null
      summary: Summary | null
      tasks: Task[]
      planFile: PlanFile | null
      totals: Totals
      tick: number
    }
  }
}
