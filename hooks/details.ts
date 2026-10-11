// What a band's stats open onto: the records a turn keeps of its calls, files, reads and steps, and the rows that list them.

import type { Color } from 'claude-code'

import type { AgentRun, CallRecord, Detail, FileChange, StatKind, StepRecord, Task } from '../types'
import { basename, duration, plural, shortToolName, tokens } from './frames'

const MAX_CALLS = 500
const MAX_FILES = 500
const MAX_READS = 500
const MAX_STEPS = 300

/** The glyph each stat is drawn with, so its kind reads at a glance. */
export const ICONS: Record<StatKind, string> = {
  tools: '⚒',
  subagents: '⑂',
  files: '✎',
  reads: '⌕',
  steps: '↻',
  tokens: '⇅',
  errors: '⚠',
  tasks: '☰',
}

export const emptyDetail = (): Detail => ({ calls: [], files: [], reads: [], stepLog: [], agentIds: [] })

/** A turn's or a run's details; one kept from before they existed has none. */
export const detailOf = (x: { detail?: Detail } | null | undefined): Detail => x?.detail ?? emptyDetail()

export function withCall(d: Detail, call: CallRecord): Detail {
  return { ...d, calls: [...d.calls, call].slice(-MAX_CALLS) }
}

export function finishCall(d: Detail, id: string, change: Pick<CallRecord, 'durationMs' | 'status' | 'error'>): Detail {
  return { ...d, calls: d.calls.map(c => (c.id === id ? { ...c, ...change } : c)) }
}

/** Adds a write's lines to its file's count; a write that could not be measured leaves the file unmeasured. */
export function withFile(d: Detail, path: string, lines: { added: number; removed: number } | null): Detail {
  const add = (a: number | null, b: number | undefined) => (a === null || b === undefined ? null : a + b)
  const known = d.files.find(f => f.path === path)
  if (known === undefined) {
    const file: FileChange = { path, added: lines?.added ?? null, removed: lines?.removed ?? null }
    return { ...d, files: [...d.files, file].slice(-MAX_FILES) }
  }
  return {
    ...d,
    files: d.files.map(f => (f.path === path ? { path, added: add(f.added, lines?.added), removed: add(f.removed, lines?.removed) } : f)),
  }
}

export function withRead(d: Detail, path: string): Detail {
  return d.reads.includes(path) ? d : { ...d, reads: [...d.reads, path].slice(-MAX_READS) }
}

export function withStep(d: Detail, step: StepRecord): Detail {
  return { ...d, stepLog: [...d.stepLog, step].slice(-MAX_STEPS) }
}

export function withAgent(d: Detail, id: string): Detail {
  return d.agentIds.includes(id) ? d : { ...d, agentIds: [...d.agentIds, id] }
}

// Line counts of a write: from the tool's own patch where it gave one, else from what the call was asked to write.

export function linesOf(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Lines added and removed between two texts, the unchanged head and tail aside. */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const a = linesOf(before)
  const b = linesOf(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  return { added: b.length - head - tail, removed: a.length - head - tail }
}

type Hunk = { lines?: unknown }

/** The `+` and `-` lines of a structured patch, or null for none. */
export function patchCount(patch: unknown): { added: number; removed: number } | null {
  if (!Array.isArray(patch) || patch.length === 0) return null
  let added = 0
  let removed = 0
  for (const hunk of patch as Hunk[]) {
    if (!Array.isArray(hunk.lines)) continue
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  return { added, removed }
}

/** What one successful write changed, in lines; null when it cannot be told. */
export function editLines(tool: string, input: Record<string, unknown>, result: unknown): { added: number; removed: number } | null {
  const r = (typeof result === 'object' && result !== null ? result : {}) as {
    structuredPatch?: unknown
    type?: unknown
    originalFile?: unknown
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  if (tool === 'Write') {
    const content = str(input.content)
    if (r.type === 'create') return { added: linesOf(content).length, removed: 0 }
    const patched = patchCount(r.structuredPatch)
    if (patched !== null) return patched
    if (typeof r.originalFile === 'string') return lineDelta(r.originalFile, content)
    // A tool that said nothing of the file it replaced: count it as written.
    return r.type === undefined ? { added: linesOf(content).length, removed: 0 } : null
  }
  if (tool === 'Edit' || tool === 'MultiEdit') {
    const patched = patchCount(r.structuredPatch)
    if (patched !== null) return patched
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input]
    return edits.reduce<{ added: number; removed: number }>(
      (sum, edit) => {
        const one = lineDelta(str(edit.old_string), str(edit.new_string))
        return { added: sum.added + one.added, removed: sum.removed + one.removed }
      },
      { added: 0, removed: 0 },
    )
  }
  return null
}

/** The first line of why a call failed. */
export function errorText(ran: { deny?: unknown; result?: unknown; text?: unknown }): string | undefined {
  const raw = typeof ran.deny === 'string' ? ran.deny : typeof ran.result === 'string' ? ran.result : typeof ran.text === 'string' ? ran.text : ''
  const line = raw.replace(/<\/?tool_use_error>/g, '').trim().split('\n')[0] ?? ''
  return line === '' ? undefined : line.length > 120 ? `${line.slice(0, 119)}…` : line
}

// The rows a stat opens onto.

export function briefDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  return duration(ms)
}

/** Each path's file name, with its folder where two share a name. */
export function shortPaths(paths: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const p of paths) counts.set(basename(p), (counts.get(basename(p)) ?? 0) + 1)
  return paths.map(p => {
    const name = basename(p)
    if ((counts.get(name) ?? 0) < 2) return name
    const parts = p.split('/').filter(Boolean)
    return parts.slice(-2).join('/')
  })
}

/** `Read ×3, Edit` for a list of tool names. */
export function toolTally(names: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(', ')
}

export type DetailLine = {
  key: string
  /** A leading status mark, drawn in `color`. */
  glyph?: string
  color?: Color
  text: string
  /** Drawn dim after the text. */
  trail?: string
  /** A file's lines, drawn green and red. */
  lines?: { added: number; removed: number }
  /** A header or a `+N more` row, drawn dim. */
  isNote?: boolean
}

export type DetailSource = {
  detail: Detail
  agents: readonly AgentRun[]
  tasks: readonly Task[]
  tokensIn: number
  tokensOut: number
  tokensCached?: number
  tokensCacheWrite?: number
  model: string | null
  now: number
  /** Cells a row may take, for rows that pack names side by side. */
  columns: number
}

const callMark = (c: CallRecord): Pick<DetailLine, 'glyph' | 'color'> =>
  c.status === 'running' ? { glyph: '◐', color: 'claude' } : c.status === 'ok' ? { glyph: '✓', color: 'success' } : { glyph: '✗', color: 'error' }

const runMark = (run: AgentRun): Pick<DetailLine, 'glyph' | 'color'> =>
  run.finishedAt === null
    ? { glyph: '◐', color: 'claude' }
    : run.reason === 'answer'
      ? { glyph: '✓', color: 'success' }
      : run.reason === 'aborted'
        ? { glyph: '■', color: 'warning' }
        : { glyph: '✗', color: 'error' }

/** The last `room` of `lines`, a `+N earlier` row first when some do not fit. */
function latest(lines: DetailLine[], room: number, what = 'earlier'): DetailLine[] {
  if (lines.length <= room) return lines
  const keep = Math.max(1, room - 1)
  return [{ key: 'more', text: `+${lines.length - keep} ${what}`, isNote: true }, ...lines.slice(-keep)]
}

/** The first `room` of `lines`, a `+N more` row last when some do not fit. */
function first(lines: DetailLine[], room: number): DetailLine[] {
  if (lines.length <= room) return lines
  const keep = Math.max(1, room - 1)
  return [...lines.slice(0, keep), { key: 'more', text: `+${lines.length - keep} more`, isNote: true }]
}

/** Names packed side by side into rows of `columns` cells. */
function packed(names: readonly string[], columns: number, room: number): DetailLine[] {
  const rows: string[] = []
  for (const name of names) {
    const last = rows[rows.length - 1]
    if (last !== undefined && last.length + 3 + name.length <= columns) rows[rows.length - 1] = `${last}   ${name}`
    else rows.push(name)
  }
  return first(
    rows.map((text, i) => ({ key: `row-${i}`, text })),
    room,
  )
}

/** The rows `kind`'s stat opens onto, at most `room` of them. */
export function detailLines(kind: StatKind, src: DetailSource, room: number): DetailLine[] {
  if (room <= 0) return []
  const d = src.detail
  switch (kind) {
    case 'tools': {
      const calls = d.calls.filter(c => c.agentId === undefined)
      if (calls.length === 0) return [{ key: 'none', text: 'No tool calls yet', isNote: true }]
      const header: DetailLine = { key: 'tally', text: toolTally(calls.map(c => shortToolName(c.tool))), isNote: true }
      const rows = calls.map(
        (c): DetailLine => ({
          key: c.id,
          ...callMark(c),
          text: c.label,
          trail: c.durationMs === null ? briefDuration(src.now - c.startedAt) : c.error !== undefined ? `${briefDuration(c.durationMs)} · ${c.error}` : briefDuration(c.durationMs),
        }),
      )
      return [header, ...latest(rows, room - 1)].slice(0, room)
    }
    case 'subagents': {
      const runs = d.agentIds.map(id => src.agents.find(run => run.id === id)).filter((run): run is AgentRun => run !== undefined)
      if (runs.length === 0) return [{ key: 'none', text: 'No subagents yet', isNote: true }]
      const rows = runs.map((run): DetailLine => {
        const elapsed = run.finishedAt === null ? src.now - run.startedAt : (run.durationMs ?? run.finishedAt - run.startedAt)
        const what = run.finishedAt === null && run.lastActivity !== null ? ` · ${run.lastActivity}` : ''
        return {
          key: run.id,
          ...runMark(run),
          text: `${run.description ?? run.type ?? 'subagent'}${run.description !== null && run.type !== null ? ` (${run.type})` : ''}`,
          trail: `${plural(run.toolCalls, 'call')} · ${tokens(run.tokensOut)}↓ · ${duration(elapsed)}${what}`,
        }
      })
      return first(rows, room)
    }
    case 'files': {
      if (d.files.length === 0) return [{ key: 'none', text: 'No files changed yet', isNote: true }]
      const names = shortPaths(d.files.map(f => f.path))
      const width = Math.min(40, Math.max(...names.map(n => n.length)))
      const rows = d.files.map(
        (f, i): DetailLine => ({
          key: f.path,
          text: (names[i] ?? f.path).padEnd(width),
          ...(f.added === null || f.removed === null ? { trail: 'changed' } : { lines: { added: f.added, removed: f.removed } }),
        }),
      )
      return first(rows, room)
    }
    case 'reads': {
      if (d.reads.length === 0) return [{ key: 'none', text: 'No files read yet', isNote: true }]
      return packed(shortPaths(d.reads), Math.max(20, src.columns - 4), room)
    }
    case 'steps': {
      const steps = d.stepLog
      if (steps.length === 0) return [{ key: 'none', text: 'No model steps yet', isNote: true }]
      const modelMs = steps.reduce((sum, s) => sum + s.durationMs, 0)
      const toolMs = d.calls.filter(c => c.agentId === undefined).reduce((sum, c) => sum + (c.durationMs ?? 0), 0)
      const header: DetailLine = { key: 'time', text: `model ${duration(modelMs)} · tools ${duration(toolMs)}`, isNote: true }
      const rows = steps.map(
        (s): DetailLine => ({
          key: `step-${s.index}`,
          glyph: `#${s.index + 1}`,
          color: 'claude',
          text:
            s.tools.length > 0
              ? toolTally(s.tools)
              : s.stopReason === 'end_turn'
                ? 'answered'
                : s.stopReason === 'max_tokens'
                  ? 'hit the output limit'
                  : s.stopReason === null
                    ? 'no response'
                    : s.stopReason.replace(/_/g, ' '),
          trail: `${tokens(s.tokensIn)}↑ ${tokens(s.tokensOut)}↓ · ${briefDuration(s.durationMs)}`,
        }),
      )
      return [header, ...latest(rows, room - 1)].slice(0, room)
    }
    case 'tokens': {
      const rows: DetailLine[] = []
      const cached = src.tokensCached
      if (cached !== undefined && src.tokensIn > 0) {
        const write = src.tokensCacheWrite ?? 0
        const fresh = Math.max(0, src.tokensIn - cached - write)
        const pct = Math.round((cached / src.tokensIn) * 100)
        rows.push({
          key: 'in',
          glyph: '↑',
          color: 'claude',
          text: `${tokens(src.tokensIn)} in`,
          trail: `${tokens(fresh)} fresh · ${tokens(cached)} cache read (${pct}%)${write > 0 ? ` · ${tokens(write)} cache write` : ''}`,
        })
      } else {
        rows.push({ key: 'in', glyph: '↑', color: 'claude', text: `${tokens(src.tokensIn)} in` })
      }
      const steps = d.stepLog.length
      rows.push({
        key: 'out',
        glyph: '↓',
        color: 'claude',
        text: `${tokens(src.tokensOut)} out`,
        trail: steps > 0 ? `${tokens(Math.round(src.tokensOut / steps))} per step` : undefined,
      })
      const last = d.stepLog[d.stepLog.length - 1]
      if (last !== undefined) rows.push({ key: 'context', glyph: '◧', color: 'claude', text: `${tokens(last.tokensIn)} context`, trail: 'at the last step' })
      if (src.model !== null) rows.push({ key: 'model', glyph: '◆', color: 'claude', text: src.model })
      return rows.slice(0, room)
    }
    case 'errors': {
      const failed = d.calls.filter(c => c.status === 'error')
      if (failed.length === 0) return [{ key: 'none', text: 'No failed calls', isNote: true }]
      const rows = failed.map(
        (c): DetailLine => ({
          key: c.id,
          glyph: '✗',
          color: 'error',
          text: `${c.agentId !== undefined ? `${ICONS.subagents} ` : ''}${c.label}`,
          trail: c.error,
        }),
      )
      return latest(rows, room)
    }
    case 'tasks': {
      if (src.tasks.length === 0) return [{ key: 'none', text: 'No steps', isNote: true }]
      const rows = src.tasks.map(
        (task): DetailLine => ({
          key: task.id,
          glyph: task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◐' : '○',
          color: task.status === 'completed' ? 'success' : task.status === 'in_progress' ? 'claude' : 'inactive',
          text: task.subject,
        }),
      )
      return first(rows, room)
    }
  }
}
