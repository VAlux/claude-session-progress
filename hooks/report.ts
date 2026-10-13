// The `progress` tool Claude reports the work left with: its definition and the system-prompt line asking for it.

import type { ToolSpec } from 'claude-code'

import type { Task, Work, WorkItem } from '../types'

/** The tool's short name, and the name the model calls it by. */
export const PROGRESS_NAME = 'progress'
export const PROGRESS_TOOL = 'mcp__session-progress__progress'

const DESCRIPTION =
  'Reports the work left in this turn, for the progress display only. Use it during work that will take more than a few steps ' +
  'when you keep no task list: start once you have a rough idea, and send it in the same response as your other tool calls, never on its own. ' +
  'List the items in order, the one you are on first. ' +
  'Give each a size: s — a quick change or lookup, about 1–2 tool calls; m — a few files or a few rounds, 3–8; ' +
  'l — a broad change or a debugging loop, 9 or more. When running a command is the item (a test suite, a build), ' +
  'give `run` with the exact command instead of a size. Send `{done: 1}` when you finish the top item; ' +
  'send `left` again when the list changes. Returns `ok`.'

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
            do: { type: 'string', description: 'The item, in a few words' },
            size: { type: 'string', enum: ['s', 'm', 'l'] },
            run: { type: 'string', description: 'The exact command, when running it is the item' },
          },
          required: ['do'],
        },
      },
      done: { type: 'integer', minimum: 1, description: 'How many items at the top of the list are finished' },
    },
  },
  isDeferred: false,
}

/** The system-prompt line asking Claude to report, when the tool is offered. */
export function etaLine(tools: readonly string[]): string | null {
  if (!tools.includes(PROGRESS_TOOL)) return null
  return (
    `During work that will take more than a few steps and has no task list, report what is left with ${PROGRESS_TOOL}. ` +
    'Start as soon as you have a rough idea, even a guess; exploring counts as an item. Keep the item you are on first. ' +
    'Send {done: 1} when you finish it and send `left` again when the work changes. ' +
    'Always send it in the same response as your other tool calls, never on its own. It only feeds the progress display.'
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

/** A report from the tool's input, trimmed to what the band holds; null for one that says nothing. */
export function parseReport(input: Record<string, unknown>): Report | null {
  if (Array.isArray(input.left)) {
    return { left: input.left.slice(0, MAX_ITEMS).map(itemOf).filter((item): item is WorkItem => item !== null) }
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
    return { work: next, finished: ended.length === 1 ? { item: ended[0]!, since: work.topSince } : null }
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
