import { expect, test } from 'claude-code/testing'

import { SEEDS } from '../hooks/eta'
import {
  BOUNDS,
  appendLog,
  flushHistory,
  loadHistory,
  mergeCommands,
  mergeSizes,
  readCommands,
  readSizes,
  type LogRow,
  type Store,
} from '../hooks/history'

const json = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

/** A store in memory that keeps JSON as `$.store` does; its first `failSets` writes throw, as one over 4 MiB would, and `failOn` throws once. */
function memoryStore(entries: Record<string, unknown> = {}, failSets = 0, failOn?: string) {
  const data = new Map<string, unknown>(Object.entries(entries).map(([k, v]) => [k, json(v)]))
  let failures = failSets
  let failedOnce = false
  const store: Store = {
    get: async key => json(data.get(key)),
    set: async (key, value) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('over 4 MiB')
      }
      if (key === failOn && !failedOnce) {
        failedOnce = true
        throw new Error('write failed')
      }
      data.set(key, json(value))
    },
  }
  return { store, data }
}

const row = (n: number): LogRow => ({ at: n, firstAtMs: 10_000, estimatedMs: 80_000, lowMs: 66_000, highMs: 108_000, tookMs: 65_000, source: 'progress' })

test('stored samples are read kind by kind; a missing or unreadable kind takes its seeds', () => {
  expect(readSizes(undefined)).toEqual(SEEDS)
  const read = readSizes({ s: [2, 3], m: 'garbage', l: [-1], task: [] })
  expect(read.s).toEqual([2, 3])
  expect(read.m).toEqual(SEEDS.m)
  expect(read.l).toEqual(SEEDS.l)
  expect(read.task).toEqual(SEEDS.task)
})

test("a turn's samples are added to the stored ones, each kind keeping its last 50", () => {
  const merged = mergeSizes({ s: Array.from({ length: 50 }, () => 1) }, { s: [9] })
  expect(merged.s).toHaveLength(50)
  expect(merged.s[49]).toBe(9)
  expect(merged.m).toEqual(SEEDS.m)
})

test("a command's runs go under its project, keeping the last 10, the least recently used commands and projects dropped past the bounds", () => {
  expect(mergeCommands(undefined, '/repo', { 'npm test': [1_000, 2_000] }, 5)).toEqual({ '/repo': { 'npm test': { samples: [1_000, 2_000], lastUsed: 5 } } })
  const ten = Array.from({ length: 10 }, (_, i) => (i + 1) * 1_000)
  const longer = mergeCommands({ '/repo': { 'npm test': { samples: ten, lastUsed: 1 } } }, '/repo', { 'npm test': [11_000] }, 2)
  expect(longer['/repo']?.['npm test']?.samples).toEqual([2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000, 11_000])

  const two = { ...BOUNDS, commands: 2, projects: 2 }
  const commands = { '/repo': { a: { samples: [1], lastUsed: 1 }, b: { samples: [1], lastUsed: 2 } } }
  expect(Object.keys(mergeCommands(commands, '/repo', { c: [1] }, 3, two)['/repo'] ?? {}).sort()).toEqual(['b', 'c'])
  const projects = { '/p1': { a: { samples: [1], lastUsed: 1 } }, '/p2': { a: { samples: [1], lastUsed: 2 } } }
  expect(Object.keys(mergeCommands(projects, '/p3', { a: [1] }, 3, two)).sort()).toEqual(['/p2', '/p3'])
})

test("the estimator reads only this project's commands", () => {
  const stored = { '/repo': { 'npm test': { samples: [1_000], lastUsed: 1 } }, '/other': { make: { samples: [2_000], lastUsed: 1 } } }
  expect(readCommands(stored, '/repo')).toEqual({ 'npm test': [1_000] })
  expect(readCommands('garbage', '/repo')).toEqual({})
})

test('the log keeps its last 200 rows and drops the ones it cannot read', () => {
  const full = [...Array.from({ length: 200 }, (_, i) => row(i)), { at: 'nope' }]
  const out = appendLog(full, row(999))
  expect(out).toHaveLength(200)
  expect(out[199]?.at).toBe(999)
})

test('the history loads from the store, and is the seeds when the store is empty, of another version, or fails', async () => {
  expect((await loadHistory(memoryStore().store, '/repo')).sizes).toEqual(SEEDS)
  expect((await loadHistory(memoryStore({ 'eta.version': 2, 'eta.sizes': { s: [9] } }).store, '/repo')).sizes).toEqual(SEEDS)
  const broken: Store = { get: async () => { throw new Error('no store') }, set: async () => {} }
  expect((await loadHistory(broken, '/repo')).sizes).toEqual(SEEDS)
  const stored = memoryStore({ 'eta.version': 1, 'eta.sizes': { s: [9] }, 'eta.commands': { '/repo': { make: { samples: [3_000], lastUsed: 1 } } } })
  const loaded = await loadHistory(stored.store, '/repo')
  expect(loaded.sizes.s).toEqual([9])
  expect(loaded.commands).toEqual({ make: [3_000] })
})

test("a write reads the store again first, so another session's samples are kept", async () => {
  const { store, data } = memoryStore()
  await loadHistory(store, '/repo')
  data.set('eta.sizes', { s: [7] }) // another session wrote meanwhile
  const written = await flushHistory(store, '/repo', { sizes: { s: [3] }, commands: { make: [4_000] } }, 1, row(1))
  expect((data.get('eta.sizes') as { s: number[] }).s).toEqual([7, 3])
  expect(data.get('eta.version')).toBe(1)
  expect(written?.commands).toEqual({ make: [4_000] })
  expect((data.get('eta.log') as LogRow[]).map(r => r.at)).toEqual([1])
})

test('a failed write prunes to half the bounds and tries once more', async () => {
  const ten = Array.from({ length: 10 }, (_, i) => (i + 1) * 1_000)
  const { store, data } = memoryStore({ 'eta.commands': { '/repo': { 'npm test': { samples: ten, lastUsed: 1 } } } }, 1)
  const written = await flushHistory(store, '/repo', { sizes: {}, commands: { 'npm test': [11_000] } }, 2, null)
  expect(written).not.toBeNull()
  const kept = (data.get('eta.commands') as Record<string, Record<string, { samples: number[] }>>)['/repo']?.['npm test']?.samples
  expect(kept).toEqual([7_000, 8_000, 9_000, 10_000, 11_000])
})

test('nothing to write writes nothing', async () => {
  const { store, data } = memoryStore()
  expect(await flushHistory(store, '/repo', { sizes: {}, commands: {} }, 1, null)).toBeNull()
  expect(data.size).toBe(0)
})

test("a store of a newer version is never written over: this release only reads what it understands", async () => {
  const { store, data } = memoryStore({ 'eta.version': 2, 'eta.sizes': { s: [9] } })
  const before = JSON.stringify([...data])
  expect(await flushHistory(store, '/repo', { sizes: { s: [3] }, commands: { make: [4_000] } }, 1, row(1))).toBeNull()
  expect(JSON.stringify([...data])).toBe(before)
})

test('a write that fails partway is retried without counting the samples twice', async () => {
  const { store, data } = memoryStore({}, 0, 'eta.commands')
  const written = await flushHistory(store, '/repo', { sizes: { s: [3] }, commands: { make: [4_000] } }, 1, null)
  expect(written).not.toBeNull()
  expect((data.get('eta.sizes') as { s: number[] }).s).toEqual([1, 1.5, 2, 3, 4, 3])
  expect((data.get('eta.commands') as Record<string, Record<string, { samples: number[] }>>)['/repo']?.make?.samples).toEqual([4_000])
})

test('samples that are not finite and positive are dropped, and the history they would have erased is kept', async () => {
  const { store, data } = memoryStore()
  await flushHistory(store, '/repo', { sizes: { s: [0, Number.NaN, 5] }, commands: { make: [0], ok: [1_000] } }, 1, null)
  expect((data.get('eta.sizes') as { s: number[] }).s).toEqual([1, 1.5, 2, 3, 4, 5])
  const commands = (data.get('eta.commands') as Record<string, Record<string, { samples: number[] }>>)['/repo']
  expect(Object.keys(commands ?? {})).toEqual(['ok'])
  expect(commands?.ok?.samples).toEqual([1_000])
  const loaded = await loadHistory(store, '/repo')
  expect(loaded.sizes.s).toEqual([1, 1.5, 2, 3, 4, 5])
  expect(loaded.commands).toEqual({ ok: [1_000] })
})
