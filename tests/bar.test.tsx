import { expect, test } from 'claude-code/testing'

import { ACCENT, CHANGE_MS, WARN, barCells, barSvg, changeSpan } from '../hooks/frames'

/** A bar's cells read back: each cell's glyph and colour. */
function cellsOf(cells: string): { glyph: string; color: number }[] {
  const bytes = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  const out: { glyph: string; color: number }[] = []
  for (let i = 0; i < words.length; i += 3) out.push({ glyph: String.fromCodePoint(words[i] ?? 0x20), color: words[i + 1] ?? 0 })
  return out
}
const text = (cells: string) => cellsOf(cells).map(c => c.glyph).join('')

test('the track has a gap where each item ends past the head, two cells apart at least, none at its very end', () => {
  expect(text(barCells(20, 0.25, 0, ACCENT, { shimmer: false, ends: [0.5, 0.75] }))).toBe('━━━━━───── ──── ────')
  expect(text(barCells(20, 0.25, 0, ACCENT, { shimmer: false, ends: [0.3, 0.5, 0.52, 0.98] })), 'too near the head, a gap or the end').toBe('━━━━━───── ─────────')
})

test('a span given back holds in amber, then drains into the fill; one gained glows, then fades', () => {
  const back = { from: 0.75, to: 0.25 }
  const held = changeSpan(back, 0, ACCENT)
  expect(held).toEqual({ from: 0.75, color: WARN.base, k: 0.85 })
  expect(changeSpan(back, CHANGE_MS * 0.25, ACCENT)?.from, 'still held').toBe(0.75)
  const draining = changeSpan(back, CHANGE_MS * 0.6, ACCENT)!.from
  expect(draining > 0.25 && draining < 0.75).toBe(true)
  expect(changeSpan(back, CHANGE_MS, ACCENT), 'over').toBeNull()
  const gained = changeSpan({ from: 0.25, to: 0.75 }, CHANGE_MS / 2, ACCENT)
  expect(gained).toEqual({ from: 0.25, color: ACCENT.glow, k: 0.5 })
  expect(changeSpan({ from: 0.5, to: 0.5 }, 0, ACCENT)).toBeNull()

  const cells = cellsOf(barCells(20, 0.25, 0, ACCENT, { shimmer: false, change: held }))
  expect(cells.slice(5, 15).every(c => c.glyph === '━'), 'the span given back is drawn filled').toBe(true)
  expect(cells[15]?.glyph).toBe('─')
  const glowing = cellsOf(barCells(20, 0.75, 0, ACCENT, { shimmer: false, change: { from: 0.25, color: 0xffffff, k: 1 } }))
  expect(glowing[10]?.color, 'the span gained in the glow colour').toBe(0xffffff)
  expect(glowing[2]?.color).not.toBe(0xffffff)
})

test('the desktop bar splits its track where items end, and animates a jump from where it stands after a redraw', () => {
  const split = barSvg(0.25, ACCENT, { ends: [0.5] }).source
  expect(split).toContain('<rect x="0" width="492" height="6" rx="3"')
  expect(split).toContain('<rect x="500" width="500" height="6" rx="3"')
  const back = barSvg(0.25, ACCENT, { jump: { from: 0.75, to: 0.25, ageMs: 600 } })
  expect(back.isAnimated, 'animated without the shimmer').toBe(true)
  expect(back.source).toContain('<rect x="250" width="500" height="6" rx="3" fill="#d8a64a"')
  expect(back.source, 'joined past its hold').toContain('begin="-300ms"')
  const gained = barSvg(0.75, ACCENT, { jump: { from: 0.25, to: 0.75, ageMs: 200 } }).source
  expect(gained).toContain('<rect x="250" width="500" height="6" fill="#ffc9a8"')
  expect(gained).toContain('begin="-200ms"')
  expect(barSvg(0.75, ACCENT, { jump: { from: 0.25, to: 0.75, ageMs: CHANGE_MS } }).isAnimated, 'over').toBe(false)
})
