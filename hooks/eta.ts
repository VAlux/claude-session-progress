// The countdown's arithmetic: from samples of how long items took, how long the work left will take, and how far the bar has come.

import type { CallRecord, Detail, EtaPending, EtaTurn, SampleKind, Spread, StepRecord, Task, Work, WorkItem } from '../types'
import { shownMs } from './frames'

export type Sizes = Record<SampleKind, number[]>

/** Each kind's samples before any are learned, in round-equivalents. */
export const SEEDS: Sizes = {
  s: [1, 1.5, 2, 3, 4],
  m: [3, 4, 5, 7, 10],
  l: [8, 10, 12, 18, 25],
  task: [3, 4, 5, 7, 10],
  planTask: [3, 4, 5, 7, 10],
  planStep: [3, 4, 5, 7, 10],
}

/** How many round-equivalents of evidence the seeds weigh against this turn's own, in *c*. */
export const PRIOR_WEIGHT = 10
/** Rounds without a report after which an item running far past its range loses its estimate. */
export const STALE_ROUNDS = 12
/** How many times its range's top an item must have run for, as well, to count as far past it. */
export const STALE_OVERRUN = 2
/** Where the bar waits until the turn ends. */
export const FILL_CAP = 0.97
/** The most one tick moves the bar: a laptop waking from sleep does not leap it ahead. */
export const MAX_TICK_MS = 5_000
/** A command with fewer runs than this gets half to double its median as its range. */
const FEW_RUNS = 5

export const byNumber = (a: number, b: number) => a - b

/** The q-quantile of sorted values, interpolated linearly between neighbours; NaN for none. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo)
}

/** What one item's estimate rests on: its samples in milliseconds, sorted, and whether they are a command's few runs. */
export type Basis = { samples: number[]; isFew: boolean }

/** A sized item's or a task's basis: its kind's samples at this turn's pace, corrected by *c*. */
export function sizedBasis(rounds: readonly number[], pace: number, c: number): Basis {
  return { samples: rounds.map(r => r * pace * c).sort(byNumber), isFew: false }
}

/** A `run` item's basis: its command's times here, or a size `m` item's for a command never timed. */
export function commandBasis(runs: readonly number[] | undefined, mRounds: readonly number[], pace: number, c: number): Basis {
  if (runs === undefined || runs.length === 0) return sizedBasis(mRounds, pace, c)
  return { samples: [...runs].sort(byNumber), isFew: runs.length < FEW_RUNS }
}

/** A whole item's median and range. */
export function spreadOf({ samples, isFew }: Basis): Spread {
  const ms = quantile(samples, 0.5)
  if (isFew) return { ms, lowMs: ms / 2, highMs: ms * 2 }
  return { ms, lowMs: quantile(samples, 0.2), highMs: quantile(samples, 0.8) }
}

/** What is left of an item in progress: its median less the time spent, and past it, how much longer the items that ran this long went on. */
export function remainingOf(basis: Basis, spentMs: number, pace: number): Spread {
  const spent = Math.max(0, spentMs)
  const whole = spreadOf(basis)
  if (spent < whole.ms) return { ms: whole.ms - spent, lowMs: Math.max(0, whole.lowMs - spent), highMs: whole.highMs - spent }
  const longer = basis.samples.filter(x => x > spent)
  if (longer.length === 0) {
    const ms = Math.max(spent / 4, pace)
    return { ms, lowMs: ms / 2, highMs: ms * 2 }
  }
  return { ms: quantile(longer, 0.5) - spent, lowMs: Math.max(0, quantile(longer, 0.2) - spent), highMs: quantile(longer, 0.8) - spent }
}

/** The work left: the items' times and one round for the closing answer; the range from each item's own, by root-sum-square. */
export function totalOf(items: readonly Spread[], pace: number): Spread {
  const ms = items.reduce((sum, s) => sum + s.ms, 0) + pace
  const down = Math.sqrt(items.reduce((sum, s) => sum + (s.ms - s.lowMs) ** 2, 0))
  const up = Math.sqrt(items.reduce((sum, s) => sum + (s.highMs - s.ms) ** 2, 0))
  return { ms, lowMs: Math.max(pace, ms - down), highMs: ms + up }
}

/** A main turn's estimate while subagents it started run: the longest of its own and theirs, or none while one of them has none. */
export function combine(own: Spread | null, agents: readonly (Spread | null)[]): Spread | null {
  if (agents.some(a => a === null)) return null
  const all = [own, ...agents].filter((s): s is Spread => s !== null)
  if (all.length === 0) return null
  return { ms: Math.max(...all.map(s => s.ms)), lowMs: Math.max(...all.map(s => s.lowMs)), highMs: Math.max(...all.map(s => s.highMs)) }
}

/** This turn's correction, *c*: its finished items' actual round-equivalents against their estimates, weighed against the seeds. */
export const correction = (actual: number, estimated: number) => (actual + PRIOR_WEIGHT) / (estimated + PRIOR_WEIGHT)

/** Whether an estimate is fit to show. */
export const isUsable = (s: Spread) => [s.ms, s.lowMs, s.highMs].every(Number.isFinite) && s.ms > 0

/** The bar at the first estimate: the share of the turn already done, were the estimate right. */
export function startFill(elapsedMs: number, remainingMs: number): number {
  const done = Math.max(0, elapsedMs)
  return Math.min(FILL_CAP, done / (done + remainingMs))
}

/** The bar one tick on, at the speed that reaches the end when the countdown does; it holds without an estimate and never goes back. */
export function advanceFill(fill: number, dtMs: number, remainingMs: number | null): number {
  if (remainingMs === null || !(remainingMs > 0)) return fill
  const dt = Math.max(0, Math.min(dtMs, MAX_TICK_MS))
  return Math.max(fill, Math.min(FILL_CAP, fill + (1 - fill) * Math.min(1, dt / remainingMs)))
}

/** A command as the history keys it: trimmed, its spaces collapsed, a leading `cd <dir> &&` dropped, cut to 200 characters. */
export function normalizeCommand(command: string): string {
  return command
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^cd (?:"[^"]*"|'[^']*'|\S+) && /, '')
    .slice(0, 200)
}

/** A 53-bit hash of a text (cyrb53), as 14 hex digits. */
function cyrb53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/** How the countdown keys a command — its run times, its rounds, a `run` item — by a hash of its normalized text, so the text is never stored. */
export const commandKey = (command: string) => cyrb53(normalizeCommand(command))

/** Each completed round's wall time (a model request and the tools it ran), leaving out rounds that ran a `run` item's command. */
export function roundTimes(steps: readonly StepRecord[], calls: readonly CallRecord[], runs: ReadonlySet<string>): number[] {
  const out: number[] = []
  for (let i = 0; i + 1 < steps.length; i++) {
    const from = steps[i]!.startedAt
    const to = steps[i + 1]!.startedAt
    if (from === undefined || to === undefined || to <= from) continue
    const ranRun = calls.some(c => c.command !== undefined && runs.has(c.command) && c.startedAt >= from && c.startedAt < to)
    if (!ranRun) out.push(to - from)
  }
  return out
}

/** A loop's pace: its median round, leaving out those that ran a `runs` command (by key); before any round has completed, its first request's own time. */
export function paceOf(detail: Detail, runs: readonly string[]): number | null {
  const times = roundTimes(detail.stepLog, detail.calls, new Set(runs)).sort(byNumber)
  if (times.length > 0) return quantile(times, 0.5)
  const first = detail.stepLog[0]
  return first !== undefined && first.durationMs > 0 ? first.durationMs : null
}

/** Since when the top item's command has been running, when the top item is a `run` and its command is. */
export function runningSince(detail: Detail, work: Work | null): number | null {
  const run = work?.items[0]?.run
  if (run === undefined) return null
  const command = commandKey(run)
  return [...detail.calls].reverse().find(c => c.status === 'running' && c.command === command)?.startedAt ?? null
}

/** A task's key for its timing: its id and its text, since a TodoWrite list numbers its entries by position. */
export const taskKey = (task: Task) => `${task.id}:${task.subject}`

/** Which kind of list an estimate's items come from: a task list, a plan's tasks, or a plan's steps. */
export type TaskKind = 'task' | 'planTask' | 'planStep'
/** Which report an estimate was worked out from: a Progress list, a task list, or a plan. */
export type EtaSource = 'progress' | 'tasks' | 'plan'

/** What a loop's estimate is worked out from. */
export type EtaInput = {
  now: number
  pace: number | null
  work: Work | null
  /** Since when the top item's command has run, for a `run` item whose command is running. */
  runningSince: number | null
  tasks: { list: readonly Task[]; kind: TaskKind } | null
  since: Readonly<Record<string, number>>
  sizes: Sizes
  commands: Readonly<Record<string, readonly number[]>>
  c: number
  roundsSinceReport: number
}

/** A loop's estimate, each item's own (the time left on the one in progress, the others' medians), what it rests on, and the estimate before calibration. */
export type EtaOutput = { estimate: Spread | null; items: { key: string; ms: number }[]; source: EtaSource | null; raw?: Spread | null }

const NONE: EtaOutput = { estimate: null, items: [], source: null }

/** A loop's estimate: a Progress list's when it has one, else its task list's or plan's, else none. */
export function estimate(x: EtaInput): EtaOutput {
  if (x.pace === null || !(x.pace > 0)) return NONE
  const pace = x.pace
  type Part = { key: string; basis: Basis; spentMs: number | null }
  let parts: Part[]
  let source: EtaSource
  const work = x.work
  if (work !== null) {
    source = 'progress'
    parts = work.items.map((item, i) => ({
      key: `work-${i}`,
      basis: item.run !== undefined ? commandBasis(x.commands[commandKey(item.run)], x.sizes.m, pace, x.c) : sizedBasis(x.sizes[item.size ?? 'm'], pace, x.c),
      spentMs: i > 0 ? null : x.now - (item.run !== undefined && x.runningSince !== null ? x.runningSince : work.topSince),
    }))
  } else if (x.tasks !== null && x.tasks.list.length > 0) {
    source = x.tasks.kind === 'task' ? 'tasks' : 'plan'
    const basis = sizedBasis(x.sizes[x.tasks.kind], pace, x.c)
    parts = x.tasks.list
      .filter(task => task.status !== 'completed')
      .map(task => ({ key: task.id, basis, spentMs: task.status === 'in_progress' ? x.now - (x.since[taskKey(task)] ?? x.now) : null }))
  } else {
    return NONE
  }
  // Nothing left by its report, yet still at work rounds later: it no longer knows what is left.
  if (parts.length === 0 && x.roundsSinceReport >= 2) return NONE
  // A long tool call is one round however long it runs, so a Progress list with nothing left also expires by time.
  if (parts.length === 0 && work !== null && x.now - work.topSince > 3 * pace) return NONE

  const spreads: Spread[] = []
  const items: EtaOutput['items'] = []
  for (const part of parts) {
    // Far past its range with no report for a good while: Claude may simply have stopped reporting.
    if (part.spentMs !== null && part.spentMs > STALE_OVERRUN * spreadOf(part.basis).highMs && x.roundsSinceReport >= STALE_ROUNDS) return NONE
    const spread = part.spentMs === null ? spreadOf(part.basis) : remainingOf(part.basis, part.spentMs, pace)
    spreads.push(spread)
    items.push({ key: part.key, ms: spread.ms })
  }
  const total = totalOf(spreads, pace)
  return isUsable(total) ? { estimate: total, items, source } : NONE
}

/** A loop's samples before any are gathered. */
export const emptyPending = (): EtaPending => ({ sizes: {}, commands: {} })

/** A loop's countdown before anything is reported. */
export function freshEta(startedAt: number): EtaTurn {
  return {
    startedAt,
    work: null,
    runs: [],
    since: {},
    counted: [],
    last: null,
    items: [],
    first: null,
    fill: null,
    lastTickAt: startedAt,
    lastReportRound: 0,
    actual: 0,
    estimated: 0,
    shownMs: null,
    upUntil: null,
    pending: emptyPending(),
  }
}

const median = (rounds: readonly number[]) => quantile([...rounds].sort(byNumber), 0.5)

/** Adds one finished item's round-equivalents to its kind's samples, and to the sums *c* is made of. */
function withFinished(eta: EtaTurn, kind: SampleKind, rounds: number, sizes: Sizes): EtaTurn {
  if (!Number.isFinite(rounds) || !(rounds > 0)) return eta
  return {
    ...eta,
    actual: eta.actual + rounds,
    estimated: eta.estimated + median(sizes[kind]),
    pending: { ...eta.pending, sizes: { ...eta.pending.sizes, [kind]: [...(eta.pending.sizes[kind] ?? []), rounds] } },
  }
}

/** Learns a Progress item that finished on its own: a sized one's time goes to its size; a `run` item's is learned from its Bash call. */
export function learnItem(eta: EtaTurn, finished: { item: WorkItem; since: number }, now: number, pace: number | null, sizes: Sizes): EtaTurn {
  if (finished.item.run !== undefined || pace === null || !(pace > 0)) return eta
  return withFinished(eta, finished.item.size ?? 'm', (now - finished.since) / pace, sizes)
}

/** When a loop's closing round began: its last request's start; null before any request, or one with no start. */
export const closingAt = (detail: Detail): number | null => detail.stepLog[detail.stepLog.length - 1]?.startedAt ?? null

/**
 * At a loop's answer, the one item still listed: Claude was on it until the closing round began, so it is learned like one reported done.
 * With more than one still listed there is no telling which took the time; a `run` item is learned from its Bash call.
 */
export function learnOpenTop(eta: EtaTurn, closing: number | null, pace: number | null, sizes: Sizes): EtaTurn {
  const work = eta.work
  if (work === null || work.items.length !== 1 || closing === null || !(closing > work.topSince)) return eta
  return learnItem(eta, { item: work.items[0]!, since: work.topSince }, closing, pace, sizes)
}

/** Notes when each task came into progress, and learns the ones that finished since, each once. */
export function learnTasks(eta: EtaTurn, list: readonly Task[], kind: TaskKind, now: number, pace: number | null, sizes: Sizes): EtaTurn {
  let out = eta
  for (const task of list) {
    const key = taskKey(task)
    const since = out.since[key]
    if (task.status === 'in_progress' && since === undefined) {
      out = { ...out, since: { ...out.since, [key]: now } }
    } else if (task.status === 'completed' && since !== undefined && !out.counted.includes(key)) {
      out = { ...out, counted: [...out.counted, key] }
      if (pace !== null && pace > 0) out = withFinished(out, kind, (now - since) / pace, sizes)
    }
  }
  return out
}

/** Adds a Bash call's time to its command's runs (by its key), keeping the last 10. */
export function learnCommand(eta: EtaTurn, command: string, ms: number): EtaTurn {
  if (command === '' || !(ms > 0)) return eta
  const runs = [...(eta.pending.commands[command] ?? []), ms].slice(-10)
  return { ...eta, pending: { ...eta.pending, commands: { ...eta.pending.commands, [command]: runs } } }
}

/** How long the label's `↑` shows after the estimate grows. */
export const UP_MS = 5_000

/** A loop's countdown after one more look: the estimate kept, the first one noted, the bar moved on, and the `↑` set when it grew. */
export function tickEta(eta: EtaTurn, out: EtaOutput, now: number): EtaTurn {
  const last = out.estimate
  const elapsed = now - eta.startedAt
  const first =
    eta.first ??
    (last === null || out.source === null
      ? null
      : { atMs: Math.max(0, elapsed), ms: last.ms, lowMs: last.lowMs, highMs: last.highMs, source: out.source, ...(out.raw ? { raw: out.raw } : {}) })
  const fill = last === null ? eta.fill : eta.fill === null ? startFill(elapsed, last.ms) : advanceFill(eta.fill, now - eta.lastTickAt, last.ms)
  const shown = last === null ? null : shownMs(last.ms)
  const grew = shown !== null && eta.shownMs !== null && shown > eta.shownMs
  return { ...eta, last, items: out.items, first, fill, lastTickAt: now, shownMs: shown ?? eta.shownMs, upUntil: grew ? now + UP_MS : eta.upUntil }
}
