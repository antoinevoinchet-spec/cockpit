export type LastCommit = { subject: string; at: number }

export type Header = {
  cwd: string
  dir: string
  branch: string | null
  isDirty: boolean
  // Files with changes not yet committed, commits not yet pushed (null: no upstream)
  changed: number
  ahead: number | null
  lastCommit: LastCommit | null
  model: string | null
  effort: string | null
  mode: string | null
}

export type Usage = {
  ctxTokens: number | null
  ctxWindow: number | null
  ctxPercent: number | null
  fiveHourPercent: number | null
  fiveHourResetsAt: string | null
  sevenDayPercent: number | null
  sevenDayResetsAt: string | null
  costUsd: number | null
  startedAt: number | null
}

// A file Claude created, edited or only read: the project map. `count` counts touches of
// that kind; a read never flashes nor takes the place of a change.
export type FileTouch = { path: string; action: 'created' | 'edited' | 'read'; count: number; at: number }

export type CommandRun = {
  id: string
  label: string
  command: string
  isSensitive: boolean
  isFromAgent: boolean
  // The agent's loop it ran in: its row gives the name drawn before the command.
  agentId?: string
  status: 'running' | 'ok' | 'error' | 'refused'
  at: number
  // A shell command (or a sensitive tool), or a skill Claude invoked; absent: a command.
  kind?: 'command' | 'skill'
}

// `status` is the engine's, or `unknown`: gone from its list with no proof of how it ended, seen
// at `endedAt`. `endedAs`: how its own last turn ended, which proves it if it leaves the list
// still shown as running or idle.
export type AgentRow = {
  id: string
  description: string
  type: string
  status: string
  endedAt?: number
  endedAs?: 'completed' | 'failed' | 'killed'
}

// A workflow script's agent, followed from its spawn to the end of its turn. `index`: its place
// among the run's agent() calls. `unknown`: its end was never heard.
export type WorkflowAgent = {
  id: string
  index: number
  description: string
  type: string
  model: string | null
  status: 'running' | 'completed' | 'failed' | 'killed' | 'unknown'
  startedAt: number
  endedAt?: number
}

// A workflow run, by its `wf_…` id. `name`: its script's meta.name, once the Workflow call has
// answered. `dropped`: finished agents past the bound, gone from `agents` and still counted.
export type WorkflowRun = { runId: string; name: string | null; agents: WorkflowAgent[]; dropped: number }

export type TodoItem = { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed' }

export type PlanTask = { n: number; name: string; covers: string[] }

export type Plan = { path: string; title: string; tasks: PlanTask[]; requirements: string[] }

// `startCost`: the session's API-priced cost when the turn began, for what the turn cost.
export type Turn = { isRunning: boolean; tools: number; startedAt: number; startCost?: number }

// The figures after one turn of the main conversation, for the pane's sparklines.
export type Snapshot = { ctx: number | null; fiveHour: number | null; cost: number | null; at: number }

export type Tab = 'files' | 'git' | 'learn' | 'pins' | 'notes'

// The last run of each kind of check Claude ran, and how it ended. `isOk`: exit code 0.
// `isMasked`: that code is not the check's own (`pnpm test | tail`), so it says nothing.
export type CheckKind = 'tests' | 'build' | 'types' | 'lint' | 'bench' | 'browser'
export type Check = { kind: CheckKind; isOk: boolean; at: number; isMasked?: boolean }

// The branch's pull request on GitHub and its CI checks, folded into one state.
export type PrStatus = {
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  checks: 'passing' | 'failing' | 'pending' | 'none'
  url: string
}

// The folder's latest Vercel deployment.
export type DeployStatus = {
  state: 'READY' | 'BUILDING' | 'QUEUED' | 'INITIALIZING' | 'ERROR' | 'CANCELED'
  target: 'production' | 'preview'
  at: number
  url: string
}

export type Remote = { pr: PrStatus | null; deploy: DeployStatus | null }

// One point of a ★ Insight block, kept for the Learn tab and the exported note.
export type Insight = { id: string; title: string; body: string; dir: string; at: number; isExported: boolean }

// A word Claude explained in a reply (`{term|word|meaning}`), kept for the lexicon.
export type Word = { term: string; meaning: string; dir: string; at: number }

// The Learn tab's two lists.
export type LearnPage = 'insights' | 'words'

// What Claude's last answer leaves to you, shown above the prompt until you answer: a choice to
// make (`decide`, also when absent, as in a band kept across a reload) or a blocker to lift.
export type Decision = { text: string; at: number; kind?: 'decide' | 'blocked' }

// What Claude waits for you on now: a permission, a question or an MCP form. `callId`: the tool
// call behind it, whose result ends the wait; none when no open call was found for it.
export type Waiting = { id: string; kind: 'permission' | 'question' | 'form'; detail: string; since: number; callId?: string }

// When a reply of Claude's was written, by its row's id in the transcript.
export type ReplyTime = { id: string; at: number }

// A reply of Claude's (or a passage of one, `isExcerpt`) pinned to come back to later.
export type Pin = { id: string; title: string; text: string; dir: string; at: number; sessionId: string; isExcerpt: boolean }

// The notepad of the session's project folder, when it was last kept, and the longer text
// a clear or a big cut replaced (`previous`), for Restore.
export type Notes = { dir: string; text: string; savedAt: number | null; previous?: string }

// What fills the context, as /context counts it: the biggest shares, and how many skills
// the listing Claude reads leaves out for lack of room.
export type ContextShare = { label: string; tokens: number }
export type Breakdown = { shares: ContextShare[]; skillsCut: number }

// Claude's answer to "why?" about one action, asked on a fork of the conversation.
// `label` is what the pane shows; `subject`, how the question names the action to Claude.
export type Why = { id: string; label: string; subject: string; status: 'asking' | 'answered' | 'failed'; text: string }

// A button that writes a ready prompt into the prompt box.
export type QuickAction = { id: string; label: string; prompt: string }

// A local server listening on a dev port, and the folder it was started from.
export type DevServer = { port: number; pid: number; name: string; dir: string }

// How the session's folder starts its dev server, when it has one.
export type Project = { manager: 'pnpm' | 'npm' | 'yarn' | 'bun'; script: string } | null

// The Git tab, read from the repository the session started in, never written to.
export type GitCommit = {
  hash: string
  at: number
  // The local branches that point at it, the active one first.
  labels: string[]
  subject: string
  // From the Co-Authored-By and Claude-Session trailers: null when the commit has none.
  model: string | null
  session: string | null
  isHead: boolean
}
// A row of `git log --graph`: the drawing, and the commit it leads to (null: strokes only).
export type GitGraphRow = { drawing: string; commit: GitCommit | null }
// `ahead` and `behind` against the main branch, null when git could not count them.
export type GitBranch = {
  name: string
  at: number
  subject: string
  model: string | null
  session: string | null
  ahead: number | null
  behind: number | null
  isCurrent: boolean
}
export type GitWorktree = { path: string; branch: string }
export type GitFacts = {
  repo: string
  // null: a detached HEAD.
  branch: string | null
  // null: no commit yet.
  headHash: string | null
  // The main branch, null when there is neither main nor master.
  base: string | null
  uncommitted: number
  isUncommittedCut: boolean
  toMerge: number
  open: GitBranch[]
  merged: GitBranch[]
  isRefListCut: boolean
  worktrees: GitWorktree[]
  graph: GitGraphRow[]
  totalCommits: number
  isStraight: boolean
}
export type GitTabView =
  | { status: 'unread' }
  | { status: 'reading' }
  | { status: 'outside' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; facts: GitFacts }
export type GitTab = { view: GitTabView; isReading: boolean }

// Another session open on this machine, as `claude agents --json` lists it. `id` is the
// short id of a background session; `status` and `pid` exist while its process lives.
export type ListedSession = {
  sessionId: string | null
  id: string | null
  pid: number | null
  name: string
  kind: 'interactive' | 'background'
  status: 'busy' | 'waiting' | 'idle' | null
  state: 'working' | 'blocked' | 'done' | 'failed' | 'stopped' | null
  waitingFor: string | null
  startedAt: number
}

// What a Cockpit publishes under its own key of the shared store when its turn ends on a
// `{decide|…}` or `{blocked|…}` verdict: the words, when, and how to find its session in the list.
export type SessionVerdict = { kind: 'decide' | 'blocked'; words: string; at: number; sessionId: string; pid: number | null }

// The last good read of the list, the verdicts read with it, and which session is this one.
export type SessionList = {
  sessions: ListedSession[]
  verdicts: SessionVerdict[]
  own: { sessionId: string | null; pid: number | null }
  readAt: number | null
}

// What each other session is doing and since when, by session. `since`: when this Cockpit saw
// that begin, null when it was already so at its first look.
export type SessionPhases = Record<string, { phase: string; since: number | null }>

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      header: Header
      usage: Usage
      files: FileTouch[]
      commands: CommandRun[]
      agents: AgentRow[]
      workflows: WorkflowRun[]
      todos: TodoItem[]
      plan: Plan | null
      turn: Turn
      isBandHidden: boolean
      tick: number
      history: Snapshot[]
      tab: Tab
      frame: number
      servers: DevServer[]
      project: Project
      checks: Check[]
      // When each code edit that no check has passed since landed.
      codeEdits: number[]
      isDoneAnnounced: boolean
      remote: Remote
      compactAt: number | null
      insights: Insight[]
      breakdown: Breakdown | null
      why: Why | null
      pins: Pin[]
      openPin: string | null
      notes: Notes
      tabRows: number
      isDetailed: boolean
      isActivityOpen: boolean
      todosAt: number
      words: Word[]
      learnPage: LearnPage
      decision: Decision | null
      waits: Waiting[]
      // One per reply of Claude's, by its row's id: only that reply redraws when it is set.
      replyAt: StateFamily<number | null>
      replyTimes: ReplyTime[]
      gitTab: GitTab
      // Your choice on the Git tab's graph, null until you make one.
      gitGraphChoice: boolean | null
      isGitUnfolded: boolean
      // The other sessions: the last good read, since when each is as it is, and the
      // Sessions section's folds (rows shown at rest, "+N more", "N old").
      sessions: SessionList
      sessionPhases: SessionPhases
      isSessionsOpen: boolean
      areSessionsMore: boolean
      areOldOpen: boolean
    }
  }
}
