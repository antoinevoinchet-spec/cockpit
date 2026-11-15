// Formatting: bars, sparklines, durations, model, mode. Same thresholds as ~/.claude/statusline.sh.

export type Tone = 'success' | 'warning' | 'error'

// Context: green < 70%, yellow 70-89%, red ≥ 90%
export function contextTone(percent: number): Tone {
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warning'
  return 'success'
}

// 5h and 7-day usage: green < 50%, yellow 50-79%, red ≥ 80%
export function usageTone(percent: number): Tone {
  if (percent >= 80) return 'error'
  if (percent >= 50) return 'warning'
  return 'success'
}

// The usage figure's color against the clock: orange (the theme's terracotta) when usage
// runs ahead of the time gone by in its window, unless it is already red.
export function paceTone(percent: number, elapsedPercent: number | null): Tone | 'claude' {
  const tone = usageTone(percent)
  return tone !== 'error' && elapsedPercent !== null && percent > elapsedPercent ? 'claude' : tone
}

export function bar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.floor(percent / (100 / width))))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export type MeterRun = { kind: 'filled' | 'empty' | 'mark'; text: string }

const clampPercent = (percent: number) => Math.max(0, Math.min(100, percent))

// A thin meter: a heavy line for the filled part, a light one for the rest, and a half
// cell (╸) so a value that glides moves the end in half-cell steps. Lines, not blocks:
// block glyphs fill the whole cell height, so stacked meters merge into one slab.
// `markAt` crosses the line with a tick (┼, ╋ over the filled part): how far through
// its window a usage limit is. Returned as runs of one kind, each drawn in its color.
export function meter(percent: number, width = 12, markAt: number | null = null): MeterRun[] {
  const halves = Math.round((clampPercent(percent) / 100) * width * 2)
  const whole = Math.floor(halves / 2)
  const cells: MeterRun[] = Array.from({ length: width }, (_, index) =>
    index < whole
      ? { kind: 'filled', text: '━' }
      : index === whole && halves % 2 === 1
        ? { kind: 'filled', text: '╸' }
        : { kind: 'empty', text: '─' },
  )
  if (markAt !== null) {
    const index = Math.min(width - 1, Math.floor((clampPercent(markAt) / 100) * width))
    cells[index] = { kind: 'mark', text: cells[index]?.kind === 'filled' ? '╋' : '┼' }
  }
  const runs: MeterRun[] = []
  for (const cell of cells) {
    const last = runs.at(-1)
    if (last !== undefined && last.kind === cell.kind && cell.kind !== 'mark') last.text += cell.text
    else runs.push({ ...cell })
  }
  return runs
}

// Where a usage limit lands at its reset if the pace so far holds: 27 % used with 80 % of
// the window gone ends near 34 %. Too early in the window (under 5 %) to say.
export function projectAtReset(percent: number, elapsedPercent: number | null): number | null {
  if (elapsedPercent === null || elapsedPercent < 5) return null
  return Math.round((percent * 100) / elapsedPercent)
}

// How many more turns before the context reaches the compaction point, at the average
// growth of the recent turns that grew it. `tokens` is the context after each turn,
// oldest first; a drop (a compaction, a /clear) is not growth and is skipped.
export function turnsLeft(tokens: readonly (number | null)[], current: number, compactAt: number): number | null {
  const growth: number[] = []
  for (let index = 1; index < tokens.length; index++) {
    const before = tokens[index - 1]
    const after = tokens[index]
    if (before !== null && before !== undefined && after !== null && after !== undefined && after > before) {
      growth.push(after - before)
    }
  }
  const recent = growth.slice(-5)
  if (recent.length === 0) return null
  const average = recent.reduce((sum, step) => sum + step, 0) / recent.length
  return Math.max(0, Math.floor((compactAt - current) / average))
}

// How far ahead that estimate holds. Replayed on 652 real announcements (23/10 to 03/11): up to
// 10 turns, 62 % end at the compaction point and the median real count matches; beyond, 31 %.
const ANNOUNCED_TURNS = 10

// The turns worth announcing: none when the estimate is too far off to hold.
export function announcedTurns(turns: number | null): number | null {
  return turns !== null && turns <= ANNOUNCED_TURNS ? turns : null
}

// Where this session compacts, as the engine settled it for the model in use (its per-model
// setting, the general one, `--autocompact`, the variable): the `Auto-compact window` line of
// /context. None when nothing set a window, when auto-compaction is off, or on no usable size.
export function settledWindow(
  detail: { rawMaxTokens: number; autocompactSource: string; isAutoCompactEnabled: boolean } | undefined,
): number | null {
  if (detail === undefined || !detail.isAutoCompactEnabled || detail.autocompactSource === 'auto') return null
  return Number.isFinite(detail.rawMaxTokens) && detail.rawMaxTokens > 0 ? detail.rawMaxTokens : null
}

// `resets_at` comes as epoch seconds or an ISO date; null when it reads as neither.
function resetTime(resetsAt: string): number | null {
  const at = /^\d+$/.test(resetsAt) ? Number(resetsAt) * 1000 : Date.parse(resetsAt)
  return Number.isNaN(at) ? null : at
}

// How far through its window a usage limit is, in percent: a 7-day window that resets
// in 1d9h is 80 % through. Usage past that mark runs ahead of the clock.
export function windowElapsed(resetsAt: string, now: number, windowMs: number): number | null {
  const at = resetTime(resetsAt)
  return at === null ? null : clampPercent((1 - (at - now) / windowMs) * 100)
}

const LEVELS = '▁▂▃▄▅▆▇█'

// One glyph per value, the last `width` values. `max` fixes the scale (100 for a
// percentage); without it the largest value is the top. A missing value is a space.
export function spark(values: readonly (number | null)[], width = 14, max?: number): string {
  const shown = values.slice(-width)
  const top = max ?? Math.max(0, ...shown.map(value => value ?? 0))
  return shown
    .map(value => {
      if (value === null) return ' '
      if (top <= 0) return LEVELS[0]
      const index = Math.round((Math.max(0, value) / top) * (LEVELS.length - 1))
      return LEVELS[Math.min(LEVELS.length - 1, index)]
    })
    .join('')
}

// Braille dots filled from the bottom, one to eight.
const DOTS = '⡀⣀⣄⣤⣦⣶⣷⣿'

// The same history as `spark`, in braille dots: light as the thin meters, where block
// glyphs make a slab next to them.
export function dots(values: readonly (number | null)[], width = 14, max?: number): string {
  const shown = values.slice(-width)
  const top = max ?? Math.max(0, ...shown.map(value => value ?? 0))
  return shown
    .map(value => {
      if (value === null) return ' '
      if (top <= 0) return DOTS[0]
      const index = Math.round((Math.max(0, value) / top) * (DOTS.length - 1))
      return DOTS[Math.min(DOTS.length - 1, index)]
    })
    .join('')
}

// 3725000 → "1h02", 125000 → "2m", 42000 → "42s"; past a day as the resets read, "9d6h"
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24}h`
  return `${hours}h${String(minutes % 60).padStart(2, '0')}`
}

// 843000 → "14m 3s", 42000 → "42s", 3725000 → "1h 02m"
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

// Same format as the status line: "2h13m" or "45m"
export function resetIn(resetsAt: string, now: number): string | null {
  const at = resetTime(resetsAt)
  if (at === null) return null
  const remain = Math.floor((at - now) / 1000)
  if (remain <= 0) return null
  const hours = Math.floor(remain / 3600)
  const minutes = Math.floor((remain % 3600) / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24}h`
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`
}

// A running turn's clock: 102000 → "1:42", 3725000 → "1:02:05"
export function stopwatch(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const ss = String(seconds % 60).padStart(2, '0')
  if (minutes < 60) return `${minutes}:${ss}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${ss}`
}

// 7200000 → "2h ago", 30000 → "just now"
export function ago(ms: number): string {
  return ms < 60_000 ? 'just now' : `${duration(ms)} ago`
}

// 20:24 in local time
export function clock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function kilo(tokens: number): string {
  return `${Math.round(tokens / 1000)}K`
}

// 3.4219 → "$3.42"
export function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`
}

// "claude-opus-5-5[1m]" → "Opus 5.5 (1M)"; an already readable name is kept
export function prettyModel(model: string): string {
  const match = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(model)
  if (match === null) return model
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase()
  const version = match[3] !== undefined ? `${match[2]}.${match[3]}` : match[2]
  const wide = /\[1m\]/i.test(model) ? ' (1M)' : ''
  return `${family} ${version}${wide}`
}

// "claude-opus-5-5[1m]" → "opus"; a name it does not know is kept
export function modelFamily(model: string): string {
  return /opus|sonnet|haiku|fable/i.exec(model)?.[0].toLowerCase() ?? model
}

// At most `max` characters, the last one an ellipsis when it had to cut.
export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

export type ModeLabel = { label: string; tone: 'planMode' | 'autoAccept' | 'error' | 'subtle' }

export function modeLabel(mode: string): ModeLabel {
  switch (mode) {
    case 'plan':
      return { label: 'Plan', tone: 'planMode' }
    case 'acceptEdits':
      return { label: 'Accept edits', tone: 'autoAccept' }
    case 'auto':
      return { label: 'Auto', tone: 'autoAccept' }
    case 'dontAsk':
      return { label: 'Don’t ask', tone: 'autoAccept' }
    case 'bypassPermissions':
      return { label: 'Bypass ⚠', tone: 'error' }
    case 'default':
      return { label: 'Default', tone: 'subtle' }
    default:
      return { label: mode, tone: 'subtle' }
  }
}

export function basename(path: string): string {
  return path.split('/').filter(part => part !== '').at(-1) ?? path
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}
