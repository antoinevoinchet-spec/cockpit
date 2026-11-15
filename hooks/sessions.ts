// The other sessions open on this machine: who waits for you and for what, who works, who
// rests. Read from `claude agents --json` (the supported way to read session state), joined
// with the decision words each other Cockpit publishes in the shared store.

import type { ListedSession, SessionPhases, SessionVerdict } from '../types'
import { basename, duration } from './format'

// A published verdict, the sessions read, and the old rows: the limits.
export const VERDICT_PREFIX = 'verdict:'
export const MAX_WORDS_LENGTH = 120
// A key whose session is not listed any more goes after this long.
export const STALE_AFTER_MS = 24 * 3_600_000
export const MAX_PUBLISHED = 40
// A background session blocked for longer than this, with no process, is old.
export const OLD_AFTER_MS = 24 * 3_600_000
// Rows shown before "+N more".
export const MAX_ROWS = 4
// A name is cut to this, and sooner when the line needs the room.
const NAME_MAX = 22

// ── Reading the list ─────────────────────────────────────────────────────────

const STATUSES = new Set(['busy', 'waiting', 'idle'])
const STATES = new Set(['working', 'blocked', 'done', 'failed', 'stopped'])

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

// The sessions in `claude agents --json`; null when the output is not that list, so a
// bad read never replaces a good one.
export function parseSessions(output: string): ListedSession[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const sessions: ListedSession[] = []
  for (const entry of parsed as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const fields = entry as Record<string, unknown>
    const cwd = text(fields.cwd) ?? ''
    const sessionId = text(fields.sessionId)
    const id = text(fields.id)
    const pid = typeof fields.pid === 'number' && Number.isInteger(fields.pid) && fields.pid > 1 ? fields.pid : null
    if (sessionId === null && id === null && pid === null) continue
    const status = text(fields.status)
    const state = text(fields.state)
    sessions.push({
      sessionId,
      id,
      pid,
      name: text(fields.name) ?? (basename(cwd) !== '' ? basename(cwd) : 'session'),
      kind: fields.kind === 'background' ? 'background' : 'interactive',
      status: status !== null && STATUSES.has(status) ? (status as ListedSession['status']) : null,
      state: state !== null && STATES.has(state) ? (state as ListedSession['state']) : null,
      waitingFor: text(fields.waitingFor),
      startedAt: typeof fields.startedAt === 'number' ? fields.startedAt : 0,
    })
  }
  return sessions
}

// What a published value must look like to be believed.
export function isSessionVerdict(value: unknown): value is SessionVerdict {
  if (typeof value !== 'object' || value === null) return false
  const fields = value as Record<string, unknown>
  return (
    (fields.kind === 'decide' || fields.kind === 'blocked') &&
    typeof fields.words === 'string' &&
    typeof fields.at === 'number' &&
    typeof fields.sessionId === 'string' &&
    (fields.pid === null || typeof fields.pid === 'number')
  )
}

// A verdict belongs to a listed session written since its process began, by that process: the
// same conversation resumed in a new process keeps its id but answered nothing yet, and a process
// number reused by a later session starts after the verdict. With no process on one side, the id.
export function belongsTo(verdict: SessionVerdict, session: ListedSession): boolean {
  if (verdict.at < session.startedAt) return false
  if (verdict.pid !== null && session.pid !== null) return verdict.pid === session.pid
  return verdict.sessionId === session.sessionId
}

// ── Lines ────────────────────────────────────────────────────────────────────

export type Group = 'wait' | 'work' | 'idle' | 'old'

// A session seen by this Cockpit, before it knows how long it has been so.
export type Item = {
  key: string
  group: Group
  glyph: '?' | '!' | '◉' | '○'
  tone: 'warning' | 'error' | 'claude' | 'subtle'
  name: string
  detail: string
  // What the session is doing, to tell when that changed.
  phase: string
  // When a published verdict was written, else null: the time counts from then.
  since: number | null
  pid: number | null
  id: string | null
  // Its own tab, by the list. A background one can still be shown in a tab, which the list does not say.
  hasTab: boolean
}

// `sinceAt`: null when it was already so at this Cockpit's first look, so nobody knows since when.
export type Line = Item & { sinceAt: number | null }

const WAIT_LABELS: Readonly<Record<string, string>> = {
  'permission prompt': 'permission',
  'input needed': 'question',
  'sandbox request': 'sandbox',
  'worker request': 'worker',
  'dialog open': 'dialog',
}
const waitLabel = (waitingFor: string | null) => (waitingFor !== null ? (WAIT_LABELS[waitingFor] ?? waitingFor) : 'blocked')

export const sessionKey = (session: ListedSession) =>
  session.sessionId ?? session.id ?? `pid-${session.pid ?? 'none'}`

// dd/mm in local time
function dayOf(at: number): string {
  const date = new Date(at)
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`
}

// How one session reads: null when it is not worth a line (a finished background session
// with no process).
export function describe(session: ListedSession, verdicts: readonly SessionVerdict[], now: number): Item | null {
  const base = {
    key: sessionKey(session),
    name: session.name,
    pid: session.pid,
    id: session.id,
    hasTab: session.kind === 'interactive',
    since: null,
  }
  const old = (detail: string): Item => ({ ...base, group: 'old', glyph: '!', tone: 'error', detail, phase: `old:${detail}` })
  // The JSON can say "working" for a background session whose process is gone for good.
  if (session.state === 'working' && session.pid === null) return old('"working", no process')
  if (session.state === 'blocked' && session.pid === null && session.startedAt > 0 && now - session.startedAt > OLD_AFTER_MS) {
    // The list says when it started, never when it blocked.
    return old(`blocked, started ${dayOf(session.startedAt)}`)
  }
  if (session.pid === null && session.state !== 'blocked') return null

  if (session.status === 'waiting' || (session.state === 'blocked' && session.status !== 'busy')) {
    const detail = waitLabel(session.waitingFor)
    return { ...base, group: 'wait', glyph: '?', tone: 'warning', detail, phase: `wait:${detail}` }
  }
  if (session.status === 'busy' || session.state === 'working') {
    return { ...base, group: 'work', glyph: '◉', tone: 'claude', detail: 'working', phase: 'work' }
  }
  const verdict = verdicts.find(item => belongsTo(item, session))
  if (verdict !== undefined) {
    return {
      ...base,
      group: 'wait',
      glyph: verdict.kind === 'blocked' ? '!' : '?',
      tone: verdict.kind === 'blocked' ? 'error' : 'warning',
      detail: verdict.words,
      phase: `verdict:${verdict.at}`,
      since: verdict.at,
    }
  }
  return { ...base, group: 'idle', glyph: '○', tone: 'subtle', detail: 'idle', phase: 'idle' }
}

// Every other session: this one is told by its session id or its process, and left out.
export function describeAll(
  sessions: readonly ListedSession[],
  verdicts: readonly SessionVerdict[],
  own: { sessionId: string | null; pid: number | null },
  now: number,
): Item[] {
  const items: Item[] = []
  for (const session of sessions) {
    if (own.sessionId !== null && session.sessionId === own.sessionId) continue
    if (own.pid !== null && session.pid === own.pid) continue
    const item = describe(session, verdicts, now)
    if (item !== null) items.push(item)
  }
  return items
}

// When each phase began, as this Cockpit saw it: a phase seen again keeps its time, a new one
// starts now, a session no longer listed is forgotten. What the first read finds was already so:
// its time is unknown, and shown as nothing rather than as "since this Cockpit started".
export function updatePhases(previous: SessionPhases, items: readonly Item[], now: number, isFirstRead = false): SessionPhases {
  const next: SessionPhases = {}
  for (const item of items) {
    const before = previous[item.key]
    next[item.key] = before !== undefined && before.phase === item.phase ? before : { phase: item.phase, since: isFirstRead ? null : now }
  }
  return next
}

const GROUP_ORDER: Readonly<Record<Group, number>> = { wait: 0, work: 1, idle: 2, old: 3 }

export type View = { lines: Line[]; old: Line[]; waits: number }

// The lines in the order you read them: those that wait for you first, the longest wait
// at the top (one of unknown age has waited at least as long as this Cockpit has looked), then
// those that work, then those at rest. Old ones apart.
export function layOut(items: readonly Item[], phases: SessionPhases): View {
  const lines: Line[] = items
    .map(item => ({ ...item, sinceAt: item.since ?? phases[item.key]?.since ?? null }))
    .sort(
      (a, b) =>
        GROUP_ORDER[a.group] - GROUP_ORDER[b.group] ||
        (a.sinceAt ?? 0) - (b.sinceAt ?? 0) ||
        a.name.localeCompare(b.name),
    )
  return {
    lines: lines.filter(line => line.group !== 'old'),
    old: lines.filter(line => line.group === 'old'),
    waits: lines.filter(line => line.group === 'wait').length,
  }
}

// ── Drawing ──────────────────────────────────────────────────────────────────

export function headerText(open: number, waits: number, isStale = false): string {
  const said = waits > 0 ? `${waits} ${waits === 1 ? 'waits' : 'wait'} for you` : 'none waits'
  return `Sessions · ${open} open · ${said}${isStale ? ' · stale' : ''}`
}

// The time as the rows read it: "42s", "14m", "1h", "1h05", "2d3h".
const age = (ms: number) => duration(ms).replace(/h00$/, 'h')

const cut = (value: string, max: number) => (max <= 0 ? '' : value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value)

export type Cells = { name: string; detail: string; age: string }

// The text of each line in `columns` cells, a button of `button` cells at its right: the
// name is cut first, then the words, so the time and the button always stay in view. Old
// lines have no time, nor have those whose time nobody knows.
export function fitLines(lines: readonly Line[], columns: number, button: number, now: number, isOld = false): Cells[] {
  const room = Math.max(8, columns - 2 - button)
  const ages = lines.map(line => (isOld || line.sinceAt === null ? '' : age(now - line.sinceAt)))
  const wanted = Math.min(NAME_MAX, Math.max(0, ...lines.map(line => line.name.length)))
  const widest = Math.max(0, ...ages.map(text => (text === '' ? 0 : text.length + 3)))
  // The words keep at least this much: an old line's say why it is old.
  const nameWidth = Math.max(4, Math.min(wanted, room - widest - 2 - (isOld ? 22 : 14)))
  return lines.map((line, index) => {
    const when = ages[index]!
    const tail = when === '' ? 0 : when.length + 3
    const detailWidth = Math.max(1, room - nameWidth - 2 - tail)
    return { name: cut(line.name, nameWidth).padEnd(nameWidth), detail: cut(line.detail, detailWidth), age: when }
  })
}
