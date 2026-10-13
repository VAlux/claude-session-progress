import { expect, test } from 'claude-code/testing'

import {
  SEEDS,
  advanceFill,
  combine,
  commandBasis,
  correction,
  isUsable,
  quantile,
  remainingOf,
  sizedBasis,
  spreadOf,
  startFill,
  totalOf,
} from '../hooks/eta'
import { capitalize, etaLabels, etaRange, etaValue, fitLabel, shownMs } from '../hooks/frames'

const PACE = 10_000
const round = (s: { ms: number; lowMs: number; highMs: number }) => ({ ms: Math.round(s.ms), lowMs: Math.round(s.lowMs), highMs: Math.round(s.highMs) })

test('quantiles interpolate between sorted neighbours', () => {
  expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3)
  expect(Math.round(quantile([1, 2, 3, 4, 5], 0.2) * 10)).toBe(18)
  expect(Math.round(quantile([1, 2, 3, 4, 5], 0.8) * 10)).toBe(42)
  expect(quantile([7], 0.8)).toBe(7)
  expect(Number.isNaN(quantile([], 0.5))).toBe(true)
})

test('a sized item is its size\'s samples at this turn\'s pace', () => {
  expect(spreadOf(sizedBasis(SEEDS.m, PACE, 1))).toEqual({ ms: 50_000, lowMs: 38_000, highMs: 76_000 })
  expect(spreadOf(sizedBasis(SEEDS.s, PACE, 1))).toEqual({ ms: 20_000, lowMs: 14_000, highMs: 32_000 })
  expect(spreadOf(sizedBasis(SEEDS.m, PACE, 2)).ms, 'c scales it').toBe(100_000)
})

test('a run item is its command\'s own times, half to double the median under five runs, a size m before any', () => {
  expect(spreadOf(commandBasis([200_000, 180_000, 190_000], SEEDS.m, PACE, 1))).toEqual({ ms: 190_000, lowMs: 95_000, highMs: 380_000 })
  const six = [10_000, 20_000, 30_000, 40_000, 50_000, 60_000]
  expect(spreadOf(commandBasis(six, SEEDS.m, PACE, 1))).toEqual({ ms: 35_000, lowMs: 20_000, highMs: 50_000 })
  expect(spreadOf(commandBasis(undefined, SEEDS.m, PACE, 1)).ms).toBe(50_000)
  expect(spreadOf(commandBasis([], SEEDS.m, PACE, 1)).ms).toBe(50_000)
})

test('the item in progress: its median less the time spent, then how long the longer ones went on, then a quarter of the time spent', () => {
  const m = sizedBasis(SEEDS.m, PACE, 1)
  expect(remainingOf(m, 20_000, PACE)).toEqual({ ms: 30_000, lowMs: 18_000, highMs: 56_000 })
  expect(round(remainingOf(m, 60_000, PACE))).toEqual({ ms: 25_000, lowMs: 16_000, highMs: 34_000 })
  expect(remainingOf(m, 120_000, PACE)).toEqual({ ms: 30_000, lowMs: 15_000, highMs: 60_000 })
  expect(remainingOf(m, 120_000, 50_000).ms, 'past every sample, never less than a round').toBe(50_000)
  expect(remainingOf(m, -5_000, PACE), 'a clock behind the item counts as no time spent').toEqual({ ms: 50_000, lowMs: 38_000, highMs: 76_000 })
})

test('the total adds a round for the answer, and its range narrows as items finish', () => {
  const m = { ms: 50_000, lowMs: 38_000, highMs: 76_000 }
  const s = { ms: 20_000, lowMs: 14_000, highMs: 32_000 }
  expect(round(totalOf([m, s], PACE))).toEqual({ ms: 80_000, lowMs: 66_584, highMs: 108_636 })
  expect(totalOf([], PACE)).toEqual({ ms: PACE, lowMs: PACE, highMs: PACE })
  const three = totalOf([m, m, m], PACE)
  const one = totalOf([m], PACE)
  expect(one.highMs - one.lowMs).toBeLessThan(three.highMs - three.lowMs)
  expect(totalOf([{ ms: 1_000, lowMs: 0, highMs: 2_000 }], PACE).lowMs, 'never below the closing round').toBe(PACE)
})

test('a turn waiting on subagents takes the longest estimate, and none while one has none', () => {
  const a = { ms: 10_000, lowMs: 5_000, highMs: 40_000 }
  const b = { ms: 30_000, lowMs: 20_000, highMs: 35_000 }
  expect(combine(a, [b])).toEqual({ ms: 30_000, lowMs: 20_000, highMs: 40_000 })
  expect(combine(null, [b])).toEqual(b)
  expect(combine(a, [])).toEqual(a)
  expect(combine(a, [b, null])).toBeNull()
  expect(combine(null, [])).toBeNull()
})

test('c leans from 1 toward this turn\'s ratio as items finish', () => {
  expect(correction(0, 0)).toBe(1)
  expect(correction(20, 10)).toBe(1.5)
})

test('an estimate with no time, or not a number, is not shown', () => {
  expect(isUsable({ ms: 1, lowMs: 0, highMs: 2 })).toBe(true)
  expect(isUsable({ ms: 0, lowMs: 0, highMs: 0 })).toBe(false)
  expect(isUsable({ ms: Number.NaN, lowMs: 0, highMs: 1 })).toBe(false)
})

test('the bar starts at the share done, moves to reach the end with the countdown, never back, and waits at 97%', () => {
  expect(startFill(30_000, 90_000)).toBe(0.25)
  expect(startFill(10_000_000, 1)).toBe(0.97)
  expect(Math.round(advanceFill(0.25, 1_000, 90_000) * 10_000)).toBe(2583)
  expect(advanceFill(0.5, 1_000, null), 'no estimate: it holds').toBe(0.5)
  expect(advanceFill(0.96, 5_000, 1_000)).toBe(0.97)
  expect(advanceFill(0, 3_600_000, 100_000), 'a long gap moves it 5 s worth').toBe(0.05)
  expect(advanceFill(0.99, 1_000, 10_000), 'past the cap it never goes back').toBe(0.99)
})

test('the countdown reads in whole minutes from 2 minutes, in 10 s steps under them, and as a few seconds at the end', () => {
  expect(etaValue(240_000)).toBe('~4m')
  expect(etaValue(245_000)).toBe('~4m')
  expect(etaValue(125_000)).toBe('~2m')
  expect(etaValue(115_000), 'rounds up into the minutes').toBe('~2m')
  expect(etaValue(90_000)).toBe('~1m 30s')
  expect(etaValue(60_000)).toBe('~1m')
  expect(etaValue(40_000)).toBe('~40s')
  expect(etaValue(9_000)).toBe('a few seconds')
  expect(etaValue(5_700_000)).toBe('~95m')
  expect(shownMs(79_000)).toBe(80_000)
  expect(shownMs(150_000)).toBe(180_000)
})

test('the range follows from 2 minutes, unless its ends round to the same minute', () => {
  expect(etaRange({ ms: 240_000, lowMs: 180_000, highMs: 360_000 })).toBe(' (3–6m)')
  expect(etaRange({ ms: 240_000, lowMs: 230_000, highMs: 250_000 })).toBeNull()
  expect(etaRange({ ms: 90_000, lowMs: 30_000, highMs: 200_000 })).toBeNull()
  expect(etaRange({ ms: 150_000, lowMs: 10_000, highMs: 300_000 }), 'the low end is at least a minute').toBe(' (1–5m)')
})

test('the labels go from the fullest to the value alone', () => {
  expect(etaLabels({ ms: 240_000, lowMs: 180_000, highMs: 360_000 })).toEqual(['~4m left (3–6m)', '~4m left', '~4m'])
  expect(etaLabels({ ms: 80_000, lowMs: 66_000, highMs: 108_000 })).toEqual(['~1m 20s left', '~1m 20s'])
  expect(etaLabels({ ms: 5_000, lowMs: 5_000, highMs: 5_000 })).toEqual(['a few seconds left', 'a few seconds'])
})

test('the label that fits leaves the bar 20 cells, and the shortest goes when none does', () => {
  const labels = ['~4m left (3–6m)', '~4m left', '~4m']
  expect(fitLabel(labels, 80)).toBe('~4m left (3–6m)')
  expect(fitLabel(labels, 30)).toBe('~4m left')
  expect(fitLabel(labels, 22)).toBe('~4m')
  expect(fitLabel([], 80)).toBe('')
  expect(capitalize('fix the parser')).toBe('Fix the parser')
})
