// Pure drawing helpers: Raster cells for the bar and spinner, and text formatting.

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

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function basename(path: string): string {
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

/** The checkbox items of a Markdown text, outside fenced code blocks. */
export function parseCheckboxes(text: string): { text: string; done: boolean }[] {
  const items: { text: string; done: boolean }[] = []
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1]
    if (marker !== undefined) {
      if (fence === null) fence = marker[0] ?? null
      else if (marker[0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const m = CHECKBOX.exec(line)
    if (m !== null) items.push({ text: (m[2] ?? '').replace(/[*_`]/g, ''), done: m[1] !== ' ' })
  }
  return items.slice(0, 300)
}

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path)
