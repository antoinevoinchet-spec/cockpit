// Cockpit: an at-a-glance dashboard for Claude Code, and a transcript that reads like a chat.
//   1. "Cockpit" pane (/cockpit): sparklines, actions, tabs (Activity · Plan · Files)
//   2. Band above the prompt: the superpowers plan in progress (Task x/y, D1…Dn)
//   3. Spinner: plain words (Thinking, Working, Writing…) and the turn's tool and agent counts
//   4. Tool rows in plain English, sensitive actions in red
//   5. Alerts (macOS notification, one sound per kind): a long turn ends, Claude waits
//      for you, a build or tests fail, a usage window passes 80%
//   6. Chat look: your prompts in a bubble, Claude's replies behind a bar, a rule closing each turn
//   7. Live pane: a pulse and a stopwatch while Claude works, meters that glide, files that flash
//   8. Project state: the context against the compaction point, usage projected to its reset,
//      the last test and build runs, the branch's pull request and the latest Vercel deployment
//   9. Understanding Claude: what fills its context, the skills it uses, "?" on any action for
//      its own reason, a map of the files it read and changed, its ★ Insight points kept in a
//      Learn tab and sent to a Markdown note

import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderNode } from 'claude-code'

import type {
  AgentRow,
  Breakdown,
  Check,
  CommandRun,
  Decision,
  DevServer,
  FileTouch,
  GitTab,
  Header,
  Insight,
  LearnPage,
  Notes,
  Pin,
  Plan,
  Project,
  QuickAction,
  Remote,
  ReplyTime,
  ListedSession,
  SessionList,
  SessionPhases,
  SessionVerdict,
  Snapshot,
  Tab,
  TodoItem,
  Turn,
  Usage,
  Waiting,
  Why,
  Word,
  WorkflowAgent,
  WorkflowRun,
} from '../types'
import {
  HIGHLIGHT_TONE,
  VERDICTS,
  colorBlocks,
  hasMarks,
  isColorful,
  lineRuns,
  marksPrompt,
  readVerdict,
  stripMarks,
  termsIn,
} from './colors'
import type { Run, Term } from './colors'
import {
  ago,
  announcedTurns,
  basename,
  clip,
  contextTone,
  dollars,
  dots,
  duration,
  elapsed,
  clock,
  kilo,
  meter,
  modelFamily,
  paceTone,
  windowElapsed,
  plural,
  projectAtReset,
  resetIn,
  spark,
  bar,
  stopwatch,
  settledWindow,
  turnsLeft,
  usageTone,
} from './format'
import { addPin, makePin, pinRequest, recentReplies, reusePrompt } from './pins'
import { approvalLabel, describeTool, firstLine, isSensitiveTool, shortPath, splitMcpName } from './labels'
import { PLAN_PATH, parsePlan, planProgress } from './plan'
import { FOCUS_SCRIPT, FOCUS_TITLE_SCRIPT, HAS_TITLE_SCRIPT, NEW_TAB_SCRIPT, ghosttyHost, ghosttyHostOf } from './ghostty'
import { GIT_READ_OPTIONS, GIT_READ_TIMEOUT_MS, fitTabLabels, gitLayout, isGraphShown, readGitTab, treeRows } from './gitgraph'
import type { GitLine, GitSpan, GitTone } from './gitgraph'
import { parseFolders, parseListeners, readProject, startCommand, withFolders } from './servers'
import {
  MAX_PUBLISHED,
  MAX_ROWS,
  STALE_AFTER_MS,
  VERDICT_PREFIX,
  belongsTo,
  describeAll,
  fitLines,
  headerText,
  isSessionVerdict,
  layOut,
  parseSessions,
  updatePhases,
} from './sessions'
import type { Line } from './sessions'
import { checkRuns, isBrowserCheck, isCodePath, parseDeploy, parsePr, touchesRemote } from './status'
import {
  appendToNote,
  capital,
  contextShares,
  noteSection,
  parseInsights,
  pendingBlocker,
  pendingDecision,
  projectMap,
  questionedCall,
  sessionVerdict,
  touch,
  whyPrompt,
} from './understand'
import type { OpenCall } from './understand'
import { addRunAgent, agentEnd, closeRuns, endRunAgent, isRunning, nameRun, runCounts, runLabel } from './workflows'

const PANE = 'cockpit'
const PANE_TITLE = 'Cockpit'
const PANE_COLUMNS = 52
const NOTIFY_AFTER_MS = 60_000
const EDITORS = ['/Applications/Cursor.app', '/Applications/Visual Studio Code.app']
// Where the Learn tab sends the ★ Insight points: a Markdown note in a folder you choose, for
// example the root of an Obsidian vault. Set by the plugin's options (`notesDir`, `notesName`,
// `obsidianVault`, see plugin.json); with no `notesDir` the export is off and Learn only keeps them.
const DEFAULT_NOTE_NAME = 'Claude Code learnings'
let noteTarget = { dir: '', name: DEFAULT_NOTE_NAME, vault: '' }

// An option is used as given when it is a string; a missing or mistyped one is the default.
const optionText = (options: PluginOptions, key: string, fallback: string): string => {
  const value = options[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}
const readNotes = (options: PluginOptions) => ({
  dir: optionText(options, 'notesDir', '').replace(/\/+$/, ''),
  name: optionText(options, 'notesName', DEFAULT_NOTE_NAME).replace(/[\\/]/g, '-'),
  vault: optionText(options, 'obsidianVault', ''),
})

// One sound per kind of alert, so you know what happened without looking.
type AlertKind = 'done' | 'waiting' | 'failed' | 'quota'
const SOUNDS: Readonly<Record<AlertKind, string>> = {
  done: '/System/Library/Sounds/Glass.aiff',
  waiting: '/System/Library/Sounds/Ping.aiff',
  failed: '/System/Library/Sounds/Basso.aiff',
  quota: '/System/Library/Sounds/Funk.aiff',
}
// The same kind of alert twice within this time is one alert.
const ALERT_GAP_MS = 15_000
// The engine's own permission alert comes after ~6 s of waiting: a question waits as long.
const QUESTION_ALERT_MS = 6_000
// A spinner drawn this soon after a question may have been on its way before the dialog opened.
const SPINNER_GRACE_MS = 500
const QUOTA_ALERT_PERCENT = 80
const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])
// The notices about this session's own dialogs, the others (a background session) only ring.
const WAIT_NOTICES: Readonly<Record<string, Waiting['kind']>> = {
  permission_prompt: 'permission',
  elicitation_dialog: 'form',
  elicitation_url_dialog: 'form',
}
const BUILD_OR_TEST =
  /\b(build|test|tests|lint|tsc|typecheck|type-check|vitest|jest|pytest|playwright|cypress|mocha|cargo test|go test)\b/i

// Animation: frames while something moves, nothing at rest.
const FRAME_MS = 200
const END_SWEEP_MS = 2_400
const FLASH_MS = 2_000
const PULSE = ['●', '◉', '◎', '○', '◎', '◉']
const RUNNING = ['◜', '◠', '◝', '◞', '◡', '◟']
const SERVERS_EVERY_MS = 15_000
// GitHub and Vercel are read every minute, and soon after a push or a deploy; never twice
// within the gap, so turns that end in a row do not pile up network calls.
const REMOTE_EVERY_MS = 60_000
const REMOTE_GAP_MS = 20_000
const CHECK_LABELS: Readonly<Record<Check['kind'], string>> = {
  tests: 'tests',
  build: 'build',
  types: 'types',
  lint: 'lint',
  bench: 'bench',
  browser: 'browser',
}
// The Proof row, with edits left unchecked: what the count starts from, what was not run.
const LAST_CHECK: Readonly<Record<Check['kind'], string>> = {
  tests: 'test',
  build: 'build',
  types: 'type check',
  lint: 'lint',
  bench: 'bench run',
  browser: 'browser test',
}
const EXPECTED_CHECKS: readonly Check['kind'][] = ['tests', 'types', 'build']
const MAX_CODE_EDITS = 999
const PROOF_CAVEAT = '✓ = exit code 0, not proof the work is right'
// Under this, the pane takes so much of the terminal that the notice and the cost do not both fit.
const NOTICE_WITH_COST_COLUMNS = 140
// Each spinner mode, in words and in a color of its own.
const ACTIVITY_COLOR: Readonly<Record<string, string>> = {
  thinking: 'suggestion',
  requesting: 'subtle',
  responding: 'claude',
  'tool-input': 'warning',
  'tool-use': 'warning',
}
// A workflow runs 91 commands at the median, 188 at the third quartile (72 real runs, 2026-11):
// the pane holds more of them than the store does, which keeps 4 MiB for 20 sessions.
const MAX_COMMANDS = 200
const MAX_SAVED_COMMANDS = 50
const MAX_FILES = 100
const MAX_AGENTS = 12
const MAX_HISTORY = 30
// Activity at rest: the running agents, then the newest commands, this many rows in all (a
// workflow's own line aside).
const SHOWN_ACTIVITY = 4
// A finished plan's line stays this long after its last step, then leaves the pane.
const PLAN_DONE_MS = 15 * 60_000
// An agent gone with no result holds a row at rest this long, then waits under ▸ all.
const NO_RESULT_SHOWN_MS = 15 * 60_000
// The agent's name before its command: the command stays in view on a narrow pane.
const AGENT_NAME_CHARS = 20
const COMPACT_CONFIRM_MS = 5_000
// The other sessions are read every 25 to 30 s while the pane is in view, the first time soon
// after the start, and within 5 s of the pane coming back. A read is allowed 15 s; past this long
// with no good one the section says what it shows is old. Fewer rows on a short terminal.
const SESSIONS_EVERY_MS = 25_000
const SESSIONS_CHECK_MS = 5_000
const SESSIONS_FIRST_MS = 3_000
const SESSIONS_TIMEOUT_MS = 15_000
const SESSIONS_STALE_MS = 90_000
const SHORT_PANE_ROWS = 40
const SHORT_PANE_SESSIONS = 3
const MAX_SAVED_SESSIONS = 20
const LATEST_KEY = 'latest'
// The usage limits' windows, for the tick that shows how much of each has gone by.
const FIVE_HOURS_MS = 5 * 3_600_000
const SEVEN_DAYS_MS = 7 * 86_400_000
const ACTIVE_AGENT = new Set(['pending', 'running', 'waiting'])

const SPINNER_WORDS: Readonly<Record<string, string>> = {
  thinking: 'Thinking',
  requesting: 'Waiting for Claude',
  responding: 'Writing',
  'tool-input': 'Preparing',
  'tool-use': 'Working',
}

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'files', label: 'Files' },
  { id: 'git', label: 'Git' },
  { id: 'learn', label: 'Learn' },
  { id: 'pins', label: 'Pins' },
  { id: 'notes', label: 'Notes' },
]
// The ★ Insight points are kept across sessions, the newest ones.
const INSIGHTS_KEY = 'insights'
const MAX_INSIGHTS = 300
const SHOWN_INSIGHTS = 6
// The words Claude explains in its replies, kept across sessions and projects.
const WORDS_KEY = 'words'
const MAX_WORDS = 500
const SHOWN_WORDS = 40
// When each reply was written, kept with the session for the newest replies.
const MAX_REPLY_TIMES = 300
// Pinned replies, kept across sessions and projects.
const PINS_KEY = 'pins'
const MAX_PINS = 200
const SHOWN_PINS = 8
// One notepad per project folder, saved a moment after you stop typing.
const NOTES_KEY = (dir: string) => `notes:${dir}`
const NOTES_SAVE_MS = 1_000
// The rows the tabs take, set by dragging the grip under them, kept across sessions.
const LAYOUT_KEY = 'layout'
const TAB_ROWS = 14
const MIN_TAB_ROWS = 4
const MAX_TAB_ROWS = 80
// The row of tabs and the grip, which the Git tab counts with the rows above it.
const TABS_AND_GRIP_ROWS = 2
const GIT_COLORS: Readonly<Record<GitTone, string | undefined>> = {
  plain: undefined,
  strong: undefined,
  label: 'suggestion',
  good: 'success',
  warn: 'warning',
  dim: undefined,
}
// How long the "?" glyph turns while Claude is asked why.
const ASKING_MS = 30_000

const EMPTY_HEADER: Header = {
  cwd: '',
  dir: '',
  branch: null,
  isDirty: false,
  changed: 0,
  ahead: null,
  lastCommit: null,
  model: null,
  effort: null,
  mode: null,
}
const EMPTY_USAGE: Usage = {
  ctxTokens: null,
  ctxWindow: null,
  ctxPercent: null,
  fiveHourPercent: null,
  fiveHourResetsAt: null,
  sevenDayPercent: null,
  sevenDayResetsAt: null,
  costUsd: null,
  startedAt: null,
}
const IDLE_TURN: Turn = { isRunning: false, tools: 0, startedAt: 0 }

const header = atom({ plugin: 'cockpit', key: 'header' } as const, EMPTY_HEADER)
const usage = atom({ plugin: 'cockpit', key: 'usage' } as const, EMPTY_USAGE)
const files = atom({ plugin: 'cockpit', key: 'files' } as const, [] as FileTouch[])
const commands = atom({ plugin: 'cockpit', key: 'commands' } as const, [] as CommandRun[])
const agents = atom({ plugin: 'cockpit', key: 'agents' } as const, [] as AgentRow[])
// A workflow's agents, on no list of the engine's. Never saved: a restart forgets them.
const workflows = atom({ plugin: 'cockpit', key: 'workflows' } as const, [] as WorkflowRun[])
const todos = atom({ plugin: 'cockpit', key: 'todos' } as const, [] as TodoItem[])
const plan = atom({ plugin: 'cockpit', key: 'plan' } as const, null as Plan | null)
const turn = atom({ plugin: 'cockpit', key: 'turn' } as const, IDLE_TURN)
const isBandHidden = atom({ plugin: 'cockpit', key: 'isBandHidden' } as const, false)
const tick = atom({ plugin: 'cockpit', key: 'tick' } as const, 0)
const history = atom({ plugin: 'cockpit', key: 'history' } as const, [] as Snapshot[])
const tab = atom({ plugin: 'cockpit', key: 'tab' } as const, 'files' as Tab)
const frame = atom({ plugin: 'cockpit', key: 'frame' } as const, 0)
const servers = atom({ plugin: 'cockpit', key: 'servers' } as const, [] as DevServer[])
const project = atom({ plugin: 'cockpit', key: 'project' } as const, null as Project)
const checks = atom({ plugin: 'cockpit', key: 'checks' } as const, [] as Check[])
// When each code edit no check has passed since landed, the agents' included.
const codeEdits = atom({ plugin: 'cockpit', key: 'codeEdits' } as const, [] as number[])
// The last reply announced ✓ DONE: until the next turn, steps still open say otherwise.
const isDoneAnnounced = atom({ plugin: 'cockpit', key: 'isDoneAnnounced' } as const, false)
const remote = atom({ plugin: 'cockpit', key: 'remote' } as const, { pr: null, deploy: null } as Remote)
// The window Claude Code compacts this session against, for the model in use; null when none.
const compactAt = atom({ plugin: 'cockpit', key: 'compactAt' } as const, null as number | null)
const insights = atom({ plugin: 'cockpit', key: 'insights' } as const, [] as Insight[])
const breakdown = atom({ plugin: 'cockpit', key: 'breakdown' } as const, null as Breakdown | null)
const why = atom({ plugin: 'cockpit', key: 'why' } as const, null as Why | null)
const pins = atom({ plugin: 'cockpit', key: 'pins' } as const, [] as Pin[])
// The pin unfolded in the Pins tab, by its id.
const openPin = atom({ plugin: 'cockpit', key: 'openPin' } as const, null as string | null)
const notes = atom({ plugin: 'cockpit', key: 'notes' } as const, { dir: '', text: '', savedAt: null } as Notes)
const tabRows = atom({ plugin: 'cockpit', key: 'tabRows' } as const, TAB_ROWS)
// The figures' details unfolded (breakdown, tokens, projections, cost, last commit).
const isDetailed = atom({ plugin: 'cockpit', key: 'isDetailed' } as const, false)
// Every row of the activity, not just the newest.
const isActivityOpen = atom({ plugin: 'cockpit', key: 'isActivityOpen' } as const, false)
// When Claude's task list last changed, 0 when unknown: a finished plan leaves a while after.
const todosAt = atom({ plugin: 'cockpit', key: 'todosAt' } as const, 0)
const words = atom({ plugin: 'cockpit', key: 'words' } as const, [] as Word[])
// The Learn tab's list: the ★ Insight points or the words.
const learnPage = atom({ plugin: 'cockpit', key: 'learnPage' } as const, 'insights' as LearnPage)
// What Claude's last answer leaves to you (a choice, a blocker), until you answer.
const decision = atom({ plugin: 'cockpit', key: 'decision' } as const, null as Decision | null)
// What Claude waits for you on now, in the order it asked; the live row shows the first.
const waits = atom({ plugin: 'cockpit', key: 'waits' } as const, [] as Waiting[])
// When each reply was written, one member per reply (memberOf): setting one redraws that
// reply alone. The list keeps them with the session, for a restart.
const replyAt = atom({ plugin: 'cockpit', key: 'replyAt' } as const, null as number | null)
// Claude Code draws a reply under its row's id until the conversation holds a message of
// several parts (a pasted image, a reminder beside a tool result); from then on, under the row
// id's first 24 characters followed by the part's index. Both share that stem.
const replyStem = (id: string) => id.slice(0, 24)
const replyTimes = atom({ plugin: 'cockpit', key: 'replyTimes' } as const, [] as ReplyTime[])
// The Git tab: what git said last, `unread` until the tab is first opened.
const gitTab = atom({ plugin: 'cockpit', key: 'gitTab' } as const, { view: { status: 'unread' }, isReading: false } as GitTab)
const gitGraphChoice = atom({ plugin: 'cockpit', key: 'gitGraphChoice' } as const, null as boolean | null)
const isGitUnfolded = atom({ plugin: 'cockpit', key: 'isGitUnfolded' } as const, false)
// The other sessions open on this machine: the last good read of `claude agents --json`, since
// when each is as it is, and the section's folds.
const EMPTY_SESSIONS: SessionList = { sessions: [], verdicts: [], own: { sessionId: null, pid: null }, readAt: null }
const sessions = atom({ plugin: 'cockpit', key: 'sessions' } as const, EMPTY_SESSIONS)
const sessionPhases = atom({ plugin: 'cockpit', key: 'sessionPhases' } as const, {} as SessionPhases)
const isSessionsOpen = atom({ plugin: 'cockpit', key: 'isSessionsOpen' } as const, false)
const areSessionsMore = atom({ plugin: 'cockpit', key: 'areSessionsMore' } as const, false)
const areOldOpen = atom({ plugin: 'cockpit', key: 'areOldOpen' } as const, false)

type Timer = { cancel: () => void }
type Saved = {
  commands: CommandRun[]
  files: FileTouch[]
  agents: AgentRow[]
  todos: TodoItem[]
  plan: Plan | null
  history: Snapshot[]
  checks?: Check[]
  codeEdits?: number[]
  replyTimes?: ReplyTime[]
}
// Which session saved last, where and when: how a pane finds its conversation again
// after a compaction gave it a new session id.
type Latest = { sessionId: string; cwd: string; savedAt: number }
type Measure = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

// Module variables start over on every reload; session.start sets them again.
let cwd = ''
let isInteractive = false
let editor: string | null = null
let tickTimer: Timer | null = null
let agentTimer: Timer | null = null
let isGitRefreshing = false
let isReadingGitTab = false
let lastTurnEndAt = 0
let lastTurnMs = 0
// What the last turn cost at the API's prices, null when unknown.
let lastTurnCost: number | null = null
// Whether the last turn left code edited with no check that passed after it.
let lastTurnUnchecked = false
let compactArmedUntil = 0
// The other sessions: the timers that read them, whether a read is under way (never two at
// once), this Cockpit's own process, whether a verdict is published, the delete a first press armed, and the last ↗ go on a background session.
let sessionsTimer: Timer | null = null
let sessionsFirstTimer: Timer | null = null
let isReadingSessions = false
let lastSessionsTryAt = 0
let isUnderGhostty = false
let ownPid: number | null = null
let hasPublished = false
let deleteArmed = { id: '', until: 0 }
let attachPressed = { id: '', until: 0 }
let notesTimer: Timer | null = null
// What was typed last, read when the field is drawn: a redraw never puts back older text.
let draft: { dir: string; text: string } | null = null
// The text last kept in the store, to tell a big cut from an edit.
let lastKept = ''
let clearArmedUntil = 0
// The pin a first press on ✕ armed, and until when.
let unpinArmed = { id: '', until: 0 }
let frameTimer: Timer | null = null
let serversTimer: Timer | null = null
let animateUntil = 0
let isRefreshingServers = false
let remoteTimer: Timer | null = null
let isRefreshingRemote = false
let lastRemoteAt = 0
// What the spinner says Claude is doing (thinking, responding, tool-use…).
let claudeMode = 'requesting'
// The tool calls that have not ended, for a permission question to find its own.
const openCalls = new Map<string, OpenCall>()
// How many waits are open, for the frames: they keep the stopwatch running between two turns.
let openWaits = 0
// The questions the terminal's spinner has shown closed, when it last showed one, and the calls
// that show they are running: how the pane knows you said yes, which no event tells (see noteSpinner).
const answeredWaits = new Set<string>()
let lastAnsweredAt = 0
const runningCalls = new Set<string>()
// The meters' drawn values, which glide toward the real ones.
const shown = new Map<string, number>()
const lastAlertAt = new Map<AlertKind, number>()
// When each closing rule's turn ended, what it cost and whether it left code unchecked, by the
// rule's id (null: ended before this load).
const turnEnds = new Map<string, { at: number; cost: number | null; isUnchecked: boolean } | null>()
// The ★ Insight points already taken from a reply: a reply is drawn many times.
// Points read wrong by the first parser, before a heading had to start its line: the
// heading itself and the bullets of a reply's other sections (2026-10-22). Never kept again.
const DROPPED_INSIGHTS: readonly string[] = ['yy9ly', '151f265', 'bx1cxn', 't7wdfl', '1d35oag', '1ek3qoy', 'fol34y']
const seenInsights = new Set<string>(DROPPED_INSIGHTS)

function usageFrom(measure: Measure): Omit<Usage, 'startedAt'> {
  const fiveHour = measure.rateLimits.find(limit => limit.kind === 'five_hour')
  const sevenDay = measure.rateLimits.find(limit => limit.kind === 'seven_day')
  return {
    ctxTokens: measure.context.tokens ?? null,
    ctxWindow: measure.context.window,
    ctxPercent: measure.context.percent ?? null,
    fiveHourPercent: fiveHour?.percentUsed ?? null,
    fiveHourResetsAt: fiveHour?.resetsAt ?? null,
    sevenDayPercent: sevenDay?.percentUsed ?? null,
    sevenDayResetsAt: sevenDay?.resetsAt ?? null,
    costUsd: measure.cost?.usd ?? null,
  }
}

function touchFile(list: readonly FileTouch[], path: string, action: FileTouch['action'], at: number): FileTouch[] {
  return touch(list, path, action, at, MAX_FILES)
}

function mergeAgents(previous: readonly AgentRow[], fresh: readonly AgentRow[], now: number): AgentRow[] {
  // Claude Code drops a subagent a while after it ends: keep its last row, which says only what
  // was seen. One that leaves with no proof of how it ended (a teammate left idle, a row read back
  // after a restart) has no result to show.
  const ids = new Set(fresh.map(agent => agent.id))
  const gone = previous
    .filter(agent => !ids.has(agent.id))
    .map(agent =>
      !ACTIVE_AGENT.has(agent.status) && agent.status !== 'idle'
        ? agent
        : agent.endedAs !== undefined
          ? { ...agent, status: agent.endedAs }
          : { ...agent, status: 'unknown', endedAt: now },
    )
  // The list may still say "running" just after a turn's end: the proof stays with the row.
  const known = new Map(previous.map(agent => [agent.id, agent.endedAs]))
  const kept = fresh.map(agent => {
    const endedAs = known.get(agent.id)
    return endedAs !== undefined ? { ...agent, endedAs } : agent
  })
  return [...gone, ...kept].slice(-MAX_AGENTS)
}

function oneLine(text: string, max: number): string {
  const line = firstLine(text).replace(/[#*`_>]/g, '').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

function isLatest(value: unknown): value is Latest {
  if (typeof value !== 'object' || value === null) return false
  const fields = value as Record<string, unknown>
  return typeof fields.sessionId === 'string' && typeof fields.cwd === 'string' && typeof fields.savedAt === 'number'
}

function isSaved(value: unknown): value is Saved {
  if (typeof value !== 'object' || value === null) return false
  const fields = value as Record<string, unknown>
  return ['commands', 'files', 'agents', 'todos', 'history'].every(key => Array.isArray(fields[key]))
}

function isReplyTime(value: unknown): value is ReplyTime {
  if (typeof value !== 'object' || value === null) return false
  const fields = value as Record<string, unknown>
  return typeof fields.id === 'string' && typeof fields.at === 'number'
}

// The pane's lists live in the session's memory, which a restart of Claude Code empties:
// they are saved at the end of each turn and read back when the session starts again.
async function save($: EngineInterface): Promise<void> {
  const key = `session:${await $.session.id()}`
  const [commandList, fileList, agentList, todoList, currentPlan, snapshots, checkList, editList, times] = await Promise.all([
    read($, commands),
    read($, files),
    read($, agents),
    read($, todos),
    read($, plan),
    read($, history),
    read($, checks),
    read($, codeEdits),
    read($, replyTimes),
  ])
  const saved: Saved = {
    commands: commandList.slice(-MAX_SAVED_COMMANDS),
    files: fileList,
    agents: agentList,
    todos: todoList,
    plan: currentPlan,
    history: snapshots,
    checks: checkList,
    codeEdits: editList,
    replyTimes: times,
  }
  await $.store.set(key, saved)
  const latest: Latest = { sessionId: await $.session.id(), cwd, savedAt: await $.clock.now() }
  await $.store.set(LATEST_KEY, latest)

  // Keep the newest sessions only: the store holds 4 MiB in all.
  const keys = (await $.store.keys()).filter(name => name.startsWith('session:'))
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SAVED_SESSIONS))) await $.store.delete(old)
}

async function restore($: EngineInterface): Promise<void> {
  const [commandList, fileList, snapshots] = await Promise.all([read($, commands), read($, files), read($, history)])
  // A hot reload keeps the session's memory: nothing to read back.
  if (commandList.length + fileList.length + snapshots.length > 0) return
  let saved = await $.store.get(`session:${await $.session.id()}`)
  if (!isSaved(saved)) {
    // A compaction carries the conversation on under a new session id. The last save is
    // then this conversation's if it was made in the same folder after it began; a
    // session started later is a new conversation and starts empty.
    const latest = await $.store.get(LATEST_KEY)
    const { startedAt } = await $.session.usage()
    if (isLatest(latest) && latest.cwd === cwd && startedAt <= latest.savedAt) {
      saved = await $.store.get(`session:${latest.sessionId}`)
    }
  }
  if (!isSaved(saved)) return
  const times = Array.isArray(saved.replyTimes) ? saved.replyTimes.filter(isReplyTime) : []
  await Promise.all([
    update($, commands, () => saved.commands),
    update($, files, () => saved.files),
    update($, agents, () => saved.agents),
    update($, todos, () => saved.todos),
    update($, plan, () => saved.plan),
    update($, history, () => saved.history),
    update($, checks, () => (Array.isArray(saved.checks) ? saved.checks : [])),
    update($, codeEdits, () => (Array.isArray(saved.codeEdits) ? saved.codeEdits.filter(at => typeof at === 'number') : [])),
    update($, replyTimes, () => times),
    // Each reply drawn again after the restart gets its time back.
    ...times.map(item => update($, memberOf(replyAt, { requestId: replyStem(item.id) }), () => item.at)),
  ])
}

const isFailing = (check: Check) => !check.isOk && check.isMasked !== true

// A check just run. One that passed covers the edits made before it started: an edit that
// landed while it ran is still unchecked. While another check still fails, nothing is covered:
// a lint that passes says nothing of the tests that failed.
async function recordChecks($: EngineInterface, runs: readonly Check[]): Promise<void> {
  if (runs.length === 0) return
  const kinds = runs.map(run => run.kind)
  let listed: readonly Check[] = runs
  await update($, checks, list => {
    const next = [...list.filter(check => !kinds.includes(check.kind)), ...runs]
    listed = next
    return next
  })
  const passed = runs.find(run => run.isOk && run.isMasked !== true)
  if (passed !== undefined && !listed.some(isFailing)) {
    await update($, codeEdits, list => list.filter(at => at > passed.at))
  }
}

async function refreshGit($: EngineInterface): Promise<void> {
  if (isGitRefreshing) return
  isGitRefreshing = true
  try {
    const where = await $.session.cwd()
    const git = (args: string[]) => $.process.run(['git', ...args], { cwd: where, timeoutMs: 10_000 })
    const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = head.exitCode === 0 ? head.stdout.trim() : null
    if (branch === null) {
      await update($, header, value => ({
        ...value,
        cwd: where,
        dir: basename(where),
        branch: null,
        isDirty: false,
        changed: 0,
        ahead: null,
        lastCommit: null,
      }))
      return
    }
    const [status, unpushed, last] = await Promise.all([
      git(['status', '--porcelain']),
      git(['rev-list', '--count', '@{upstream}..HEAD']),
      git(['log', '-1', '--format=%ct%x09%s']),
    ])
    const changed = status.stdout.split('\n').filter(line => line.trim() !== '').length
    const aheadCount = Number(unpushed.stdout.trim())
    const ahead = unpushed.exitCode === 0 && Number.isInteger(aheadCount) ? aheadCount : null
    const [seconds, ...subject] = last.stdout.trim().split('\t')
    const lastCommit =
      last.exitCode === 0 && Number(seconds) > 0 ? { subject: subject.join('\t'), at: Number(seconds) * 1000 } : null
    await update($, header, value => ({
      ...value,
      cwd: where,
      dir: basename(where),
      branch,
      isDirty: changed > 0,
      changed,
      ahead,
      lastCommit,
    }))
  } catch {
    // No git, not a repository, or too slow: keep what is shown.
  } finally {
    isGitRefreshing = false
  }
}

async function refreshAgents($: EngineInterface): Promise<void> {
  const list = await $.agent.list()
  const fresh: AgentRow[] = list.map(agent => ({
    id: agent.id,
    description: agent.name ?? agent.description,
    type: agent.type,
    status: agent.status,
  }))
  const now = await $.clock.now()
  await update($, agents, previous => mergeAgents(previous, fresh, now))

  // While a subagent runs, read the list again every 2 s.
  const isActive = fresh.some(agent => ACTIVE_AGENT.has(agent.status))
  if (isActive && agentTimer === null) {
    agentTimer = $.clock.every(2_000, () => void refreshAgents($).catch(() => undefined))
  }
  if (!isActive && agentTimer !== null) {
    agentTimer.cancel()
    agentTimer = null
  }
}

// The end of an agent's own turn, the proof of how it went. The list has the last word while it
// names a plain agent (a teammate goes idle, then wakes): it is read again at once.
async function noteAgentEnd($: EngineInterface, id: string, reason: string): Promise<void> {
  const status = agentEnd(reason)
  const at = await $.clock.now()
  await update($, workflows, list => endRunAgent(list, id, status, at))
  await update($, agents, list => list.map(agent => (agent.id === id ? { ...agent, status, endedAs: status } : agent)))
  void refreshAgents($).catch(() => undefined)
}

// The branch's pull request (gh) and the folder's latest deployment (vercel, when the
// folder is linked). Either tool missing, signed out or slow leaves its row out.
async function refreshRemote($: EngineInterface, isForced = false): Promise<void> {
  const now = await $.clock.now()
  if (isRefreshingRemote || (!isForced && now - lastRemoteAt < REMOTE_GAP_MS)) return
  isRefreshingRemote = true
  lastRemoteAt = now
  try {
    const where = await $.session.cwd()
    const info = await read($, header)
    const [prRun, isLinked] = await Promise.all([
      info.branch !== null
        ? $.process
            .run(['gh', 'pr', 'view', '--json', 'number,state,isDraft,url,statusCheckRollup'], { cwd: where, timeoutMs: 20_000 })
            .catch(() => null)
        : Promise.resolve(null),
      $.fs.exists(`${where}/.vercel/project.json`).catch(() => false),
    ])
    const deployRun = isLinked
      ? await $.process
          .run(['vercel', 'list', '--format', 'json', '--non-interactive'], { cwd: where, timeoutMs: 40_000 })
          .catch(() => null)
      : null
    const fresh: Remote = {
      pr: prRun !== null && prRun.exitCode === 0 ? parsePr(prRun.stdout) : null,
      deploy: deployRun !== null && deployRun.exitCode === 0 ? parseDeploy(deployRun.stdout) : null,
    }
    const current = await read($, remote)
    if (JSON.stringify(current) !== JSON.stringify(fresh)) await update($, remote, () => fresh)
  } finally {
    isRefreshingRemote = false
  }
}

async function takeSnapshot($: EngineInterface): Promise<void> {
  const figures = usageFrom(await $.session.usage())
  const at = await $.clock.now()
  await update($, usage, value => ({ ...value, ...figures }))
  const snapshot: Snapshot = { ctx: figures.ctxPercent, fiveHour: figures.fiveHourPercent, cost: figures.costUsd, at }
  await update($, history, list => [...list, snapshot].slice(-MAX_HISTORY))
}

async function loadPlan($: EngineInterface, path: string): Promise<void> {
  const text = await $.fs.read(path)
  const parsed = parsePlan(String(text))
  if (parsed.tasks.length === 0) return
  const previous = await read($, plan)
  await update($, plan, () => ({ path, ...parsed }))
  if (previous?.path !== path) await update($, isBandHidden, () => false)
}

async function alert($: EngineInterface, kind: AlertKind, body: string): Promise<void> {
  if (!isInteractive) return
  const now = await $.clock.now()
  if (now - (lastAlertAt.get(kind) ?? 0) < ALERT_GAP_MS) return
  lastAlertAt.set(kind, now)
  const { dir } = await read($, header)
  const title = dir !== '' ? `Claude Code · ${dir}` : 'Claude Code'
  // The text goes in as arguments (argv), never into the script: no AppleScript injection.
  await Promise.allSettled([
    $.process.run(
      ['osascript', '-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', body, title],
      { timeoutMs: 10_000 },
    ),
    $.process.run(['afplay', SOUNDS[kind]], { timeoutMs: 10_000 }),
  ])
}

async function notifyDone($: EngineInterface, durationMs: number, answer: string): Promise<void> {
  // Read without its marks, by its verdict when it has one: "✓ DONE" would only repeat "Done in".
  const verdict = readVerdict(answer)
  const gist = verdict !== null && verdict.text !== '' ? verdict.text : (verdict?.rest ?? answer)
  const badge = verdict !== null && verdict.kind !== 'done' ? `${VERDICTS[verdict.kind].badge} — ` : ''
  const summary = oneLine(badge + stripMarks(gist), 90)
  await alert($, 'done', `Done in ${elapsed(durationMs)}` + (summary !== '' ? ` — ${summary}` : ''))
}

// Once per usage window: the window's reset time is kept, so a restart does not alert again.
async function checkQuota($: EngineInterface, figures: Omit<Usage, 'startedAt'>): Promise<void> {
  const windows = [
    { kind: 'five_hour', label: '5-hour', percent: figures.fiveHourPercent, resetsAt: figures.fiveHourResetsAt },
    { kind: 'seven_day', label: '7-day', percent: figures.sevenDayPercent, resetsAt: figures.sevenDayResetsAt },
  ]
  for (const window of windows) {
    if (window.percent === null || window.percent < QUOTA_ALERT_PERCENT) continue
    const key = `quota:${window.kind}`
    const mark = window.resetsAt ?? 'unknown'
    if ((await $.store.get(key)) === mark) continue
    await $.store.set(key, mark)
    const now = await $.clock.now()
    const reset = window.resetsAt !== null ? resetIn(window.resetsAt, now) : null
    await alert($, 'quota', `${window.label} usage at ${Math.round(window.percent)}%${reset !== null ? ` · resets in ${reset}` : ''}`)
  }
}

// ── Animation ────────────────────────────────────────────────────────────────

// Frames run while a turn runs or something moves, then stop.
async function animate($: EngineInterface, forMs: number): Promise<void> {
  const now = await $.clock.now()
  animateUntil = Math.max(animateUntil, now + forMs)
  if (frameTimer !== null) return
  frameTimer = $.clock.every(FRAME_MS, () => void nextFrame($).catch(() => undefined))
}

async function nextFrame($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const { isRunning } = await read($, turn)
  if (!isRunning && openWaits === 0 && now > animateUntil) {
    frameTimer?.cancel()
    frameTimer = null
  }
  await update($, frame, n => n + 1)
}

// ── What waits for you ───────────────────────────────────────────────────────

async function setWaits($: EngineInterface, change: (list: Waiting[]) => Waiting[]): Promise<void> {
  await update($, waits, list => {
    const changed = change(list)
    openWaits = changed.length
    for (const id of answeredWaits) if (!changed.some(wait => wait.id === id)) answeredWaits.delete(id)
    return changed
  })
}

async function addWait($: EngineInterface, wait: Omit<Waiting, 'since'>, earlierMs = 0): Promise<void> {
  const since = (await $.clock.now()) - earlierMs
  await setWaits($, list => (list.some(item => item.id === wait.id) ? list : [...list, { ...wait, since }]))
  // The stopwatch runs on the frames, also for a background agent's question between two turns.
  void animate($, 0).catch(() => undefined)
}

// You said yes and the command runs, which can take minutes: it no longer waits for you. No event
// tells it, the call only ends with the command. But the terminal draws no spinner while a dialog
// is open, so one drawn since the question means the dialog has closed (measured on 2.1.317: drawn
// about 0.6 s after the yes). A spinner that had nothing new to draw stays silent: then the
// "run in background" hint of a command still running tells, ~5 s in, or the call's end.
// With several questions open, one drawing closes one, the oldest: the next counts from that yes,
// as the terminal may draw once between two dialogs.
function noteSpinner(now: number, list: readonly Waiting[]): void {
  const oldest = list.find(wait => wait.kind === 'permission' && !answeredWaits.has(wait.id))
  if (oldest === undefined || now <= Math.max(oldest.since, lastAnsweredAt) + SPINNER_GRACE_MS) return
  answeredWaits.add(oldest.id)
  lastAnsweredAt = now
}

function isAnswered(wait: Waiting): boolean {
  if (wait.kind !== 'permission') return false
  return answeredWaits.has(wait.id) || (wait.callId !== undefined && runningCalls.has(wait.callId))
}

// A permission question is about to be shown. Only a call can end it outside a turn: with no
// call and no turn running, nothing would ever take the row back, so it is left out.
async function askedPermission($: EngineInterface, tool: string, input: unknown, agentId: string | undefined): Promise<void> {
  const [list, { isRunning }] = await Promise.all([read($, waits), read($, turn)])
  const taken = new Set(list.map(wait => wait.callId))
  const callId = questionedCall([...openCalls.values()].filter(call => !taken.has(call.id)), tool, input, agentId)
  if (callId === undefined && !isRunning) return
  const detail = approvalLabel(tool, input, cwd)
  await addWait($, { id: callId ?? detail, kind: 'permission', detail, ...(callId !== undefined ? { callId } : {}) })
}

// The engine's notice about a dialog, ~6 s after it opened, when no signal showed it first (a
// sandboxed command's network request has none). Only a turn's end can then take the row back.
async function noticedWait($: EngineInterface, kind: Waiting['kind'], message: string): Promise<void> {
  const [list, { isRunning }] = await Promise.all([read($, waits), read($, turn)])
  if (!isRunning || list.length > 0) return
  const detail = message !== '' ? message : 'Claude is waiting for you'
  await addWait($, { id: detail, kind, detail }, QUESTION_ALERT_MS)
}

// A call has its result, a refusal included: what it asked is over. A wait tied to no call ends
// with the first result too, as nothing else would tell; a form ends with its own result.
// No read first: every read of a dispatch sees one moment, and a call's dispatch began before
// its question. `update` tries again on a stale version, so it always lands.
async function endWait($: EngineInterface, callId: string): Promise<void> {
  await setWaits($, list =>
    list.filter(wait => wait.kind === 'form' || (wait.callId !== undefined && wait.callId !== callId)),
  )
}

// The drawn value moves a third of the way to the real one each frame.
function glide(name: string, target: number): { value: number; isMoving: boolean } {
  const from = shown.get(name)
  const value = from === undefined || Math.abs(target - from) < 0.4 ? target : from + (target - from) / 3
  shown.set(name, value)
  return { value, isMoving: value !== target }
}

// ── Dev servers ──────────────────────────────────────────────────────────────

async function refreshServers($: EngineInterface): Promise<void> {
  if (isRefreshingServers) return
  isRefreshingServers = true
  try {
    const listening = await $.process.run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeoutMs: 10_000 })
    const listeners = parseListeners(listening.stdout)
    const pids = [...new Set(listeners.map(listener => listener.pid))]
    const folders =
      pids.length > 0
        ? parseFolders(
            (await $.process.run(['lsof', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'], { timeoutMs: 10_000 })).stdout,
          )
        : new Map<number, string>()
    const fresh = withFolders(listeners, folders)
    const current = await read($, servers)
    if (JSON.stringify(current) !== JSON.stringify(fresh)) await update($, servers, () => fresh)
  } catch {
    // lsof missing or slow: keep what is shown.
  } finally {
    isRefreshingServers = false
  }
}

async function loadProject($: EngineInterface): Promise<void> {
  const where = await $.session.cwd()
  const found = await $.fs.exists(`${where}/package.json`).catch(() => false)
  if (!found) {
    await update($, project, () => null)
    return
  }
  const text = String(await $.fs.read(`${where}/package.json`))
  const locks: string[] = []
  for (const name of ['pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'yarn.lock']) {
    if (await $.fs.exists(`${where}/${name}`).catch(() => false)) locks.push(name)
  }
  await update($, project, () => readProject(text, locks))
}

// A new tab right of this one, in the Ghostty this session runs in, with `command` typed
// into it in `where`. True when Ghostty took it.
async function openGhosttyTab($: EngineInterface, where: string, command: string): Promise<boolean> {
  const tree = await $.process.run(['sh', '-c', 'echo $$; ps -axo pid=,ppid=,comm='], { timeoutMs: 10_000 })
  const host = tree.exitCode === 0 ? ghosttyHost(tree.stdout) : null
  const ran = await $.process.run(
    ['osascript', '-l', 'JavaScript', '-e', NEW_TAB_SCRIPT, host === null ? '' : String(host), where, command],
    { timeoutMs: 10_000 },
  )
  return ran.exitCode === 0
}

// In a Ghostty tab of its own, so its log stays visible and ctrl+c stops it.
async function startDevServer($: EngineInterface, command: string): Promise<void> {
  const isOpen = await openGhosttyTab($, await $.session.cwd(), command)
  $.ui.toast(isOpen ? `Starting ${command} in a new tab…` : `Couldn’t start ${command}`)
  $.clock.after(4_000, () => void refreshServers($))
  $.clock.after(10_000, () => void refreshServers($))
}

// A new Ghostty tab, right of this one, that resumes this conversation on a fork: the
// original session stays as it is. The id goes into a shell command, so only the UUID form
// is accepted.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function forkSession($: EngineInterface): Promise<void> {
  const [where, sessionId] = await Promise.all([$.session.cwd(), $.session.id()])
  if (!SESSION_ID.test(sessionId)) {
    $.ui.toast('Couldn’t read the session id')
    return
  }
  const isOpen = await openGhosttyTab($, where, `claude --resume ${sessionId} --fork-session`)
  $.ui.toast(isOpen ? 'Forking the session in a new tab…' : 'Couldn’t open a Ghostty tab')
}

async function openUrl($: EngineInterface, url: string): Promise<void> {
  if (!/^https:\/\//.test(url)) return
  await $.process.run(['open', url], { timeoutMs: 10_000 })
}

async function openSite($: EngineInterface, port: number): Promise<void> {
  await $.process.run(['open', `http://localhost:${port}`], { timeoutMs: 10_000 })
}

async function openProject($: EngineInterface): Promise<void> {
  const where = await $.session.cwd()
  const ran = await $.process.run(editor !== null ? ['open', '-a', editor, where] : ['open', where], { timeoutMs: 10_000 })
  if (ran.exitCode !== 0) $.ui.toast('Couldn’t open the project')
}

async function setMode($: EngineInterface, mode: unknown): Promise<void> {
  if (typeof mode !== 'string') return
  const current = await read($, header)
  if (current.mode !== mode) await update($, header, value => ({ ...value, mode }))
}

async function openFile($: EngineInterface, path: string): Promise<void> {
  // In the editor when one is installed, else shown in the Finder.
  const argv = editor !== null ? ['open', '-a', editor, path] : ['open', '-R', path]
  const ran = await $.process.run(argv, { timeoutMs: 10_000 })
  if (ran.exitCode !== 0) $.ui.toast(`Couldn’t open ${basename(path)}`)
}

async function openFolder($: EngineInterface): Promise<void> {
  const where = await $.session.cwd()
  await $.process.run(['open', where], { timeoutMs: 10_000 })
}

async function showDiff($: EngineInterface): Promise<void> {
  try {
    await $.command.run({ command: 'diff' })
  } catch {
    $.ui.toast('The diff view is not available here')
  }
}

async function compactNow($: EngineInterface): Promise<void> {
  // Compacting drops detail from the conversation: the first press only arms it.
  const now = await $.clock.now()
  if (now > compactArmedUntil) {
    compactArmedUntil = now + COMPACT_CONFIRM_MS
    $.ui.toast('Press Compact again within 5 s to compact the conversation')
    return
  }
  compactArmedUntil = 0
  try {
    const result = await $.session.compact({})
    $.ui.toast(result.skip !== undefined ? `Compaction skipped: ${result.skip}` : 'Conversation compacted')
  } catch {
    $.ui.toast('Can’t compact while Claude is working')
  }
}

// ── 10. The other sessions ───────────────────────────────────────────────────

// Each Cockpit publishes, under a key of its own, what its session's last answer leaves you
// to decide; the others read it with the list from `claude agents --json`. The key follows the
// process, which a /clear or a compaction leaves as it is. No process known, no key.
const ownKey = () => (ownPid !== null ? `${VERDICT_PREFIX}${ownPid}` : null)

// The process this Cockpit runs in: the parent of a shell it starts. Null when not told.
async function findOwnPid($: EngineInterface): Promise<number | null> {
  try {
    const ran = await $.process.run(['sh', '-c', 'echo $PPID'], { timeoutMs: 10_000 })
    const pid = Number(ran.stdout.trim())
    return ran.exitCode === 0 && Number.isInteger(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

async function isPaneShown($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced && pane.isShown)
  } catch {
    return false
  }
}

// The verdicts published by every Cockpit. Those of sessions not listed for over a day go,
// and the oldest of them past the limit; no other key is touched.
async function collectVerdicts(
  $: EngineInterface,
  listed: readonly ListedSession[],
  now: number,
): Promise<SessionVerdict[]> {
  const found: { name: string; verdict: SessionVerdict }[] = []
  for (const name of (await $.store.keys()).filter(key => key.startsWith(VERDICT_PREFIX))) {
    const value = await $.store.get(name)
    if (isSessionVerdict(value)) found.push({ name, verdict: value })
  }
  const isListed = (verdict: SessionVerdict) => listed.some(session => belongsTo(verdict, session))
  const gone = found.filter(item => item.name !== ownKey() && !isListed(item.verdict) && now - item.verdict.at > STALE_AFTER_MS)
  const rest = found.filter(item => !gone.includes(item))
  const extra = rest
    .filter(item => item.name !== ownKey() && !isListed(item.verdict))
    .sort((a, b) => a.verdict.at - b.verdict.at)
    .slice(0, Math.max(0, rest.length - MAX_PUBLISHED))
  const dropped = [...gone, ...extra]
  for (const item of dropped) await $.store.delete(item.name).catch(() => undefined)
  return rest.filter(item => !extra.includes(item)).map(item => item.verdict)
}

// One read of the list at a time, only while the pane is in view. A failed, late or invalid
// read leaves the last list as it was: no error is shown and nothing is guessed.
async function readSessions($: EngineInterface, isForced = false): Promise<void> {
  if (isReadingSessions || !isInteractive) return
  isReadingSessions = true
  try {
    if (!isForced && !(await isPaneShown($))) return
    lastSessionsTryAt = await $.clock.now()
    const ran = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: SESSIONS_TIMEOUT_MS })
    if (ran.exitCode !== 0) return
    const listed = parseSessions(ran.stdout)
    if (listed === null) return
    const [now, sessionId, { readAt }] = await Promise.all([$.clock.now(), $.session.id(), read($, sessions)])
    const verdicts = await collectVerdicts($, listed, now)
    const own = { sessionId, pid: ownPid }
    await update($, sessionPhases, before => updatePhases(before, describeAll(listed, verdicts, own, now), now, readAt === null))
    await update($, sessions, () => ({ sessions: listed, verdicts, own, readAt: now }))
  } catch {
    // claude missing, slow or failing: keep what is shown.
  } finally {
    isReadingSessions = false
  }
}

// Checked every few seconds, so that a pane back in view reads soon; hidden, nothing is due.
async function readSessionsWhenDue($: EngineInterface): Promise<void> {
  if ((await $.clock.now()) - lastSessionsTryAt >= SESSIONS_EVERY_MS) await readSessions($)
}

// Whether this session runs under a Ghostty: ↗ go has nothing to do otherwise.
async function noteGhostty($: EngineInterface): Promise<void> {
  const tree = await $.process.run(['sh', '-c', 'echo $$; ps -axo pid=,ppid=,comm='], { timeoutMs: 10_000 })
  isUnderGhostty = tree.exitCode === 0 && ghosttyHost(tree.stdout) !== null
}

// When a turn ends: the words of its `{decide|…}` or `{blocked|…}` verdict go under this
// Cockpit's key; with none, the key goes. Only that key is written.
async function syncVerdict($: EngineInterface, answer: string, isAnswered: boolean): Promise<void> {
  if (!isInteractive) return
  const verdict = isAnswered ? sessionVerdict(answer) : null
  if (verdict === null) return dropVerdict($)
  // Not known yet, a busy machine at the start: asked again. Still unknown, nothing is published.
  if (ownPid === null) ownPid = await findOwnPid($)
  const key = ownKey()
  if (key === null) return
  const [at, sessionId] = await Promise.all([$.clock.now(), $.session.id()])
  const published: SessionVerdict = { ...verdict, at, sessionId, pid: ownPid }
  hasPublished = true
  await $.store.set(key, published)
}

async function dropVerdict($: EngineInterface): Promise<void> {
  const key = ownKey()
  if (!hasPublished || key === null) return
  hasPublished = false
  await $.store.delete(key)
}

// At the start: a key left by an earlier life of this process (another conversation) goes; one
// of this conversation, after a reload, is kept and known again.
async function adoptVerdict($: EngineInterface): Promise<void> {
  const key = ownKey()
  if (!isInteractive || key === null) return
  const value = await $.store.get(key)
  if (value === undefined || value === null) return
  if (isSessionVerdict(value) && value.sessionId === (await $.session.id())) hasPublished = true
  else await $.store.delete(key)
}

// ↗ go: the Ghostty tab the session runs in comes to the front. Only from Ghostty, and the
// tab is found by the terminal device of the session's process; anything else says so, once.
async function goToSession($: EngineInterface, pid: number, name: string): Promise<void> {
  try {
    const tree = await $.process.run(['sh', '-c', 'echo $$; ps -axo pid=,ppid=,comm='], { timeoutMs: 10_000 })
    const here = tree.exitCode === 0 ? ghosttyHost(tree.stdout) : null
    if (here === null) {
      $.ui.toast('Go works from Ghostty only')
      return
    }
    const host = ghosttyHostOf(tree.stdout, pid) ?? here
    const found = await $.process.run(['ps', '-o', 'tty=', '-p', String(pid)], { timeoutMs: 10_000 })
    const tty = found.stdout.trim()
    if (found.exitCode !== 0 || !/^ttys\d+$/.test(tty)) {
      $.ui.toast(`Couldn’t find ${name}’s tab`)
      return
    }
    const ran = await $.process.run(['osascript', '-l', 'JavaScript', '-e', FOCUS_SCRIPT, String(host), `/dev/${tty}`], {
      timeoutMs: 10_000,
    })
    if (ran.exitCode !== 0) $.ui.toast(`Couldn’t switch to ${name}`)
  } catch {
    $.ui.toast(`Couldn’t switch to ${name}`)
  }
}

// Runs a script of `hooks/ghostty.ts` on the tab with one of these titles. True when it found one.
async function onTitledTab(
  $: EngineInterface,
  script: string,
  titles: readonly string[],
  timeoutMs: number,
): Promise<boolean> {
  const tree = await $.process.run(['sh', '-c', 'echo $$; ps -axo pid=,ppid=,comm='], { timeoutMs })
  const host = tree.exitCode === 0 ? ghosttyHost(tree.stdout) : null
  if (host === null) return false
  const found = await $.process.run(['osascript', '-l', 'JavaScript', '-e', script, String(host), ...titles], { timeoutMs })
  return found.exitCode === 0
}

// ↗ go on a background session. One sent to the background from its tab is still shown there, which
// the list does not say: only the title tells, so a tab with its name comes forward. Else a new tab
// attaches to it, and it keeps running when that tab closes. The id goes into a shell command, hence
// the strict form.
async function attachSession($: EngineInterface, id: string, name: string): Promise<void> {
  // Looking takes seconds and a new tab has no title at first: a press now would open a second one.
  const now = await $.clock.now()
  if (attachPressed.id === id && now < attachPressed.until) return
  attachPressed = { id, until: now + 8_000 }
  const command = `claude attach ${id}`
  let isOpen = false
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    try {
      if (await onTitledTab($, FOCUS_TITLE_SCRIPT, [name, command], 10_000)) return
      isOpen = await openGhosttyTab($, await $.session.cwd(), command)
    } catch {
      // Said below.
    }
  }
  $.ui.toast(isOpen ? `Opening ${name} in a new tab…` : `Couldn’t open ${name}`)
}

// ✕ delete on a session with no tab: like Compact, the first press only arms it. One that still
// runs is stopped first. `claude rm` keeps a worktree with unsaved work and says where it is; a stopped
// session leaves the list even so, hence "Stopped …, not deleted". The conversation stays resumable.
async function deleteSession($: EngineInterface, id: string, name: string, isRunning: boolean): Promise<void> {
  const now = await $.clock.now()
  if (deleteArmed.id !== id || now > deleteArmed.until) {
    // A press on another row disarms at once, even while this one looks. The list cannot say that a
    // tab shows a running session, only a title can. If the look fails the plain words stay, and the
    // 5 s start once they are on screen.
    deleteArmed = { id: '', until: 0 }
    let isInTab = false
    try {
      isInTab = isRunning && (await onTitledTab($, HAS_TITLE_SCRIPT, [name, `claude attach ${id}`], 3_000))
    } catch {
      // Said by the plain words below.
    }
    deleteArmed = { id, until: (await $.clock.now()) + COMPACT_CONFIRM_MS }
    $.ui.toast(
      isInTab
        ? `${name} is open in a tab. Press delete again within 5 s to stop and delete it`
        : `Press delete again within 5 s to delete ${name}`,
    )
    return
  }
  deleteArmed = { id: '', until: 0 }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    $.ui.toast(`Couldn’t delete ${name}`)
    return
  }
  const run = (verb: 'stop' | 'rm') => $.process.run(['claude', verb, id], { timeoutMs: SESSIONS_TIMEOUT_MS })
  // `claude rm` tells a refusal over unsaved work on stdout, its other failures on stderr.
  const why = (ran: { stdout: string; stderr: string }) => {
    const line = firstLine(ran.stderr) || firstLine(ran.stdout)
    return line === '' ? '' : `: ${line}`
  }
  let said = `Couldn’t delete ${name}`
  let isListChanged = false
  try {
    const stop = isRunning ? await run('stop') : null
    if (stop !== null && stop.exitCode !== 0) {
      said += why(stop)
    } else {
      if (stop !== null) {
        said = `Stopped ${name}, not deleted`
        isListChanged = true
      }
      const removal = await run('rm')
      said = removal.exitCode === 0 ? `Deleted ${name}` : said + why(removal)
      isListChanged ||= removal.exitCode === 0
    }
  } catch {
    // `said` already tells how far it went.
  }
  $.ui.toast(said)
  if (isListChanged) await readSessions($, true)
}

// ── 9. Understanding Claude ──────────────────────────────────────────────────

// A button writes its prompt into the box (Reuse, → Claude), after any draft, and never sends it.
async function fillPrompt($: EngineInterface, action: QuickAction): Promise<void> {
  const box = await $.prompt.read()
  const isEmpty = box.text.trim() === ''
  const filled = await $.prompt.fill(isEmpty ? { text: action.prompt } : { text: ` ${action.prompt}`, mode: 'append' })
  if (!filled.isFilled) $.ui.toast(filled.refusal === 'dialog' ? 'Close the dialog first' : 'Couldn’t fill the prompt box')
  else $.ui.toast(`${action.label}: prompt ready, press Enter to send`)
}

// What fills the context, counted locally as /context's summary does: no request is sent.
// The same answer says where the session compacts now; without it, no point stays promised.
async function refreshBreakdown($: EngineInterface): Promise<void> {
  const measured = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
  const detail = measured?.context.breakdown
  await update($, compactAt, () => settledWindow(detail))
  if (detail === undefined) return
  await update($, breakdown, () => contextShares(detail.categories, detail.skills))
}

// "?" on an action: Claude says why on a fork of the conversation, so the answer costs a
// fraction of a turn and stays out of the transcript. A second press closes the answer.
async function askWhy($: EngineInterface, id: string, label: string, subject: string): Promise<void> {
  const current = await read($, why)
  if (current?.status === 'asking') return
  if (current?.id === id) {
    await update($, why, () => null)
    return
  }
  await update($, why, () => ({ id, label, subject, status: 'asking', text: '' }))
  void animate($, ASKING_MS)
  const reply = await $.model.fork({ prompt: whyPrompt(subject) }).catch(() => null)
  const answer: Pick<Why, 'status' | 'text'> =
    reply !== null && reply.isAnswered
      ? { status: 'answered', text: reply.text.trim() }
      : {
          status: 'failed',
          text:
            reply !== null && reply.reason === 'nothing-to-fork'
              ? 'Claude can answer once a turn has ended. Try again in a moment.'
              : 'No answer: the request failed.',
        }
  await update($, why, value => (value?.id === id ? { ...value, ...answer } : value))
  void animate($, FRAME_MS)
}

// The ★ Insight points of a reply, kept once each, with the folder they came from.
function captureInsights($: EngineInterface, text: string): void {
  if (!text.includes('★ Insight')) return
  const found = parseInsights(stripMarks(text)).filter(item => !seenInsights.has(item.id))
  if (found.length === 0) return
  for (const item of found) seenInsights.add(item.id)
  void (async () => {
    const [at, where] = await Promise.all([$.clock.now(), $.session.cwd()])
    await update($, insights, list => {
      const known = new Set(list.map(item => item.id))
      const added = found
        .filter(item => !known.has(item.id))
        .map(item => ({ ...item, dir: basename(where), at, isExported: false }))
      return [...list, ...added].slice(-MAX_INSIGHTS)
    })
    await $.store.set(INSIGHTS_KEY, await read($, insights))
  })().catch(() => undefined)
}

// Kept points from earlier sessions, merged with any taken since this load.
async function loadInsights($: EngineInterface): Promise<void> {
  const stored = await $.store.get(INSIGHTS_KEY)
  if (!Array.isArray(stored)) return
  const isKept = (item: Insight) => !DROPPED_INSIGHTS.includes(item.id) && !item.title.includes('★ Insight')
  const kept = stored
    .filter(
      (item): item is Insight =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Insight).id === 'string' &&
        typeof (item as Insight).title === 'string' &&
        typeof (item as Insight).body === 'string',
    )
    .map(item => ({ ...item, body: capital(item.body) }))
  for (const item of kept) seenInsights.add(item.id)
  // The pane's state can outlive a /reload-plugins: what it held is cleaned as well.
  await update($, insights, list => {
    const known = new Set(kept.map(item => item.id))
    return [...kept, ...list.filter(item => !known.has(item.id))].filter(isKept).slice(-MAX_INSIGHTS)
  })
  const merged = await read($, insights)
  if (merged.length < stored.length || kept.some((item, index) => item.body !== (stored[index] as Insight).body)) {
    await $.store.set(INSIGHTS_KEY, merged)
  }
}

// A reply of Claude's as it is kept: when it was written, for its "Claude · 20:24" label,
// and the words it explains, for the lexicon (the first meaning given wins).
async function noteReply($: EngineInterface, id: string, text: string): Promise<void> {
  const at = await $.clock.now()
  await update($, memberOf(replyAt, { requestId: replyStem(id) }), () => at)
  await update($, replyTimes, list => [...list.filter(item => item.id !== id), { id, at }].slice(-MAX_REPLY_TIMES))
  const found = termsIn(text)
  if (found.length > 0) await keepWords($, found, at)
}

async function keepWords($: EngineInterface, found: readonly Term[], at: number): Promise<void> {
  const isNew = (list: readonly Word[]) => {
    const known = new Set(list.map(item => item.term.toLowerCase()))
    return found.filter(item => !known.has(item.term.toLowerCase()))
  }
  if (isNew(await read($, words)).length === 0) return
  const dir = basename(cwd)
  await update($, words, list => [...list, ...isNew(list).map(item => ({ ...item, dir, at }))].slice(-MAX_WORDS))
  await $.store.set(WORDS_KEY, await read($, words))
}

// Kept words from earlier sessions, merged with any taken since this load.
async function loadWords($: EngineInterface): Promise<void> {
  const stored = await $.store.get(WORDS_KEY)
  if (!Array.isArray(stored)) return
  const kept = stored.filter(
    (item): item is Word =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Word).term === 'string' &&
      typeof (item as Word).meaning === 'string',
  )
  await update($, words, list => {
    const known = new Set(kept.map(item => item.term.toLowerCase()))
    return [...kept, ...list.filter(item => !known.has(item.term.toLowerCase()))].slice(-MAX_WORDS)
  })
}

const notePath = () => `${noteTarget.dir}/${noteTarget.name}.md`

// The points not yet in the note go at its end, under the date and the project's folder.
async function exportInsights($: EngineInterface): Promise<void> {
  if (noteTarget.dir === '') {
    $.ui.toast('Set the plugin option notesDir to a folder first')
    return
  }
  const fresh = (await read($, insights)).filter(item => !item.isExported)
  if (fresh.length === 0) {
    $.ui.toast('Every insight is already in the note')
    return
  }
  // iCloud keeps both copies of a note edited in two places: let the person merge them first.
  if (await $.fs.exists(`${noteTarget.dir}/${noteTarget.name} 2.md`).catch(() => false)) {
    $.ui.toast(`An iCloud copy “${noteTarget.name} 2” exists: merge the two copies first`)
    return
  }
  try {
    const path = notePath()
    const existing = (await $.fs.exists(path).catch(() => false)) ? String(await $.fs.read(path)) : null
    const today = new Date(await $.clock.now())
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    await $.fs.write(path, appendToNote(existing, noteSection(fresh, date), noteTarget.name))
  } catch {
    $.ui.toast('Couldn’t write the note')
    return
  }
  const ids = new Set(fresh.map(item => item.id))
  await update($, insights, list => list.map(item => (ids.has(item.id) ? { ...item, isExported: true } : item)))
  await $.store.set(INSIGHTS_KEY, await read($, insights))
  $.ui.toast(`${plural(fresh.length, 'insight')} added to “${noteTarget.name}”`)
}

async function openNote($: EngineInterface): Promise<void> {
  if (noteTarget.vault === '') return
  const url = `obsidian://open?vault=${encodeURIComponent(noteTarget.vault)}&file=${encodeURIComponent(noteTarget.name)}`
  const ran = await $.process.run(['open', url], { timeoutMs: 10_000 })
  if (ran.exitCode !== 0) $.ui.toast('Couldn’t open Obsidian')
}

// ── 10. Pinned replies ───────────────────────────────────────────────────────

const day = (at: number) => {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

async function loadPins($: EngineInterface): Promise<void> {
  const stored = await $.store.get(PINS_KEY)
  if (!Array.isArray(stored)) return
  const kept = stored.filter(
    (item): item is Pin =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Pin).id === 'string' &&
      typeof (item as Pin).title === 'string' &&
      typeof (item as Pin).text === 'string',
  )
  await update($, pins, () => kept.slice(-MAX_PINS))
}

async function savePins($: EngineInterface, change: (list: Pin[]) => Pin[]): Promise<void> {
  await update($, pins, change)
  await $.store.set(PINS_KEY, await read($, pins))
}

// The text selected with the mouse, else a reply read back from the transcript: the last
// one, or the one `/pin 3` names. Pinning never needs the reply to have ended since this load.
async function pinReply($: EngineInterface, args: string): Promise<string> {
  const request = pinRequest(args)
  const isRanked = /^\d/.test(args.trim())
  const selected = isRanked ? undefined : await $.ui.selection().catch(() => undefined)
  const excerpt = selected !== undefined && selected.text.trim().length >= 20 ? selected.text.trim() : null
  let text = excerpt
  if (text === null) {
    const replies = recentReplies(await $.session.messages())
    text = replies[request.rank - 1] ?? null
    if (text === null) return replies.length === 0 ? 'No reply of Claude’s to pin yet.' : `Only ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'} in this session.`
  }
  const [at, where, sessionId] = await Promise.all([$.clock.now(), $.session.cwd(), $.session.id()])
  const pin = makePin(text, { dir: basename(where), at, sessionId }, { title: request.title, isExcerpt: excerpt !== null })
  await savePins($, list => addPin(list, pin, MAX_PINS))
  await update($, openPin, () => null)
  return `📌 Pinned${excerpt !== null ? ' the selected passage' : ''}: “${pin.title}” · Cockpit → Pins`
}

// ✕ on a pin: the first press arms it, a second within 5 s unpins, as Compact does.
async function unpin($: EngineInterface, id: string, title: string): Promise<void> {
  const now = await $.clock.now()
  if (unpinArmed.id !== id || now > unpinArmed.until) {
    unpinArmed = { id, until: now + COMPACT_CONFIRM_MS }
    $.ui.toast(`Press ✕ again within 5 s to unpin “${title}”`)
    return
  }
  unpinArmed = { id: '', until: 0 }
  await savePins($, list => list.filter(item => item.id !== id))
  await update($, openPin, value => (value === id ? null : value))
  $.ui.toast('Unpinned')
}

// ── 11. Notes ───────────────────────────────────────────────────────────────

// The notepad of the folder the session started in: a `cd` of Claude's never switches it.
async function loadNotes($: EngineInterface): Promise<void> {
  const dir = cwd
  const stored = await $.store.get(NOTES_KEY(dir))
  const kept = typeof stored === 'object' && stored !== null && typeof (stored as Notes).text === 'string' ? (stored as Notes) : null
  lastKept = kept?.text ?? ''
  // Text typed since this load wins over what the store held.
  await update($, notes, value =>
    draft !== null && draft.dir === dir
      ? { ...value, dir, text: draft.text }
      : {
          dir,
          text: kept?.text ?? '',
          savedAt: kept?.savedAt ?? null,
          ...(typeof kept?.previous === 'string' ? { previous: kept.previous } : {}),
        },
  )
}

async function saveNotes($: EngineInterface): Promise<void> {
  notesTimer?.cancel()
  notesTimer = null
  const at = await $.clock.now()
  // A text cut to less than half keeps the longer one aside, for Restore.
  const isBigCut = (text: string) => lastKept.trim().length >= 20 && text.trim().length < lastKept.trim().length / 2
  await update($, notes, value => ({ ...value, savedAt: at, ...(isBigCut(value.text) ? { previous: lastKept } : {}) }))
  const current = await read($, notes)
  if (current.dir === '') return
  await $.store.set(NOTES_KEY(current.dir), current)
  lastKept = current.text
}

// Restore puts back the text a clear or a big cut replaced.
async function restoreNotes($: EngineInterface): Promise<void> {
  const current = await read($, notes)
  if (current.previous === undefined) return
  draft = { dir: current.dir, text: current.previous }
  await update($, notes, value => {
    const { previous, ...rest } = value
    return { ...rest, text: previous ?? value.text }
  })
  await saveNotes($)
  $.ui.toast('Notes restored')
}

// Every change is kept in the pane at once, and saved once typing pauses.
async function typeNotes($: EngineInterface, text: string): Promise<void> {
  const dir = (await read($, notes)).dir
  draft = { dir, text }
  await update($, notes, value => ({ ...value, text }))
  notesTimer?.cancel()
  notesTimer = $.clock.after(NOTES_SAVE_MS, () => void saveNotes($).catch(() => undefined))
}

// Clear asks for a second press, as Compact does: the notes are gone once saved empty.
async function clearNotes($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (now > clearArmedUntil) {
    clearArmedUntil = now + COMPACT_CONFIRM_MS
    $.ui.toast('Press Clear again within 5 s to empty the notes')
    return
  }
  clearArmedUntil = 0
  draft = null
  await update($, notes, value => ({ ...value, text: '' }))
  await saveNotes($)
}

// ── 12. The Git tab ──────────────────────────────────────────────────────────

// Read when the tab opens, at the end of a turn once it has been opened, and on ↻, never on a
// timer. From the folder the session started in, as the Notes: a `cd` of Claude's never moves it.
async function refreshGitTab($: EngineInterface): Promise<void> {
  if (isReadingGitTab) return
  isReadingGitTab = true
  try {
    await update($, gitTab, (value): GitTab => ({
      view: value.view.status === 'unread' ? { status: 'reading' } : value.view,
      isReading: true,
    }))
    const view = await readGitTab(args =>
      $.process.run(['git', ...GIT_READ_OPTIONS, ...args], { cwd, timeoutMs: GIT_READ_TIMEOUT_MS }),
    ).catch((error: unknown) => {
      const said = (error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim() ?? ''
      return { status: 'failed', message: said !== '' ? said.slice(0, 120) : 'no answer within 30 s' } as const
    })
    await update($, gitTab, () => ({ view, isReading: false }))
  } finally {
    isReadingGitTab = false
  }
}

// ── 13. Layout ───────────────────────────────────────────────────────────────

const clampTabRows = (rows: number) => Math.min(MAX_TAB_ROWS, Math.max(MIN_TAB_ROWS, Math.round(rows)))

async function loadLayout($: EngineInterface): Promise<void> {
  const stored = await $.store.get(LAYOUT_KEY)
  const layout = (typeof stored === 'object' && stored !== null ? stored : {}) as { tabRows?: unknown; isDetailed?: unknown }
  const rows = layout.tabRows
  const detailed = layout.isDetailed
  if (typeof rows === 'number') await update($, tabRows, () => clampTabRows(rows))
  if (typeof detailed === 'boolean') await update($, isDetailed, () => detailed)
}

// The tabs' height and the details' fold, kept as they were left.
async function saveLayout($: EngineInterface): Promise<void> {
  const [rows, detailed] = await Promise.all([read($, tabRows), read($, isDetailed)])
  await $.store.set(LAYOUT_KEY, { tabRows: rows, isDetailed: detailed })
}

async function toggleDetails($: EngineInterface): Promise<void> {
  await update($, isDetailed, value => !value)
  await saveLayout($)
}

export const register: Register = (on, options) => {
  noteTarget = readNotes(options)

  // ── Start, end, figures ──────────────────────────────────────────────────

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    isInteractive = e.isInteractive

    await $.command.register({ name: 'cockpit', description: 'Open the Cockpit dashboard for this session' })
    await $.command.register({
      name: 'pin',
      description: 'Pin Claude’s last reply (or the selected text) to the Cockpit’s Pins tab · /pin 2 for the one before',
    })

    const [figures, model, effort] = await Promise.all([
      $.session.usage(),
      $.session.model(),
      $.settings.read({ key: 'effortLevel' }),
    ])
    await update($, usage, () => ({ ...usageFrom(figures), startedAt: figures.startedAt }))
    await update($, header, value => ({
      ...value,
      cwd: e.cwd,
      dir: basename(e.cwd),
      model: value.model ?? model,
      effort: value.effort ?? (typeof effort === 'string' ? effort : null),
    }))
    for (const app of EDITORS) {
      if (await $.fs.exists(app).catch(() => false)) {
        editor = app
        break
      }
    }
    await restore($).catch(() => undefined)
    // What the probe of 2026-10-23 left in the store, never read again.
    void $.store.delete('debug:replyTime').catch(() => undefined)
    void loadInsights($).catch(() => undefined)
    void loadWords($).catch(() => undefined)
    void loadPins($).catch(() => undefined)
    void loadNotes($).catch(() => undefined)
    void loadLayout($).catch(() => undefined)
    void refreshBreakdown($).catch(() => undefined)
    void refreshAgents($).catch(() => undefined)
    void refreshServers($)
    void loadProject($).catch(() => undefined)

    // The other sessions: this process, the key it publishes under, then a read now and then.
    if (e.isInteractive) {
      // Not awaited: on a busy machine this can take seconds, and the start does not depend on it.
      void findOwnPid($)
        .then(pid => {
          ownPid = pid
          return adoptVerdict($)
        })
        .catch(() => undefined)
      isUnderGhostty = false
      void noteGhostty($).catch(() => undefined)
      lastSessionsTryAt = 0
      sessionsFirstTimer?.cancel()
      sessionsFirstTimer = $.clock.after(SESSIONS_FIRST_MS, () => void readSessions($))
      sessionsTimer?.cancel()
      sessionsTimer = $.clock.every(SESSIONS_CHECK_MS, () => void readSessionsWhenDue($).catch(() => undefined))
    }

    tickTimer?.cancel()
    tickTimer = $.clock.every(60_000, () => void update($, tick, n => n + 1).catch(() => undefined))
    serversTimer?.cancel()
    serversTimer = $.clock.every(SERVERS_EVERY_MS, () => void refreshServers($))
    // Git first: the PR is read only on a branch.
    void refreshGit($).then(() => refreshRemote($, true)).catch(() => undefined)
    remoteTimer?.cancel()
    remoteTimer = $.clock.every(REMOTE_EVERY_MS, () => void refreshRemote($, true).catch(() => undefined))

    if (e.isInteractive && e.surface !== null) void $.ui.open({ id: PANE, title: PANE_TITLE, columns: PANE_COLUMNS })

    return next(e)
  })

  on('command.run', { command: 'cockpit' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, columns: PANE_COLUMNS })
    return { text: opened.isPlaced ? 'Cockpit opened.' : `Cockpit is waiting: ${opened.reason}` }
  })

  on('command.run', { command: 'pin' }, async ($, e) => {
    const text = await pinReply($, e.args).catch(() => 'Couldn’t pin the reply.')
    return { text }
  })

  // The grip under the tabs posts the height it is dragged to; the release keeps it.
  on('ui.message', async ($, e, next) => {
    if (e.element !== 'tabs-handle') return next(e)
    const data = e.data as { rows?: unknown; isDone?: unknown }
    if (typeof data?.rows !== 'number') return {}
    const rows = clampTabRows(data.rows)
    await update($, tabRows, () => rows)
    if (data.isDone === true) await saveLayout($)
    return { props: { rows } }
  })

  on('session.end', async ($, e, next) => {
    // Whatever replaces this conversation (/clear, /resume), its verdict is no longer the session's.
    await dropVerdict($).catch(() => undefined)
    if (e.reason === 'clear') {
      const now = await $.clock.now()
      await Promise.all([
        update($, files, () => []),
        update($, commands, () => []),
        update($, workflows, () => []),
        update($, todos, () => []),
        update($, plan, () => null),
        update($, history, () => []),
        update($, checks, () => []),
        update($, codeEdits, () => []),
        update($, isDoneAnnounced, () => false),
        update($, why, () => null),
        update($, breakdown, () => null),
        update($, turn, () => IDLE_TURN),
        update($, isBandHidden, () => false),
        update($, decision, () => null),
        setWaits($, () => []),
        update($, replyTimes, () => []),
        update($, usage, value => ({ ...value, costUsd: null, startedAt: now })),
      ])
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const figures = usageFrom(e)
    await update($, usage, value => ({ ...value, ...figures }))
    void checkQuota($, figures).catch(() => undefined)
    return next(e)
  })

  // Claude waits for you: a permission prompt or an MCP form left ~6 s unanswered.
  on('classic.Notification', async ($, e, next) => {
    if (WAITING_NOTIFICATIONS.has(e.notification_type)) {
      void alert($, 'waiting', e.message !== '' ? e.message : 'Claude is waiting for you').catch(() => undefined)
    }
    const kind = WAIT_NOTICES[e.notification_type]
    if (kind !== undefined) await noticedWait($, kind, e.message).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The live row says so as soon as Claude asks, where the notice above comes ~6 s later.
  // This hook only watches: it hands back what it got, untouched, and never answers for you. An
  // answer from beneath (a settings hook's allow or deny) means no question will be shown.
  on('classic.PermissionRequest', async ($, e, next) => {
    const answer = await next(e)
    // AskUserQuestion comes through here too; its `tool.call` already said it was a question.
    if (answer.decision === undefined && e.tool_name !== 'AskUserQuestion') {
      await askedPermission($, e.tool_name, e.tool_input, e.agent_id).catch(() => undefined)
    }
    return answer
  }).catch(($, e, next) => next(e))

  // An MCP server's form, watched the same way: open from the request to its result.
  on('classic.Elicitation', async ($, e, next) => {
    const answer = await next(e)
    if (answer.block === undefined) {
      const { server } = splitMcpName(`mcp__${e.mcp_server_name}`)
      const id = `form-${e.elicitation_id ?? e.mcp_server_name}`
      await addWait($, { id, kind: 'form', detail: `form: ${server}` }).catch(() => undefined)
    }
    return answer
  }).catch(($, e, next) => next(e))
  on('classic.ElicitationResult', async ($, e, next) => {
    // A form known only from the engine's notice has no id of its own: this result ends it too.
    const id = `form-${e.elicitation_id ?? e.mcp_server_name}`
    await setWaits($, list => list.filter(wait => wait.kind !== 'form' || (wait.id.startsWith('form-') && wait.id !== id))).catch(
      () => undefined,
    )
    return next(e)
  }).catch(($, e, next) => next(e))

  // The model and effort actually sent, on each request of the main conversation.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const effort = e.effort === undefined ? null : String(e.effort)
      const current = await read($, header)
      if (current.model !== e.model || current.effort !== effort) {
        await update($, header, value => ({ ...value, model: e.model, effort }))
      }
      // Another model, another compaction point (a fallback changes it with no command).
      if (current.model !== null && current.model !== e.model) void refreshBreakdown($).catch(() => undefined)
    }
    return yield* next(e)
  })

  // The permission mode (auto, plan, bypass…) arrives with the classic hook events.
  on('classic.SessionStart', async ($, e, next) => {
    await setMode($, e.permission_mode)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await setMode($, e.permission_mode)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.Stop', async ($, e, next) => {
    await setMode($, e.permission_mode)
    // Nothing of a workflow's in flight: an agent shown running ended without being heard.
    const inFlight = e.background_tasks
    if (inFlight !== undefined && !inFlight.some(task => /workflow/i.test(task.type))) {
      const at = await $.clock.now()
      await update($, workflows, list => closeRuns(list, at))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ── Turns ────────────────────────────────────────────────────────────────

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const [now, spent] = await Promise.all([
        $.clock.now(),
        $.session.usage().then(
          measured => measured.cost?.usd,
          () => undefined,
        ),
      ])
      await update($, turn, () => ({
        isRunning: true,
        tools: 0,
        startedAt: now,
        ...(spent !== undefined ? { startCost: spent } : {}),
      }))
      // You answered: what Claude was waiting for leaves the band.
      if ((await read($, decision)) !== null) await update($, decision, () => null)
      await setWaits($, () => []).catch(() => undefined)
      await update($, isDoneAnnounced, () => false)
      void dropVerdict($).catch(() => undefined)
      void animate($, 0)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // Whatever ended the turn, Esc included: nothing stays shown as waiting for you.
      await setWaits($, () => []).catch(() => undefined)
      const [now, spent, started, editList, checkList] = await Promise.all([
        $.clock.now(),
        $.session.usage().then(
          measured => measured.cost?.usd,
          () => undefined,
        ),
        read($, turn),
        read($, codeEdits),
        read($, checks),
      ])
      // This turn's edits that nothing passed since. Those a failure elsewhere still holds count on
      // the Proof row, which names that failure; here a test that just passed is not denied.
      const lastPassedAt = Math.max(0, ...checkList.filter(check => check.isOk && check.isMasked !== true).map(check => check.at))
      lastTurnUnchecked = editList.some(at => at >= started.startedAt && at >= lastPassedAt)
      lastTurnEndAt = now
      lastTurnMs = e.durationMs
      lastTurnCost = spent !== undefined && started.startCost !== undefined ? Math.max(0, spent - started.startCost) : null
      await update($, turn, value => ({ ...value, isRunning: false }))
      // What the answer leaves to you stays above the prompt until you answer.
      const isAnswer = e.reason === 'answer' && !e.isAborted
      const choice = isAnswer ? pendingDecision(e.answer) : null
      const blocker = isAnswer ? pendingBlocker(e.answer) : null
      if (choice !== null || blocker !== null || (await read($, decision)) !== null) {
        await update($, decision, (): Decision | null =>
          choice !== null
            ? { text: choice, at: now, kind: 'decide' }
            : blocker !== null
              ? { text: blocker, at: now, kind: 'blocked' }
              : null,
        )
      }
      await update($, isDoneAnnounced, () => e.reason === 'answer' && !e.isAborted && readVerdict(e.answer)?.kind === 'done')
      // The other Cockpits show the words of this verdict; this write never waits for a read.
      void syncVerdict($, e.answer, e.reason === 'answer' && !e.isAborted).catch(() => undefined)
      void animate($, END_SWEEP_MS)
      void takeSnapshot($)
        .then(() => save($))
        .catch(() => undefined)
      void refreshGit($)
      void refreshAgents($).catch(() => undefined)
      void refreshRemote($).catch(() => undefined)
      void refreshBreakdown($).catch(() => undefined)
      void read($, gitTab)
        .then(state => (state.view.status !== 'unread' ? refreshGitTab($) : undefined))
        .catch(() => undefined)
      if (isInteractive && !e.isAborted && e.durationMs >= NOTIFY_AFTER_MS) {
        void notifyDone($, e.durationMs, e.answer).catch(() => undefined)
      }
    } else {
      await noteAgentEnd($, e.agentId, e.reason).catch(() => undefined)
    }
    return next(e)
  })

  // A workflow script's agent: its row starts here, as $.agent.list() never names it. Only a
  // started agent has an id (a refused one has none, a remote one no loop to follow).
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (e.workflow !== undefined && started.agentId !== undefined) {
      const { runId, agentIndex } = e.workflow
      const startedAt = await $.clock.now()
      const model = started.model ?? e.model
      const agent: WorkflowAgent = {
        id: started.agentId,
        index: agentIndex,
        description: e.name ?? (e.description !== '' ? e.description : e.subagentType),
        type: e.subagentType,
        model: model !== undefined ? modelFamily(model) : null,
        status: 'running',
        startedAt,
      }
      await update($, workflows, list => addRunAgent(list, runId, agent))
    }
    return started
  }).catch(($, e, next) => next(e))

  // Each block of Claude's reply as the conversation keeps it (not one a --resume loads):
  // when it was written and the words it explains. The row itself is never changed.
  on('session.append', async ($, e, next) => {
    const kept = await next(e)
    if (e.door === 'response' && e.agentId === undefined && e.message.type === 'assistant') {
      const text = e.message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
      if (text.trim() !== '') void noteReply($, e.uuid, text).catch(() => undefined)
    }
    // /model or /autocompact may have just moved the compaction point, between two turns.
    if (e.door === 'command' && e.agentId === undefined) void refreshBreakdown($).catch(() => undefined)
    return kept
  }).catch(($, e, next) => next(e))

  // ── Tool calls: watched, never blocked ───────────────────────────────────

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const at = await $.clock.now()
    await update($, turn, value => ({ ...value, tools: value.tools + 1 }))

    const label = describeTool(tool, e, cwd)
    const isSkill = tool === 'Skill'
    const isTracked = tool === 'Bash' || isSkill || isSensitiveTool(tool)
    if (isTracked) {
      const run: CommandRun = {
        id: e.tool_use_id,
        label: label.detail !== '' ? label.detail : label.verb,
        command: label.command ?? label.verb,
        isSensitive: label.isSensitive,
        isFromAgent: e.agentId !== undefined,
        ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
        status: 'running',
        at,
        kind: isSkill ? 'skill' : 'command',
      }
      await update($, commands, list => [...list, run].slice(-MAX_COMMANDS))
    }
    if (tool === 'Agent' || tool === 'Task') {
      $.clock.after(1_000, () => void refreshAgents($).catch(() => undefined))
    }
    const hadFile = e.tool === 'Write' ? await $.fs.exists(e.file_path).catch(() => true) : true

    // A question waits for you: alert unless it is answered within a few seconds.
    const question =
      tool === 'AskUserQuestion'
        ? $.clock.after(QUESTION_ALERT_MS, () => void alert($, 'waiting', 'Claude has a question for you'))
        : null
    if (tool === 'AskUserQuestion') {
      await addWait($, { id: e.tool_use_id, kind: 'question', detail: 'question', callId: e.tool_use_id }).catch(() => undefined)
    }

    openCalls.set(e.tool_use_id, {
      id: e.tool_use_id,
      tool,
      fields: e as Record<string, unknown>,
      ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
    })
    // A result, a refusal or a call the abort cut: the wait ends with the call, however it ends.
    const ran = await next(e).finally(() => {
      question?.cancel()
      openCalls.delete(e.tool_use_id)
      runningCalls.delete(e.tool_use_id)
      return endWait($, e.tool_use_id).catch(() => undefined)
    })

    try {
      const status: CommandRun['status'] = ran.deny !== undefined ? 'refused' : ran.isError === true ? 'error' : 'ok'
      if (isTracked) {
        await update($, commands, list => list.map(run => (run.id === e.tool_use_id ? { ...run, status } : run)))
      }
      if (status === 'error' && e.tool === 'Bash' && BUILD_OR_TEST.test(e.command)) {
        void alert($, 'failed', `Failed: ${label.detail !== '' ? label.detail : oneLine(e.command, 80)}`)
      }
      if (status !== 'refused' && e.tool === 'Bash') {
        // Sent to the background, the command's code only says it started.
        const isDetached = e.run_in_background === true
        await recordChecks(
          $,
          checkRuns(e.command).map(run => ({
            kind: run.kind,
            isOk: status === 'ok',
            at,
            ...(run.isMasked || isDetached ? { isMasked: true } : {}),
          })),
        )
      }
      if (status !== 'refused' && isBrowserCheck(tool)) {
        await recordChecks($, [{ kind: 'browser', isOk: status === 'ok', at }])
      }
      if (status !== 'ok') return ran

      // A push or a deploy: read GitHub and Vercel again once they have had time to react.
      if (e.tool === 'Bash' && touchesRemote(e.command)) {
        $.clock.after(5_000, () => void refreshRemote($, true).catch(() => undefined))
        $.clock.after(45_000, () => void refreshRemote($, true).catch(() => undefined))
      }

      if (e.tool === 'Write' || e.tool === 'Edit' || e.tool === 'NotebookEdit' || tool === 'MultiEdit') {
        const fields = e as { file_path?: unknown; notebook_path?: unknown }
        const path = String(fields.file_path ?? fields.notebook_path ?? '')
        if (path !== '') {
          await update($, files, list => touchFile(list, path, hadFile ? 'edited' : 'created', at))
          void animate($, FLASH_MS)
          if (isCodePath(path)) {
            const landedAt = await $.clock.now()
            await update($, codeEdits, list => [...list, landedAt].slice(-MAX_CODE_EDITS))
          }
        }
      }
      // A file only read goes on the project map, quietly: no flash, no change count.
      if (e.tool === 'Read' && e.agentId === undefined) {
        await update($, files, list => touchFile(list, e.file_path, 'read', at))
      }
      if ((e.tool === 'Read' || e.tool === 'Write' || e.tool === 'Edit') && PLAN_PATH.test(e.file_path)) {
        await loadPlan($, e.file_path)
      }
      if (e.tool === 'TaskCreate') {
        const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
        if (id !== undefined) {
          const created: TodoItem = { id, subject: e.subject, status: 'pending' }
          await update($, todos, list => [...list, created])
        }
      }
      if (e.tool === 'TaskUpdate') {
        const { taskId, subject, status: newStatus } = e
        await update($, todos, list =>
          newStatus === 'deleted'
            ? list.filter(item => item.id !== taskId)
            : list.map(item =>
                item.id === taskId ? { ...item, subject: subject ?? item.subject, status: newStatus ?? item.status } : item,
              ),
        )
      }
      if (e.tool === 'TodoWrite') {
        await update($, todos, () =>
          e.todos.map((item, index) => ({ id: String(index + 1), subject: item.content, status: item.status })),
        )
      }
      if (e.tool === 'TaskCreate' || e.tool === 'TaskUpdate' || e.tool === 'TodoWrite') await update($, todosAt, () => at)
      if (tool === 'Agent' || tool === 'Task') await refreshAgents($)
      if (tool === 'Workflow') {
        // Whatever comes first, this answer or the run's first agent: the name finds its run.
        const launched = ran.result as { runId?: unknown; workflowName?: unknown } | undefined
        const runId = launched?.runId
        const name = launched?.workflowName
        if (typeof runId === 'string' && typeof name === 'string') {
          await update($, workflows, list => nameRun(list, runId, name))
        }
      }
      if (tool === 'Bash' || e.tool === 'Write' || e.tool === 'Edit') void refreshGit($)
      if (tool === 'Bash') $.clock.after(3_000, () => void refreshServers($))
      if ((e.tool === 'Write' || e.tool === 'Edit') && basename(String(e.file_path)) === 'package.json') {
        void loadProject($).catch(() => undefined)
      }
    } catch {
      // Tracking is a side matter: an error here must never change the tool's result.
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ── 6. Chat look: your prompt in a bubble ────────────────────────────────

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const kind = e.props.origin.kind
    const isYours = kind === 'composer' || kind === 'bridge'
    // ctrl+o keeps the original row; slash commands keep theirs.
    if (e.surface !== 'terminal' || e.props.isExpanded || !isYours || e.props.text.startsWith('/')) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
        <Text color="claude" weight="semibold">
          You{kind === 'bridge' ? ' · remote' : ''}
        </Text>
        <Text>{e.props.text}</Text>
      </Box>
    )
  })

  // ── 6. Chat look: Claude's reply behind a bar ────────────────────────────

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // A summary row keeps the engine's look (and its faint "· summary" mark).
    captureInsights($, e.props.text)
    // Elsewhere the reply keeps the engine's look, without the marks it cannot draw.
    if (e.surface !== 'terminal' || e.props.isSummary === true) {
      return next(hasMarks(e.props.text) ? { ...e, props: { ...e.props, text: stripMarks(e.props.text) } } : e)
    }

    const { Box, Text, Markdown } = $.ui.resolve(e)
    // Only a reply's opening block reads its time: setting it redraws that block alone.
    const writtenAt = e.props.isFirstOfReply
      ? await read($, memberOf(replyAt, { requestId: replyStem(e.requestId) }))
      : null
    const verdict = readVerdict(e.props.text)
    const text = verdict !== null ? verdict.rest : e.props.text
    const runText = (run: Run, key: string) => (
      <Text
        key={key}
        color={run.isHighlight ? 'inverseText' : (run.tone ?? (run.isCode ? 'permission' : undefined))}
        backgroundColor={run.isHighlight ? HIGHLIGHT_TONE : undefined}
        bold={run.isBold}
        italic={run.isItalic}
        underline={run.isUnderline}
        dimColor={run.isDim}
      >
        {run.text}
      </Text>
    )
    // A paragraph with something to colour is drawn run by run; the rest stays markdown.
    const body = isColorful(text) ? (
      <Box flexDirection="column" gap={1}>
        {colorBlocks(text).map((block, index) =>
          block.kind === 'markdown' ? (
            <Markdown key={String(index)} text={block.text} />
          ) : (
            <Box key={String(index)} flexDirection="column">
              {block.lines.map((runs, row) => (
                <Text key={String(row)}>{runs.map((run, at) => runText(run, String(at)))}</Text>
              ))}
            </Box>
          ),
        )}
      </Box>
    ) : text.trim() !== '' ? (
      <Markdown text={text} />
    ) : null
    // The verdict: a badge in its colour, then the gist in bold.
    const verdictRow =
      verdict !== null ? (
        <Box marginBottom={body !== null ? 1 : 0}>
          <Text wrap="wrap">
            <Text backgroundColor={VERDICTS[verdict.kind].tone} color="inverseText" bold>
              {` ${VERDICTS[verdict.kind].badge} `}
            </Text>
            {' '}
            {lineRuns(verdict.text).map((run, at) => runText({ ...run, isBold: true }, String(at)))}
          </Text>
        </Box>
      ) : null
    return (
      <Box
        flexDirection="column"
        borderStyle="quote"
        borderColor="claude"
        paddingLeft={1}
        marginTop={e.props.isFirstOfReply ? 1 : 0}
      >
        {e.props.isFirstOfReply && (
          <Text>
            <Text color="claude" weight="semibold">
              Claude
            </Text>
            {writtenAt !== null && <Text dimColor> · {clock(writtenAt)}</Text>}
          </Text>
        )}
        {verdictRow}
        {body}
      </Box>
    )
  })

  // Claude is told the marks, where the terminal draws them; never under -p or --bare.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const isDrawn = e.surfaces.includes('terminal') && !e.traits.includes('print') && !e.traits.includes('bare')
    if (!isDrawn) return result
    return { sections: [...result.sections, { id: 'cockpit:marks', text: marksPrompt(), scope: 'session' as const }] }
  })

  // ── 6. Chat look: a rule closing each turn ───────────────────────────────

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)

    // The end time and the cost are known only for turns that ended since this load.
    if (!turnEnds.has(e.requestId)) {
      const now = await $.clock.now()
      turnEnds.set(
        e.requestId,
        now - lastTurnEndAt < 15_000 ? { at: lastTurnEndAt, cost: lastTurnCost, isUnchecked: lastTurnUnchecked } : null,
      )
    }
    const ended = turnEnds.get(e.requestId) ?? null
    // At the API's prices, as the pane's "API cost": with a Pro or Max plan, not a bill.
    const fullCost = ended !== null && ended.cost !== null && ended.cost > 0 ? ` · API ${dollars(ended.cost)}` : ''
    // Narrow, the notice stays and the cost goes whole, not as a bare "· API" at the edge.
    const isCramped = ended?.isUnchecked === true && e.viewport !== undefined && e.viewport.columns < NOTICE_WITH_COST_COLUMNS
    const cost = isCramped ? '' : fullCost

    // One row, clipped by its box: the rule runs to the edge without a trailing "…".
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box height={1} overflow="hidden">
        <Text dimColor>
          {'── '}
          <Text color="success">✓</Text>
          {` Done in ${elapsed(e.props.durationMs)}${ended !== null ? ` · ${clock(ended.at)}` : ''}`}
          {/* Before the cost: on a narrow terminal the box clips the row's end. */}
          {ended?.isUnchecked === true && <Text color="warning"> · no check since last edit</Text>}
          {`${cost} `}
          {'─'.repeat(400)}
        </Text>
      </Box>
    )
  })

  // ── 3. Spinner: plain words and the turn's counts ────────────────────────

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    claudeMode = e.props.mode
    if (e.surface === 'terminal') noteSpinner(await $.clock.now(), await read($, waits))
    const current = await read($, turn)
    const active =
      (await read($, agents)).filter(agent => ACTIVE_AGENT.has(agent.status)).length +
      (await read($, workflows)).flatMap(run => run.agents).filter(isRunning).length
    const parts = [
      ...(current.tools > 0 ? [plural(current.tools, 'tool')] : []),
      ...(active > 0 ? [plural(active, 'agent')] : []),
    ]
    // On the desktop the word already says what the step does: keep it there.
    const word =
      e.surface === 'terminal' && e.props.message === null ? (SPINNER_WORDS[e.props.mode] ?? e.props.word) : e.props.word
    const suffix = parts.length > 0 ? ` · ${parts.join(' · ')}…` : e.props.suffix
    return next({ ...e, props: { ...e.props, word, suffix } })
  })

  // The hint under a command that has run for a few seconds: it is running, so nothing waits.
  on('ui.render', { component: 'ToolProgress' }, async (_, e, next) => {
    if (openCalls.has(e.props.tool_use_id)) runningCalls.add(e.props.tool_use_id)
    return next(e)
  })

  // ── 4. Tool rows in plain English ────────────────────────────────────────

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    // ctrl+o (detailed view) keeps the original rows; only the terminal's are redrawn.
    if (e.surface !== 'terminal' || e.props.isExpanded === true) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const label = describeTool(e.props.tool, e.props.input, cwd)
    const dot = e.props.isRunning
      ? { glyph: '◌', color: 'subtle' }
      : e.props.isInterrupted
        ? { glyph: '◼', color: 'warning' }
        : e.props.isErrored
          ? { glyph: '✗', color: 'error' }
          : { glyph: '●', color: 'success' }
    const tone = label.isSensitive ? { color: 'error' } : {}

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color={dot.color}>{dot.glyph} </Text>
          <Text {...tone} weight="semibold">
            {label.isSensitive ? '⚠ ' : ''}
            {label.verb}
          </Text>
          {label.detail !== '' && (
            <Text {...tone} dimColor={!label.isSensitive}>
              {'  '}
              {label.detail}
            </Text>
          )}
          {e.props.isInterrupted && <Text color="warning"> (interrupted)</Text>}
        </Text>
        {label.isSensitive && label.command !== undefined && (
          <Text color="error" dimColor wrap="truncate-end">
            {'  $ '}
            {firstLine(label.command)}
          </Text>
        )}
      </Box>
    )
  })

  // ── 2. Band: the plan in progress ────────────────────────────────────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const [left, isHidden, current, list] = await Promise.all([
      read($, decision),
      read($, isBandHidden),
      read($, plan),
      read($, todos),
    ])
    const finished = list.filter(item => item.status === 'completed').length
    const doing = list.find(item => item.status === 'in_progress')
    const hasPlan = !isHidden && (current !== null || (list.length > 0 && finished < list.length))
    if (left === null && !hasPlan) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const hide = <Button key="cockpit-hide" label="Hide" onPress={() => update($, isBandHidden, () => true)} />

    // What Claude's last answer leaves to you, a choice or a blocker, until you answer or close it.
    const verdict = VERDICTS[left?.kind ?? 'decide']
    const decisionRow =
      left !== null ? (
        <Box key="cockpit-decision" flexDirection="row">
          <Box flexGrow={1}>
            <Text wrap="truncate-end">
              <Text backgroundColor={verdict.tone} color="inverseText" bold>
                {` ${verdict.badge} `}
              </Text>
              <Text> {left.text}</Text>
            </Text>
          </Box>
          <Button key="cockpit-decision-close" plain label=" ×" onPress={() => update($, decision, () => null)} />
        </Box>
      ) : null

    const planBand = () => {
      if (!hasPlan) return null
      if (current === null) {
        return (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text weight="semibold">☐ Steps </Text>
              <Text color="claude">{bar((finished / list.length) * 100, 16)}</Text>
              <Text>
                {' '}
                {finished}/{list.length}
              </Text>
              {doing !== undefined && <Text dimColor> · {doing.subject}</Text>}
            </Text>
            {hide}
          </Box>
        )
      }

      const progress = planProgress(current.tasks, list)
      const total = current.tasks.length
      const done = progress.done.filter(n => current.tasks.some(task => task.n === n)).length
      const task = current.tasks.find(item => item.n === progress.current)

      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text weight="semibold">📋 {current.title !== '' ? current.title : basename(current.path)}</Text>
            {task !== undefined ? (
              <Text dimColor>
                {' '}
                · Task {task.n}/{total} — {task.name}
              </Text>
            ) : (
              <Text dimColor> · {plural(total, 'task')}</Text>
            )}
          </Text>
          <Text wrap="truncate-end">
            <Text color="claude">{bar((done / Math.max(1, total)) * 100, 16)}</Text>
            <Text>
              {' '}
              {done}/{total}
            </Text>
            {current.requirements.length > 0 && <Text dimColor>{'   Requirements '}</Text>}
            {current.requirements.map(id =>
              progress.coveredRequirements.includes(id) ? (
                <Text color="success">{id}✓ </Text>
              ) : (
                <Text dimColor>{id} </Text>
              ),
            )}
          </Text>
          {!progress.hasMatchedTodos && list.length > 0 && (
            <Text dimColor wrap="truncate-end">
              Session steps: {finished}/{list.length}
              {doing !== undefined ? ` · ${doing.subject}` : ''}
            </Text>
          )}
          {hide}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {decisionRow}
        {planBand()}
      </Box>
    )
  })

  // ── 1. The Cockpit pane ──────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = elements
    // The mobile app draws no field yet: there the notes are only read.
    const Input = 'Input' in elements ? elements.Input : null
    // Only the terminal and desktop draw a module's region: elsewhere the grip is a plain rule.
    const Client = 'Client' in elements ? elements.Client : null
    const width = Math.max(10, e.props.bodyColumns)
    const [
      info,
      figures,
      snapshots,
      shownTab,
      fileList,
      commandList,
      agentList,
      workflowList,
      currentPlan,
      list,
      current,
      serverList,
      dev,
      checkList,
      editList,
      isDoneSaid,
      outside,
      compactPoint,
      insightList,
      contextFill,
      whyState,
      pinList,
      unfolded,
      notepad,
      tabHeight,
      showsDetails,
      showsAllActivity,
      stepsAt,
      wordList,
      page,
      gitState,
      graphChoice,
      isGitOpen,
      waitList,
    ] = await Promise.all([
        read($, header),
        read($, usage),
        read($, history),
        read($, tab),
        read($, files),
        read($, commands),
        read($, agents),
        read($, workflows),
        read($, plan),
        read($, todos),
        read($, turn),
        read($, servers),
        read($, project),
        read($, checks),
        read($, codeEdits),
        read($, isDoneAnnounced),
        read($, remote),
        read($, compactAt),
        read($, insights),
        read($, breakdown),
        read($, why),
        read($, pins),
        read($, openPin),
        read($, notes),
        read($, tabRows),
        read($, isDetailed),
        read($, isActivityOpen),
        read($, todosAt),
        read($, words),
        read($, learnPage),
        read($, gitTab),
        read($, gitGraphChoice),
        read($, isGitUnfolded),
        read($, waits),
      ])
    await read($, tick) // redraw every minute (reset countdown, session time)
    const [known, phases, isSessionsUnfolded, areMore, areOldShown] = await Promise.all([
      read($, sessions),
      read($, sessionPhases),
      read($, isSessionsOpen),
      read($, areSessionsMore),
      read($, areOldOpen),
    ])
    const n = await read($, frame) // redraw on every animation frame
    const now = await $.clock.now()
    let isMoving = false

    const rule = () => <Text dimColor>{'─'.repeat(width)}</Text>
    const heading = (text: string) => (
      <Text color="claude" weight="semibold">
        {text}
      </Text>
    )
    const quiet = (text: string) => (
      <Text dimColor wrap="wrap">
        {text}
      </Text>
    )

    // Figures: a meter that glides to the value, the history as a sparkline.
    const ctx = figures.ctxPercent
    const fiveHour = figures.fiveHourPercent
    const sevenDay = figures.sevenDayPercent
    // Against the compaction point when one is set: that is where the context starts over.
    const ctxLimit =
      compactPoint !== null && figures.ctxWindow !== null ? Math.min(compactPoint, figures.ctxWindow) : figures.ctxWindow
    const toTokens = (percent: number | null) =>
      percent !== null && figures.ctxWindow !== null ? (percent / 100) * figures.ctxWindow : null
    const ctxUsed =
      figures.ctxTokens !== null && ctxLimit !== null && compactPoint !== null
        ? (figures.ctxTokens / ctxLimit) * 100
        : ctx
    const ctxSeries = (snapshots.length > 0 ? snapshots.map(s => s.ctx) : [ctx]).map(percent => {
      const tokens = toTokens(percent)
      return tokens !== null && ctxLimit !== null && compactPoint !== null ? (tokens / ctxLimit) * 100 : percent
    })
    const turnsToCompact =
      compactPoint !== null && figures.ctxTokens !== null && ctxLimit !== null
        ? announcedTurns(
            turnsLeft(
              snapshots.map(snapshot => toTokens(snapshot.ctx)),
              figures.ctxTokens,
              ctxLimit,
            ),
          )
        : null
    const costs = snapshots.map(s => s.cost)
    const perTurn = costs.slice(1).map((cost, index) => {
      const before = costs[index]
      return cost !== null && before !== null && before !== undefined ? Math.max(0, cost - before) : null
    })
    const lastTurnCost = perTurn.at(-1) ?? null
    const gauge = (
      name: string,
      label: string,
      percent: number,
      tone: string,
      after: RenderNode | null,
      markAt: number | null = null,
    ) => {
      const moved = glide(name, percent)
      isMoving = isMoving || moved.isMoving
      return (
        <Text wrap="truncate-end">
          <Text dimColor>{label}</Text>
          {meter(moved.value, 12, markAt).map((run, index) =>
            run.kind === 'empty' ? (
              <Text key={String(index)} dimColor>
                {run.text}
              </Text>
            ) : (
              <Text key={String(index)} color={run.kind === 'mark' ? 'text' : tone}>
                {run.text}
              </Text>
            ),
          )}
          <Text color={markAt !== null ? paceTone(percent, markAt) : tone}>
            {' '}
            {String(Math.round(moved.value)).padStart(3)}%
          </Text>
          {projection(percent, markAt)}
          {after}
        </Text>
      )
    }
    // Where the usage ends at its reset at this pace: in the details, and always, in red, once
    // it would hit the limit first.
    const projection = (percent: number, markAt: number | null) => {
      const projected = projectAtReset(percent, markAt)
      if (projected === null) return null
      if (projected >= 100) return <Text color="error"> →{Math.min(projected, 999)}%</Text>
      return showsDetails ? <Text dimColor> →{projected}%</Text> : null
    }
    // The tick on a usage meter: how much of its window has gone by.
    const elapsedMark = (resetsAt: string | null, windowMs: number) =>
      resetsAt !== null ? windowElapsed(resetsAt, now, windowMs) : null
    const resetNote = (resetsAt: string | null) => {
      const reset = resetsAt !== null ? resetIn(resetsAt, now) : null
      return reset !== null ? <Text dimColor> · resets in {reset}</Text> : null
    }
    // How many turns are left before Claude Code compacts, at the pace of the last ones.
    const compactNote = () =>
      turnsToCompact === null ? null : (
        <Text color={turnsToCompact <= 2 ? 'warning' : undefined} dimColor={turnsToCompact > 2}>
          {' · '}
          {turnsToCompact === 0 ? 'compacts next turn' : `compacts in ~${plural(turnsToCompact, 'turn')}`}
        </Text>
      )
    const detailsLabel = showsDetails ? ' ▾ details' : ' ▸ details'

    // What still waits for you, the first asked first; read on each frame (isAnswered).
    const openWaitList = waitList.filter(wait => !isAnswered(wait))
    // The live row: what Claude does now, in its color, with a pulse and a stopwatch.
    const workflowRuns = workflowList.filter(run => run.agents.length > 0)
    const workflowAgents = workflowRuns.flatMap(run => run.agents)
    const activeCount =
      agentList.filter(agent => ACTIVE_AGENT.has(agent.status)).length + workflowAgents.filter(isRunning).length
    const liveRow = () => {
      // Claude waits for you, not the other way round: no pulse, and the time counts the wait.
      const wait = openWaitList[0]
      if (wait !== undefined) {
        return (
          <Text wrap="truncate-end">
            <Text color="warning" weight="semibold">
              ? Waiting for you
            </Text>
            <Text> {stopwatch(now - wait.since)}</Text>
            <Text color="warning"> · {wait.detail}</Text>
          </Text>
        )
      }
      if (current.isRunning) {
        const color = activeCount > 0 && claudeMode === 'tool-use' ? 'planMode' : (ACTIVITY_COLOR[claudeMode] ?? 'claude')
        const word = SPINNER_WORDS[claudeMode] ?? 'Working'
        const counts = [
          ...(current.tools > 0 ? [plural(current.tools, 'tool')] : []),
          ...(activeCount > 0 ? [plural(activeCount, 'agent')] : []),
        ]
        return (
          <Text wrap="truncate-end">
            <Text color={color}>{PULSE[n % PULSE.length]} </Text>
            <Text color={color} weight="semibold">
              {word}
            </Text>
            <Text> {stopwatch(now - current.startedAt)}</Text>
            {counts.length > 0 && <Text dimColor> · {counts.join(' · ')}</Text>}
          </Text>
        )
      }
      // Just ended: a green sweep across the pane, up to the details' toggle, then a quiet line.
      const sinceEnd = now - lastTurnEndAt
      if (lastTurnEndAt > 0 && sinceEnd < END_SWEEP_MS) {
        const done = `✓ Done in ${elapsed(lastTurnMs)} `
        const sweep = Math.round((sinceEnd / END_SWEEP_MS) * Math.max(0, width - done.length - detailsLabel.length))
        return (
          <Text wrap="truncate-end">
            <Text color="success" weight="semibold">
              {done}
            </Text>
            <Text color="success">{'━'.repeat(sweep)}</Text>
          </Text>
        )
      }
      // The turn is over and agents still work: they are what to watch, not a rest.
      if (activeCount > 0) {
        return (
          <Text wrap="truncate-end">
            <Text color="planMode" weight="semibold">
              ◌ {plural(activeCount, 'agent')} running
            </Text>
            {lastTurnEndAt > 0 && <Text dimColor> · last reply {ago(now - lastTurnEndAt)}</Text>}
          </Text>
        )
      }
      // At rest, how long the session has run; each turn's own time closes it in the chat.
      return (
        <Text dimColor wrap="truncate-end">
          ○ Ready{figures.startedAt !== null ? ` · session ${duration(now - figures.startedAt)}` : ''}
        </Text>
      )
    }

    // Git: what is not committed, what is not pushed, the last commit.
    const gitRow = () => {
      if (info.branch === null) return null
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text dimColor>{'Git      '}</Text>
            <Text>⎇ {info.branch}</Text>
            {info.changed > 0 ? (
              <Text color="warning"> · {plural(info.changed, 'change')}</Text>
            ) : (
              <Text color="success"> · clean</Text>
            )}
            {info.ahead !== null && info.ahead > 0 && <Text color="suggestion"> · ↑{info.ahead} to push</Text>}
            {info.ahead === null && <Text dimColor> · not on GitHub</Text>}
          </Text>
          {showsDetails && info.lastCommit !== null && (
            <Text dimColor wrap="truncate-end">
              {'Last     '}
              {info.lastCommit.subject} · {ago(now - info.lastCommit.at)}
            </Text>
          )}
        </Box>
      )
    }

    // Proof: the code edits no check has passed since, then the last run of each kind, with
    // how long ago. A ✓ is an exit code: the row under them says so, whenever one shows.
    const proofRow = () => {
      if (editList.length === 0 && checkList.length === 0) return null
      const ran = (Object.keys(CHECK_LABELS) as Check['kind'][])
        .map(kind => checkList.find(check => check.kind === kind))
        .filter((check): check is Check => check !== undefined)
      const notRun = editList.length > 0 ? EXPECTED_CHECKS.filter(kind => !ran.some(check => check.kind === kind)) : []
      const lastPassed = ran.filter(check => check.isOk && check.isMasked !== true).sort((a, b) => b.at - a.at)[0]
      const failing = ran.filter(isFailing).map(check => CHECK_LABELS[check.kind])
      // "Since the last lint" would be false of edits made before it: they wait for what failed.
      const isHeldByFailure = lastPassed !== undefined && failing.length > 0 && editList.some(at => at <= lastPassed.at)
      const since = (check: Check) => ago(now - check.at).replace(' ago', '').replace('just now', 'now')
      const runs = (label: string) => (
        <Text wrap="truncate-end">
          <Text dimColor>{label}</Text>
          {ran.map((check, index) => (
            <Text key={check.kind}>
              {index > 0 && <Text dimColor> · </Text>}
              {check.isMasked === true ? (
                <Text>
                  <Text color="warning">? </Text>
                  <Text>{CHECK_LABELS[check.kind]}</Text>
                </Text>
              ) : (
                <Text>
                  <Text>{CHECK_LABELS[check.kind]}</Text>
                  <Text color={check.isOk ? 'success' : 'error'}> {check.isOk ? '✓' : '✗'}</Text>
                </Text>
              )}
              <Text dimColor> {since(check)}</Text>
            </Text>
          ))}
          {notRun.length > 0 && (
            <Text dimColor>
              {ran.length > 0 ? ' · ' : ''}
              {notRun.map(kind => CHECK_LABELS[kind]).join(', ')} not run
            </Text>
          )}
        </Text>
      )
      return (
        <Box flexDirection="column">
          {editList.length > 0 && (
            <Text wrap="truncate-end">
              <Text dimColor>{'Proof    '}</Text>
              {isHeldByFailure ? (
                <Text color="warning">⚠ {failing.join(', ')} failing</Text>
              ) : (
                <Text color="warning">
                  ⚠ {plural(editList.length, 'code edit')}
                  {lastPassed !== undefined ? ` since the last ${LAST_CHECK[lastPassed.kind]}` : ' with no passing check'}
                </Text>
              )}
            </Text>
          )}
          {runs(editList.length > 0 ? '         ' : 'Proof    ')}
          {lastPassed !== undefined && (
            <Text dimColor wrap="truncate-end">
              {' '.repeat(Math.max(0, Math.min(9, width - PROOF_CAVEAT.length)))}
              {PROOF_CAVEAT}
            </Text>
          )}
        </Box>
      )
    }

    // The branch's pull request and its CI checks.
    const prRow = () => {
      const pr = outside.pr
      if (pr === null) return null
      const look =
        pr.state === 'MERGED'
          ? { glyph: '✓', color: 'planMode', text: 'merged' }
          : pr.state === 'CLOSED'
            ? { glyph: '⊘', color: 'subtle', text: 'closed' }
            : pr.checks === 'failing'
              ? { glyph: '✗', color: 'error', text: 'checks failing' }
              : pr.checks === 'pending'
                ? { glyph: RUNNING[n % RUNNING.length]!, color: 'warning', text: 'checks running' }
                : pr.checks === 'passing'
                  ? { glyph: '✓', color: 'success', text: 'checks passing' }
                  : { glyph: '○', color: 'subtle', text: 'no checks' }
      return (
        <Box flexDirection="row">
          <Box flexGrow={1}>
            <Text wrap="truncate-end">
              <Text dimColor>{'PR       '}</Text>
              <Text weight="semibold">#{pr.number}</Text>
              {pr.isDraft && <Text dimColor> draft</Text>}
              <Text color={look.color}> {look.glyph} </Text>
              <Text color={look.color}>{look.text}</Text>
            </Text>
          </Box>
          {pr.url !== '' && <Button key="open-pr" plain label=" ↗ open" onPress={() => openUrl($, pr.url)} />}
        </Box>
      )
    }

    // The folder's latest Vercel deployment.
    const deployRow = () => {
      const deploy = outside.deploy
      if (deploy === null) return null
      const look =
        deploy.state === 'READY'
          ? { glyph: '✓', color: 'success', text: 'Ready' }
          : deploy.state === 'ERROR'
            ? { glyph: '✗', color: 'error', text: 'Error' }
            : deploy.state === 'CANCELED'
              ? { glyph: '⊘', color: 'subtle', text: 'Canceled' }
              : { glyph: RUNNING[n % RUNNING.length]!, color: 'warning', text: 'Building' }
      return (
        <Box flexDirection="row">
          <Box flexGrow={1}>
            <Text wrap="truncate-end">
              <Text dimColor>{'Deploy   '}</Text>
              <Text color={look.color}>
                {look.glyph} {look.text}
              </Text>
              <Text dimColor>
                {' · '}
                {deploy.target}
                {deploy.at > 0 ? ` · ${ago(now - deploy.at)}` : ''}
              </Text>
            </Text>
          </Box>
          {deploy.url !== '' && <Button key="open-deploy" plain label=" ↗ open" onPress={() => openUrl($, deploy.url)} />}
        </Box>
      )
    }

    // Dev servers, in the label column as Git and Proof: one row each with its button, and
    // a start button for this folder when nothing serves it yet.
    const isServingHere = serverList.some(server => server.dir === info.cwd)
    const serversView = () => {
      const canStart = dev !== null && !isServingHere
      if (serverList.length === 0 && !canStart) return null
      const label = (index: number) => <Text dimColor>{index === 0 ? 'Servers  ' : '         '}</Text>
      return (
        <Box flexDirection="column">
          {serverList.map((server, index) => (
            <Box key={`server-${server.port}`} flexDirection="row">
              <Box flexGrow={1}>
                <Text wrap="truncate-end">
                  {label(index)}
                  <Text color="success">{PULSE[(n + server.port) % PULSE.length]} </Text>
                  <Text weight="semibold">:{server.port}</Text>
                  <Text dimColor> {server.dir !== '' ? basename(server.dir) : server.name}</Text>
                </Text>
              </Box>
              <Button key={`site-${server.port}`} plain label=" ↗ open" onPress={() => openSite($, server.port)} />
            </Box>
          ))}
          {dev !== null && canStart && (
            <Box flexDirection="row">
              {label(serverList.length)}
              <Button
                key="action-start"
                label={`▶ ${startCommand(dev)}`}
                onPress={() => startDevServer($, startCommand(dev))}
              />
            </Box>
          )}
        </Box>
      )
    }

    // The other sessions: one line when nothing waits for you, the rows when something does.
    const sessionsView = () => {
      const view = layOut(describeAll(known.sessions, known.verdicts, known.own, now), phases)
      if (view.lines.length === 0 && view.old.length === 0) return null
      const showsRows = view.waits > 0 || isSessionsUnfolded
      const maxRows = e.props.scroll.bodyRows < SHORT_PANE_ROWS ? SHORT_PANE_SESSIONS : MAX_ROWS
      const shownLines = areMore ? view.lines : view.lines.slice(0, maxRows)
      const hidden = view.lines.length - shownLines.length
      const isStale = known.readAt !== null && now - known.readAt > SESSIONS_STALE_MS
      const head = headerText(view.lines.length, view.waits, isStale)
      const oldLabel = ` ${areOldShown ? '▾' : '▸'} ${view.old.length} old`
      const row = (line: Line, cells: { name: string; detail: string; age: string }, action: RenderNode | null) => (
        <Box key={`session-${line.key}`} flexDirection="row">
          <Box flexGrow={1}>
            <Text wrap="truncate-end">
              <Text color={line.tone}>{line.glyph} </Text>
              <Text weight={line.group === 'wait' ? 'semibold' : undefined} dimColor={line.group === 'idle'}>
                {cells.name}
              </Text>
              <Text dimColor={line.group !== 'wait'}>{`  ${cells.detail}`}</Text>
              {cells.age !== '' && <Text dimColor>{` · ${cells.age}`}</Text>}
            </Text>
          </Box>
          {action}
        </Box>
      )
      const goLabel = ' ↗ go'
      const deleteLabel = ' ✕ delete'
      const deleteButton = ({ id, key, name, pid }: Line) =>
        id === null ? null : (
          <Button
            key={`delete-${key}`}
            plain
            label={deleteLabel}
            onPress={() => deleteSession($, id, name, pid !== null)}
          />
        )
      // Only one with a process: attaching to one without could start its work again.
      const attachButton = ({ id, key, name, pid }: Line) =>
        id === null || pid === null || !isUnderGhostty ? null : (
          <Button key={`attach-${key}`} plain label={goLabel} onPress={() => attachSession($, id, name)} />
        )
      const noTab = shownLines.filter(line => !line.hasTab && line.id !== null)
      const buttons =
        (noTab.length > 0 ? deleteLabel.length : 0) +
        (noTab.some(line => line.pid !== null) && isUnderGhostty ? goLabel.length : 0)
      const cells = fitLines(shownLines, width, Math.max(buttons, goLabel.length), now)
      const oldCells = fitLines(view.old, width, deleteLabel.length, now, true)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Box flexGrow={1}>
              {view.waits === 0 && view.lines.length > 0 ? (
                <Button
                  key="sessions-toggle"
                  plain
                  dimColor={isStale}
                  label={`${isSessionsUnfolded ? '▾' : '▸'} ${head}`}
                  onPress={() => update($, isSessionsOpen, value => !value)}
                />
              ) : (
                <Text
                  wrap="truncate-end"
                  weight="semibold"
                  color={view.waits > 0 && !isStale ? 'warning' : undefined}
                  dimColor={isStale}
                >
                  {head}
                </Text>
              )}
            </Box>
            {view.old.length > 0 && (
              <Button key="sessions-old" plain label={oldLabel} onPress={() => update($, areOldOpen, value => !value)} />
            )}
          </Box>
          {showsRows &&
            shownLines.map((line, index) =>
              row(
                line,
                cells[index]!,
                !line.hasTab ? (
                  <Box key={`buttons-${line.key}`} flexDirection="row">
                    {deleteButton(line)}
                    {attachButton(line)}
                  </Box>
                ) : line.pid !== null && isUnderGhostty ? (
                  <Button
                    key={`go-${line.key}`}
                    plain
                    label={goLabel}
                    onPress={() => goToSession($, line.pid!, line.name)}
                  />
                ) : null,
              ),
            )}
          {showsRows && (hidden > 0 || areMore) && view.lines.length > maxRows && (
            <Button
              key="sessions-more"
              plain
              label={areMore ? '▾ fewer' : `+${hidden} more`}
              onPress={() => update($, areSessionsMore, value => !value)}
            />
          )}
          {areOldShown &&
            view.old.map((line, index) => row(line, oldCells[index]!, deleteButton(line)))}
        </Box>
      )
    }
    const sessionsBlock = sessionsView()

    // Activity, the plan and the tabs
    const activeAgents = agentList.filter(agent => ACTIVE_AGENT.has(agent.status))
    const doneAgents = agentList.filter(agent => !ACTIVE_AGENT.has(agent.status))
    const progress = currentPlan !== null ? planProgress(currentPlan.tasks, list) : null
    const shownTabId: Tab =
      shownTab === 'git' || shownTab === 'learn' || shownTab === 'pins' || shownTab === 'notes' ? shownTab : 'files'
    const freshInsights = insightList.filter(item => !item.isExported).length
    const counts: Readonly<Record<Tab, string>> = {
      files:
        fileList.length > 0
          ? `${fileList.length}${fileList.some(file => file.action !== 'read' && now - file.at < FLASH_MS) && n % 2 === 0 ? ' ✦' : ''}`
          : '',
      git: '',
      learn:
        insightList.length + wordList.length > 0
          ? `${insightList.length + wordList.length}${freshInsights > 0 ? ' •' : ''}`
          : '',
      pins: pinList.length > 0 ? String(pinList.length) : '',
      notes: notepad.text.trim() !== '' ? '•' : '',
    }

    const agentLook = (status: string) =>
      status === 'running'
        ? { glyph: RUNNING[n % RUNNING.length]!, color: 'claude' }
        : status === 'pending' || status === 'waiting'
          ? { glyph: '◌', color: 'subtle' }
          : status === 'failed'
            ? { glyph: '✗', color: 'error' }
            : status === 'killed'
              ? { glyph: '◼', color: 'warning' }
              : status === 'completed'
                ? { glyph: '✓', color: 'success' }
                : status === 'idle'
                  ? { glyph: '○', color: 'subtle' }
                  : { glyph: '?', color: 'warning' }
    const commandLook = (status: CommandRun['status']) =>
      status === 'running'
        ? { glyph: RUNNING[n % RUNNING.length]!, color: 'claude' }
        : status === 'error'
          ? { glyph: '✗', color: 'error' }
          : status === 'refused'
            ? { glyph: '⊘', color: 'warning' }
            : { glyph: '✓', color: 'success' }

    // A row with "? why" at the right, shown while the pointer is on the row (always on the
    // mobile app, which has no pointer), and Claude's answer under it once asked.
    const canHover = e.surface !== 'mobile'
    const withWhy = (id: string, label: string, subject: string, content: RenderNode, more: RenderNode | null = null) => {
      const isAsked = whyState?.id === id
      const ask = (
        <Button key={`why-${id}`} plain label={isAsked ? ' ×' : ' ? why'} onPress={() => askWhy($, id, label, subject)} />
      )
      return (
        <Box key={`row-${id}`} flexDirection="column">
          <Box flexDirection="row">
            <Box flexGrow={1}>{content}</Box>
            {isAsked || !canHover ? (
              ask
            ) : (
              <Box display="none" hover={{ display: 'flex' }}>
                {ask}
              </Box>
            )}
            {more}
          </Box>
          {isAsked && whyState !== null && (
            <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
              {whyState.status === 'asking' ? (
                <Text color="suggestion">{RUNNING[n % RUNNING.length]} Asking Claude why…</Text>
              ) : (
                <Text wrap="wrap" color={whyState.status === 'failed' ? 'warning' : undefined}>
                  {whyState.text}
                </Text>
              )}
            </Box>
          )}
        </Box>
      )
    }

    const noResultRow = (type: string) => (
      <Text wrap="truncate-end">
        <Text color="warning">? </Text>
        <Text>ended without a result: </Text>
        <Text dimColor>{type}</Text>
      </Text>
    )
    const agentRow = (agent: AgentRow) => {
      const look = agentLook(agent.status)
      return withWhy(
        `agent-${agent.id}`,
        agent.description,
        `tu as lancé l’agent « ${agent.description} » (${agent.type})`,
        agent.status === 'unknown' ? (
          noResultRow(agent.type)
        ) : (
          <Text wrap="truncate-end">
            <Text color={look.color}>{look.glyph} </Text>
            <Text>{agent.description}</Text>
            <Text dimColor>
              {' '}
              · {agent.type}
              {agent.status === 'idle' ? ' · idle' : ''}
            </Text>
          </Text>
        ),
      )
    }
    const workflowRow = (run: WorkflowRun) => {
      const { ended, total, noResult } = runCounts(run)
      return (
        <Text key={`workflow-${run.runId}`} wrap="truncate-end">
          <Text color="planMode">⚙ </Text>
          <Text weight="semibold">{runLabel(run)}</Text>
          <Text dimColor>
            {' '}
            · {ended}/{total} agents
          </Text>
          {noResult > 0 && <Text color="warning"> · {noResult} no result</Text>}
        </Text>
      )
    }
    const workflowAgentRow = (agent: WorkflowAgent) => {
      const look = isRunning(agent) ? { glyph: '◌', color: 'claude' } : agentLook(agent.status)
      return withWhy(
        `agent-${agent.id}`,
        agent.description,
        `tu as lancé l’agent « ${agent.description} » (${agent.type})`,
        agent.status === 'unknown' ? (
          noResultRow(agent.type)
        ) : (
          <Text wrap="truncate-end">
            <Text color={look.color}>{look.glyph} </Text>
            <Text>{agent.description}</Text>
            <Text dimColor>
              {agent.model !== null ? ` · ${agent.model}` : ''} · {duration((agent.endedAt ?? now) - agent.startedAt)}
            </Text>
          </Text>
        ),
      )
    }
    // The name before an agent's command, from whichever list knows it.
    const agentNames = new Map([...agentList, ...workflowAgents].map(agent => [agent.id, agent.description]))
    const commandRow = (run: CommandRun) => {
      // Asked but not running yet, while its question waits for you.
      const look = openWaitList.some(wait => wait.callId === run.id) ? { glyph: '?', color: 'warning' } : commandLook(run.status)
      const isSkill = run.kind === 'skill'
      const agentName = run.agentId !== undefined ? agentNames.get(run.agentId) : undefined
      const subject = isSkill
        ? `tu as utilisé le skill « ${run.label} »`
        : `tu as lancé « ${oneLine(run.command, 300)} »${run.status === 'error' ? ' (qui a échoué)' : ''}`
      return withWhy(
        `run-${run.id}`,
        run.label,
        subject,
        <Text wrap="truncate-end">
          <Text color={look.color}>{look.glyph} </Text>
          {agentName !== undefined && agentName !== '' ? (
            <Text dimColor>{clip(agentName, AGENT_NAME_CHARS)}: </Text>
          ) : (
            run.isFromAgent && <Text dimColor>↳ </Text>
          )}
          {isSkill ? (
            <Text color="suggestion">◆ {run.label}</Text>
          ) : run.isSensitive ? (
            <Text color="error">⚠ {run.label}</Text>
          ) : (
            <Text>{run.label}</Text>
          )}
        </Text>,
      )
    }

    // At rest, a few rows that keep their place: the running agents, the oldest first, each
    // workflow's under a line of its own; then the newest commands; last, the newest agent gone
    // with no result, for a while; and the row whose answer is open, wherever it went. ▸ all
    // shows the lot, by kind.
    const activity = () => {
      const newest = [...commandList].reverse()
      let room = SHOWN_ACTIVITY
      const liveRuns = workflowRuns
        .filter(run => run.agents.some(isRunning))
        .map(run => {
          const shown = run.agents.filter(isRunning).slice(0, room)
          room -= shown.length
          return { run, shown }
        })
      const shownAgents = activeAgents.slice(0, room)
      room -= shownAgents.length
      const isFreshNoResult = (agent: AgentRow | WorkflowAgent) =>
        agent.status === 'unknown' && agent.endedAt !== undefined && now - agent.endedAt < NO_RESULT_SHOWN_MS
      const noResultAgent = room > 0 ? agentList.filter(isFreshNoResult).at(-1) : undefined
      const noResultRunAgent =
        room > 0 && noResultAgent === undefined ? workflowAgents.filter(isFreshNoResult).at(-1) : undefined
      if (noResultAgent !== undefined || noResultRunAgent !== undefined) room -= 1
      const shownRuns = newest.slice(0, room)
      const askedRun = newest.find(run => whyState?.id === `run-${run.id}` && !shownRuns.includes(run))
      const isAsked = (agent: AgentRow | WorkflowAgent) => whyState?.id === `agent-${agent.id}`
      const askedAgent = agentList.find(
        agent => isAsked(agent) && agent !== noResultAgent && !shownAgents.includes(agent),
      )
      const askedRunAgent = workflowAgents.find(
        agent => isAsked(agent) && agent !== noResultRunAgent && !liveRuns.some(({ shown }) => shown.includes(agent)),
      )
      const total =
        agentList.length + commandList.length + workflowRuns.reduce((sum, run) => sum + runCounts(run).total, 0)
      const shownCount =
        liveRuns.reduce((sum, { shown }) => sum + shown.length, 0) +
        shownAgents.length +
        (noResultAgent !== undefined || noResultRunAgent !== undefined ? 1 : 0) +
        shownRuns.length
      const hasMore = shownCount < total
      const header = (
        <Box flexDirection="row">
          <Box flexGrow={1}>{heading(total > 0 ? `Activity · ${total}` : 'Activity')}</Box>
          {(hasMore || showsAllActivity) && (
            <Button
              key="activity-toggle"
              plain
              label={showsAllActivity ? ' ▾ all' : ' ▸ all'}
              onPress={() => update($, isActivityOpen, value => !value)}
            />
          )}
        </Box>
      )
      if (total === 0) {
        return (
          <Box flexDirection="column">
            {header}
            {quiet('Nothing yet. Commands, skills and subagents show up here as Claude works; point at one for ? why.')}
          </Box>
        )
      }
      if (showsAllActivity) {
        return (
          <Box flexDirection="column">
            {header}
            {[...workflowRuns]
              .sort((a, b) => Number(b.agents.some(isRunning)) - Number(a.agents.some(isRunning)))
              .flatMap(run => [
                workflowRow(run),
                ...run.agents.filter(isRunning).map(workflowAgentRow),
                ...run.agents.filter(agent => !isRunning(agent)).map(workflowAgentRow),
              ])}
            {agentList.length > 0 && (
              <Text dimColor>Agents{activeAgents.length > 0 ? ` · ${activeAgents.length} running` : ''}</Text>
            )}
            {[...activeAgents, ...doneAgents].map(agentRow)}
            {commandList.length > 0 && <Text dimColor>Commands & skills · {commandList.length}</Text>}
            {newest.map(commandRow)}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          {header}
          {liveRuns.flatMap(({ run, shown }) => [workflowRow(run), ...shown.map(workflowAgentRow)])}
          {shownAgents.map(agentRow)}
          {askedAgent !== undefined && agentRow(askedAgent)}
          {askedRunAgent !== undefined && workflowAgentRow(askedRunAgent)}
          {shownRuns.map(commandRow)}
          {askedRun !== undefined && commandRow(askedRun)}
          {noResultAgent !== undefined && agentRow(noResultAgent)}
          {noResultRunAgent !== undefined && workflowAgentRow(noResultRunAgent)}
        </Box>
      )
    }

    // The plan while it runs; done, one line, gone 15 minutes after its last step (at once when
    // that time is unknown, as for a plan read back after a restart).
    const isDoneLongAgo = now - stepsAt > PLAN_DONE_MS
    const planSection = () => {
      if (currentPlan !== null && progress !== null) {
        const total = currentPlan.tasks.length
        const done = progress.done.filter(number => currentPlan.tasks.some(task => task.n === number)).length
        const title = currentPlan.title !== '' ? currentPlan.title : basename(currentPlan.path)
        if (done === total) {
          if (isDoneLongAgo) return null
          return (
            <Text dimColor wrap="truncate-end">
              <Text color="success">✓ </Text>
              Plan {done}/{total} · {title}
            </Text>
          )
        }
        return (
          <Box flexDirection="column">
            {heading(`Plan · ${done}/${total}`)}
            <Text weight="semibold" wrap="truncate-end">
              📋 {title}
            </Text>
            {currentPlan.tasks.map(task => {
              const isDone = progress.done.includes(task.n)
              const isCurrent = progress.current === task.n
              return (
                <Text wrap="truncate-end">
                  <Text color={isDone ? 'success' : isCurrent ? 'claude' : 'subtle'}>
                    {isDone ? '✓' : isCurrent ? '◐' : '○'}{' '}
                  </Text>
                  <Text dimColor={isDone}>
                    {task.n}. {task.name}
                  </Text>
                  {task.covers.length > 0 && <Text dimColor> {task.covers.join(' ')}</Text>}
                </Text>
              )
            })}
            {currentPlan.requirements.length > 0 && (
              <Text wrap="truncate-end">
                <Text dimColor>Requirements </Text>
                {currentPlan.requirements.map(id =>
                  progress.coveredRequirements.includes(id) ? (
                    <Text color="success">{id}✓ </Text>
                  ) : (
                    <Text dimColor>{id} </Text>
                  ),
                )}
              </Text>
            )}
            {!progress.hasMatchedTodos && quiet('Progress counts tasks named “Task N” in Claude’s task list.')}
          </Box>
        )
      }
      if (list.length === 0) return null
      const finished = list.filter(item => item.status === 'completed').length
      const open = list.length - finished
      if (finished === list.length) {
        if (isDoneLongAgo) return null
        return (
          <Text dimColor wrap="truncate-end">
            <Text color="success">✓ </Text>
            Steps {finished}/{list.length} · {list.at(-1)?.subject}
          </Text>
        )
      }
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            {heading(`Steps · ${finished}/${list.length}`)}
            {isDoneSaid && <Text color="warning"> ⚠ DONE announced, {plural(open, 'step')} open</Text>}
          </Text>
          {list.map(item => (
            <Text wrap="truncate-end">
              <Text color={item.status === 'completed' ? 'success' : item.status === 'in_progress' ? 'claude' : 'subtle'}>
                {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◐' : '○'}{' '}
              </Text>
              <Text dimColor={item.status === 'completed'}>{item.subject}</Text>
            </Text>
          ))}
        </Box>
      )
    }

    // The project map: folders, then the files Claude changed (✎ +) or only read (◦).
    const filesView = () => {
      if (fileList.length === 0) return quiet('No file yet. Files Claude reads, writes or edits show up here, by folder.')
      const folders = projectMap(fileList, info.cwd)
      const changed = fileList.filter(file => file.action !== 'read').length
      return (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate-end">
            <Text color="warning">✎</Text> changed · <Text color="success">+</Text> created · ◦ read
            {` · ${changed} changed, ${fileList.length - changed} read`}
          </Text>
          {folders.map(folder => (
            <Box key={`dir-${folder.dir}`} flexDirection="column">
              <Text color="suggestion" wrap="truncate-start">
                {folder.dir !== '' ? folder.dir : './'}
              </Text>
              {folder.files.map(file => {
                const isFlashing = file.action !== 'read' && now - file.at < FLASH_MS
                const verb = file.action === 'created' ? 'créé' : file.action === 'edited' ? 'modifié' : 'lu'
                return withWhy(
                  `file-${file.path}`,
                  file.name,
                  `tu as ${verb} le fichier ${folder.dir}${file.name}`,
                  <Text wrap="truncate-start">
                    {'  '}
                    {file.action === 'read' ? (
                      <Text dimColor>◦ </Text>
                    ) : (
                      <Text color={file.action === 'created' ? 'success' : 'warning'}>
                        {file.action === 'created' ? '+ ' : '✎ '}
                      </Text>
                    )}
                    {isFlashing ? (
                      <Text color={n % 2 === 0 ? 'claude' : 'warning'} weight="semibold">
                        ✦ {file.name}
                      </Text>
                    ) : (
                      <Text dimColor={file.action === 'read'}>{file.name}</Text>
                    )}
                    {file.action !== 'read' && file.count > 1 && <Text dimColor> ×{file.count}</Text>}
                  </Text>,
                  <Button key={`open-${file.path}`} plain label=" ↗" onPress={() => openFile($, file.path)} />,
                )
              })}
            </Box>
          ))}
          {fileList.length > folders.reduce((sum, folder) => sum + folder.files.length, 0) &&
            quiet(`Older reads left out: ${fileList.length} files in all.`)}
        </Box>
      )
    }

    // The ★ Insight points, newest first, and the way to Obsidian.
    const insightsView = () => {
      if (insightList.length === 0) {
        return quiet('No insight yet. The ★ Insight points Claude writes are kept here, and can go to a note (option notesDir).')
      }
      return (
        <Box flexDirection="column">
          {[...insightList]
            .reverse()
            .slice(0, SHOWN_INSIGHTS)
            .map(item => (
              <Box key={`insight-${item.id}`} flexDirection="column">
                <Text wrap="wrap">
                  <Text color={item.isExported ? 'subtle' : 'claude'}>★ </Text>
                  <Text weight="semibold">{item.title}</Text>
                  {item.dir !== '' && <Text dimColor> · {item.dir}</Text>}
                </Text>
                {item.body !== '' && (
                  <Text dimColor wrap="wrap">
                    {'  '}
                    {item.body.length > 180 ? item.body.slice(0, 179) + '…' : item.body}
                  </Text>
                )}
              </Box>
            ))}
          <Box flexDirection="row" gap={1}>
            {noteTarget.dir !== '' && (
              <Button
                key="insights-export"
                label={freshInsights > 0 ? `→ Note (${freshInsights} new)` : '✓ In the note'}
                onPress={() => exportInsights($)}
              />
            )}
            {noteTarget.dir !== '' && noteTarget.vault !== '' && <Button key="insights-note" label="↗ Obsidian" onPress={() => openNote($)} />}
          </Box>
          {insightList.length > SHOWN_INSIGHTS && quiet(`${insightList.length} kept · the note holds them all once sent.`)}
        </Box>
      )
    }

    // The words Claude explained in its replies, newest first, whatever the project.
    const wordsView = () => {
      if (wordList.length === 0) {
        return quiet('No word yet. The terms Claude explains in its replies are kept here, across projects.')
      }
      return (
        <Box flexDirection="column">
          {[...wordList]
            .reverse()
            .slice(0, SHOWN_WORDS)
            .map(item => (
              <Text key={`word-${item.term.toLowerCase()}`} wrap="wrap">
                <Text weight="semibold">{item.term}</Text>
                <Text dimColor> — {item.meaning}</Text>
              </Text>
            ))}
          {wordList.length > SHOWN_WORDS && quiet(`${wordList.length} kept · the ${SHOWN_WORDS} newest shown.`)}
        </Box>
      )
    }

    // Learn holds two lists behind a switch: a sixth tab would not fit the pane's width.
    const learnSwitch = (view: LearnPage, name: string, count: number) => {
      const label = count > 0 ? `${name} ${count}` : name
      const show = () => update($, learnPage, () => view)
      return view === page ? (
        <Button key={`learn-${view}`} plain onPress={show}>
          <Text color="claude" weight="semibold">
            {label}
          </Text>
        </Button>
      ) : (
        <Button key={`learn-${view}`} plain dimColor label={label} onPress={show} />
      )
    }
    const learnView = () => (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          {learnSwitch('insights', 'Insights', insightList.length)}
          {learnSwitch('words', 'Words', wordList.length)}
        </Box>
        {page === 'words' ? wordsView() : insightsView()}
      </Box>
    )

    // Pinned replies, newest first: a press unfolds one, to read, reuse, copy or unpin.
    const pinsView = () => {
      const pinButton = (
        <Button key="pin-last" label="📌 Pin last reply" onPress={() => void pinReply($, '').then(text => $.ui.toast(text))} />
      )
      if (pinList.length === 0) {
        return (
          <Box flexDirection="column">
            {quiet('Nothing pinned yet. /pin keeps Claude’s last reply here, across sessions; select a passage first to pin just that.')}
            {pinButton}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          {[...pinList]
            .reverse()
            .slice(0, SHOWN_PINS)
            .map(item => {
              const isOpen = item.id === unfolded
              return (
                <Box key={`pin-${item.id}`} flexDirection="column">
                  <Box flexDirection="row">
                    <Button key={`pin-remove-${item.id}`} plain label="✕ " onPress={() => unpin($, item.id, item.title)} />
                    <Button
                      key={`pin-open-${item.id}`}
                      plain
                      label={`${isOpen ? '▾' : '▸'} ${item.isExcerpt ? '❝ ' : ''}${item.title}`}
                      onPress={() => update($, openPin, value => (value === item.id ? null : item.id))}
                    />
                    <Text dimColor wrap="truncate-end">
                      {' · '}
                      {item.dir !== '' ? `${item.dir} · ` : ''}
                      {day(item.at)}
                    </Text>
                  </Box>
                  {isOpen && (
                    <Box flexDirection="column" paddingLeft={2}>
                      <Markdown text={item.text} />
                      <Box flexDirection="row" gap={1}>
                        <Button
                          key={`pin-reuse-${item.id}`}
                          label="Reuse"
                          onPress={() => fillPrompt($, { id: 'pin', label: 'Reuse', prompt: reusePrompt(item, day(item.at)) })}
                        />
                        <Button
                          key={`pin-copy-${item.id}`}
                          label="Copy"
                          onPress={press =>
                            void $.ui
                              .copy({ text: item.text, surface: press.surface })
                              .then(copied => $.ui.toast(copied.isCopied ? 'Copied' : 'Couldn’t copy'))
                          }
                        />
                      </Box>
                    </Box>
                  )}
                </Box>
              )
            })}
          {pinButton}
          {pinList.length > SHOWN_PINS && quiet(`${plural(pinList.length, 'pin')} kept · the ${SHOWN_PINS} newest shown.`)}
        </Box>
      )
    }

    // The project's notepad: it simply stays, kept out of sight, handed to Claude on request.
    const notesView = () => (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          {notepad.dir !== '' ? basename(notepad.dir) : 'This folder'}
        </Text>
        {notepad.dir === '' ? (
          quiet('Loading the notes…')
        ) : Input === null ? (
          <Markdown text={notepad.text !== '' ? notepad.text : '_No notes yet._'} />
        ) : (
          <Input
            key="notes-text"
            rows={Math.max(3, tabHeight - 2)}
            value={draft !== null && draft.dir === notepad.dir ? draft.text : notepad.text}
            placeholder="Your notes for this project…"
            submitLabel="new line"
            onInput={value => void typeNotes($, value)}
            // The field empties itself on Enter, as a message box does: the notes are drawn
            // back at once with the new line Enter means here.
            onSubmit={value => void typeNotes($, `${value}\n`).then(() => saveNotes($))}
          />
        )}
        <Box flexDirection="row" gap={1}>
          <Button
            key="notes-send"
            label="→ Claude"
            onPress={() =>
              notepad.text.trim() === ''
                ? $.ui.toast('The notes are empty')
                : fillPrompt($, { id: 'notes', label: 'Notes', prompt: `Voici mes notes sur ce projet :\n\n${notepad.text.trim()}\n\n` })
            }
          />
          <Button key="notes-copy" label="Copy" onPress={press => void $.ui.copy({ text: notepad.text, surface: press.surface })} />
          <Button key="notes-clear" label="Clear" onPress={() => clearNotes($)} />
          {notepad.previous !== undefined && (
            <Button key="notes-restore" label="↶ Restore" onPress={() => restoreNotes($)} />
          )}
        </Box>
      </Box>
    )

    // The Git tab, read-only: rows laid out for the pane, and nothing that acts on the repository.
    const gitReload = (
      <Button key="git-reload" plain label={gitState.isReading ? ' …' : ' ↻'} onPress={() => refreshGitTab($).catch(() => undefined)} />
    )
    const gitMessage = (text: string) => (
      <Box flexDirection="row">
        <Box flexGrow={1}>{quiet(text)}</Box>
        {gitReload}
      </Box>
    )
    const gitSpans = (spans: readonly GitSpan[]) =>
      spans.map((part, index) => (
        <Text
          key={String(index)}
          color={GIT_COLORS[part.tone]}
          dimColor={part.tone === 'dim'}
          weight={part.tone === 'strong' ? 'semibold' : undefined}
        >
          {part.text}
        </Text>
      ))
    const isGraphOpen = gitState.view.status === 'ready' && isGraphShown(graphChoice, gitState.view.facts)
    const gitTabRow = (line: GitLine) => {
      if (line.action !== undefined) {
        const action = line.action
        return (
          <Button
            key={line.key}
            plain
            dimColor
            label={line.spans.map(part => part.text).join('')}
            onPress={() =>
              action === 'graph'
                ? update($, gitGraphChoice, () => !isGraphOpen)
                : update($, isGitUnfolded, value => !value)
            }
          />
        )
      }
      return (
        <Box key={line.key} flexDirection="row">
          <Box flexGrow={1}>
            <Text wrap="truncate-end">{gitSpans(line.spans)}</Text>
          </Box>
          {line.key === 'git-header' && gitReload}
          {line.right !== undefined && <Text> {gitSpans(line.right)}</Text>}
        </Box>
      )
    }
    const gitView = (lines: readonly GitLine[]) => {
      const view = gitState.view
      if (view.status === 'outside') return gitMessage('Not a git repository.')
      if (view.status === 'failed') return gitMessage(`Couldn’t read git: ${view.message}`)
      if (view.status !== 'ready') return gitMessage('Reading git…')
      return <Box flexDirection="column">{lines.map(gitTabRow)}</Box>
    }

    // What fills the context, biggest first, in the details; skills Claude cannot see, in
    // yellow, folded or not: a warning is never put away.
    const breakdownRow = () => {
      if (contextFill === null) return null
      const hasShares = showsDetails && contextFill.shares.length > 0
      const isCut = contextFill.skillsCut > 0
      if (!hasShares && !isCut) return null
      return (
        <Text wrap="truncate-end">
          <Text dimColor>{'         '}</Text>
          {isCut && <Text color="warning">⚠ {plural(contextFill.skillsCut, 'skill')} unseen</Text>}
          {isCut && hasShares && <Text dimColor> · </Text>}
          {hasShares && (
            <Text dimColor>
              {contextFill.shares
                .slice(0, 5)
                .map(share => `${share.label} ${kilo(share.tokens)}`)
                .join(' · ')}
            </Text>
          )}
        </Text>
      )
    }

    // What the session would cost at the API's prices: with a Pro or Max plan, not a bill.
    const costRow = () => (
      <Text wrap="truncate-end">
        <Text dimColor>{'API cost '}</Text>
        {perTurn.length > 0 && <Text color="suggestion">{dots(perTurn, 12)} </Text>}
        <Text>{figures.costUsd !== null ? dollars(figures.costUsd) : '—'}</Text>
        {lastTurnCost !== null && <Text dimColor> · last turn {dollars(lastTurnCost)}</Text>}
      </Text>
    )

    // All that stands above the tabs: what it takes is what the Git tab must do without.
    const aboveTabs = (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row">
          <Box flexGrow={1}>{liveRow()}</Box>
          <Button key="details-toggle" plain label={detailsLabel} onPress={() => toggleDetails($)} />
        </Box>
        {sessionsBlock}
        {sessionsBlock !== null && rule()}
        {ctx !== null && ctxUsed !== null ? (
          gauge('ctx', 'Context  ', ctxUsed, contextTone(ctxUsed), compactNote())
        ) : (
          <Text dimColor>Context  after the first reply</Text>
        )}
        {showsDetails && ctx !== null && (
          <Text dimColor wrap="truncate-end">
            {'         '}
            {dots(ctxSeries, 6, 100)}
            {figures.ctxTokens !== null && ctxLimit !== null ? ` ${kilo(figures.ctxTokens)}/${kilo(ctxLimit)} tokens` : ''}
          </Text>
        )}
        {breakdownRow()}
        {fiveHour !== null &&
          gauge(
            'fiveHour',
            '5 hours  ',
            fiveHour,
            usageTone(fiveHour),
            resetNote(figures.fiveHourResetsAt),
            elapsedMark(figures.fiveHourResetsAt, FIVE_HOURS_MS),
          )}
        {sevenDay !== null &&
          gauge(
            'sevenDay',
            '7 days   ',
            sevenDay,
            usageTone(sevenDay),
            resetNote(figures.sevenDayResetsAt),
            elapsedMark(figures.sevenDayResetsAt, SEVEN_DAYS_MS),
          )}
        {showsDetails && costRow()}
        {gitRow()}
        {proofRow()}
        {prRow()}
        {deployRow()}
        {serversView()}

        <Box flexDirection="row" gap={1}>
          {info.branch !== null && <Button key="action-diff" label="Diff" onPress={() => showDiff($)} />}
          <Button key="action-compact" label="Compact" onPress={() => compactNow($)} />
          <Button key="action-folder" label="Folder" onPress={() => openFolder($)} />
          {editor !== null && (
            <Button key="action-editor" label={basename(editor).replace('.app', '')} onPress={() => openProject($)} />
          )}
          <Button key="action-fork" label="Fork" onPress={() => forkSession($)} />
        </Box>

        {rule()}
        {planSection()}
        {activity()}

        {rule()}
      </Box>
    )
    // The Git tab fits the rows left on screen, the grip included, so that what it says it cut
    // stays in view; unfolded, it takes what it needs and the pane scrolls. The rows of a tab
    // that is not shown are not worked out.
    const gitRoom =
      shownTabId === 'git'
        ? Math.min(tabHeight, Math.max(MIN_TAB_ROWS, e.props.scroll.bodyRows - treeRows(aboveTabs, width) - TABS_AND_GRIP_ROWS))
        : tabHeight
    const gitRows =
      shownTabId === 'git' && gitState.view.status === 'ready'
        ? gitLayout(gitState.view.facts, { width, rows: gitRoom, now, isGraphOpen, isUnfolded: isGitOpen })
        : []
    const tabLabels = fitTabLabels(
      TABS.map(item => ({
        ...item,
        badge: counts[item.id],
        // Measured with its flash, so that the flash coming and going does not move the row.
        ...(item.id === 'files' && fileList.length > 0 ? { widest: `${fileList.length} ✦` } : {}),
      })),
      width,
    )

    const tree = (
      <Box flexDirection="column" width={width}>
        {aboveTabs}
        <Box flexDirection="row" gap={1}>
          {TABS.map((item, index) => (
            <Button
              key={`tab-${item.id}`}
              label={tabLabels[index] ?? item.label}
              variant={item.id === shownTabId ? 'primary' : 'secondary'}
              onPress={async () => {
                await update($, tab, () => item.id)
                if (item.id === 'git') void refreshGitTab($).catch(() => undefined)
              }}
            />
          ))}
        </Box>
        <Box
          flexDirection="column"
          height={shownTabId !== 'git' ? tabHeight : isGitOpen ? Math.max(gitRoom, gitRows.length) : gitRoom}
          overflow="hidden"
        >
          {shownTabId === 'files' && filesView()}
          {shownTabId === 'git' && gitView(gitRows)}
          {shownTabId === 'learn' && learnView()}
          {shownTabId === 'pins' && pinsView()}
          {shownTabId === 'notes' && notesView()}
        </Box>

        {Client !== null ? (
          <Client key="tabs-handle" module="./handle.tsx" props={{ rows: tabHeight }} width={width} height={1} />
        ) : (
          rule()
        )}
      </Box>
    )
    // A meter still gliding asks for a few more frames.
    if (isMoving) void animate($, FRAME_MS * 3)
    return tree
  })
}
