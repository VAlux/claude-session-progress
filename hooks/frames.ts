// Pure drawing helpers: Raster cells (terminal) and SVG markup (desktop) for the bar and spinner, and text formatting.

import type { PlanTask } from '../types'

export type Palette = { base: number; glow: number; dim: number }

export const ACCENT: Palette = { base: 0xd97757, glow: 0xffc9a8, dim: 0x8a4a35 }
export const DONE: Palette = { base: 0x4eba65, glow: 0xb8f0c4, dim: 0x2f7a3f }
export const WARN: Palette = { base: 0xd8a64a, glow: 0xffe2a6, dim: 0x8a6a2c }
export const FAIL: Palette = { base: 0xd2555a, glow: 0xffb0b2, dim: 0x8a3236 }

const TRACK = 0x5c5c5c
const DEFAULT_BG = 0x01000000
const FILLED = 0x2501 // ━
const EMPTY = 0x2500 // ─
const HALF = 0x2578 // ╸

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

function lerp(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t))
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff
    const y = (b >> shift) & 0xff
    return Math.round(x + (y - x) * k) << shift
  }
  return ch(16) | ch(8) | ch(0)
}

function encode(words: Uint32Array): string {
  const bytes = new Uint8Array(words.buffer)
  const withBase64 = bytes as Uint8Array & { toBase64?: () => string }
  if (typeof withBase64.toBase64 === 'function') return withBase64.toBase64()
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export const MUTED = 0x9a9a9a

export type BarOptions = {
  /** The moving highlight along the filled part; off for a settled bar. */
  shimmer?: boolean
  /** Text drawn in the bar's own last cells (a percentage, a clock), so it can never wrap away from it. */
  label?: string
  labelColor?: number
}

export function pctLabel(progress: number): string {
  return `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`.padStart(4)
}

/**
 * One row of bar cells, `width` wide including the label. `progress` in [0, 1],
 * or null for an indeterminate comet sweeping the track. `t` is milliseconds,
 * driving the shimmer.
 */
export function barCells(width: number, progress: number | null, t: number, palette: Palette, options: BarOptions = {}): string {
  const { shimmer = true, label = '', labelColor = palette.base } = options
  const w = Math.max(1, Math.min(512, Math.floor(width)))
  const words = new Uint32Array(w * 3)
  const put = (i: number, glyph: number, color: number) => {
    words[i * 3] = glyph
    words[i * 3 + 1] = color
    words[i * 3 + 2] = DEFAULT_BG
  }
  const text = label.length > 0 && label.length + 2 <= w ? label : ''
  const barW = text.length > 0 ? w - text.length - 1 : w
  if (text.length > 0) {
    put(barW, 0x20, labelColor)
    for (let k = 0; k < text.length; k++) put(barW + 1 + k, text.charCodeAt(k), labelColor)
  }

  if (progress === null) {
    const tail = Math.max(6, Math.round(barW / 5))
    const period = 2200
    const head = ((t % period) / period) * (barW + tail)
    for (let i = 0; i < barW; i++) {
      const d = head - i
      if (d >= 0 && d < tail) {
        const k = 1 - d / tail
        put(i, FILLED, lerp(TRACK, d < 1 ? palette.glow : palette.base, k * k))
      } else {
        put(i, EMPTY, TRACK)
      }
    }
    return encode(words)
  }

  const exact = Math.max(0, Math.min(1, progress)) * barW
  const full = Math.floor(exact)
  const shimmerAt = ((t % 2600) / 2600) * (full + 16) - 8
  for (let i = 0; i < barW; i++) {
    if (i < full) {
      const gradient = lerp(palette.dim, palette.base, full <= 1 ? 1 : 0.35 + (0.65 * i) / (full - 1))
      const glow = shimmer ? Math.exp(-((i - shimmerAt) ** 2) / 10) : 0
      put(i, FILLED, lerp(gradient, palette.glow, glow * 0.85))
    } else if (i === full && exact - full >= 0.5) {
      put(i, HALF, palette.base)
    } else {
      put(i, EMPTY, TRACK)
    }
  }
  return encode(words)
}

export function spinnerCells(t: number, palette: Palette): string {
  const glyph = SPINNER.charCodeAt(Math.floor(t / 80) % SPINNER.length)
  const pulse = (Math.sin(t / 400) + 1) / 2
  return encode(Uint32Array.of(glyph, lerp(palette.base, palette.glow, pulse * 0.6), DEFAULT_BG))
}

export function glyphCells(char: string, color: number): string {
  return encode(Uint32Array.of(char.charCodeAt(0), color, DEFAULT_BG))
}

// The desktop's bar and spinner: SVG markup the page draws as an image, or in a frame when it animates.
// Nothing in it depends on the clock, so the band's once-a-second redraw leaves an animation running.

export const hex = (color: number) => `#${(color & 0xffffff).toString(16).padStart(6, '0')}`

const SVG_W = 1000
const SVG_H = 6
const SVG_TRACK = '<rect width="1000" height="6" rx="3" fill="#8c8c8c" fill-opacity="0.3"/>'

/** The bar as SVG, stretched to its row: `progress` in [0, 1], or null for a comet sweeping the track. */
export function barSvg(progress: number | null, palette: Palette, options: { shimmer?: boolean } = {}): { source: string; isAnimated: boolean } {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}" preserveAspectRatio="none">`
  if (progress === null) {
    const tail = 200
    const comet =
      `<defs><linearGradient id="c"><stop offset="0" stop-color="${hex(palette.base)}" stop-opacity="0"/>` +
      `<stop offset="0.85" stop-color="${hex(palette.base)}"/><stop offset="1" stop-color="${hex(palette.glow)}"/></linearGradient></defs>` +
      `<rect x="${-tail}" width="${tail}" height="6" rx="3" fill="url(#c)">` +
      `<animate attributeName="x" from="${-tail}" to="${SVG_W}" dur="2.2s" repeatCount="indefinite"/></rect>`
    return { source: `${open}${SVG_TRACK}${comet}</svg>`, isAnimated: true }
  }
  const fill = Math.round(Math.max(0, Math.min(1, progress)) * SVG_W)
  const bar =
    `<defs><linearGradient id="f"><stop offset="0" stop-color="${hex(palette.dim)}"/><stop offset="1" stop-color="${hex(palette.base)}"/></linearGradient>` +
    `<clipPath id="k"><rect width="${fill}" height="6" rx="3"/></clipPath></defs>` +
    `<rect width="${fill}" height="6" rx="3" fill="url(#f)"/>`
  const isAnimated = options.shimmer === true && fill > 0
  const shimmer = isAnimated
    ? `<defs><linearGradient id="s"><stop offset="0" stop-color="${hex(palette.glow)}" stop-opacity="0"/>` +
      `<stop offset="0.5" stop-color="${hex(palette.glow)}" stop-opacity="0.85"/><stop offset="1" stop-color="${hex(palette.glow)}" stop-opacity="0"/></linearGradient></defs>` +
      `<g clip-path="url(#k)"><rect x="-120" width="120" height="6" fill="url(#s)">` +
      `<animate attributeName="x" from="-120" to="${fill}" dur="2.6s" repeatCount="indefinite"/></rect></g>`
    : ''
  return { source: `${open}${SVG_TRACK}${bar}${shimmer}</svg>`, isAnimated }
}

/** The desktop's live spinner: an arc turning on its own. */
export function spinnerSvg(palette: Palette): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">' +
    `<circle cx="6" cy="6" r="4.5" fill="none" stroke="${hex(palette.base)}" stroke-opacity="0.25" stroke-width="2"/>` +
    `<path d="M6 1.5 A4.5 4.5 0 0 1 10.5 6" fill="none" stroke="${hex(palette.base)}" stroke-width="2" stroke-linecap="round">` +
    '<animateTransform attributeName="transform" type="rotate" from="0 6 6" to="360 6 6" dur="0.9s" repeatCount="indefinite"/></path></svg>'
  )
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** The countdown rounded to the unit its label shows: whole minutes from 2 minutes, 10 s steps under them, 0 under 10 s. */
export function shownMs(ms: number): number {
  if (ms >= 120_000) return Math.round(ms / 60_000) * 60_000
  if (ms >= 10_000) return Math.round(ms / 10_000) * 10_000
  return 0
}

/** The countdown's value as its label reads: `~4m`, `~1m 30s`, `~40s`, or `a few seconds`. */
export function etaValue(ms: number): string {
  const shown = shownMs(ms)
  if (shown === 0) return 'a few seconds'
  if (ms >= 120_000) return `~${shown / 60_000}m`
  const m = Math.floor(shown / 60_000)
  const s = (shown % 60_000) / 1000
  if (m === 0) return `~${s}s`
  return s === 0 ? `~${m}m` : `~${m}m ${s}s`
}

/** The range after a countdown of 2 minutes or more, ` (3–6m)`; null under 2 minutes or when its ends round to the same minute. */
export function etaRange(est: { ms: number; lowMs: number; highMs: number }): string | null {
  if (est.ms < 120_000) return null
  const lo = Math.max(1, Math.round(est.lowMs / 60_000))
  const hi = Math.round(est.highMs / 60_000)
  return hi > lo ? ` (${lo}–${hi}m)` : null
}

/** The countdown's labels, longest first: with its range, without it, the value alone. */
export function etaLabels(est: { ms: number; lowMs: number; highMs: number }): string[] {
  const value = etaValue(est.ms)
  const range = etaRange(est)
  return range === null ? [`${value} left`, value] : [`${value} left${range}`, `${value} left`, value]
}

/** The cells a bar keeps for its track beside its label. */
export const MIN_BAR_CELLS = 20

/** The longest label that leaves the bar its track in `width` cells, or the shortest when none does. */
export function fitLabel(labels: readonly string[], width: number): string {
  return labels.find(label => width - label.length - 1 >= MIN_BAR_CELLS) ?? labels[labels.length - 1] ?? ''
}

/** The text with its first letter in capitals. */
export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** USD per million tokens: fresh input, output, cache read. Cache writes bill at 1.25x input. */
const PRICES: [prefix: string, input: number, output: number, cacheRead: number][] = [
  ['claude-fable-5', 10, 50, 0.25],
  ['claude-mythos-5', 10, 50, 0.25],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4', 5, 25, 0.5],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4', 3, 15, 0.3],
  ['claude-haiku-5', 0.1, 0.5, 0.01],
  ['claude-haiku-4', 1, 5, 0.1],
]

export type StepUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** What one model request costs, from list prices. 0 for a model the table does not know. */
export function stepCost(model: string | null | undefined, usage: StepUsage | null | undefined): number {
  if (!model || !usage) return 0
  const price = PRICES.find(([prefix]) => model.startsWith(prefix))
  if (!price) return 0
  const [, input, output, cacheRead] = price
  return (
    (usage.input_tokens * input +
      usage.cache_creation_input_tokens * input * 1.25 +
      usage.cache_read_input_tokens * cacheRead +
      usage.output_tokens * output) /
    1_000_000
  )
}

export function usd(n: number): string {
  if (n < 0.005) return '<$0.01'
  return `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

function firstLine(text: string, max = 60): string {
  const line = (text.split('\n')[0] ?? '').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A short "what is happening" label for a tool call. */
export function activityLabel(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (tool) {
    case 'Bash':
      return `$ ${firstLine(str('description') || str('command'))}`
    case 'Read':
      return `reading ${basename(str('file_path'))}`
    case 'Edit':
    case 'MultiEdit':
      return `editing ${basename(str('file_path'))}`
    case 'Write':
      return `writing ${basename(str('file_path'))}`
    case 'NotebookEdit':
      return `editing ${basename(str('notebook_path'))}`
    case 'Grep':
      return `searching “${firstLine(str('pattern'), 40)}”`
    case 'Glob':
      return `finding ${firstLine(str('pattern'), 40)}`
    case 'Agent':
    case 'Task':
      return `subagent: ${firstLine(str('description'), 50)}`
    case 'WebFetch':
      try {
        return `fetching ${new URL(str('url')).host}`
      } catch {
        return 'fetching a page'
      }
    case 'WebSearch':
      return `searching the web: ${firstLine(str('query'), 40)}`
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'updating the plan'
    default:
      if (tool.startsWith('mcp__')) {
        const [, server, name] = tool.split('__')
        return `${server} · ${name}`
      }
      return tool
  }
}

export function shortToolName(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const parts = tool.split('__')
  return parts[parts.length - 1] || tool
}

const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+?)\s*$/
const TASK_HEADING = /^#{2,4}\s+Task\s+(\d+)\s*[:.)—–-]\s*(.+?)\s*#*\s*$/
// What superpowers' task-done appends to its ledger, and prints prefixed with `ledger: `.
const LEDGER_DONE = /^(?:ledger:\s*)?Task (\d+): complete\b/gm
const LEDGER_PLAN = /^# SDD ledger — plan: (.+?)\s*$/m

const plain = (text: string) => text.replace(/[*_`]/g, '')

/** A Markdown plan, outside fenced code blocks: its checkboxes, and its `### Task N:` headings with the boxes beneath each. */
export function parsePlan(text: string): { items: { text: string; done: boolean }[]; tasks: PlanTask[] } {
  const items: { text: string; done: boolean }[] = []
  const tasks: PlanTask[] = []
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1]
    if (marker !== undefined) {
      if (fence === null) fence = marker[0] ?? null
      else if (marker[0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = TASK_HEADING.exec(line)
    if (heading !== null) {
      tasks.push({ n: Number(heading[1]), text: plain(heading[2] ?? ''), steps: 0, stepsDone: 0 })
      continue
    }
    const m = CHECKBOX.exec(line)
    if (m === null) continue
    const done = m[1] !== ' '
    items.push({ text: plain(m[2] ?? ''), done })
    const task = tasks[tasks.length - 1]
    if (task !== undefined) {
      task.steps += 1
      if (done) task.stepsDone += 1
    }
  }
  return { items: items.slice(0, 300), tasks: tasks.slice(0, 100) }
}

/** The checkbox items of a Markdown text, outside fenced code blocks. */
export function parseCheckboxes(text: string): { text: string; done: boolean }[] {
  return parsePlan(text).items
}

/** The task numbers a superpowers ledger (or task-done's output) reports complete. */
export function ledgerTasks(text: string): number[] {
  return [...new Set([...text.matchAll(LEDGER_DONE)].map(m => Number(m[1])))]
}

/** The file name of the plan a ledger names in its first line, if it names one. */
export function ledgerPlanName(text: string): string | null {
  const path = LEDGER_PLAN.exec(text)?.[1]
  return path === undefined ? null : path.split('/').pop() || path
}

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path)
