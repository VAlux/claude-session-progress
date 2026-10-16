import { expect, test } from 'claude-code/testing'

import { NO_CALIBRATION, calibrated, calibrationOf, type CalRow } from '../hooks/calibrate'

const PACE = 10_000
/** A ratio to 4 decimals: the kit's `expect` has no `toBeCloseTo`. */
const near = (x: number) => Math.round(x * 10_000)
const round = (s: { ms: number; lowMs: number; highMs: number }) => ({ ms: Math.round(s.ms), lowMs: Math.round(s.lowMs), highMs: Math.round(s.highMs) })
/** `n` turns first estimated at 1m (40 s–1m 30s) that took `tookMs`; written before calibration, so with no `raw`. */
const turns = (n: number, tookMs = 120_000): CalRow[] => Array.from({ length: n }, () => ({ estimatedMs: 60_000, lowMs: 40_000, highMs: 90_000, tookMs }))

test('fewer than 5 turns that can be measured call for no correction', () => {
  expect(calibrationOf([])).toEqual(NO_CALIBRATION)
  expect(calibrationOf(turns(4))).toEqual(NO_CALIBRATION)
  expect(calibrationOf([...turns(4), { estimatedMs: 60_000, lowMs: 40_000, highMs: 90_000, tookMs: 0 }]), 'a turn that took no time').toEqual(NO_CALIBRATION)
})

test('turns that took twice their first estimate lean the bias toward 2, more with every turn, and the range narrows when they all agree', () => {
  const fifty = calibrationOf(turns(50))
  expect(fifty.turns).toBe(50)
  // 2 to the power 50 / (50 + 10).
  expect(near(fifty.bias)).toBe(near(2 ** (5 / 6)))
  // Every turn missed by 0.28 of its range once corrected: the range halves, its floor.
  expect(fifty.widen).toBe(0.5)
  expect(near(calibrationOf(turns(5)).bias)).toBe(near(2 ** (1 / 3)))
})

test('turns that miss by twice their range either way widen it, and leave the bias at 1', () => {
  const wide = (tookMs: number): CalRow => ({ estimatedMs: 60_000, lowMs: 30_000, highMs: 120_000, tookMs })
  const cal = calibrationOf([...Array.from({ length: 25 }, () => wide(240_000)), ...Array.from({ length: 25 }, () => wide(15_000))])
  expect(cal.bias).toBe(1)
  expect(near(cal.widen)).toBe(near(1 + 5 / 6))
})

test('only the last 50 turns count', () => {
  const cal = calibrationOf([...turns(50, 60_000), ...turns(50)])
  expect(cal.turns).toBe(50)
  expect(near(cal.bias)).toBe(near(2 ** (5 / 6)))
})

test('a row from before calibration is measured by the estimate it showed; a newer one by the estimate before calibration', () => {
  const shownRight = Array.from({ length: 50 }, (): CalRow => ({ estimatedMs: 120_000, lowMs: 80_000, highMs: 180_000, tookMs: 120_000, raw: { ms: 60_000, lowMs: 40_000, highMs: 90_000 } }))
  expect(near(calibrationOf(shownRight).bias)).toBe(near(2 ** (5 / 6)))
  expect(near(calibrationOf([...turns(25), ...shownRight.slice(0, 25)]).bias), 'old and new rows mixed').toBe(near(2 ** (5 / 6)))
})

test('a row whose raw estimate cannot be read is dropped, not read by the estimate it showed', () => {
  const garbage = Array.from({ length: 50 }, () => ({ estimatedMs: 120_000, lowMs: 80_000, highMs: 180_000, tookMs: 120_000, raw: { ms: 'x' } }) as unknown as CalRow)
  expect(calibrationOf(garbage)).toEqual(NO_CALIBRATION)
})

test('each correction is held between half and three times', () => {
  expect(calibrationOf(turns(50, 6_000_000)).bias).toBe(3)
  expect(calibrationOf(turns(50, 1_000)).bias).toBe(0.5)
})

test('a calibrated estimate: its time scaled by the bias, its range widened about it in proportion', () => {
  const raw = { ms: 60_000, lowMs: 40_000, highMs: 90_000 }
  expect(calibrated(raw, NO_CALIBRATION, 0, PACE)).toBe(raw)
  expect(round(calibrated(raw, { bias: 2, widen: 1, turns: 50 }, 0, PACE))).toEqual({ ms: 120_000, lowMs: 80_000, highMs: 180_000 })
  expect(round(calibrated(raw, { bias: 1, widen: 2, turns: 50 }, 0, PACE))).toEqual({ ms: 60_000, lowMs: 26_667, highMs: 135_000 })
})

test("the correction gives way to the turn's own evidence: at 10 round-equivalents finished, it counts half", () => {
  const raw = { ms: 60_000, lowMs: 40_000, highMs: 90_000 }
  expect(round(calibrated(raw, { bias: 4, widen: 1, turns: 50 }, 10, PACE))).toEqual({ ms: 120_000, lowMs: 80_000, highMs: 180_000 })
})

test('a calibrated range keeps its low end a round or more, yet never above the estimate', () => {
  expect(round(calibrated({ ms: 12_000, lowMs: 10_000, highMs: 20_000 }, { bias: 0.5, widen: 1, turns: 50 }, 0, PACE))).toEqual({ ms: 6_000, lowMs: 6_000, highMs: 10_000 })
  expect(round(calibrated({ ms: 60_000, lowMs: 15_000, highMs: 90_000 }, { bias: 1, widen: 3, turns: 50 }, 0, PACE)).lowMs).toBe(PACE)
})
