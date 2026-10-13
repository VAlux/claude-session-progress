// The countdown's memory across sessions: how long each size of item and each command took, in the mod's own store.

import type { EtaPending, SampleKind } from '../types'
import { SEEDS, type Sizes } from './eta'

const KEY = { version: 'eta.version', sizes: 'eta.sizes', commands: 'eta.commands', log: 'eta.log' } as const
const VERSION = 1

/** How much the store keeps: samples per kind, runs per command, commands per project, projects, and log rows. */
export type Bounds = { sizes: number; runs: number; commands: number; projects: number; log: number }
export const BOUNDS: Bounds = { sizes: 50, runs: 10, commands: 100, projects: 50, log: 200 }

/** One turn's first estimate against what followed. */
export type LogRow = { at: number; firstAtMs: number; estimatedMs: number; lowMs: number; highMs: number; tookMs: number; source: 'progress' | 'tasks' | 'plan' }

/** What the estimator reads: every kind's samples, and this project's command runs. */
export type History = { sizes: Sizes; commands: Record<string, number[]> }

/** The part of `$.store` the history uses. */
export type Store = { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> }

type Runs = { samples: number[]; lastUsed: number }
type Commands = Record<string, Record<string, Runs>>

const isTimes = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'number' && Number.isFinite(x) && x > 0)
const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** The history before anything is learned. */
export const seeded = (): History => ({ sizes: readSizes(undefined), commands: {} })

/** Every kind's stored samples; a kind missing or unreadable takes its seeds. */
export function readSizes(stored: unknown): Sizes {
  const s = asRecord(stored)
  const out = {} as Sizes
  for (const kind of Object.keys(SEEDS) as SampleKind[]) {
    const v = s[kind]
    out[kind] = isTimes(v) ? [...v] : [...SEEDS[kind]]
  }
  return out
}

/** The stored commands of every project, without the entries that cannot be read. */
function readAll(stored: unknown): Commands {
  const out: Commands = {}
  for (const [project, commands] of Object.entries(asRecord(stored))) {
    const kept: Record<string, Runs> = {}
    for (const [command, runs] of Object.entries(asRecord(commands))) {
      const r = asRecord(runs)
      if (isTimes(r.samples) && typeof r.lastUsed === 'number') kept[command] = { samples: [...r.samples], lastUsed: r.lastUsed }
    }
    if (Object.keys(kept).length > 0) out[project] = kept
  }
  return out
}

/** One project's command runs. */
export function readCommands(stored: unknown, project: string): Record<string, number[]> {
  return Object.fromEntries(Object.entries(readAll(stored)[project] ?? {}).map(([command, runs]) => [command, runs.samples]))
}

/** The stored samples with a turn's added, each kind keeping its last `max`. */
export function mergeSizes(stored: unknown, added: EtaPending['sizes'], max = BOUNDS.sizes): Sizes {
  const out = readSizes(stored)
  for (const kind of Object.keys(added) as SampleKind[]) out[kind] = [...out[kind], ...(added[kind] ?? [])].slice(-max)
  return out
}

const lastUsedOf = (commands: Record<string, Runs>) => Math.max(0, ...Object.values(commands).map(r => r.lastUsed))

/** The stored commands with a turn's runs added under its project; past the bounds the least recently used commands and projects go. */
export function mergeCommands(stored: unknown, project: string, added: EtaPending['commands'], now: number, bounds = BOUNDS): Commands {
  const all = readAll(stored)
  const mine = { ...(all[project] ?? {}) }
  for (const [command, runs] of Object.entries(added)) {
    if (runs.length === 0) continue
    mine[command] = { samples: [...(mine[command]?.samples ?? []), ...runs].slice(-bounds.runs), lastUsed: now }
  }
  const kept = Object.fromEntries(Object.entries(mine).sort((a, b) => b[1].lastUsed - a[1].lastUsed).slice(0, bounds.commands))
  const projects = Object.entries({ ...all, [project]: kept })
    .filter(([, commands]) => Object.keys(commands).length > 0)
    .sort((a, b) => lastUsedOf(b[1]) - lastUsedOf(a[1]))
  return Object.fromEntries(projects.slice(0, bounds.projects))
}

const isRow = (v: unknown): v is LogRow => {
  const r = asRecord(v)
  return ['at', 'firstAtMs', 'estimatedMs', 'lowMs', 'highMs', 'tookMs'].every(k => typeof r[k] === 'number') && typeof r.source === 'string'
}

/** The stored log with one row added, keeping the last `max`. */
export function appendLog(stored: unknown, row: LogRow, max = BOUNDS.log): LogRow[] {
  return [...(Array.isArray(stored) ? stored.filter(isRow) : []), row].slice(-max)
}

/** Whether the store holds this version's data, or none yet. */
async function isCurrent(store: Store): Promise<boolean> {
  const version = await store.get(KEY.version)
  return version === undefined || version === VERSION
}

/** One project's history as stored; the seeds when the store cannot be read or holds another version. */
export async function loadHistory(store: Store, project: string): Promise<History> {
  try {
    if (!(await isCurrent(store))) return seeded()
    return { sizes: readSizes(await store.get(KEY.sizes)), commands: readCommands(await store.get(KEY.commands), project) }
  } catch {
    return seeded()
  }
}

const halved = (b: Bounds): Bounds => ({
  sizes: Math.ceil(b.sizes / 2),
  runs: Math.ceil(b.runs / 2),
  commands: Math.ceil(b.commands / 2),
  projects: Math.ceil(b.projects / 2),
  log: Math.ceil(b.log / 2),
})

/**
 * Writes a turn's samples and its log row, each key read again and merged first so two sessions keep each other's.
 * A failed write prunes to half the bounds and tries once more. Resolves the project's history as written, or null when nothing was.
 */
export async function flushHistory(store: Store, project: string, pending: EtaPending, now: number, row: LogRow | null): Promise<History | null> {
  const hasSizes = Object.values(pending.sizes).some(list => (list?.length ?? 0) > 0)
  const hasCommands = Object.values(pending.commands).some(list => list.length > 0)
  if (!hasSizes && !hasCommands && row === null) return null
  for (const bounds of [BOUNDS, halved(BOUNDS)]) {
    try {
      const current = await isCurrent(store)
      const stored = async (key: string) => (current ? await store.get(key) : undefined)
      const sizes = mergeSizes(await stored(KEY.sizes), pending.sizes, bounds.sizes)
      const commands = mergeCommands(await stored(KEY.commands), project, pending.commands, now, bounds)
      const log = row === null ? null : appendLog(await stored(KEY.log), row, bounds.log)
      await store.set(KEY.version, VERSION)
      await store.set(KEY.sizes, sizes)
      await store.set(KEY.commands, commands)
      if (log !== null) await store.set(KEY.log, log)
      return { sizes, commands: readCommands(commands, project) }
    } catch {
      // Over the store's 4 MiB, say: the second pass keeps half as much.
    }
  }
  return null
}
