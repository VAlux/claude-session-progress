// The `progress` tool Claude reports the work left with: its definition and the system-prompt line asking for it.

import type { ToolSpec } from 'claude-code'

import type { Task, Work, WorkItem } from '../types'

/** The tool's short name, and the name the model calls it by. */
export const PROGRESS_NAME = 'progress'
export const PROGRESS_TOOL = 'mcp__session-progress__progress'

const DESCRIPTION =
  'Reports the work left in this turn, for the progress display only. Use it during work that will take more than a few steps ' +
  'when you keep no task list: start in your first response that calls tools, with a rough guess if that is all you have, ' +
  'and send it in the same response as your other tool calls, never on its own. ' +
  'List the items in order, the one you are on first, each in a few words (5 at most). ' +
  'Give each a size: s — a quick change or lookup, about 1–2 tool calls; m — a few files or a few rounds, 3–8; ' +
  'l — a broad change or a debugging loop, 9 or more. When running a command is the item (a test suite, a build), ' +
  'give `run` with the exact command instead of a size. Send `{done: 1}` with the first tool calls of the next item, one item at a time ' +
  'and not the list again: a late `done`, or one for several items, loses their times. Send `left` only when items are added, dropped or changed. ' +
  'Once the last item is done, just answer: the turn ending closes it. ' +
  'Returns `ok`.'

/** The tool as the mod registers it: in the prompt's tool list, not behind ToolSearch, since a report there would cost a round. */
export const PROGRESS_SPEC: ToolSpec = {
  name: PROGRESS_NAME,
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      left: {
        type: 'array',
        maxItems: 30,
        items: {
          type: 'object',
          properties: {
            // No descriptions here: the tool's description says what each field is, and they would cost every request.
            do: { type: 'string' },
            size: { type: 'string', enum: ['s', 'm', 'l'] },
            run: { type: 'string' },
          },
          required: ['do'],
        },
      },
      done: { type: 'integer', minimum: 1 },
    },
  },
  isDeferred: false,
}

/**
 * The system-prompt line asking Claude to report, when the tool is offered. It says only when to start, which Claude skipped
 * without it; how to report is the tool's description, which every request carries already.
 */
export function etaLine(tools: readonly string[]): string | null {
  if (!tools.includes(PROGRESS_TOOL)) return null
  return (
    `During work that will take more than a few steps and has no task list, report what is left with ${PROGRESS_TOOL} ` +
    'in your first response that calls tools, before you know the details: a rough guess is fine, and exploring counts as an item. ' +
    'Its description says how.'
  )
}

/** The reminder a turn's call carries once the turn has run a few calls with nothing to count down. */
export function nudgeLine(calls: number): string {
  return (
    `This turn has made ${calls} tool calls with no task list and no report, so the progress display has nothing to count down. ` +
    `If more work is left, report it with ${PROGRESS_TOOL} in your next response, alongside your other tool calls. If you are about to answer, ignore this.`
  )
}

/** The reminder a call carries once a report has stood unchanged for some rounds with items still listed. */
export function staleLine(rounds: number, top: string, after: number): string {
  const rest = after === 0 ? '' : after === 1 ? ', with 1 more item after it' : `, with ${after} more items after it`
  return (
    `Your last ${PROGRESS_TOOL} report was ${rounds} rounds ago, and the progress display still shows "${top}" in progress${rest}. ` +
    'If it or later items are finished, send {done: 1} (or how many finished), or `left` with what is left now, in your next response alongside your other tool calls. ' +
    'If it is still in progress, or you are about to answer, ignore this.'
  )
}

/** One report: the whole list left, or how many items at its top are finished. */
export type Report = { left: WorkItem[] } | { done: number }

const MAX_ITEMS = 30
const MAX_TEXT = 80
const MAX_FINISHED = 50

/** One item of `left`: an object with its text, or the text alone. */
function itemOf(raw: unknown): WorkItem | null {
  const r = (typeof raw === 'object' && raw !== null ? raw : typeof raw === 'string' ? { do: raw } : {}) as Record<string, unknown>
  const text = typeof r.do === 'string' ? r.do.trim().slice(0, MAX_TEXT) : ''
  if (text === '') return null
  if (typeof r.run === 'string' && r.run.trim() !== '') return { do: text, run: r.run.trim() }
  if (r.size === 's' || r.size === 'm' || r.size === 'l') return { do: text, size: r.size }
  return { do: text }
}

/** A report from the tool's input, trimmed to what the band holds; null for one that says nothing, a list with no usable item included. */
export function parseReport(input: Record<string, unknown>): Report | null {
  if (Array.isArray(input.left)) {
    const left = input.left.slice(0, MAX_ITEMS).map(itemOf).filter((item): item is WorkItem => item !== null)
    if (input.left.length > 0 && left.length === 0) return null
    return { left }
  }
  const done = typeof input.done === 'number' && Number.isFinite(input.done) ? Math.floor(input.done) : 0
  return done >= 1 ? { done } : null
}

/** The top item that finished, and since when it had been on top: what its time is learned from. */
export type Finished = { item: WorkItem; since: number }

/** A work list after a report, and the top item when the report says it ended on its own, so its time can be learned. */
export function applyReport(work: Work | null, report: Report, now: number): { work: Work | null; finished: Finished | null } {
  if ('done' in report) {
    if (work === null || work.items.length === 0) return { work, finished: null }
    const ended = work.items.slice(0, report.done)
    const next: Work = { items: work.items.slice(report.done), finished: [...work.finished, ...ended.map(item => item.do)].slice(-MAX_FINISHED), topSince: now }
    // Several at once leave no telling how long each took.
    return { work: next, finished: report.done === 1 && ended.length === 1 ? { item: ended[0]!, since: work.topSince } : null }
  }
  const { left } = report
  if (work === null) return { work: { items: left, finished: [], topSince: now }, finished: null }
  const top = work.items[0]
  const isGone = top !== undefined && !left.some(item => item.do === top.do)
  const isStill = top !== undefined && left[0]?.do === top.do
  return {
    work: { items: left, finished: isGone ? [...work.finished, top.do].slice(-MAX_FINISHED) : work.finished, topSince: isStill ? work.topSince : now },
    finished: isGone ? { item: top, since: work.topSince } : null,
  }
}

/** A work list as the band's step rows: what finished, the item in progress, the rest. */
export function workTasks(work: Work): Task[] {
  return [
    ...work.finished.map((text, i): Task => ({ id: `done-${i}`, subject: text, status: 'completed' })),
    ...work.items.map((item, i): Task => ({ id: `work-${i}`, subject: item.do, status: i === 0 ? 'in_progress' : 'pending' })),
  ]
}
