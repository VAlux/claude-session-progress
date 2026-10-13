// The countdown's arithmetic: from samples of how long items took, how long the work left will take, and how far the bar has come.

import type { SampleKind, Spread } from '../types'

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
/** Rounds without a report after which an item running past its range loses its estimate. */
export const STALE_ROUNDS = 8
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
