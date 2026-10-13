import { expect, test } from 'claude-code/testing'

import {
  SEEDS,
  advanceFill,
  combine,
  commandBasis,
  commandKey,
  correction,
  estimate,
  freshEta,
  isUsable,
  learnCommand,
  learnItem,
  learnTasks,
  normalizeCommand,
  paceOf,
  quantile,
  remainingOf,
  roundTimes,
  runningSince,
  sizedBasis,
  spreadOf,
  startFill,
  taskKey,
  tickEta,
  totalOf,
  type EtaInput,
} from '../hooks/eta'
import { capitalize, countdownLabel, etaLabels, etaRange, etaValue, fitLabel, isGrowing, shownMs } from '../hooks/frames'
import type { CallRecord, Detail, StepRecord, Task } from '../types'

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

test('a countdown label is the fullest that fits on the terminal, the whole one on the desktop, and carries ↑ while it grows', () => {
  const est = { ms: 240_000, lowMs: 180_000, highMs: 360_000 }
  expect(isGrowing(null, 5)).toBe(false)
  expect(isGrowing(10, 5)).toBe(true)
  expect(isGrowing(10, 10)).toBe(false)
  expect(countdownLabel(null, false, true, 80)).toBe('')
  expect(countdownLabel(est, false, true, 80)).toBe('~4m left (3–6m)')
  expect(countdownLabel(est, false, true, 30)).toBe('~4m left')
  expect(countdownLabel(est, false, false, 30)).toBe('~4m left (3–6m)')
  expect(countdownLabel(est, true, true, 80)).toBe('~4m left (3–6m) ↑')
})

test('a command is keyed trimmed, its spaces collapsed, a leading cd dropped, cut to 200 characters', () => {
  expect(normalizeCommand('  npm   test ')).toBe('npm test')
  expect(normalizeCommand('cd /repo && npm test')).toBe('npm test')
  expect(normalizeCommand('cd "/a b" && make')).toBe('make')
  expect(normalizeCommand('x'.repeat(300))).toHaveLength(200)
})

test('a command is keyed by a hash of its normalized text, so the text itself is never kept', () => {
  expect(commandKey('cd /repo &&  npm   test')).toBe(commandKey('npm test'))
  expect(commandKey('npm test')).toMatch(/^[0-9a-f]{14}$/)
  expect(commandKey('npm test')).not.toBe(commandKey('npm run test'))
})

const step = (index: number, startedAt: number, durationMs = 1_000): StepRecord => ({ index, startedAt, durationMs, tools: [], tokensIn: 0, tokensOut: 0, stopReason: null })
const call = (startedAt: number, command: string, status: CallRecord['status'] = 'ok'): CallRecord => ({
  id: `c${startedAt}`,
  tool: 'Bash',
  label: command,
  command: commandKey(command),
  startedAt,
  durationMs: 1,
  status,
})
const detail = (stepLog: StepRecord[], calls: CallRecord[] = []): Detail => ({ calls, files: [], reads: [], stepLog, agentIds: [] })

test("the pace is the median round, leaving out rounds that ran a run item's command", () => {
  const steps = [step(0, 0), step(1, 10_000), step(2, 30_000), step(3, 31_000)]
  expect(roundTimes(steps, [], new Set())).toEqual([10_000, 20_000, 1_000])
  expect(roundTimes(steps, [call(12_000, 'npm test')], new Set([commandKey('npm test')]))).toEqual([10_000, 1_000])
  expect(paceOf(detail(steps), [])).toBe(10_000)
  expect(paceOf(detail(steps, [call(12_000, 'npm test')]), [commandKey('npm test')])).toBe(5_500)
  expect(paceOf(detail([step(0, 0, 4_000)]), []), 'before a round has completed, the first request').toBe(4_000)
  expect(paceOf(detail([]), [])).toBeNull()
})

test("a run item's command, while it runs, is timed from when it started", () => {
  const work = { items: [{ do: 'test', run: 'npm  test' }], finished: [], topSince: 0 }
  expect(runningSince(detail([], [call(5_000, 'npm test', 'running')]), work)).toBe(5_000)
  expect(runningSince(detail([], [call(5_000, 'npm test')]), work)).toBeNull()
  expect(runningSince(detail([], [call(5_000, 'npm test', 'running')]), null)).toBeNull()
})

const NOW = 1_000_000
const input = (over: Partial<EtaInput>): EtaInput => ({
  now: NOW,
  pace: 10_000,
  work: null,
  runningSince: null,
  tasks: null,
  since: {},
  sizes: SEEDS,
  commands: {},
  c: 1,
  roundsSinceReport: 0,
  ...over,
})
const rounded = (s: { ms: number; lowMs: number; highMs: number } | null) => s && { ms: Math.round(s.ms), lowMs: Math.round(s.lowMs), highMs: Math.round(s.highMs) }
const listed = (items: { do: string; size?: 's' | 'm' | 'l'; run?: string }[], topSince = NOW) => ({ items, finished: [], topSince })

test("a Progress list's estimate: the item in progress, the rest's medians, a round for the answer", () => {
  const out = estimate(input({ work: listed([{ do: 'a', size: 'm' }, { do: 'b', size: 's' }]) }))
  expect(rounded(out.estimate)).toEqual({ ms: 80_000, lowMs: 66_584, highMs: 108_636 })
  expect(out.items).toEqual([{ key: 'work-0', ms: 50_000 }, { key: 'work-1', ms: 20_000 }])
  expect(out.source).toBe('progress')
  expect(estimate(input({ pace: null, work: listed([{ do: 'a' }]) })).estimate, 'no pace, no estimate').toBeNull()
  expect(estimate(input({})).estimate, 'nothing reported, no estimate').toBeNull()
  expect(rounded(estimate(input({ work: listed([{ do: 'a', size: 'm' }, { do: 'b', size: 's' }], NOW + 5_000) })).estimate)?.ms, 'a clock behind the item').toBe(80_000)
  expect(Math.round(estimate(input({ work: listed([{ do: 'a', size: 'm' }]), c: correction(6, 2) })).estimate?.ms ?? 0)).toBe(76_667)
})

test("a run item is its command's times, timed from when the command started", () => {
  const work = listed([{ do: 'test', run: 'npm test' }])
  const commands = { [commandKey('npm test')]: [180_000, 190_000, 200_000] }
  expect(estimate(input({ work, commands })).estimate).toEqual({ ms: 200_000, lowMs: 105_000, highMs: 390_000 })
  expect(estimate(input({ work, commands, runningSince: NOW - 60_000 })).estimate?.ms).toBe(140_000)
})

const tasks = (statuses: Task['status'][]): Task[] => statuses.map((status, i) => ({ id: `todo-${i}`, subject: `task ${i}`, status }))

test("a task list's estimate: the task in progress from when it began, the pending ones' medians", () => {
  const list = tasks(['completed', 'in_progress', 'pending'])
  const out = estimate(input({ tasks: { list, kind: 'task' }, since: { [taskKey(list[1]!)]: NOW - 20_000 } }))
  expect(out.estimate?.ms).toBe(90_000)
  expect(out.source).toBe('tasks')
  expect(out.items.map(i => i.key)).toEqual(['todo-1', 'todo-2'])
  expect(estimate(input({ tasks: { list: tasks(['pending', 'pending']), kind: 'planStep' } })).source).toBe('plan')
})

test('an item far past its range with no report for 8 rounds loses its estimate', () => {
  const list = tasks(['in_progress'])
  const late = { tasks: { list, kind: 'task' as const }, since: { [taskKey(list[0]!)]: NOW - 80_000 } }
  expect(estimate(input({ ...late, roundsSinceReport: 7 })).estimate?.ms).toBe(30_000)
  expect(estimate(input({ ...late, roundsSinceReport: 8 })).estimate).toBeNull()
})

test('down to its answer, a list is one round; two rounds later, with Claude still at work, it is none', () => {
  expect(estimate(input({ work: listed([]), roundsSinceReport: 0 })).estimate).toEqual({ ms: 10_000, lowMs: 10_000, highMs: 10_000 })
  expect(estimate(input({ work: listed([]), roundsSinceReport: 2 })).estimate).toBeNull()
})

test('down to its answer, a list is none after three rounds of time too, however few rounds a long call took', () => {
  expect(estimate(input({ work: listed([], NOW - 29_000) })).estimate).toEqual({ ms: 10_000, lowMs: 10_000, highMs: 10_000 })
  expect(estimate(input({ work: listed([], NOW - 31_000) })).estimate).toBeNull()
})

test('a task list with every task done is one round, and none two rounds on', () => {
  const done = tasks(['completed', 'completed'])
  expect(estimate(input({ tasks: { list: done, kind: 'task' }, roundsSinceReport: 0 })).estimate).toEqual({ ms: 10_000, lowMs: 10_000, highMs: 10_000 })
  expect(estimate(input({ tasks: { list: done, kind: 'task' }, roundsSinceReport: 2 })).estimate).toBeNull()
})

test('a finished sized item is learned in round-equivalents, and adds to c; a run item is not', () => {
  const eta = learnItem(freshEta(0), { item: { do: 'a', size: 's' }, since: 0 }, 30_000, 10_000, SEEDS)
  expect(eta.pending.sizes.s).toEqual([3])
  expect(eta.actual).toBe(3)
  expect(eta.estimated).toBe(2)
  expect(learnItem(freshEta(0), { item: { do: 'test', run: 'npm test' }, since: 0 }, 30_000, 10_000, SEEDS).pending.sizes).toEqual({})
  expect(learnItem(freshEta(0), { item: { do: 'a' }, since: 0 }, 30_000, 10_000, SEEDS).pending.sizes.m, 'unsized counts as m').toEqual([3])
  expect(learnItem(freshEta(0), { item: { do: 'a' }, since: 0 }, 30_000, null, SEEDS).pending.sizes).toEqual({})
})

test('a task is timed from when it came into progress to when it finished, once', () => {
  const list = tasks(['in_progress', 'pending'])
  const started = learnTasks(freshEta(0), list, 'task', 1_000, 10_000, SEEDS)
  expect(started.since).toEqual({ [taskKey(list[0]!)]: 1_000 })
  const finished = learnTasks(started, tasks(['completed', 'in_progress']), 'task', 41_000, 10_000, SEEDS)
  expect(finished.pending.sizes.task).toEqual([4])
  expect(finished.since[taskKey(list[1]!)]).toBe(41_000)
  const again = learnTasks(finished, tasks(['completed', 'in_progress']), 'task', 50_000, 10_000, SEEDS)
  expect(again.pending.sizes.task, 'never learned twice').toEqual([4])
  expect(learnTasks(freshEta(0), tasks(['completed']), 'task', 1_000, 10_000, SEEDS).pending.sizes, 'one never seen in progress').toEqual({})
})

test('a rewritten task list times the task now at a position as a new one', () => {
  const one = (status: Task['status'], subject: string): Task[] => [{ id: 'todo-0', subject, status }]
  const a = learnTasks(freshEta(0), one('in_progress', 'write types'), 'task', 0, 10_000, SEEDS)
  const b = learnTasks(a, one('completed', 'write types'), 'task', 30_000, 10_000, SEEDS)
  const c = learnTasks(b, one('in_progress', 'write docs'), 'task', 40_000, 10_000, SEEDS)
  const d = learnTasks(c, one('completed', 'write docs'), 'task', 60_000, 10_000, SEEDS)
  expect(d.pending.sizes.task).toEqual([3, 2])
})

test("a Bash call's time joins its command's runs, the last 10 kept", () => {
  const key = commandKey('npm test')
  let eta = freshEta(0)
  for (let i = 1; i <= 12; i++) eta = learnCommand(eta, key, i * 1_000)
  expect(eta.pending.commands[key]).toEqual([3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000, 11_000, 12_000])
  expect(learnCommand(freshEta(0), key, 0).pending.commands).toEqual({})
})

test('each look keeps the estimate, notes the first, moves the bar on, and marks a growing one', () => {
  const out = (ms: number | null) => ({ estimate: ms === null ? null : { ms, lowMs: ms / 2, highMs: ms * 2 }, items: [], source: 'progress' as const })
  const one = tickEta(freshEta(NOW), out(80_000), NOW + 10_000)
  expect(one.first).toEqual({ atMs: 10_000, ms: 80_000, lowMs: 40_000, highMs: 160_000, source: 'progress' })
  expect(Math.round((one.fill ?? 0) * 1000)).toBe(111)
  expect(one.shownMs).toBe(80_000)
  const two = tickEta(one, out(79_000), NOW + 11_000)
  expect(Math.round((two.fill ?? 0) * 1000)).toBe(122)
  expect(two.upUntil).toBeNull()
  const grown = tickEta(two, out(200_000), NOW + 12_000)
  expect(grown.upUntil).toBe(NOW + 17_000)
  expect(grown.first?.ms, 'the first estimate stays the first').toBe(80_000)
  const lost = tickEta(grown, out(null), NOW + 13_000)
  expect(lost.last).toBeNull()
  expect(lost.fill, 'with no estimate the bar holds').toBe(grown.fill)
})
