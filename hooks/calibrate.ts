// The countdown checked against past turns: how far each turn's first estimate was from what it took, and the correction that follows.

import type { Spread } from '../types'
import { PRIOR_WEIGHT, byNumber, isUsable, quantile } from './eta'

/** What past turns teach the countdown: how much longer they took than first estimated, how much wider their range had to be, and how many turns say so. */
export type Calibration = { bias: number; widen: number; turns: number }

/** The calibration while too few turns are on record: none. */
export const NO_CALIBRATION: Calibration = { bias: 1, widen: 1, turns: 0 }

/** The past turns a calibration rests on, at most. */
export const CAL_ROWS = 50
/** The fewest turns a calibration needs. */
export const CAL_MIN_ROWS = 5
/** How many turns' evidence no correction at all weighs against the log's. */
export const CAL_WEIGHT = 10
/** The share of turns a range should hold: what each item's 20th to 80th percentile stand for. */
export const COVERAGE = 0.6
/** The bounds each correction is held between. */
const BIAS = { min: 0.5, max: 3 }
const WIDEN = { min: 0.5, max: 3 }

/** One past turn as the calibration reads it: its first estimate as shown and before calibration (absent on rows from before it), and what it took. */
export type CalRow = { estimatedMs: number; lowMs: number; highMs: number; tookMs: number; raw?: Spread }

type Measured = { raw: Spread; tookMs: number }

const clamp = (x: number, bounds: { min: number; max: number }) => Math.min(bounds.max, Math.max(bounds.min, x))

/** A turn's estimate before calibration and what it took; null for a turn that cannot be measured. A row from before calibration showed its estimate raw. */
function measured(row: CalRow): Measured | null {
  const raw: unknown = row.raw ?? { ms: row.estimatedMs, lowMs: row.lowMs, highMs: row.highMs }
  if (typeof raw !== 'object' || raw === null) return null
  const s = raw as Spread
  if (!isUsable(s) || !(s.lowMs > 0 && s.lowMs <= s.ms && s.ms <= s.highMs)) return null
  if (!(Number.isFinite(row.tookMs) && row.tookMs > 0)) return null
  return { raw: s, tookMs: row.tookMs }
}

/**
 * The correction the last `CAL_ROWS` turns call for: the median of what they took against their first estimate, and how many
 * half-widths of its range a turn missed by, at `COVERAGE`. Each leans from none toward the log's as turns add up; none below `CAL_MIN_ROWS`.
 */
export function calibrationOf(rows: readonly CalRow[]): Calibration {
  const turns = rows
    .slice(-CAL_ROWS)
    .map(measured)
    .filter((m): m is Measured => m !== null)
  if (turns.length < CAL_MIN_ROWS) return NO_CALIBRATION
  const weight = turns.length / (turns.length + CAL_WEIGHT)
  const ratio = quantile(turns.map(t => Math.log(t.tookMs / t.raw.ms)).sort(byNumber), 0.5)
  const bias = clamp(Math.exp(weight * ratio), BIAS)
  // How far each turn missed its estimate as now corrected, in half-widths of its range on the side it missed.
  const misses = turns.flatMap(t => {
    const off = Math.log(t.tookMs / (t.raw.ms * bias))
    const half = off >= 0 ? Math.log(t.raw.highMs / t.raw.ms) : Math.log(t.raw.ms / t.raw.lowMs)
    return half > 0 ? [Math.abs(off) / half] : []
  })
  const widen = misses.length < CAL_MIN_ROWS ? 1 : clamp(1 + weight * (quantile(misses.sort(byNumber), COVERAGE) - 1), WIDEN)
  return { bias, widen, turns: turns.length }
}

/**
 * A loop's whole estimate with the log's correction: its time scaled by the bias, its range widened or narrowed about it.
 * Both give way to the turn's own evidence as its items finish (`evidence`, in round-equivalents, as *c* weighs it); the low end stays a round or more.
 */
export function calibrated(raw: Spread, cal: Calibration, evidence: number, pace: number): Spread {
  if (cal.bias === 1 && cal.widen === 1) return raw
  const share = PRIOR_WEIGHT / (PRIOR_WEIGHT + Math.max(0, evidence))
  const bias = cal.bias ** share
  const widen = cal.widen ** share
  const ms = raw.ms * bias
  const lowMs = raw.lowMs > 0 ? ms * (raw.lowMs / raw.ms) ** widen : 0
  const highMs = ms * (raw.highMs / raw.ms) ** widen
  return { ms, lowMs: Math.min(ms, Math.max(pace, lowMs)), highMs: Math.max(ms, highMs) }
}
