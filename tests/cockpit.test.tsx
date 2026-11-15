import type { On } from 'claude-code'
import type { SessionVerdict } from '../types'
import { expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'

import {
  type MeterRun,
  ago,
  announcedTurns,
  bar,
  clip,
  clock,
  dots,
  elapsed,
  meter,
  modelFamily,
  paceTone,
  prettyModel,
  projectAtReset,
  resetIn,
  settledWindow,
  spark,
  stopwatch,
  turnsLeft,
  windowElapsed,
} from '../hooks/format'
import { FOCUS_SCRIPT, FOCUS_TITLE_SCRIPT, HAS_TITLE_SCRIPT, ghosttyHost, ghosttyHostOf } from '../hooks/ghostty'
import {
  type GitCommand,
  type GitLine,
  GIT_READ_OPTIONS,
  cells,
  dayMonth,
  fit,
  fitTabLabels,
  gitLayout,
  isGraphShown,
  lineText,
  parseAheadBehind,
  parseGraph,
  parseWorktrees,
  readGitTab,
  readModel,
  readSession,
  shortAge,
  treeRows,
} from '../hooks/gitgraph'
import { approvalLabel, describeTool, isSensitiveCommand } from '../hooks/labels'
import { parsePlan, planProgress } from '../hooks/plan'
import { belongsTo, describe, describeAll, fitLines, headerText, layOut, parseSessions, updatePhases } from '../hooks/sessions'
import { parseFolders, parseListeners, readProject, startCommand, withFolders } from '../hooks/servers'
import { checkKinds, checkRuns, isBrowserCheck, isCodePath, parseDeploy, parsePr, touchesRemote } from '../hooks/status'
import { addPin, makePin, pinRequest, pinTitle, recentReplies } from '../hooks/pins'
import { colorBlocks, hasMarks, isColorful, lineRuns, marksPrompt, readVerdict, stripMarks, termsIn } from '../hooks/colors'
import {
  appendToNote,
  contextShares,
  noteSection,
  parseInsights,
  pendingBlocker,
  pendingDecision,
  projectMap,
  questionedCall,
  sessionVerdict,
  touch,
} from '../hooks/understand'
import { addRunAgent, agentEnd, endRunAgent, nameRun, runCounts, runLabel } from '../hooks/workflows'
import type { WorkflowAgent } from '../types'

// The tests run under Bun, but the type check sees no runtime globals.
declare function setTimeout(callback: () => void, ms: number): unknown
// Lets work the mod started in the background finish before the assertions.
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 50))

const PLAN_FILE = '/project/docs/superpowers/plans/2026-10-22-cockpit.md'
const PLAN_TEXT = [
  '# Cockpit — Implementation Plan',
  '',
  '```bash',
  '# 1. A code comment, not a heading',
  '```',
  '',
  '### Task 1: Read the session',
  '**Couvre:** D1, D2',
  '- [ ] **Step 1: test**',
  '',
  '### Task 2: Draw the pane',
  '**Couvre:** D2',
  '',
  '## Task 3: Notify',
  '**Couvre :** D3',
].join('\n')

const RUN_ID = 'wf_78595e9c-84f'
const SCROLL = { offset: 0, bodyRows: 40 }
const PANE = {
  plugin: 'cockpit',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'cockpit',
  props: { title: 'Cockpit', isFocused: false, bodyColumns: 52, placement: 'dock', scroll: SCROLL, view: {} },
} as const

// What /context counts, in the summary the mod asks for at each turn's end.
const BREAKDOWN = {
  categories: [
    { name: 'Messages', tokens: 60_000, color: 'x', isDeferred: false, kind: 'used' },
    { name: 'System tools', tokens: 15_000, color: 'x', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 100_000, color: 'x', isDeferred: false, kind: 'free' },
  ],
  skills: { totalSkills: 90, includedSkills: 80, tokens: 6_000, skillFrontmatter: [] },
}

// The breakdown with the window it measures against: the one the engine settled, or the
// model's own (`auto`) when nothing set one.
const settled = (compactWindow: number | null, modelWindow = 200_000) => ({
  ...BREAKDOWN,
  rawMaxTokens: compactWindow ?? modelWindow,
  autocompactSource: compactWindow !== null ? 'settings' : 'auto',
  isAutoCompactEnabled: true,
})

// A session on a 1M model whose context each test moves: unset, the engine's fixed figures.
// `breakdown` is what `$.session.usage({ breakdown })` answers: the window, none, or a refusal.
const live = {
  tokens: null as number | null,
  breakdown: null as ReturnType<typeof settled> | 'absent' | 'refused' | null,
}

// What `gh pr view` and `vercel list` answer, in the shape the real tools print.
const PR_JSON = JSON.stringify({
  number: 91,
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/me/site/pull/91',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'pytest', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'Vercel', state: 'SUCCESS' },
  ],
})
const DEPLOY_JSON = JSON.stringify({
  deployments: [{ state: 'READY', target: 'production', url: 'site-abc.vercel.app', createdAt: 1 }],
})

// What the mod wrote to disk and into the prompt box, and what it asked Claude, by test.
const written = new Map<string, string>()
const filled: string[] = []
const asked: string[] = []
// What lsof prints: the listening ports, then their folders. Empty in each new engine.
const lsof = { listening: '', folders: '' }
// The other sessions as the fake engine answers for them: what `claude agents --json` prints
// (or that it fails, or never answers), the process this session runs in, the process tree
// `ps` prints, and how `claude stop` and `osascript` end. Reset in each new engine.
const NOW = Date.parse('2026-10-22T10:00:00Z')
const fx = {
  agents: '[]',
  agentsExit: 0,
  agentsFails: false,
  ownPid: 4242,
  tree: null as string | null,
  stopExit: 0,
  rmExit: 0,
  rmStdout: '',
  rmStderr: '',
  osascriptExit: 0,
  titleExit: 1,
  titleGate: null as Promise<void> | null,
  osascriptFails: false,
  psOut: 'ttys004\n',
  isPaneShown: true,
}
// One row of `claude agents --json`, the fields the mod reads.
const sessionRow = (fields: Record<string, unknown>) => ({
  cwd: '/home/me/site',
  kind: 'interactive',
  startedAt: NOW - 3_600_000,
  id: null,
  state: null,
  pid: 5001,
  status: 'idle',
  sessionId: 's-1',
  name: 'site',
  ...fields,
})
// What the mod published for a session, as a Cockpit writes it.
const published = (fields: Partial<SessionVerdict>): SessionVerdict => ({
  kind: 'decide',
  words: 'Choisir A ou B',
  at: NOW - 14 * 60_000,
  sessionId: 's-1',
  pid: 5001,
  ...fields,
})
const GHOSTTY_TREE = [
  '500',
  '  500   400 ps',
  '  400   300 claude',
  '  300   200 -/bin/zsh',
  '  200   100 /usr/bin/login',
  '  100     1 /Applications/Ghostty.app/Contents/MacOS/ghostty',
  ' 5001   300 claude',
].join('\n')
// What the session has cost so far, at the API's prices: a test moves it to cost a turn.
const spend = { usd: 3.42 }
// What a settings hook answers a permission question, nothing in each new engine.
type PermissionAnswer = { decision?: { behavior: 'allow' } | { behavior: 'deny'; message: string } }
const beneath: { permission: PermissionAnswer } = { permission: {} }
// A tool left open, as a call is behind a dialog, until the test answers it (heldCalls).
type CallAnswer = { result: unknown; isError?: true } | { deny: string } | Error
const held: { tool: string; answer: Promise<CallAnswer> | null; callId: string } = { tool: '', answer: null, callId: '' }
// The project's package.json, with a pnpm lockfile beside it; none in each new engine.
const pkg: { json: string | null } = { json: null }
// What the engine's agent list answers: a test moves it to start or drop an agent. Empty in each new engine.
const listed: { agents: { id: string; description: string; type: string; status: string; name?: string }[] } = { agents: [] }

// What git answers the Git tab: a fake repository, none until a test sets one.
const gitTabAnswers: { run: GitCommand | null } = { run: null }
// A shell command with "slow" in it runs until this settles; one with "refused" is refused.
const shellGate: { until: Promise<void> } = { until: Promise.resolve() }

// What sits beneath the mod in a session: every call on `$` gets an answer, and the
// clock is returned to move it on. Each command the mod runs is recorded in `ran`.
// `compactWindow` is the auto-compact window the engine settled, none when null.
function engine(
  on: On,
  isRepo = true,
  ran: string[] = [],
  percentUsed = 18,
  startedAt = 0,
  compactWindow: number | null = null,
): MockClock {
  const clock = mock.clock(on, { now: Date.parse('2026-10-22T10:00:00Z') })
  lsof.listening = ''
  lsof.folders = ''
  spend.usd = 3.42
  pkg.json = null
  gitTabAnswers.run = null
  beneath.permission = {}
  held.tool = ''
  held.answer = null
  listed.agents = []
  Object.assign(fx, {
    agents: '[]',
    agentsExit: 0,
    agentsFails: false,
    ownPid: 4242,
    tree: null,
    stopExit: 0,
    rmExit: 0,
    rmStdout: '',
    rmStderr: '',
    osascriptExit: 0,
    titleExit: 1,
    titleGate: null,
    osascriptFails: false,
    psOut: 'ttys004\n',
    isPaneShown: true,
  })
  // What the mod passes on, the engine draws: a spinner shows its word and suffix.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.component === 'Spinner' ? `${e.props.word}${e.props.suffix}` : 'engine'}</Text>
  })
  on('command.register', () => ({ value: { command: 'cockpit' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  live.tokens = null
  on('session.usage', (_, e) => {
    const detail = live.tokens !== null ? live.breakdown : settled(compactWindow)
    if (e?.breakdown !== undefined && detail === 'refused') throw new Error('no session bound')
    return {
      value: {
        startedAt,
        context: {
          tokens: live.tokens ?? 84_000,
          window: live.tokens !== null ? 1_000_000 : 200_000,
          percent: live.tokens !== null ? Math.round(live.tokens / 10_000) : 42,
          ...(e?.breakdown !== undefined && detail !== 'absent' ? { breakdown: detail as never } : {}),
        },
        rateLimits: [
          { kind: 'five_hour', percentUsed, resetsAt: '2099-01-01T00:00:00Z' },
          { kind: 'seven_day', percentUsed: 24, resetsAt: '2099-01-05T00:00:00Z' },
        ],
        cost: { usd: spend.usd },
      },
    }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('settings.read', () => ({ value: { effortLevel: 'high' } }))
  on('ui.panes', () => ({
    value: [{ id: 'cockpit', title: 'Cockpit', isShown: fx.isPaneShown, isFocused: false, isPlaced: true }],
  }))
  on('process.run', (_, e) => {
    ran.push(JSON.stringify(e))
    const tool = e.argv[0]
    const done = (stdout: string, exitCode = 0, stderr = '') => ({
      value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (tool === 'git' && e.argv[1] === GIT_READ_OPTIONS[0] && gitTabAnswers.run !== null) {
      return gitTabAnswers
        .run(e.argv.slice(1 + GIT_READ_OPTIONS.length))
        .then(answer => ({ value: { isStdoutTruncated: false, isStderrTruncated: false, ...answer } }))
    }
    if (tool === 'claude' && e.argv[1] === 'agents') {
      if (fx.agentsFails) throw new Error('timed out')
      return done(fx.agents, fx.agentsExit)
    }
    if (tool === 'claude' && e.argv[1] === 'stop') return done('', fx.stopExit)
    if (tool === 'claude' && e.argv[1] === 'rm') return done(fx.rmStdout, fx.rmExit, fx.rmStderr)
    if (tool === 'sh' && e.argv[2] === 'echo $PPID') return done(`${fx.ownPid}\n`)
    if (tool === 'sh' && fx.tree !== null && String(e.argv[2]).startsWith('echo $$')) return done(fx.tree)
    if (tool === 'ps' && e.argv[1] === '-o') return done(fx.psOut)
    if (tool === 'osascript' && fx.osascriptFails) throw new Error('timed out')
    if (tool === 'osascript' && (e.argv.includes(FOCUS_TITLE_SCRIPT) || e.argv.includes(HAS_TITLE_SCRIPT))) {
      const answer = done('', fx.titleExit)
      return fx.titleGate === null ? answer : fx.titleGate.then(() => answer)
    }
    if (tool === 'osascript' && fx.osascriptExit !== 0) return done('', fx.osascriptExit)
    if (tool === 'lsof') {
      const stdout = e.argv.includes('-iTCP') ? lsof.listening : lsof.folders
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (isRepo && (tool === 'gh' || tool === 'vercel')) {
      const stdout = tool === 'gh' ? PR_JSON : DEPLOY_JSON
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return {
    value: isRepo
      ? { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      : { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('agent.list', () => ({ value: listed.agents as never }))
  // The engine starts each agent: its id comes from its description here. A remote agent has no id.
  on('agent.spawn', (_, e) =>
    e.description === 'refused'
      ? { deny: 'no' }
      : e.description === 'remote'
        ? { model: 'claude-opus-5-5' }
        : { model: 'claude-opus-5-5', agentId: `agent-${e.description}` },
  )
  on('model.fork', (_, e) => {
    asked.push(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: 'Pour vérifier que le nettoyage ne casse rien.',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({
    value: e.path.endsWith('/.vercel/project.json') || (pkg.json !== null && /\/(package\.json|pnpm-lock\.yaml)$/.test(e.path)),
  }))
  on('fs.read', (_, e) => ({ value: pkg.json !== null && e.path.endsWith('/package.json') ? pkg.json : PLAN_TEXT }))
  on('classic.PermissionRequest', () => beneath.permission)
  on('classic.Elicitation', () => ({}))
  on('classic.ElicitationResult', () => ({}))
  on('classic.Notification', () => ({}))
  shellGate.until = Promise.resolve()
  on('tool.call', async (_, e) => {
    if (held.answer !== null && String(e.tool) === held.tool) {
      held.callId = e.tool_use_id
      const answer = await held.answer
      if (answer instanceof Error) throw answer
      return answer as never
    }
    if (e.tool === 'Bash' && String(e.command).includes('slow')) await shellGate.until
    return e.tool === 'TaskCreate'
      ? { result: { task: { id: '1', subject: String(e.subject) } } }
      : e.tool === 'Bash' && String(e.command).includes('refused')
        ? { deny: 'refused' }
        : e.tool === 'Bash' && String(e.command).includes('build')
          ? { result: {}, isError: true }
          : e.tool === 'Workflow'
            ? e.script === 'broken'
              ? { result: 'Syntax error', isError: true }
              : e.script === 'odd'
                ? { result: 'Workflow launched in background.' }
                : { result: { status: 'async_launched', taskId: 'w1', workflowName: 'audit-supervision', runId: RUN_ID } }
            : { result: {} }
  })
  return clock
}

// The Box an element sits in, by the element's key, in a drawn tree.
type Drawn = { props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }
function holderOf(node: unknown, key: string): Drawn | undefined {
  const element = node as Drawn
  for (const child of element.children ?? []) {
    if (typeof child === 'object' && child !== null && (child as Drawn).props?.key === key) return element
    const found = typeof child === 'object' && child !== null ? holderOf(child, key) : undefined
    if (found !== undefined) return found
  }
  return undefined
}

test('sensitive commands are flagged, others are not', () => {
  expect(isSensitiveCommand('rm -rf build')).toBe(true)
  expect(isSensitiveCommand('git push origin main')).toBe(true)
  expect(isSensitiveCommand('git -C repo reset --hard HEAD~1')).toBe(true)
  expect(isSensitiveCommand('vercel --prod')).toBe(true)
  expect(isSensitiveCommand('git status')).toBe(false)
  expect(isSensitiveCommand('pnpm build')).toBe(false)
  expect(isSensitiveCommand('rm notes.txt')).toBe(false)
})

test('tools read in plain English', () => {
  expect(describeTool('Read', { file_path: '/project/src/app.ts' }, '/project')).toEqual({
    verb: 'Read',
    detail: 'src/app.ts',
    isSensitive: false,
  })
  const sql = describeTool('mcp__claude_ai_Supabase__execute_sql', { query: 'select 1' }, '/project')
  expect(sql.verb).toBe('Supabase · Run SQL')
  expect(sql.isSensitive).toBe(true)
  // Any mail-sending MCP tool reads as "Send email" and is sensitive; reading mail is not.
  for (const name of ['send_email', 'send_mail_message']) {
    const mail = describeTool(`mcp__mailer__${name}`, {}, '/project')
    expect(mail.verb).toBe('mailer · Send email')
    expect(mail.isSensitive).toBe(true)
  }
  expect(describeTool('mcp__mailer__search_messages', {}, '/project').isSensitive).toBe(false)
  const bash = describeTool('Bash', { command: 'git push', description: 'Push the branch' }, '/project')
  expect(bash.detail).toBe('Push the branch')
  expect(bash.isSensitive).toBe(true)
})

test('the plan is read: title, tasks, requirements, code blocks skipped', () => {
  const plan = parsePlan(PLAN_TEXT)
  expect(plan.title).toBe('Cockpit')
  expect(plan.tasks.map(task => task.n)).toEqual([1, 2, 3])
  expect(plan.tasks[0]?.covers).toEqual(['D1', 'D2'])
  expect(plan.requirements).toEqual(['D1', 'D2', 'D3'])

  const progress = planProgress(plan.tasks, [
    { id: '1', subject: 'Task 1: Read the session', status: 'completed' },
    { id: '2', subject: 'Task 2: Draw the pane', status: 'in_progress' },
  ])
  expect(progress.current).toBe(2)
  expect(progress.coveredRequirements).toEqual(['D1'])
})

test('formats match the status line, sparklines scale', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-sonnet-4-5-20250929[1m]')).toBe('Sonnet 4.5 (1M)')
  expect(bar(42)).toBe('████░░░░░░')
  expect(resetIn('2026-10-22T12:00:00Z', Date.parse('2026-10-22T09:47:00Z'))).toBe('2h13m')
  expect(spark([0, 50, 100], 14, 100)).toBe('▁▅█')
  expect(spark([1, null, 2])).toBe('▅ █')
  expect(elapsed(843_000)).toBe('14m 3s')
})

test('the pane shows figures, activity always, and the project map by folder', async ($, on) => {
  engine(on)
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf dist', description: 'Clean the build' })
  await $.tool.call({ tool: 'Write', file_path: '/project/src/new.ts', content: 'x' })
  await $.tool.call({ tool: 'Read', file_path: '/project/src/old.ts' })
  await $.tool.call({ tool: 'Skill', skill: 'brainstorming' })

  const ui = await $.ui.mount(PANE)
  // The token count is a detail: folded at rest, shown by ▸ details.
  expect(await ui.find({ type: 'Text', text: /84K\/200K/ })).toBeUndefined()
  await ui.press({ key: 'details-toggle' })
  expect(await ui.find({ type: 'Text', text: /84K\/200K tokens/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Clean the build/ }))?.text).toContain('⚠')
  expect(await ui.find({ type: 'Text', text: /◆ brainstorming/ })).toBeDefined()
  // Files: the folder, the file created and the file only read.
  expect(await ui.find({ type: 'Text', text: /^src\/$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+ (✦ )?new\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◦ old\.ts/ })).toBeDefined()
  expect(await ui.find({ key: 'open-/project/src/new.ts' })).toBeDefined()
  expect(await ui.find({ key: 'why-file-/project/src/new.ts' })).toBeDefined()

  await ui.press({ key: 'tab-learn' })
  expect(await ui.find({ type: 'Text', text: /new\.ts/ })).toBeUndefined()
  // Activity stays in view whatever the tab.
  expect(await ui.find({ type: 'Text', text: /Clean the build/ })).toBeDefined()
  await ui.unmount()
})

test('the band follows the plan and hides on request', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: PLAN_FILE })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Task 1: Read the session', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })

  const band = {
    plugin: 'cockpit',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: SCROLL, view: {} },
  } as const
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band, surface })
    expect((await ui.find({ type: 'Text', text: /Task 1\/3/ }))?.text).toContain('Read the session')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...band, surface: 'terminal' })
  await ui.press({ key: 'cockpit-hide' })
  expect(await ui.find({ type: 'Text', text: /Task 1\/3/ })).toBeUndefined()
  await ui.unmount()
})

test('a sensitive tool row is translated and flagged', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'toolu_1',
    props: {
      tool_use_id: 'toolu_1',
      tool: 'Bash',
      input: { command: 'git push --force', description: 'Force push' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  })
  expect((await ui.find({ type: 'Text', text: /Force push/ }))?.text).toContain('⚠ Run')
  expect(await ui.find({ type: 'Text', text: /\$ git push --force/ })).toBeDefined()
  await ui.unmount()
})

test('your prompt sits in a bubble, a rule closes the turn', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

  const bubble = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'msg_1',
    props: { text: 'make the UI nicer', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect(await bubble.find({ type: 'Text', text: /^You$/ })).toBeDefined()
  expect(await bubble.find({ type: 'Text', text: /make the UI nicer/ })).toBeDefined()
  await bubble.unmount()

  const ruleRow = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'TurnDuration',
    requestId: 'msg_2',
    props: { word: 'Cogitated', durationMs: 843_000 },
  })
  expect(await ruleRow.find({ type: 'Text', text: /Done in 14m 3s/ })).toBeDefined()
  await ruleRow.unmount()
})

test('the spinner says what Claude does and counts tools', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/project/a.ts' })

  const ui = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'Spinner',
    requestId: 'main',
    props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
  })
  expect((await ui.find({ type: 'Text', text: /Thinking/ }))?.text).toBe('Thinking · 1 tool…')
  await ui.unmount()
})

test('after a restart, the pane reads back what the session saved', async ($, on) => {
  engine(on)
  on('session.id', () => ({ value: 'abc' }))
  mock.store(on, {
    'session:abc': {
      commands: [
        { id: 't1', label: 'Saved command', command: 'ls', isSensitive: false, isFromAgent: false, status: 'ok', at: 1 },
      ],
      files: [],
      agents: [],
      todos: [],
      plan: null,
      history: [],
    },
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Saved command/ })).toBeDefined()
  await ui.unmount()
})

const SAVED_OLD = {
  commands: [
    { id: 't1', label: 'Before the compaction', command: 'ls', isSensitive: false, isFromAgent: false, status: 'ok', at: 1 },
  ],
  files: [],
  agents: [],
  todos: [],
  plan: null,
  history: [],
}

test('after a compaction gave a new session id, the pane finds its conversation', async ($, on) => {
  engine(on)
  on('session.id', () => ({ value: 'after-compaction' }))
  mock.store(on, {
    'session:before': SAVED_OLD,
    latest: { sessionId: 'before', cwd: '/project', savedAt: 1_000 },
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Before the compaction/ })).toBeDefined()
  await ui.unmount()
})

test('a session started after the last save starts empty', async ($, on) => {
  engine(on, true, [], 18, 5_000)
  on('session.id', () => ({ value: 'new' }))
  mock.store(on, {
    'session:before': SAVED_OLD,
    latest: { sessionId: 'before', cwd: '/project', savedAt: 1_000 },
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Before the compaction/ })).toBeUndefined()
  await ui.unmount()
})

test('outside a git repository there is no Diff button', async ($, on) => {
  engine(on, false)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'action-diff' })).toBeUndefined()
  expect(await ui.find({ key: 'action-folder' })).toBeDefined()
  await ui.unmount()
})

test('Fork session opens Ghostty on a fork of this session', async ($, on) => {
  const ran: string[] = []
  engine(on, true, ran)
  on('session.id', () => ({ value: '5f0c2a9e-1b7d-4c3a-9e8f-2d6b7a1c4e90' }))
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'action-fork' })
  expect(ran.some(argv => argv.includes('osascript') && argv.includes('claude --resume 5f0c2a9e-1b7d-4c3a-9e8f-2d6b7a1c4e90 --fork-session'))).toBe(true)
  await ui.unmount()
})

test('Fork session refuses a session id that is not a UUID', async ($, on) => {
  const ran: string[] = []
  engine(on, true, ran)
  on('session.id', () => ({ value: 'abc; rm -rf ~' }))
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'action-fork' })
  expect(ran.some(argv => argv.includes('--fork-session'))).toBe(false)
  await ui.unmount()
})

test('▶ starts the dev server in a new Ghostty tab, not a new copy of Ghostty', async ($, on) => {
  const ran: string[] = []
  engine(on, true, ran)
  pkg.json = '{"scripts":{"dev":"next dev"}}'
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'action-start' })
  expect(ran.some(argv => argv.includes('osascript') && argv.includes('"pnpm dev"'))).toBe(true)
  expect(ran.some(argv => argv.includes('"open"'))).toBe(false)
  await ui.unmount()
})

test('Fork finds the Ghostty this session runs under, not another copy', () => {
  const tree = [
    '500',
    '  500   400 ps',
    '  400   300 claude',
    '  300   200 -/bin/zsh',
    '  200   100 /usr/bin/login',
    '  100     1 /Applications/Ghostty.app/Contents/MacOS/ghostty',
    '  900     1 /Applications/Ghostty.app/Contents/MacOS/ghostty',
    '  910   900 /usr/bin/login',
  ].join('\n')
  expect(ghosttyHost(tree)).toBe(100)
  // Under tmux the shell's server hangs from launchd, with no Ghostty above it.
  expect(ghosttyHost(['500', '  500   400 sh', '  400     1 tmux'].join('\n'))).toBe(null)
  expect(ghosttyHost('')).toBe(null)
})

test('meters glide in half cells, the stopwatch counts', () => {
  const drawn = (runs: readonly MeterRun[]) => runs.map(run => run.text).join('')
  expect(meter(50, 12)).toEqual([
    { kind: 'filled', text: '━━━━━━' },
    { kind: 'empty', text: '──────' },
  ])
  expect(drawn(meter(54, 12))).toBe('━━━━━━╸─────')
  expect(drawn(meter(100, 4))).toBe('━━━━')
  expect(drawn(meter(0, 4))).toBe('────')
  // The tick: on the empty part, on the filled part, and at the very end.
  expect(drawn(meter(27, 12, 80))).toBe('━━━──────┼──')
  expect(meter(27, 12, 80)[2]).toEqual({ kind: 'mark', text: '┼' })
  expect(drawn(meter(50, 12, 22))).toBe('━━╋━━━──────')
  expect(drawn(meter(10, 12, 100))).toBe('━──────────┼')
  expect(stopwatch(102_000)).toBe('1:42')
  // The user's own figures: 7 days resetting in 1d9h are 80 % gone, 5 hours in 3h53 are 22 %.
  const now = Date.parse('2026-10-22T10:00:00Z')
  const inHours = (hours: number) => new Date(now + hours * 3_600_000).toISOString()
  expect(Math.round(windowElapsed(inHours(33), now, 7 * 86_400_000) ?? -1)).toBe(80)
  expect(Math.round(windowElapsed(inHours(3 + 53 / 60), now, 5 * 3_600_000) ?? -1)).toBe(22)
  expect(windowElapsed('not a date', now, 5 * 3_600_000)).toBe(null)
  // Ahead of the clock turns the figure orange; red stays red; behind it keeps its tone.
  expect(paceTone(27, 80)).toBe('success')
  expect(paceTone(30, 20)).toBe('claude')
  expect(paceTone(60, 40)).toBe('claude')
  expect(paceTone(85, 40)).toBe('error')
  expect(paceTone(30, null)).toBe('success')
  expect(resetIn('2026-10-25T12:00:00Z', Date.parse('2026-10-22T09:00:00Z'))).toBe('3d3h')
})

test('dev servers are read from lsof, the start command from package.json', () => {
  const listeners = parseListeners(
    ['p100', 'cnode', 'f20', 'n*:3000', 'f21', 'n[::1]:3000', 'p200', 'cpostgres', 'f5', 'n*:5432', 'p300', 'cControlCe', 'n*:7000'].join('\n'),
  )
  expect(listeners).toEqual([{ port: 3000, pid: 100, name: 'node' }])
  const folders = parseFolders(['p100', 'fcwd', 'n/home/me/site'].join('\n'))
  expect(withFolders(listeners, folders)[0]?.dir).toBe('/home/me/site')
  expect(withFolders(listeners, parseFolders(['p100', 'fcwd', 'n/'].join('\n')))).toEqual([])

  const dev = readProject('{"scripts":{"dev":"next dev"}}', ['pnpm-lock.yaml'])
  expect(dev).toEqual({ manager: 'pnpm', script: 'dev' })
  expect(startCommand({ manager: 'npm', script: 'dev' })).toBe('npm run dev')
  expect(readProject('{"scripts":{"lint":"eslint"}}', [])).toBe(null)
  expect(readProject('not json', [])).toBe(null)
})

test('a time ago past a day reads in days, like the resets', () => {
  expect(ago(30_000)).toBe('just now')
  expect(ago(9_960_000)).toBe('2h46 ago')
  // The A site's last deployment: 222 h 32 earlier.
  expect(ago(800_884_789)).toBe('9d6h ago')
})

test('★ Insight blocks are read point by point, and go to the note after what it holds', () => {
  const reply = [
    'Done.',
    '',
    '`★ Insight ─────────────────────────────────────`',
    '- **Un bouton peut préparer une instruction.** Le volet écrit',
    '  dans la zone de saisie sans envoyer.',
    '- **Ta to-do est lisible.** Le skill cherche la note par `repo`.',
    '`─────────────────────────────────────────────────`',
    'After.',
  ].join('\n')
  const found = parseInsights(reply)
  expect(found.map(item => item.title)).toEqual(['Un bouton peut préparer une instruction', 'Ta to-do est lisible'])
  expect(found[0]?.body).toBe('Le volet écrit dans la zone de saisie sans envoyer.')
  // The same text twice is the same insight.
  expect(parseInsights(reply)[1]?.id).toBe(found[1]?.id)
  expect(parseInsights('no insight here')).toEqual([])
  // "★ Insight" named in a sentence before the block is not a heading (seen live: the
  // block's own heading came out as a point). A body starts with a capital.
  const named = ['| Learn | Les points de mes encadrés ★ Insight, gardés. |', '', ...reply.split('\n')].join('\n')
  expect(parseInsights(named).map(item => item.title)).toEqual(found.map(item => item.title))
  expect(parseInsights('`★ Insight ─────`\n- **Titre** : le corps.\n`─────`')[0]?.body).toBe('Le corps.')

  const kept = found.map(item => ({ ...item, dir: 'cockpit', at: 0, isExported: false }))
  const section = noteSection(kept, '2026-10-22')
  expect(section).toBe(
    '## 2026-10-22 · cockpit\n\n- **Un bouton peut préparer une instruction.** Le volet écrit dans la zone de saisie sans envoyer.\n- **Ta to-do est lisible.** Le skill cherche la note par `repo`.\n',
  )
  expect(appendToNote(null, section)).toContain('# Claude Code learnings')
  expect(appendToNote(null, section, 'Learnings')).toContain('# Learnings')
  expect(appendToNote('# Mine\n\nkept line', section)).toBe('# Mine\n\nkept line\n\n' + section)
})

test('the project map groups files by folder, a read never hides a change', () => {
  let list = touch([], '/p/src/a.ts', 'read', 1, 100)
  list = touch(list, '/p/src/a.ts', 'edited', 2, 100)
  list = touch(list, '/p/src/a.ts', 'read', 3, 100)
  expect(list).toEqual([{ path: '/p/src/a.ts', action: 'edited', count: 1, at: 2 }])
  list = touch(list, '/p/README.md', 'read', 4, 100)
  list = touch(list, '/home/me/.claude/CLAUDE.md', 'read', 5, 100)
  const map = projectMap(list, '/p')
  expect(map.map(folder => folder.dir)).toEqual(['', 'src/', '~/.claude/'])
  expect(map[1]?.files[0]?.name).toBe('a.ts')
  // Past the limit, changes stay and the oldest reads go.
  expect(projectMap(list, '/p', 1).flatMap(folder => folder.files.map(file => file.name))).toEqual(['a.ts'])
})

test('the context breakdown keeps what is in use, biggest first, and counts unseen skills', () => {
  const fill = contextShares(
    [
      { name: 'System prompt', tokens: 3_000, kind: 'used' },
      { name: 'Messages', tokens: 80_000, kind: 'used' },
      { name: 'MCP tools', tokens: 12_000, kind: 'deferred' },
      { name: 'Skills', tokens: 6_000, kind: 'used' },
      { name: 'Free space', tokens: 500_000, kind: 'free' },
    ],
    { totalSkills: 90, includedSkills: 78 },
  )
  expect(fill.shares).toEqual([
    { label: 'chat', tokens: 80_000 },
    { label: 'skills', tokens: 6_000 },
    { label: 'system', tokens: 3_000 },
  ])
  expect(fill.skillsCut).toBe(12)
  expect(dots([0, 50, 100], 3, 100)).toBe('⡀⣦⣿')
})

test('usage is projected to its reset, the context counts turns to its compaction', () => {
  // The user's own figures: 27 % used with 80 % of the week gone ends near 34 %.
  expect(projectAtReset(27, 80)).toBe(34)
  expect(projectAtReset(8, 22)).toBe(36)
  expect(projectAtReset(50, 2)).toBe(null)
  expect(projectAtReset(50, null)).toBe(null)
  // +20K a turn, 140K now, compaction at 300K: 8 turns; a drop (a compaction) is no growth.
  expect(turnsLeft([80_000, 100_000, 120_000, 140_000], 140_000, 300_000)).toBe(8)
  expect(turnsLeft([250_000, 30_000, 50_000], 50_000, 300_000)).toBe(12)
  expect(turnsLeft([100_000], 100_000, 300_000)).toBe(null)
  expect(turnsLeft([100_000, 290_000], 310_000, 300_000)).toBe(0)
})

test('checks are read from shell commands, quoted text and file commands aside', () => {
  expect(checkKinds('pnpm test')).toEqual(['tests'])
  expect(checkKinds('cd site && pnpm lint && pnpm build')).toEqual(['lint', 'build'])
  expect(checkKinds('pnpm --package=typescript dlx tsc -p .')).toEqual(['types'])
  expect(checkKinds('uv run pytest -q')).toEqual(['tests'])
  expect(checkKinds('git commit -m "fix the test"')).toEqual([])
  expect(checkKinds('grep -n test src/app.ts')).toEqual([])
  expect(checkKinds('echo "pnpm build"')).toEqual([])
})

test('a command that only names a check is not a check', () => {
  const notChecks = [
    'wc -l tests/x',
    'wc -l tests',
    'jest --help',
    'ls tests',
    'node scripts/test-data.js',
    'python3 scripts/report.py test',
    'test -f package.json',
    'pnpm add -D vitest',
    'npm install jest',
    'uv pip install pytest',
    'npx playwright install',
    'which pytest',
    'tsc --version',
    'pytest --collect-only',
    'rm -rf build',
    'npx rimraf build',
    'pnpm exec rm -rf build',
    '# pnpm test',
    "cat > run.sh <<'EOF'\npnpm test\nEOF",
    'git commit -m "a && pnpm test"',
    'gh workflow run build',
  ]
  for (const command of notChecks) expect([command, checkKinds(command)]).toEqual([command, []])
})

test('the real runners are still recognised, whatever wraps them', () => {
  const kinds: readonly (readonly [string, readonly string[]])[] = [
    ['claude plugin test .', ['tests']],
    ['pnpm run test', ['tests']],
    ['pnpm --filter web test', ['tests']],
    ['pnpm test:unit', ['tests']],
    ['pnpm tests', ['tests']],
    ['npx jest src', ['tests']],
    ['./node_modules/.bin/vitest run', ['tests']],
    ['.venv/bin/pytest tests -q', ['tests']],
    ['python3 -m pytest tests', ['tests']],
    ['node --test', ['tests']],
    ['npx playwright test', ['tests']],
    ['bash scripts/test.sh', ['tests']],
    ['./scripts/test.sh', ['tests']],
    ['CI=1 pnpm test', ['tests']],
    ['(cd site && pnpm test)', ['tests']],
    ['cargo test', ['tests']],
    ['go test ./...', ['tests']],
    ['pnpm build:css', ['build']],
    ['vercel build', ['build']],
    ['pnpm --silent --package=typescript@5.6.3 dlx tsc -p /x/test --noEmit', ['types']],
    ['pnpm typecheck', ['types']],
    ['ruff check .', ['lint']],
    ['ruff format .', []],
    ['echo ok; pnpm test', ['tests']],
  ]
  for (const [command, expected] of kinds) expect([command, checkKinds(command)]).toEqual([command, expected])
})

test('the bench counts as the bench, whatever words it is given', () => {
  expect(checkKinds('python3 dev/drive.py tests')).toEqual(['bench'])
  expect(checkKinds('python3 dev/drive.py "Reponds juste: bonjour"')).toEqual(['bench'])
  expect(checkKinds('cd /x/cockpit && python3 /x/cockpit/dev/drive.py --two-part "pnpm test"')).toEqual(['bench'])
})

test('a check whose exit code the command hides is told apart', () => {
  const masked = (command: string) => checkRuns(command).map(run => run.isMasked)
  for (const command of [
    'pnpm test | tail -5',
    'pnpm test 2>&1 | tail -20',
    'pnpm test | tee log.txt',
    'pytest -q || true',
    'pnpm test || echo failed',
    'pnpm test; echo "code=$?"',
    'pnpm test &',
    'ls missing || pnpm test',
    'pnpm test && pnpm test:e2e; echo done',
  ]) {
    expect([command, masked(command)]).toEqual([command, [true]])
  }
  for (const command of [
    'pnpm test',
    'pnpm test;',
    'pnpm test > log.txt 2>&1',
    'echo ok; pnpm test',
    'pnpm test && git add .',
    'pnpm test || exit 1',
    'set -o pipefail; pnpm test | tail -5',
    'set -e; pnpm test; echo done',
    'set -euo pipefail\npnpm test | tail -5\necho done',
    'echo start | pnpm test',
  ]) {
    expect([command, masked(command)]).toEqual([command, [false]])
  }
  // Each check on its own: the lint's code still decides the command, the tests' no longer does.
  expect(checkRuns('pnpm lint && pnpm test | tail -5')).toEqual([
    { kind: 'lint', isMasked: false },
    { kind: 'tests', isMasked: true },
  ])
  // Run twice, the last run is the one that counts.
  expect(checkRuns('pnpm test | tail -5; pnpm test')).toEqual([{ kind: 'tests', isMasked: false }])
})

test('only edits to code count: notes, reports and scratch files do not', () => {
  for (const path of [
    '/project/src/app.ts',
    'hooks/register.tsx',
    '/project/package.json',
    '/project/notes.md.ts',
    '/project/src/tmp.ts',
    '/project/src/memory.ts',
    '/project/styles.css',
    '/home/a/x/src/memory/store.ts',
    '/home/a/stage/obsidian-plugin/main.ts',
    '/home/a/Obsidian/plugin.ts',
    'memory/state.json',
    '/private/tmp/claude-501/x/scratchpad/wt/p2/hooks/a.ts',
  ]) {
    expect([path, isCodePath(path)]).toEqual([path, true])
  }
  for (const path of [
    '/project/README.md',
    '/project/docs/NOTES.MD',
    '/project/todo.txt',
    '/private/tmp/claude-501/x/scratchpad/draft.ts',
    '/tmp/a.ts',
    '/private/tmp/a.py',
    '/home/a/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/x.js',
    '/home/a/.claude/projects/x/memory/state.json',
    '',
  ]) {
    expect([path, isCodePath(path)]).toEqual([path, false])
  }
})

test('a Playwright browser check is a look at the page, not any browser call', () => {
  expect(isBrowserCheck('mcp__plugin_playwright_playwright__browser_take_screenshot')).toBe(true)
  expect(isBrowserCheck('mcp__plugin_playwright_playwright__browser_snapshot')).toBe(true)
  expect(isBrowserCheck('mcp__playwright__browser_run_code')).toBe(true)
  expect(isBrowserCheck('mcp__plugin_playwright_playwright__browser_navigate')).toBe(false)
  expect(isBrowserCheck('mcp__plugin_playwright_playwright__browser_close')).toBe(false)
  expect(isBrowserCheck('mcp__browser-use__browser_screenshot')).toBe(false)
  expect(isBrowserCheck('Bash')).toBe(false)
})

test('the PR and the deployment are read from gh and vercel', () => {
  expect(parsePr(PR_JSON)).toEqual({
    number: 91,
    state: 'OPEN',
    isDraft: false,
    checks: 'passing',
    url: 'https://github.com/me/site/pull/91',
  })
  const running = JSON.stringify({
    number: 3,
    state: 'OPEN',
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }],
  })
  expect(parsePr(running)?.checks).toBe('pending')
  const failing = JSON.stringify({
    number: 3,
    state: 'OPEN',
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'IN_PROGRESS' },
      { __typename: 'StatusContext', state: 'FAILURE' },
    ],
  })
  expect(parsePr(failing)?.checks).toBe('failing')
  expect(parsePr('no pull requests found')).toBe(null)

  expect(parseDeploy(DEPLOY_JSON)).toEqual({
    state: 'READY',
    target: 'production',
    at: 1,
    url: 'https://site-abc.vercel.app',
  })
  expect(parseDeploy('{"deployments":[]}')).toBe(null)
  expect(touchesRemote('git push -u origin feat/x')).toBe(true)
  expect(touchesRemote('vercel deploy')).toBe(true)
  expect(touchesRemote('git status')).toBe(false)
})

test('the pane shows the compaction point, checks, the PR and the deployment', async ($, on) => {
  engine(on, true, [], 18, 0, 100_000)
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'pnpm test', description: 'Run the tests' })
  await $.tool.call({ tool: 'Bash', command: 'pnpm build', description: 'Build the site' })
  // Git, then GitHub and Vercel, are read in the background once the session starts.
  await settle()

  const ui = await $.ui.mount(PANE)
  // 84K against the 100K compaction point, not the 200K window, in the details.
  await ui.press({ key: 'details-toggle' })
  expect(await ui.find({ type: 'Text', text: /84K\/100K/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /tests ✓/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /build ✗/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#91/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /checks passing/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Ready/ })).toBeDefined()
  expect(await ui.find({ key: 'open-pr' })).toBeDefined()
  await ui.unmount()
})

test('? asks Claude why on a fork', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf dist', description: 'Clean the build' })
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1_000, isAborted: false, reason: 'answer' })
  await settle()

  const ui = await $.ui.mount(PANE)
  // The skills Claude cannot see are a warning, shown folded or not; the breakdown counted
  // at the turn's end is a detail.
  expect(await ui.find({ type: 'Text', text: /10 skills unseen/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /chat 60K/ })).toBeUndefined()
  await ui.press({ key: 'details-toggle' })
  expect(await ui.find({ type: 'Text', text: /chat 60K · tools 15K/ })).toBeDefined()

  const row = (await ui.findAll({ type: 'Button' })).find(button => button.key?.startsWith('why-run-'))
  expect(row).toBeDefined()
  await ui.press({ key: String(row?.key) })
  await settle()
  expect(asked.at(-1)).toContain('rm -rf dist')
  expect(await ui.find({ type: 'Text', text: /nettoyage ne casse rien/ })).toBeDefined()

  await ui.unmount()
})

test('the pane has no Ask row, in a repository with changes or outside one', async ($, on) => {
  engine(on)
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount(PANE)
  // Git says 1 change on main (Tests, Commit and Review used to be offered): none now.
  const keys = (await ui.findAll({ type: 'Button' })).map(button => String(button.key))
  expect(keys.filter(key => key.startsWith('ask-'))).toEqual([])
  expect(await ui.find({ type: 'Text', text: /^Ask$/ })).toBeUndefined()
  // The other buttons are still there.
  expect(keys).toContain('action-compact')
  expect(keys).toContain('action-fork')
  await ui.unmount()
})

test('outside a repository, the pane still draws its buttons and no Ask row', async ($, on) => {
  engine(on, false)
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount(PANE)
  const keys = (await ui.findAll({ type: 'Button' })).map(button => String(button.key))
  expect(keys.filter(key => key.startsWith('ask-'))).toEqual([])
  expect(await ui.find({ type: 'Text', text: /^Ask$/ })).toBeUndefined()
  expect(keys).toContain('action-folder')
  expect(keys).not.toContain('action-diff')
  await ui.unmount()
})

test('★ Insight points are kept in Learn and sent to the note when a notes folder is set', { options: { notesDir: '/vault', notesName: 'Learnings' } }, async ($, on) => {
  engine(on)
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const reply = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'msg_9',
    props: {
      text: '`★ Insight ─────`\n- **Un fork ne coûte presque rien.** La conversation est en cache.\n`─────────`',
      isFirstOfReply: true,
    },
  })
  await reply.unmount()
  await settle()

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-learn' })
  expect(await ui.find({ type: 'Text', text: /Un fork ne coûte presque rien/ })).toBeDefined()
  await ui.press({ key: 'insights-export' })
  await settle()
  const note = [...written].find(([path]) => path === '/vault/Learnings.md')?.[1]
  expect(note).toContain('- **Un fork ne coûte presque rien.** La conversation est en cache.')
  expect(note).toContain('· project')
  await ui.unmount()
})

test('With no notes folder set, insights stay in Learn and nothing is written', async ($, on) => {
  engine(on)
  mock.store(on, {})
  written.clear()
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const reply = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'msg_10',
    props: { text: '`★ Insight ─────`\n- **A fork costs little.** The conversation is cached.\n`─────────`', isFirstOfReply: true },
  })
  await reply.unmount()
  await settle()

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-learn' })
  expect(await ui.find({ type: 'Text', text: /A fork costs little/ })).toBeDefined()
  expect(await ui.find({ key: 'insights-export' })).toBeUndefined()
  expect(await ui.find({ key: 'insights-note' })).toBeUndefined()
  expect(written.size).toBe(0)
  await ui.unmount()
})

test('Points read wrong by the first parser are dropped on load', async ($, on) => {
  engine(on)
  const point = (id: string, title: string, body: string) => ({ id, title, body, dir: 'cockpit', at: 1, isExported: true })
  mock.store(on, {
    insights: [
      point('keep1', 'Ce que la carte voit vraiment', 'elle montre les fichiers lus.'),
      point('yy9ly', '`★ Insight ─────`', ''),
      point('t7wdfl', 'Nettoyage', ''),
    ],
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-learn' })
  expect(await ui.find({ type: 'Text', text: /Elle montre les fichiers lus/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Nettoyage|★ Insight ─/ })).toBeUndefined()
  await ui.unmount()
})

test('Claude replies sit behind a bar, under a Claude label', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const reply = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'msg_3',
    props: { text: 'All done.', isFirstOfReply: true },
  })
  expect(await reply.find({ type: 'Text', text: /^Claude$/ })).toBeDefined()
  expect(await reply.find({ type: 'Markdown' })).toBeDefined()
  await reply.unmount()

  const more = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'msg_4',
    props: { text: 'Second block.', isFirstOfReply: false },
  })
  expect(await more.find({ type: 'Text', text: /^Claude$/ })).toBeUndefined()
  await more.unmount()
})

test('the pane shows the 7-day window, git and the live row', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  // Git is read in the background once the session starts.
  await settle()
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /7 days/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⎇ main/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Ready/ })).toBeDefined()
  await ui.unmount()
})

test('a failed build alerts with its own sound', async ($, on) => {
  const ran: string[] = []
  engine(on, true, ran)
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'pnpm build', description: 'Build the site' })
  // The alert runs in the background: the tool's result is never held for it.
  await settle()
  expect(ran.some(argv => argv.includes('Basso.aiff'))).toBe(true)
  expect(ran.some(argv => argv.includes('Failed: Build the site'))).toBe(true)
})

test('a usage window past 80% alerts once', async ($, on) => {
  const ran: string[] = []
  engine(on, true, ran, 85)
  mock.store(on, {})
  on('session.measure', () => ({ changed: [] }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const figures = {
    startedAt: 0,
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 85, resetsAt: '2099-01-01T00:00:00Z' }],
    cost: { usd: 3.42 },
    changed: [],
  }
  await $.session.measure(figures)
  await settle()
  await $.session.measure(figures)
  await settle()
  expect(ran.filter(argv => argv.includes('Funk.aiff')).length).toBe(1)
})

// ── Pinned replies ───────────────────────────────────────────────────────────

// /pin as typed at the prompt; the engine stamps where it came from.
const runPin = ($: { command: { run: (e: never) => Promise<{ text?: string }> } }, args: string) =>
  $.command.run({ command: 'pin', args } as never)

const TRANSCRIPT = [
  { role: 'user', text: 'Explique le cache', toolUses: [] },
  { role: 'assistant', text: 'Je regarde le code.', toolUses: [] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }] },
  { role: 'assistant', text: '## Le cache garde les échecs\n\nUn objet vide passe le test.', toolUses: [] },
  { role: 'user', text: 'Et la suite ?', toolUses: [] },
  { role: 'assistant', text: '**Deux pistes.** Tester le contenu, ou lever une erreur.', toolUses: [] },
] as never[]

test('the replies are read back from the transcript, newest first, one per prompt', () => {
  expect(recentReplies(TRANSCRIPT)).toEqual([
    '**Deux pistes.** Tester le contenu, ou lever une erreur.',
    '## Le cache garde les échecs\n\nUn objet vide passe le test.',
  ])
  expect(pinTitle('## Le cache garde les échecs\n\nUn objet vide.')).toBe('Le cache garde les échecs')
  expect(pinTitle('**Deux pistes.** Tester le contenu.')).toBe('Deux pistes')
  expect(pinTitle('Oui, c’est faisable sans trop d’effort. Voici comment.')).toBe('Oui, c’est faisable sans trop d’effort')
  expect(pinRequest('')).toEqual({ rank: 1, title: null })
  expect(pinRequest('2')).toEqual({ rank: 2, title: null })
  expect(pinRequest('2 Plan du cache')).toEqual({ rank: 2, title: 'Plan du cache' })
  expect(pinRequest('Plan du cache')).toEqual({ rank: 1, title: 'Plan du cache' })
  // A reply pinned twice is kept once, with its latest title.
  const where = { dir: 'market', at: 1, sessionId: 's' }
  const once = addPin([], makePin('Texte', where), 10)
  const twice = addPin(once, makePin('Texte', where, { title: 'Renommé' }), 10)
  expect(twice.map(pin => pin.title)).toEqual(['Renommé'])
})

test('/pin keeps the last reply across sessions, the Pins tab reads, reuses and unpins it', async ($, on) => {
  engine(on)
  on('session.id', () => ({ value: 'abc' }))
  on('session.messages', () => ({ value: TRANSCRIPT }))
  on('ui.selection', () => ({ value: undefined }))
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

  const ran = await runPin($, '')
  expect(ran.text).toContain('Deux pistes')
  const earlier = await runPin($, '2')
  expect(earlier.text).toContain('Le cache garde les échecs')
  expect((await runPin($, '5')).text).toBe('Only 2 replies in this session.')

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-pins' })
  expect(await ui.find({ type: 'Button', text: /Le cache garde les échecs/ })).toBeDefined()
  const id = makePin(TRANSCRIPT_LAST, { dir: '', at: 0, sessionId: '' }).id
  expect(await ui.find({ key: `pin-open-${id}` })).toBeDefined()
  expect(await ui.find({ key: `pin-reuse-${id}` })).toBeUndefined()
  await ui.press({ key: `pin-open-${id}` })
  expect(await ui.find({ key: `pin-reuse-${id}` })).toBeDefined()
  // ✕ asks for a second press before it unpins.
  await ui.press({ key: `pin-remove-${id}` })
  expect(await ui.find({ key: `pin-open-${id}` })).toBeDefined()
  await ui.press({ key: `pin-remove-${id}` })
  expect(await ui.find({ key: `pin-open-${id}` })).toBeUndefined()
  await ui.unmount()
})

test('pins kept by an earlier session show in the Pins tab', async ($, on) => {
  engine(on)
  mock.store(on, {
    pins: [{ id: 'p1', title: 'Plan du cache', text: 'Le plan.', dir: 'market', at: 1, sessionId: 'old', isExcerpt: false }],
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Button', text: 'Pins 1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Pins 2' })).toBeUndefined()
  await ui.press({ key: 'tab-pins' })
  expect(await ui.find({ key: 'pin-open-p1' })).toBeDefined()
  await ui.unmount()
})

const TRANSCRIPT_LAST = '**Deux pistes.** Tester le contenu, ou lever une erreur.'

test('/pin with text selected keeps just that passage', async ($, on) => {
  engine(on)
  on('session.id', () => ({ value: 'abc' }))
  on('session.messages', () => ({ value: TRANSCRIPT }))
  on('ui.selection', () => ({ value: { text: 'Un objet vide passe le test du cache.' } }))
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

  const ran = await runPin($, 'Piège du cache')
  expect(ran.text).toBe('📌 Pinned the selected passage: “Piège du cache” · Cockpit → Pins')
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-pins' })
  expect(await ui.find({ type: 'Button', text: '▸ ❝ Piège du cache' })).toBeDefined()
  await ui.unmount()
})

// ── Notes ────────────────────────────────────────────────────────────────────

test('the Notes tab keeps one notepad per project, saved as you type', async ($, on) => {
  engine(on)
  // The store in memory, written down to see what is saved.
  const saved: { key: string; value: unknown }[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => {
    saved.push({ key: e.key, value: e.value })
    return { value: undefined }
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-notes' })
  expect(await ui.find({ type: 'Button', text: 'Notes' })).toBeDefined()
  await ui.input({ plugin: 'cockpit', key: 'notes-text', text: '- vérifier le score', kind: 'change' })
  // Typing marks the tab at once; Enter saves under the project's folder.
  expect(await ui.find({ type: 'Button', text: 'Notes •' })).toBeDefined()
  // Enter is a new line: the notes stay, and are kept at once.
  await ui.input({ plugin: 'cockpit', key: 'notes-text', text: '- vérifier le score\n- alerte PR' })
  expect(saved.at(-1)).toMatchObject({ key: 'notes:/project', value: { dir: '/project', text: '- vérifier le score\n- alerte PR\n' } })
  expect(await ui.find({ type: 'Button', text: 'Notes •' })).toBeDefined()

  await ui.press({ key: 'notes-send' })
  expect(filled.at(-1)).toBe('Voici mes notes sur ce projet :\n\n- vérifier le score\n- alerte PR\n\n')
  // Clear asks twice.
  await ui.press({ key: 'notes-clear' })
  expect(await ui.find({ type: 'Button', text: 'Notes •' })).toBeDefined()
  await ui.press({ key: 'notes-clear' })
  expect(await ui.find({ type: 'Button', text: 'Notes •' })).toBeUndefined()
  expect(saved.at(-1)).toMatchObject({ key: 'notes:/project', value: { text: '' } })
  // The text a clear replaced comes back with Restore.
  await ui.press({ key: 'notes-restore' })
  expect(await ui.find({ type: 'Button', text: 'Notes •' })).toBeDefined()
  expect(await ui.find({ key: 'notes-restore' })).toBeUndefined()
  expect(saved.at(-1)).toMatchObject({ value: { text: '- vérifier le score\n- alerte PR\n' } })
  await ui.unmount()
})

test('a short edit keeps no copy aside, a big cut does', async ($, on) => {
  engine(on)
  mock.store(on, { 'notes:/project': { dir: '/project', text: 'Relancer le client lundi, puis la banque', savedAt: 1 } })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-notes' })
  await ui.input({ plugin: 'cockpit', key: 'notes-text', text: 'Relancer le client mardi, puis la banque' })
  expect(await ui.find({ key: 'notes-restore' })).toBeUndefined()
  await ui.input({ plugin: 'cockpit', key: 'notes-text', text: ' o ' })
  expect(await ui.find({ key: 'notes-restore' })).toBeDefined()
  await ui.unmount()
})

test('the notes of another session in the same folder come back', async ($, on) => {
  engine(on)
  mock.store(on, {
    'notes:/project': { dir: '/project', text: 'Relancer le client', savedAt: 1 },
    'notes:/other': { dir: '/other', text: 'Autre projet', savedAt: 1 },
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Button', text: 'Notes •' })).toBeDefined()
  await ui.press({ key: 'tab-notes' })
  await ui.press({ key: 'notes-send' })
  expect(filled.at(-1)).toBe('Voici mes notes sur ce projet :\n\nRelancer le client\n\n')
  await ui.unmount()
})

// ── Layout ───────────────────────────────────────────────────────────────────

test('the grip under the tabs is dragged to make them taller or shorter', async ($, on) => {
  engine(on)
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-notes' })
  expect((await ui.find({ key: 'tabs-handle' }))?.props.props).toEqual({ rows: 14 })
  expect((await ui.find({ key: 'notes-text' }))?.props.rows).toBe(12)

  // Pressed, dragged 3 rows down, released: the notes grow with the tabs.
  await ui.pointer({ type: 'down', x: 10, y: 0, button: 'left', in: 'tabs-handle' })
  await ui.pointer({ type: 'move', x: 10, y: 3, button: 'left', in: 'tabs-handle' })
  expect((await ui.find({ key: 'notes-text' }))?.props.rows).toBe(15)
  await ui.pointer({ type: 'up', x: 10, y: 0, button: 'left', in: 'tabs-handle' })
  expect((await ui.find({ key: 'tabs-handle' }))?.props.props).toEqual({ rows: 17 })

  // Dragged far up, the tabs keep a few rows.
  await ui.pointer({ type: 'down', x: 10, y: 0, button: 'left', in: 'tabs-handle' })
  await ui.pointer({ type: 'up', x: 10, y: -50, button: 'left', in: 'tabs-handle' })
  expect((await ui.find({ key: 'tabs-handle' }))?.props.props).toEqual({ rows: 4 })
  await ui.unmount()
})

test('the tabs’ height and the unfolded details come back in the next session', async ($, on) => {
  engine(on)
  mock.store(on, { layout: { tabRows: 20, isDetailed: true } })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /API cost/ })).toBeDefined()
  await ui.press({ key: 'tab-notes' })
  expect((await ui.find({ key: 'notes-text' }))?.props.rows).toBe(18)
  await ui.unmount()
})

// ── A lighter pane ───────────────────────────────────────────────────────────

test('the figures fold: the essentials at rest, the details on request, kept for next time', async ($, on) => {
  engine(on)
  const saved: { key: string; value: unknown }[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => {
    saved.push({ key: e.key, value: e.value })
    return { value: undefined }
  })
  on('session.measure', () => ({ changed: [] }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  // Two hours before the 5-hour reset, 60 % of the window is gone: 18 % ends near 30 %.
  const measure = (percentUsed: number) =>
    $.session.measure({
      context: { tokens: 84_000, window: 200_000, percent: 42 },
      rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: '2026-10-22T12:00:00Z' }],
      cost: { usd: 3.42 },
      changed: [],
    })
  await measure(18)
  await settle()

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /5 hours/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /→30%/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /API cost/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /cockpit reopens/ })).toBeUndefined()
  await ui.press({ key: 'details-toggle' })
  expect(await ui.find({ type: 'Text', text: /→30%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /API cost.*\$3\.42/ })).toBeDefined()
  expect(saved.at(-1)).toEqual({ key: 'layout', value: { tabRows: 14, isDetailed: true } })

  // Folded again, a projection past the limit still shows, in red.
  await ui.press({ key: 'details-toggle' })
  await measure(70)
  expect((await ui.find({ type: 'Text', text: /^ →117%$/ }))?.props.color).toBe('error')
  await ui.unmount()
})

test('Activity keeps its newest rows at rest, the lot on request, and ? why under the pointer', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  for (const step of [1, 2, 3, 4, 5, 6]) {
    await $.tool.call({ tool: 'Bash', command: `echo ${step}`, description: `Step ${step}` })
  }

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: 'Activity · 6' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Step 6/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Step 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Step 2/ })).toBeUndefined()

  // "? why" waits out of sight, shown while the pointer is on its row.
  const why = (await ui.findAll({ type: 'Button' })).find(button => button.key?.startsWith('why-run-'))
  const holder = holderOf(await ui.drawn(), String(why?.key))
  expect(holder?.props?.display).toBe('none')
  expect(holder?.hover).toEqual({ display: 'flex' })
  // Once asked, the row keeps its × in view.
  await ui.press({ key: String(why?.key) })
  await settle()
  const asked = holderOf(await ui.drawn(), String(why?.key))
  expect(asked).toBeDefined()
  expect(asked?.props?.display).toBeUndefined()

  await ui.press({ key: 'activity-toggle' })
  expect(await ui.find({ type: 'Text', text: /Step 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Commands & skills · 6' })).toBeDefined()
  await ui.unmount()

  // The mobile app has no pointer: there "? why" is always shown.
  const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
  const shown = (await phone.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('why-run-'))
  expect(shown.length).toBeGreaterThan(0)
  for (const button of shown) {
    const holder = holderOf(await phone.drawn(), String(button.key))
    expect(holder).toBeDefined()
    expect(holder?.props?.display).toBeUndefined()
  }
  await phone.unmount()
})

test('a finished plan leaves the pane 15 minutes after its last step', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write the tests', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Steps 1\/1/ })).toBeDefined()
  await clock.advance(14 * 60_000)
  expect(await ui.find({ type: 'Text', text: /Steps 1\/1/ })).toBeDefined()
  await clock.advance(2 * 60_000)
  expect(await ui.find({ type: 'Text', text: /Steps 1\/1/ })).toBeUndefined()
  await ui.unmount()
})

test('dev servers sit in the label column, one row each', async ($, on) => {
  engine(on, false)
  lsof.listening = ['p100', 'cnode', 'f20', 'n*:3000'].join('\n')
  lsof.folders = ['p100', 'fcwd', 'n/home/me/site'].join('\n')
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^Servers {2}. :3000 site$/ })).toBeDefined()
  expect(await ui.find({ key: 'site-3000' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Servers · / })).toBeUndefined()
  await ui.unmount()
})

// ── Colour in replies ────────────────────────────────────────────────────────

test('colour marks are read outside code, and the rest of a reply stays markdown', () => {
  const reply = [
    '## Result',
    '',
    'The tests {green|passed}, but **one** setting is {red|irreversible}.',
    '- edit {blue|hooks/register.tsx}',
    '',
    '```ts',
    "const x = '{red|not a mark}'",
    '```',
    '',
    'Plain closing words with `{green|code}`.',
  ].join('\n')
  expect(hasMarks(reply)).toBe(true)
  expect(hasMarks('Only `{green|code}` and\n```\n{red|fenced}\n```')).toBe(false)
  expect(stripMarks(reply)).toContain('The tests passed, but **one** setting is irreversible.')
  expect(stripMarks(reply)).toContain("const x = '{red|not a mark}'")
  expect(stripMarks(reply)).toContain('`{green|code}`')

  const blocks = colorBlocks(reply)
  expect(blocks.map(block => block.kind)).toEqual(['markdown', 'colored', 'markdown'])
  expect(blocks[0]).toEqual({ kind: 'markdown', text: '## Result' })
  expect((blocks[2] as { text: string }).text).toContain("```ts\nconst x = '{red|not a mark}'\n```")
  expect(lineRuns('The tests {green|passed}, but **one** is {red|gone}.')).toEqual([
    { text: 'The tests ' },
    { text: 'passed', tone: 'success', isBold: false },
    { text: ', but ' },
    { text: 'one', isBold: true },
    { text: ' is ' },
    { text: 'gone', tone: 'error', isBold: false },
    { text: '.' },
  ])
  expect(lineRuns('- edit {blue|a.ts}')).toEqual([{ text: '- ' }, { text: 'edit ' }, { text: 'a.ts', tone: 'suggestion', isBold: false }])
  // A pin keeps the reply without its marks.
  const pin = makePin('Done: {green|all good}.', { dir: 'p', at: 0, sessionId: 's' })
  expect(pin.text).toBe('Done: all good.')
})

test('a reply with colour marks draws them in colour, and Claude is told the marks', async ($, on) => {
  engine(on)
  // The engine's own prompt, beneath the mod.
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const reply = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'msg_5',
    props: { text: 'Intro.\n\nThe build {red|failed} on {blue|src/a.ts}.', isFirstOfReply: true },
  })
  expect((await reply.find({ type: 'Text', text: /^failed$/ }))?.props.color).toBe('error')
  expect((await reply.find({ type: 'Text', text: /^src\/a\.ts$/ }))?.props.color).toBe('suggestion')
  expect(await reply.find({ type: 'Text', text: /\{red\|/ })).toBeUndefined()
  expect((await reply.find({ type: 'Markdown' }))?.props.text).toBe('Intro.')
  await reply.unmount()

  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', tools: [], outputStyle: null, surfaces: ['terminal'], traits: [] })
  const section = composed.sections.find(item => item.id === 'cockpit:marks')
  expect(section?.text).toMatch(/\{green\|text\}/)
  expect(section?.text).toMatch(/red\|…\} = failed/)
  const printed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', tools: [], outputStyle: null, surfaces: [], traits: ['print'] })
  expect(printed.sections.some(item => item.id === 'cockpit:marks')).toBe(false)
})

test('signs colour on their own, and one sentence can be highlighted', async ($, on) => {
  expect(isColorful('✓ tests 4m · ⚠ one warning')).toBe(true)
  expect(isColorful('Nothing `✓` here')).toBe(false)
  expect(lineRuns('**DOING :** write the file ✓')).toEqual([
    { text: 'DOING', isBold: true, tone: 'suggestion' },
    { text: ' :', isBold: true },
    { text: ' write the file ' },
    { text: '✓', tone: 'success', isBold: false },
  ])
  expect(lineRuns('- IF WRONG: {mark|run /reload-plugins}')).toEqual([
    { text: '- ' },
    { text: 'IF WRONG', tone: 'warning', isBold: true },
    { text: ': ' },
    { text: 'run /reload-plugins', isHighlight: true, isBold: true },
  ])
  expect(stripMarks('Then {mark|reload}.')).toBe('Then reload.')

  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const reply = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'msg_6',
    props: { text: '✗ build failed. {mark|Run the build again.}', isFirstOfReply: false },
  })
  expect((await reply.find({ type: 'Text', text: /^✗$/ }))?.props.color).toBe('error')
  const marked = await reply.find({ type: 'Text', text: /^Run the build again\.$/ })
  expect(marked?.props.backgroundColor).toBe('warning')
  expect(marked?.props.color).toBe('inverseText')
  await reply.unmount()
})

// ── Verdicts, words, the decision waiting for you, the signature ─────────────

const DONE_REPLY = '{done|Tests {green|verts}, prêt à recharger}\n\nUn {term|commit|instantané enregistré du code} est fait.'

test('a verdict opens a reply, whole or still streaming, and a word carries its meaning', () => {
  expect(readVerdict(DONE_REPLY)).toEqual({
    kind: 'done',
    text: 'Tests {green|verts}, prêt à recharger',
    rest: 'Un {term|commit|instantané enregistré du code} est fait.',
  })
  // While the reply streams, the badge is drawn before the closing brace arrives.
  expect(readVerdict('{decide|Garder les deux ou')).toEqual({ kind: 'decide', text: 'Garder les deux ou', rest: '' })
  expect(readVerdict('Plain words, then {done|not first}')).toBeNull()
  expect(readVerdict('{maybe|not a verdict}')).toBeNull()
  expect(hasMarks('{info|Oui}')).toBe(true)
  expect(stripMarks(DONE_REPLY)).toBe(
    '**✓ DONE** — Tests verts, prêt à recharger\n\nUn commit (instantané enregistré du code) est fait.',
  )

  // Once each, outside code, the first meaning given wins.
  expect(termsIn('Un {term|commit|instantané du code}, un {term|Commit|autre sens} et `{term|hook|code}`.')).toEqual([
    { term: 'commit', meaning: 'instantané du code' },
  ])
  expect(lineRuns('Un {term|commit|instantané du code} est fait.')).toEqual([
    { text: 'Un ' },
    { text: 'commit', isUnderline: true },
    { text: ' (instantané du code)', isDim: true },
    { text: ' est fait.' },
  ])

  // A pin is named by its verdict and keeps it as a bold label.
  const pin = makePin(DONE_REPLY, { dir: 'p', at: 0, sessionId: 's' })
  expect(pin.title).toBe('Tests verts, prêt à recharger')
  expect(pin.text.startsWith('**✓ DONE** — Tests verts')).toBe(true)

  // Claude is told both marks.
  expect(marksPrompt()).toMatch(/\{done\|…\} = the work is finished/)
  expect(marksPrompt()).toMatch(/\{term\|word\|meaning\}/)
})

test('only a decide verdict leaves you something to decide, in its own words', () => {
  expect(pendingDecision('{decide|**A** ou **B** pour la suite}\n\nDétails.')).toBe('A ou B pour la suite')
  expect(pendingDecision('Fait.')).toBeNull()
  // A polite offer closing the answer, or a question asked in passing, waits on no choice.
  expect(pendingDecision('Tu veux que je le publie ?')).toBeNull()
  expect(pendingDecision('{done|Fini}\n\nOn passe à la suite ?')).toBeNull()
  // Without the badge, even a question with options: the badge is what says a choice waits.
  const choice = ['Les deux marchent.', '', '**Lequel préfères-tu ?**', '- **A.** Garder (recommandé)', '- **B.** Retirer']
  expect(pendingDecision(choice.join('\n'))).toBeNull()
})

test('a reply shows its verdict badge, its words underlined and the time it was written', async ($, on) => {
  engine(on)
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: DONE_REPLY }] },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid: 'u1',
  })
  await settle()

  const reply = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'u1',
    props: { text: DONE_REPLY, isFirstOfReply: true },
  })
  const badge = await reply.find({ type: 'Text', text: /^ ✓ DONE $/ })
  expect(badge?.props.backgroundColor).toBe('success')
  expect(badge?.props.color).toBe('inverseText')
  expect((await reply.find({ type: 'Text', text: /^verts$/ }))?.props.color).toBe('success')
  expect((await reply.find({ type: 'Text', text: /^, prêt à recharger$/ }))?.props.bold).toBe(true)
  expect((await reply.find({ type: 'Text', text: /^commit$/ }))?.props.underline).toBe(true)
  expect((await reply.find({ type: 'Text', text: /^ \(instantané enregistré du code\)$/ }))?.props.dimColor).toBe(true)
  expect(await reply.find({ type: 'Text', text: /\{done\||\{term\|/ })).toBeUndefined()
  const writtenAt = clock(Date.parse('2026-10-22T10:00:00Z'))
  expect(await reply.find({ type: 'Text', text: new RegExp(`^Claude · ${writtenAt}$`) })).toBeDefined()
  await reply.unmount()

  // A later block of the same reply carries no label.
  const next = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'u2',
    props: { text: 'Suite.', isFirstOfReply: false },
  })
  expect(await next.find({ type: 'Text', text: /^Claude/ })).toBeUndefined()
  await next.unmount()

  // The word is kept for Learn → Words.
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-learn' })
  expect(await ui.find({ type: 'Text', text: /^commit$/ })).toBeUndefined()
  await ui.press({ key: 'learn-words' })
  expect(await ui.find({ type: 'Text', text: /^commit$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /instantané enregistré du code/ })).toBeDefined()
  await ui.unmount()
})

test('words kept by earlier sessions show under Learn → Words, and new ones are saved', async ($, on) => {
  engine(on)
  const saved: { key: string; value: unknown }[] = []
  on('store.get', (_, e) =>
    e.key === 'words'
      ? { value: [{ term: 'hook', meaning: 'script lancé à un moment précis', dir: 'cockpit', at: 1 }] }
      : { value: undefined },
  )
  on('store.set', (_, e) => {
    saved.push({ key: e.key, value: e.value })
    return { value: undefined }
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-learn' })
  await ui.press({ key: 'learn-words' })
  expect(await ui.find({ type: 'Text', text: /^hook$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /script lancé à un moment précis/ })).toBeDefined()
  await ui.press({ key: 'learn-insights' })
  expect(await ui.find({ type: 'Text', text: /^hook$/ })).toBeUndefined()
  await ui.unmount()

  // A word already known is not kept twice; a new one joins the saved list.
  await $.session.append({
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [{ type: 'text', text: 'Un {term|Hook|autre sens} puis un {term|diff|écart entre deux versions}.' }],
    },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid: 'u3',
  })
  await settle()
  const kept = saved.filter(item => item.key === 'words').at(-1)?.value as { term: string; meaning: string }[]
  expect(kept.map(item => item.term)).toEqual(['hook', 'diff'])
  expect(kept[0]?.meaning).toBe('script lancé à un moment précis')
})

test('a choice left to you waits above the prompt until you answer or close it', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const band = {
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: SCROLL, view: {} },
  } as const
  const end = (turnId: string, answer: string) =>
    $.turn.complete({ turnId, answer, durationMs: 1_000, isAborted: false, reason: 'answer' })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await end('t1', '{decide|Choisis A ou B pour la suite}\n\nDétails.')
  let ui = await $.ui.mount(band)
  const badge = await ui.find({ type: 'Text', text: /^ \? DECIDE $/ })
  expect(badge?.props.backgroundColor).toBe('warning')
  expect(await ui.find({ type: 'Text', text: /^ Choisis A ou B pour la suite$/ })).toBeDefined()
  await ui.unmount()

  // You answer: the row leaves.
  await $.turn.start({ text: 'A', turnId: 't2' })
  ui = await $.ui.mount(band)
  expect(await ui.find({ type: 'Text', text: /DECIDE/ })).toBeUndefined()
  await ui.unmount()

  // × closes it.
  await end('t2', '{decide|Garder ou retirer ?}\n\nDétails.')
  ui = await $.ui.mount(band)
  expect(await ui.find({ type: 'Text', text: /^ Garder ou retirer \?$/ })).toBeDefined()
  await ui.press({ key: 'cockpit-decision-close' })
  expect(await ui.find({ type: 'Text', text: /DECIDE/ })).toBeUndefined()
  await ui.unmount()

  // A polite offer closing finished work leaves nothing to decide.
  await $.turn.start({ text: 'go on', turnId: 't3' })
  await end('t3', '{done|Publié}\n\nTu veux que je l’annonce aussi ?')
  ui = await $.ui.mount(band)
  expect(await ui.find({ type: 'Text', text: /DECIDE/ })).toBeUndefined()
  await ui.unmount()

  // Nor does an answer that asks nothing, or a turn you stopped.
  await $.turn.start({ text: 'again', turnId: 't4' })
  await end('t4', 'Fait. Rien à décider.')
  await $.turn.start({ text: 'and again', turnId: 't5' })
  await $.turn.complete({ turnId: 't5', answer: '{decide|On continue ?}', durationMs: 1_000, isAborted: true, reason: 'aborted' })
  ui = await $.ui.mount(band)
  expect(await ui.find({ type: 'Text', text: /DECIDE/ })).toBeUndefined()
  await ui.unmount()
})

test('the rule closing a turn says when it ended and what it cost', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  spend.usd = 3.84
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1_000, isAborted: false, reason: 'answer' })

  const ruleRow = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'TurnDuration',
    requestId: 'turn_cost',
    props: { word: 'Cogitated', durationMs: 192_000 },
  })
  const ended = clock(Date.parse('2026-10-22T10:00:00Z'))
  expect(await ruleRow.find({ type: 'Text', text: new RegExp(`Done in 3m 12s · ${ended} · API \\$0\\.42 `) })).toBeDefined()
  await ruleRow.unmount()
})

test('after a restart, a reply still says when it was written', async ($, on) => {
  engine(on)
  on('session.id', () => ({ value: 'abc' }))
  const at = Date.parse('2026-10-22T09:30:00Z')
  mock.store(on, { 'session:abc': { ...SAVED_OLD, replyTimes: [{ id: 'u7', at }, { id: 42, at: 'bad' }] } })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()

  const reply = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'u7',
    props: { text: 'Bonjour.', isFirstOfReply: true },
  })
  expect(await reply.find({ type: 'Text', text: new RegExp(`^Claude · ${clock(at)}$`) })).toBeDefined()
  await reply.unmount()
})

test('the end-of-turn notification reads the verdict, without its marks', async ($, on) => {
  const ran: string[] = []
  engine(on, true, ran)
  on('turn.complete', () => ({ text: 'ok' }))
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({
    turnId: 't1',
    answer: '{decide|Choisis {orange|A} ou B}\n\nDétails.',
    durationMs: 120_000,
    isAborted: false,
    reason: 'answer',
  })
  await settle()
  expect(ran.some(argv => argv.includes(' — ? DECIDE — Choisis A ou B'))).toBe(true)
  expect(ran.some(argv => argv.includes('{decide|') || argv.includes('{orange|'))).toBe(false)
})

test('a reply finds its time when Claude Code draws it under a derived id', async ($, on) => {
  engine(on)
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Fait.' }] },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid: '72f54596-33ec-48af-b29a-c0e5bd25072c',
  })
  await settle()

  // Once the conversation holds a message of several parts, Claude Code draws each later one
  // under its row id's first 24 characters followed by the part's index.
  const reply = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: '72f54596-33ec-48af-b29a-000000000000',
    props: { text: 'Fait.', isFirstOfReply: true },
  })
  const writtenAt = clock(Date.parse('2026-10-22T10:00:00Z'))
  expect(await reply.find({ type: 'Text', text: new RegExp(`^Claude · ${writtenAt}$`) })).toBeDefined()
  await reply.unmount()
})

// ── The context gauge against the window of the model in use ─────────────────

function liveContext(on: On, tokens: number, compactWindow: number | null): void {
  live.tokens = tokens
  live.breakdown = settled(compactWindow, 1_000_000)
  on('turn.complete', () => ({ text: 'ok' }))
}
// One finished turn per size: the pane keeps a point of the context for each.
async function turnsAt($: Engine, sizes: readonly number[]): Promise<void> {
  for (const [index, size] of sizes.entries()) {
    live.tokens = size
    await $.turn.complete({ turnId: `t${index}`, answer: 'ok', durationMs: 1_000, isAborted: false, reason: 'answer' })
    await settle()
  }
}

test('the compaction point is the window the engine settled, and nothing else', () => {
  const window = { rawMaxTokens: 650_000, autocompactSource: 'settings', isAutoCompactEnabled: true }
  expect(settledWindow(window)).toBe(650_000)
  expect(settledWindow({ ...window, autocompactSource: 'env' })).toBe(650_000)
  // No setting: the model's own limit, which the gauge already measures against.
  expect(settledWindow({ ...window, rawMaxTokens: 1_000_000, autocompactSource: 'auto' })).toBe(null)
  // Auto-compaction off: nothing compacts, whatever the window.
  expect(settledWindow({ ...window, isAutoCompactEnabled: false })).toBe(null)
  // An answer that reads as no size, or no answer at all.
  expect(settledWindow({ ...window, rawMaxTokens: 0 })).toBe(null)
  expect(settledWindow({ ...window, rawMaxTokens: Number.NaN })).toBe(null)
  expect(settledWindow(undefined)).toBe(null)
})

test('turns to the compaction are announced only as far as the estimate holds', () => {
  expect(announcedTurns(null)).toBe(null)
  expect(announcedTurns(0)).toBe(0)
  expect(announcedTurns(10)).toBe(10)
  expect(announcedTurns(11)).toBe(null)
})

test('at 305K on Opus 5.5 the gauge reads against 650K and promises no compaction', async ($, on) => {
  engine(on)
  liveContext(on, 305_000, 650_000)
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  // +30K a turn: 11 turns left, too far to announce.
  await turnsAt($, [245_000, 275_000, 305_000])

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'details-toggle' })
  expect(await ui.find({ type: 'Text', text: /305K\/650K tokens/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /47%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /compacts/ })).toBeUndefined()
  await ui.unmount()
})

test('close to the compaction point the pane says how many turns are left', async ($, on) => {
  engine(on)
  liveContext(on, 580_000, 650_000)
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  // +30K a turn, 70K left: 2 turns.
  await turnsAt($, [520_000, 550_000, 580_000])

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /compacts in ~2 turns/ })).toBeDefined()
  await ui.unmount()
})

test('a change of model moves the compaction point, at its first request or its command', async ($, on) => {
  engine(on)
  liveContext(on, 305_000, 650_000)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  await turnsAt($, [245_000, 275_000, 305_000])

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'details-toggle' })
  expect(await ui.find({ type: 'Text', text: /305K\/650K tokens/ })).toBeDefined()

  // /model between two turns: its output row is the first sign of the new model.
  live.breakdown = settled(300_000, 1_000_000)
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'Set model to Sonnet 5.5' }] },
    door: 'command',
    origin: { kind: 'human' },
    uuid: 'c1',
  } as never)
  await settle()
  expect(await ui.find({ type: 'Text', text: /305K\/300K tokens/ })).toBeDefined()
  // Already past the new point: the next turn compacts, as the 25/10 switch to Haiku did at 379K.
  expect(await ui.find({ type: 'Text', text: /compacts next turn/ })).toBeDefined()

  // A model changed without any command (a fallback): the first request names it.
  live.breakdown = settled(650_000, 1_000_000)
  for await (const _ of $.turn.step({ turnId: 't9', index: 0, model: 'claude-fable-5', messageCount: 1 })) {
    // nothing to read in the stream
  }
  await settle()
  expect(await ui.find({ type: 'Text', text: /305K\/650K tokens/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /compacts/ })).toBeUndefined()
  await ui.unmount()
})

test('a subagent on another model leaves the compaction point alone', async ($, on) => {
  engine(on)
  liveContext(on, 305_000, 650_000)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const before = live.breakdown
  live.breakdown = settled(300_000, 1_000_000)
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1' })) {
    // nothing to read in the stream
  }
  await settle()
  live.breakdown = before

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'details-toggle' })
  expect(await ui.find({ type: 'Text', text: /305K\/650K tokens/ })).toBeDefined()
  await ui.unmount()
})

test('with no window to read, the gauge keeps the model and promises nothing', async ($, on) => {
  engine(on)
  liveContext(on, 305_000, 650_000)
  live.breakdown = 'refused'
  mock.store(on, {})
  // The answer is refused from the start: the session and the pane go on all the same.
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  await turnsAt($, [245_000, 275_000, 305_000])

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'details-toggle' })
  expect(await ui.find({ type: 'Text', text: /305K\/1000K tokens/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /compacts/ })).toBeUndefined()

  // Read once, then lost after a turn: no stale point stays on screen.
  live.breakdown = settled(650_000, 1_000_000)
  await turnsAt($, [335_000])
  expect(await ui.find({ type: 'Text', text: /335K\/650K tokens/ })).toBeDefined()
  live.breakdown = 'absent'
  await turnsAt($, [365_000])
  expect(await ui.find({ type: 'Text', text: /365K\/1000K tokens/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /compacts/ })).toBeUndefined()
  await ui.unmount()
})

test('with no setting the gauge reads against the model, as before', async ($, on) => {
  engine(on)
  liveContext(on, 305_000, null)
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  await turnsAt($, [245_000, 275_000, 305_000])

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'details-toggle' })
  expect(await ui.find({ type: 'Text', text: /305K\/1000K tokens/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /compacts/ })).toBeUndefined()
  await ui.unmount()
})

// ── The Git tab ──────────────────────────────────────────────────────────────

const GIT_NOW = new Date(2026, 10, 3, 12).getTime()
const gitSeconds = (month: number, day: number, hour = 12) => Math.floor(new Date(2026, month - 1, day, hour).getTime() / 1000)
const OPUS = 'Claude Opus 5.5 <noreply@anthropic.com>'
const SONNET = 'Claude Sonnet 5 <noreply@anthropic.com>'
// Built in two parts: the host name is the only thing the fake link borrows from a real one.
const SESSION_BASE = 'https://claude.' + 'ai/code/session_'
const SESSION = SESSION_BASE + 'Zx8Qk2mP7TqLwNvB3yRfHcD'
const logRow = (drawing: string, hash: string, at: number, decoration: string, subject: string, coAuthor = '', session = '') =>
  [drawing, hash, at, decoration, coAuthor, session, subject].join('\x1f')
const refRow = (name: string, at: number, subject: string, coAuthor = '', session = '') =>
  [name, name.slice(0, 7), at, coAuthor, session, subject].join('\x1f')

type FakeRepo = {
  branch: string | null
  head: string | null
  log: string[]
  refs: string[]
  total: number
  status?: string
  origin?: string
  unmerged?: string[]
  compare?: Readonly<Record<string, string>>
  worktrees?: string
  top?: string
}

// Git as the tab reads it: a command it was not meant to run fails the test, which is also what
// keeps the tab read-only.
function fakeGit(repo: FakeRepo, seen: string[] = []): GitCommand {
  const top = repo.top ?? '/code/cockpit'
  return async args => {
    const command = args.join(' ')
    seen.push(command)
    const yes = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
    const no = { exitCode: 1, stdout: '', stderr: '' }
    if (command.startsWith('rev-parse --path-format')) return yes(`/code/cockpit/.git\n${top}\n`)
    if (command === 'symbolic-ref --short -q HEAD') return repo.branch !== null ? yes(`${repo.branch}\n`) : no
    if (command.startsWith('rev-parse -q --verify')) return repo.head !== null ? yes(`${repo.head}\n`) : no
    if (args[0] === 'status') return yes(repo.status ?? '')
    if (command.startsWith('for-each-ref refs/heads --sort')) return yes(repo.refs.join('\n'))
    if (command === 'symbolic-ref --short -q refs/remotes/origin/HEAD') return repo.origin !== undefined ? yes(repo.origin) : no
    if (args[0] === 'worktree') return yes(repo.worktrees ?? `worktree ${top}\nHEAD abc\nbranch refs/heads/main\n\n`)
    if (args[0] === 'log') return yes(repo.log.join('\n'))
    if (command.startsWith('rev-list --count')) return yes(`${repo.total}\n`)
    if (command.startsWith('for-each-ref refs/heads --no-merged')) return yes((repo.unmerged ?? []).join('\n'))
    if (command.startsWith('rev-list --left-right')) {
      return yes(repo.compare?.[/\.\.\.refs\/heads\/(.+)$/.exec(command)?.[1] ?? ''] ?? '0\t0\n')
    }
    throw new Error(`unexpected git command: ${command}`)
  }
}

// The first mockup: the mod's own repository, in a straight line, nothing to merge.
const STRAIGHT: FakeRepo = {
  branch: 'main',
  head: '2f377d5',
  total: 14,
  log: [
    logRow('* ', '2f377d5', gitSeconds(10, 25), 'main', 'Start the dev server in a new Ghostty tab, like Fork', OPUS, SESSION),
    logRow('* ', 'a913239', gitSeconds(10, 25), 'fork-own-ghostty', 'Send the fork tab to the Ghostty that hosts the session', OPUS, SESSION),
    logRow('* ', '74c9810', gitSeconds(10, 25), 'fork-tab', 'Open the fork in a new Ghostty tab instead of a new window'),
    logRow('* ', 'cbddaa8', gitSeconds(10, 24), 'fork-session-button', 'Move the Fork button to the action row and shorten it'),
    logRow('* ', 'd516cc8', gitSeconds(10, 24), '', 'Add a Fork session button that resumes the session in Ghostty'),
    logRow('* ', 'e000001', gitSeconds(10, 23), '', 'Show the decision band only for a decide verdict'),
    logRow('* ', 'e000002', gitSeconds(10, 23), '', 'An older commit'),
    logRow('* ', 'e000003', gitSeconds(10, 22), '', 'The oldest commit'),
  ],
  refs: [
    refRow('main', gitSeconds(10, 25), 'Start the dev server', OPUS, SESSION),
    refRow('fork-own-ghostty', gitSeconds(10, 25), 'Send the fork tab'),
    refRow('fork-tab', gitSeconds(10, 25), 'Open the fork'),
    refRow('fork-session-button', gitSeconds(10, 24), 'Move the Fork button'),
    refRow('dev-server-tab', gitSeconds(10, 23), 'An older tip'),
  ],
}

// The second mockup: three branches to merge, drawn as the audit's throwaway repository is.
const BRANCHES: FakeRepo = {
  branch: 'main',
  head: '4ca5876',
  total: 16,
  status: ' M a.txt\n?? b.txt\n',
  unmerged: ['feat/billing', 'feat/search', 'feat/dark-mode'],
  compare: { 'feat/billing': '6\t3\n', 'feat/search': '3\t3\n', 'feat/dark-mode': '0\t1\n' },
  refs: [
    refRow('feat/billing', gitSeconds(11, 3, 10), 'Add invoice email', SONNET),
    refRow('feat/dark-mode', gitSeconds(11, 3, 8), 'Add dark theme tokens', OPUS),
    refRow('main', gitSeconds(11, 2), 'Merge chore/deps'),
    refRow('feat/search', gitSeconds(11, 2), 'Debounce search input', OPUS),
    refRow('chore/deps', gitSeconds(11, 1), 'Run audit'),
    refRow('fix/cart-bug', gitSeconds(10, 30), 'Fix cart total rounding'),
  ],
  log: [
    logRow('* ', '3ae20f1', gitSeconds(11, 3, 10), 'feat/billing', 'Add invoice email'),
    logRow('* ', 'b7fbf6a', gitSeconds(11, 3, 9), '', 'Wire Stripe webhook'),
    logRow('* ', '418276e', gitSeconds(11, 3, 8), '', 'Add billing table'),
    logRow('| * ', '6ec4015', gitSeconds(11, 3, 8), 'feat/dark-mode', 'Add dark theme tokens'),
    logRow('| *   ', '4ca5876', gitSeconds(11, 2), 'main', 'Merge chore/deps'),
    '| |\\  ',
    logRow('| | * ', '4247f71', gitSeconds(11, 1), 'chore/deps', 'Run audit'),
    logRow('| | * ', 'e6b00f0', gitSeconds(11, 1), '', 'Bump deps'),
    '| |/  ',
    '|/|   ',
    logRow('| | * ', 'be42a97', gitSeconds(11, 2), 'feat/search', 'Debounce search input'),
    logRow('| | * ', 'd38f015', gitSeconds(11, 1), '', 'Add search results'),
    logRow('| | * ', '19e47d8', gitSeconds(11, 1), '', 'Add search box'),
    '| |/  ',
    logRow('* ', 'f9d4ad1', gitSeconds(10, 1), '', 'Initial commit'),
  ],
}

async function readFacts(repo: FakeRepo, seen: string[] = []) {
  const view = await readGitTab(fakeGit(repo, seen))
  if (view.status !== 'ready') throw new Error(`the repository was not read: ${view.status}`)
  return view.facts
}
const drawnWidth = (line: GitLine) =>
  cells(lineText(line)) + (line.right !== undefined ? 1 + cells(line.right.map(part => part.text).join('')) : 0)
const layoutOf = async (repo: FakeRepo, rows = 13, width = 61, isUnfolded = false, graph: boolean | null = null) => {
  const facts = await readFacts(repo)
  return gitLayout(facts, { width, rows, now: GIT_NOW, isGraphOpen: isGraphShown(graph, facts), isUnfolded })
}

test('git tab: a straight history is the journal, with its labels, the signature and the cut said', async () => {
  const lines = await layoutOf(STRAIGHT, 9)
  expect(lineText(lines[0]!)).toBe('cockpit · on main · nothing to merge · clean')
  expect(lineText(lines[1]!)).toBe('● main  Start the dev server in a new Ghostty tab, lik…')
  expect(lines[1]!.right?.[0]?.text).toBe('25/10')
  // The session's signature, under the active branch.
  expect(lineText(lines[2]!)).toBe('│       Opus 5.5 · session Zx8Qk…')
  expect(lineText(lines[3]!)).toContain('● fork-own-ghostty  Send the fork tab')
  // No hash in the journal, no graph on a straight line.
  expect(lines.map(lineText).join('\n')).not.toContain('a913239')
  expect(lines.some(line => line.action === 'graph')).toBe(false)
  expect(lines.length).toBe(9)
  // 7 commits fit nowhere: the last row says what is left, and unfolds it.
  expect(lines.at(-1)).toMatchObject({ action: 'unfold', key: 'git-cut' })
  expect(lineText(lines.at(-1)!)).toBe('▸ 8 older commits · 4 merged branches')
})

test('git tab: open branches come first, then the graph with its hashes', async () => {
  const lines = await layoutOf(BRANCHES, 16)
  const texts = lines.map(lineText)
  expect(texts[0]).toBe('cockpit · on main · 3 to merge · 2 uncommitted')
  expect(texts[1]).toContain('feat/billing')
  expect(texts[1]).toContain('+3 -6  Add invoice email')
  expect(lines[1]!.right?.[0]?.text).toBe('Sonnet 2h')
  expect(texts[2]).toContain('+1 -0  Add dark theme tokens')
  expect(lines[2]!.right?.[0]?.text).toBe('Opus 4h')
  expect(texts[3]).toContain('+3 -3  Debounce search input')
  expect(lines[3]!.right?.[0]?.text).toBe('Opus 1d')
  expect(lines[4]).toMatchObject({ key: 'git-graph-toggle', action: 'graph' })
  expect(texts[4]).toBe('▾ graph')
  expect(texts[5]).toBe('* 3ae20f1 feat/billing  Add invoice email')
  expect(texts).toContain('| *   4ca5876 main  Merge chore/deps')
  expect(texts).toContain('| |\\')
  // Merged branches are counted, not listed, and only the graph holds hashes.
  expect(texts.at(-1)).toContain('2 merged branches')
  expect(texts.slice(0, 4).join('\n')).not.toContain('3ae20f1')
})

test('git tab: the graph folds, and leaves its rows to nothing else', async () => {
  const lines = await layoutOf(BRANCHES, 13, 61, false, false)
  const texts = lines.map(lineText)
  expect(texts.some(text => text.startsWith('▸ graph · 15 lines'))).toBe(true)
  expect(texts.join('\n')).not.toContain('3ae20f1')
})

test('git tab: a merged history with nothing to merge is the journal, the graph one press away', async () => {
  const repo: FakeRepo = { ...BRANCHES, status: '', unmerged: [], compare: {} }
  const lines = await layoutOf(repo, 10)
  const texts = lines.map(lineText)
  expect(texts[0]).toBe('cockpit · on main · nothing to merge · clean')
  expect(texts[1]).toContain('●')
  expect(texts.join('\n')).not.toContain('3ae20f1')
  expect(lines.at(-2)).toMatchObject({ key: 'git-graph-toggle', action: 'graph' })
  expect(lines.length).toBeLessThanOrEqual(10)
  // Opened, the graph takes the journal's place.
  const open = (await layoutOf(repo, 10, 61, false, true)).map(lineText)
  expect(open.some(text => text.startsWith('* 3ae20f1'))).toBe(true)
  expect(open[1]).toBe('▾ graph')
})

test('git tab: a straight history with a branch ahead keeps the journal, no graph', async () => {
  const repo: FakeRepo = {
    branch: 'feat/x',
    head: 'aaa1111',
    total: 2,
    unmerged: ['feat/x'],
    compare: { 'feat/x': '0\t1\n' },
    refs: [refRow('feat/x', gitSeconds(11, 3), 'Next step', OPUS, SESSION), refRow('main', gitSeconds(11, 2), 'First')],
    log: [
      logRow('* ', 'aaa1111', gitSeconds(11, 3), 'feat/x', 'Next step', OPUS, SESSION),
      logRow('* ', 'bbb2222', gitSeconds(11, 2), 'main', 'First'),
    ],
  }
  const lines = await layoutOf(repo)
  const texts = lines.map(lineText)
  expect(texts[0]).toBe('cockpit · on feat/x · 1 to merge · clean')
  expect(texts[1]).toContain('+1 -0  Next step')
  // The active branch is a row of its own: its signature goes under it, once.
  expect(texts[2]).toBe('  Opus 5.5 · session Zx8Qk…')
  expect(texts.filter(text => text.includes('session Zx8Qk'))).toHaveLength(1)
  expect(lines.some(line => line.action === 'graph')).toBe(false)
  expect(texts[3]).toContain('● feat/x  Next step')
})

test('git tab: on the main branch with branches open, its signature sits under the header', async () => {
  const repo: FakeRepo = {
    ...BRANCHES,
    log: BRANCHES.log.map(row =>
      row.includes('4ca5876') ? logRow('| *   ', '4ca5876', gitSeconds(11, 2), 'main', 'Merge chore/deps', OPUS, SESSION) : row,
    ),
  }
  const texts = (await layoutOf(repo, 16)).map(lineText)
  expect(texts[1]).toBe('main  Opus 5.5 · session Zx8Qk…')
})

test('git tab: no trailers, no signature and no model, without an error', async () => {
  const repo: FakeRepo = {
    ...STRAIGHT,
    log: STRAIGHT.log.map((row, index) => logRow('* ', `abc000${index}`, gitSeconds(10, 25), index === 0 ? 'main' : '', 'A commit')),
    refs: [refRow('main', gitSeconds(10, 25), 'A commit')],
    head: 'abc0000',
    total: 8,
  }
  const lines = await layoutOf(repo)
  expect(lines.map(lineText).join('\n')).not.toContain('session')
  expect(lineText(lines[2]!)).toBe('● A commit')

  const noModel: FakeRepo = { ...BRANCHES, refs: BRANCHES.refs.map(row => row.replaceAll(/Claude (Sonnet|Opus)[^\x1f]*/g, '')) }
  const row = (await layoutOf(noModel))[1]!
  expect(row.right?.[0]?.text).toBe('2h')
})

test('git tab: trailers read a model and a session, and nothing else', () => {
  expect(readModel('Claude Opus 5.5 <noreply@anthropic.com>')).toBe('Opus 5.5')
  expect(readModel('Someone <a@b.c>\x1eClaude Sonnet 5 <noreply@anthropic.com>')).toBe('Sonnet 5')
  expect(readModel('claude haiku <x@y>')).toBe('Haiku')
  expect(readModel('Claude Monet <monet@giverny.fr>')).toBeNull()
  expect(readModel('')).toBeNull()
  expect(readSession(SESSION_BASE + 'Zx8Qk2mP7T')).toBe('Zx8Qk2mP7T')
  expect(readSession('')).toBeNull()
  expect(readSession(SESSION_BASE + 'Zx8Qk\x1e' + SESSION_BASE + 'Qw3Er')).toBe('Zx8Qk')
})

test('git tab: every row keeps to the pane, at each real width and with long names', async () => {
  const long = 'feat/a-really-long-branch-name-that-an-agent-would-pick-for-its-worktree'
  const repo: FakeRepo = {
    branch: long,
    head: 'aaa1111',
    total: 40,
    status: ' M a\n M b\n M c\n',
    unmerged: [long, 'fix/🚀-launch-日本語-branch'],
    compare: { [long]: '1200\t31000\n', 'fix/🚀-launch-日本語-branch': '2\t5\n' },
    worktrees: `worktree /code/cockpit\nbranch refs/heads/main\n\nworktree /tmp/wt/p7\nbranch refs/heads/${long}\n\n`,
    refs: [
      refRow(long, gitSeconds(11, 3), 'A subject long enough to need cutting, whatever the width of the pane is', OPUS, SESSION),
      refRow('fix/🚀-launch-日本語-branch', gitSeconds(11, 2), '🚀 日本語のとても長いコミットメッセージ、とても長いです、とても長いです', SONNET),
      refRow('main', gitSeconds(11, 1), 'First'),
      refRow('merged-branch-with-a-long-name-too-and-more-and-more-and-more', gitSeconds(10, 1), 'Merged long ago with a long message'),
    ],
    log: [
      logRow('| | | | | | | | | | | | | | | | | | | | | | | | | | | | | | | * ', 'aaa1111', gitSeconds(11, 3), `${long}, main, other-branch`, 'A subject long enough to need cutting, again and again and again'),
      '| | | | | | | | | | | | | | | | | | | | | | | | | | | | | | | | | | | |\\',
      logRow('* ', 'bbb2222', gitSeconds(11, 1), long, 'Another subject long enough to need cutting, again and again and again'),
    ],
  }
  for (const width of [48, 53, 61]) {
    for (const isUnfolded of [false, true]) {
      for (const graph of [true, false]) {
        const lines = await layoutOf(repo, 13, width, isUnfolded, graph)
        for (const line of lines) {
          expect(drawnWidth(line)).toBeLessThanOrEqual(line.key === 'git-header' ? width - 2 : width)
        }
      }
    }
  }
  const narrow = await layoutOf(repo, 13, 48)
  // The status stays whole: a long name is what gets cut.
  expect(lineText(narrow[0]!)).toContain('2 to merge · 3 uncommitted')
  expect(lineText(narrow[0]!)).toContain('…')
  expect(lineText(narrow[1]!)).toContain('…')
  expect(fit('abcdef', 4)).toBe('abc…')
  expect(fit('abcd', 4)).toBe('abcd')
  expect(fit('日本語', 4)).toBe('日…')
  expect(cells('日本語🚀')).toBe(8)
  expect(cells('é')).toBe(1)
})

test('git tab: the rows are counted, however few there are, and nothing is cut in silence', async () => {
  for (const rows of [4, 5, 6, 7, 9, 13]) {
    const lines = await layoutOf(BRANCHES, rows)
    expect(lines.length).toBeLessThanOrEqual(rows)
    expect(lines.at(-1)?.action).toBe('unfold')
    // An open graph with not one stroke under it does not take a row.
    if (!lines.some(line => line.key.startsWith('git-graph-') && !line.key.endsWith('toggle'))) {
      expect(lines.some(line => line.key === 'git-graph-toggle')).toBe(false)
      expect(lineText(lines.at(-1)!)).toContain('graph')
    }
    const said = lineText(lines.at(-1)!)
    expect(said).toContain('2 merged branches')
    const shown = lines.filter(line => line.key.startsWith('git-graph-') && !line.key.endsWith('toggle') && /[a-f0-9]{7}/.test(lineText(line))).length
    if (shown > 0) expect(said).toContain(`${16 - shown} older commits`)
    else expect(said).toContain('16 commits')
    const branchRows = lines.filter(line => line.key.startsWith('git-branch-')).length
    if (branchRows < 3) expect(said).toContain(`${3 - branchRows} more branch`)
  }
  // Too short for the branches: the graph's row is named on the last one.
  expect(lineText((await layoutOf(BRANCHES, 4)).at(-1)!)).toContain('graph')
})

test('git tab: unfolded, everything read is drawn, and the limit of the read is said', async () => {
  const facts = await readFacts(BRANCHES)
  const lines = gitLayout(facts, { width: 61, rows: 5, now: GIT_NOW, isGraphOpen: true, isUnfolded: true })
  const texts = lines.map(lineText)
  expect(lines.length).toBeGreaterThan(5)
  for (const hash of ['3ae20f1', '4247f71', 'be42a97', 'f9d4ad1']) {
    expect(texts.some(text => text.includes(hash))).toBe(true)
  }
  expect(texts.some(text => text.includes('✓ chore/deps'))).toBe(true)
  expect(texts.some(text => text.includes('✓ fix/cart-bug'))).toBe(true)
  // 16 commits exist, 11 were read: the fold row says so.
  expect(lines.at(-1)).toMatchObject({ key: 'git-fold', action: 'unfold' })
  expect(texts.at(-1)).toBe('▾ fold · newest 11 of 16 commits')
})

test('git tab: other working copies are counted and listed, this one left out', async () => {
  const repo: FakeRepo = {
    ...STRAIGHT,
    worktrees: 'worktree /code/cockpit\nHEAD a\nbranch refs/heads/main\n\nworktree /tmp/scratch/wt/p7\nHEAD b\nbranch refs/heads/feat/p7\n\nworktree /tmp/scratch/wt/p8\nHEAD c\ndetached\n\n',
  }
  expect(parseWorktrees(repo.worktrees!, '/code/cockpit')).toEqual([
    { path: '/tmp/scratch/wt/p7', branch: 'feat/p7' },
    { path: '/tmp/scratch/wt/p8', branch: '' },
  ])
  const folded = await layoutOf(repo, 9)
  expect(lineText(folded.at(-1)!)).toBe('▸ 8 older commits · 4 merged branches · 2 worktrees')
  const texts = (await layoutOf(repo, 9, 61, true)).map(lineText)
  expect(texts).toContain('⌂ feat/p7  wt/p7')
  expect(texts).toContain('⌂ wt/p8')
})

test('git tab: an empty repository, a detached HEAD and no main branch each read plainly', async () => {
  const empty = await layoutOf({ branch: 'main', head: null, log: [], refs: [], total: 0 })
  expect(empty.map(lineText)).toEqual(['cockpit · on main · no commits yet · clean'])

  const detached = await layoutOf({ ...STRAIGHT, branch: null })
  expect(lineText(detached[0]!)).toBe('cockpit · detached 2f377d5 · nothing to merge · clean')

  const trunk: FakeRepo = { ...STRAIGHT, branch: 'trunk', refs: [refRow('trunk', gitSeconds(10, 25), 'Start')] }
  const seen: string[] = []
  const facts = await readFacts(trunk, seen)
  expect(facts.base).toBeNull()
  expect(seen.some(command => command.includes('--no-merged'))).toBe(false)
  expect(lineText(gitLayout(facts, { width: 61, rows: 9, now: GIT_NOW, isGraphOpen: false, isUnfolded: false })[0]!)).toBe(
    'cockpit · on trunk · no main branch · clean',
  )

  // The main branch is the one origin names, when it has one.
  const named = await readFacts({ ...BRANCHES, origin: 'origin/feat/search\n', unmerged: [] })
  expect(named.base).toBe('feat/search')
  // master, when there is no main.
  const old = await readFacts({ ...STRAIGHT, refs: [refRow('master', gitSeconds(10, 25), 'Start')] })
  expect(old.base).toBe('master')
})

test('git tab: what the read leaves out is said too', async () => {
  // A status cut by the engine's limit is a lower bound.
  const huge = async (args: readonly string[]) => {
    const answer = await fakeGit(STRAIGHT)(args)
    return args[0] === 'status' ? { ...answer, stdout: ' M a\n M b\n', isStdoutTruncated: true } : answer
  }
  const view = await readGitTab(huge)
  if (view.status !== 'ready') throw new Error('not read')
  const header = gitLayout(view.facts, { width: 61, rows: 9, now: GIT_NOW, isGraphOpen: false, isUnfolded: false })[0]!
  expect(lineText(header)).toContain('2+ uncommitted')

  // 50 branches to merge: all counted, the newest 40 compared, the others named.
  const names = Array.from({ length: 50 }, (_, index) => `feat/${index}`)
  const seen: string[] = []
  const many: FakeRepo = {
    ...STRAIGHT,
    unmerged: names,
    refs: [...names.map(name => refRow(name, gitSeconds(11, 1), 'Work')), refRow('main', gitSeconds(10, 25), 'Start')],
  }
  const facts = await readFacts(many, seen)
  expect(facts.toMerge).toBe(50)
  expect(seen.filter(command => command.startsWith('rev-list --left-right'))).toHaveLength(40)
  const folded = gitLayout(facts, { width: 61, rows: 8, now: GIT_NOW, isGraphOpen: false, isUnfolded: false })
  expect(lineText(folded[0]!)).toContain('50 to merge')
  expect(lineText(folded.at(-1)!)).toContain('44 more branches')
  const open = gitLayout(facts, { width: 61, rows: 8, now: GIT_NOW, isGraphOpen: false, isUnfolded: true })
  expect(lineText(open.at(-1)!)).toContain('10 branches not compared')

  // 200 branches read, and maybe more: the count says so.
  const refs = Array.from({ length: 200 }, (_, index) => refRow(`old/${index}`, gitSeconds(10, 1), 'Old'))
  const capped = await readFacts({ ...STRAIGHT, refs: [refRow('main', gitSeconds(10, 25), 'Start'), ...refs.slice(1)] })
  const cut = gitLayout(capped, { width: 61, rows: 8, now: GIT_NOW, isGraphOpen: false, isUnfolded: false })
  expect(lineText(cut.at(-1)!)).toContain('199+ merged branches')
})

test('git tab: a commit message cannot draw on the pane', () => {
  const [row] = parseGraph(logRow('* ', 'abc1234', 1, 'main', 'Evil\x1b[2J\x07 message\ttabbed', OPUS), 'main', 'abc1234')
  expect(row?.commit?.subject).toBe('Evil [2J  message tabbed')
  expect(row?.commit?.isHead).toBe(true)
  // A strokes-only row carries no commit.
  expect(parseGraph('| |\\  ', null, null)[0]).toEqual({ drawing: '| |\\', commit: null })
  expect(parseAheadBehind('6\t3\n')).toEqual({ behind: 6, ahead: 3 })
  expect(parseAheadBehind('not a count')).toBeNull()
})

test('git tab: dates read in local time, ages in their largest unit', () => {
  const now = new Date(2026, 10, 3, 12).getTime()
  // 00:30 local on the 25th is the 25th here, whatever day UTC calls it.
  expect(dayMonth(new Date(2026, 9, 25, 0, 30).getTime(), now)).toBe('25/10')
  expect(dayMonth(new Date(2026, 9, 25, 23, 30).getTime(), now)).toBe('25/10')
  expect(dayMonth(new Date(2025, 9, 25, 12).getTime(), now)).toBe('25/10/25')
  expect(shortAge(30_000)).toBe('now')
  expect(shortAge(45 * 60_000)).toBe('45m')
  expect(shortAge(2 * 3_600_000)).toBe('2h')
  expect(shortAge(30 * 3_600_000)).toBe('1d')
})

test('git tab: the row of tabs keeps to the pane, its widest badges leaving first', () => {
  const tabs = [
    { id: 'files', label: 'Files', badge: '12', widest: '12 ✦' },
    { id: 'git', label: 'Git', badge: '' },
    { id: 'learn', label: 'Learn', badge: '34 •' },
    { id: 'pins', label: 'Pins', badge: '3' },
    { id: 'notes', label: 'Notes', badge: '•' },
  ]
  const rowWidth = (labels: string[]) => labels.reduce((sum, label) => sum + cells(label) + 4, 0) + labels.length - 1
  // 61 columns: all of them. Measured at its widest, a flash costs no badge on the next frame.
  expect(fitTabLabels(tabs, 61)).toEqual(['Files 12', 'Git', 'Learn 34 •', 'Pins 3', 'Notes •'])
  expect(fitTabLabels(tabs.map(tab => (tab.id === 'files' ? { ...tab, badge: '12 ✦' } : tab)), 61)[0]).toBe('Files 12 ✦')
  for (const width of [46, 48, 50, 52, 53, 55, 58, 61]) {
    expect(rowWidth(fitTabLabels(tabs, width))).toBeLessThanOrEqual(width)
  }
  expect(fitTabLabels(tabs, 48)).toEqual(['Files', 'Git', 'Learn', 'Pins', 'Notes •'])
  expect(fitTabLabels(tabs, 46)).toEqual(['Files', 'Git', 'Learn', 'Pins', 'Notes'])
  // Narrower than the bare names, the row has nothing more to give.
  expect(fitTabLabels(tabs, 30)).toEqual(['Files', 'Git', 'Learn', 'Pins', 'Notes'])
})

test('git tab: a drawn tree says how many rows it takes', () => {
  const text = (children: unknown, props: Record<string, unknown> = {}) => ({ type: 'Text', props, children: [children] })
  const box = (props: Record<string, unknown>, ...children: unknown[]) => ({ type: 'Box', props, children })
  expect(treeRows(text('short'), 20)).toBe(1)
  expect(treeRows(text('one two three four five six seven eight'), 10)).toBe(5)
  expect(treeRows(text('a very long line that truncates', { wrap: 'truncate-end' }), 10)).toBe(1)
  expect(treeRows(box({ flexDirection: 'column' }, text('a'), text('b'), null, false, [text('c')]), 10)).toBe(3)
  expect(treeRows(box({ flexDirection: 'row' }, text('a'), text('b')), 10)).toBe(1)
  expect(treeRows(box({ display: 'none' }, text('a')), 10)).toBe(0)
  expect(treeRows(box({ flexDirection: 'column', height: 7 }, text('a')), 10)).toBe(7)
  expect(treeRows({ type: 'Button', props: { label: 'x' } }, 10)).toBe(1)
  const buttons = Array.from({ length: 6 }, () => ({ type: 'Button', props: { label: 'Reused' } }))
  expect(treeRows(box({ flexDirection: 'row', flexWrap: 'wrap' }, ...buttons), 22)).toBe(3)
  // The action row at 110 columns: 51 cells of buttons in 48 columns, one folds.
  const actions = ['Diff', 'Compact', 'Folder', 'Cursor', 'Fork'].map(label => ({ type: 'Button', props: { label } }))
  expect(treeRows(box({ flexDirection: 'row', gap: 1 }, ...actions), 61)).toBe(1)
  expect(treeRows(box({ flexDirection: 'row', gap: 1 }, ...actions), 48)).toBe(2)
  expect(treeRows(box({ flexDirection: 'row' }, { type: 'Button', props: { label: 'x'.repeat(30), plain: true } }), 48)).toBe(1)
})

// Git's commands, each as the Git tab ran it.
const gitTabCommands = (ran: readonly string[]) =>
  ran
    .map(run => JSON.parse(run) as { argv: string[]; init?: { cwd?: string; timeoutMs?: number } })
    .filter(run => run.argv[0] === 'git' && run.argv[1] === GIT_READ_OPTIONS[0])

test('the Git tab is the second one, and is read only once opened: no read before, no timer after', async ($, on) => {
  const ran: string[] = []
  const clock = engine(on, true, ran)
  mock.store(on, {})
  on('turn.complete', () => ({ text: 'ok' }))
  gitTabAnswers.run = fakeGit(STRAIGHT)
  await $.session.start({ cwd: '/where/it/started', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount(PANE)

  const tabs = (await ui.findAll({ type: 'Button' })).map(button => button.key).filter(key => key?.startsWith('tab-'))
  expect(tabs).toEqual(['tab-files', 'tab-git', 'tab-learn', 'tab-pins', 'tab-notes'])

  // A turn ends before the tab was ever opened: nothing is read.
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1_000, isAborted: false, reason: 'answer' })
  await settle()
  expect(gitTabCommands(ran)).toEqual([])

  // Opened: read, from the folder the session started in, not where Claude has gone since.
  await ui.press({ key: 'tab-git' })
  await settle()
  const opened = gitTabCommands(ran)
  expect(opened.length).toBeGreaterThan(5)
  expect(opened.every(run => run.init?.cwd === '/where/it/started')).toBe(true)
  expect(opened.every(run => run.init?.timeoutMs === 30_000)).toBe(true)
  expect(await ui.find({ type: 'Text', text: /cockpit · on main · nothing to merge · clean/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Opus 5\.5 · session Zx8Qk…/ })).toBeDefined()

  // Read-only: only these subcommands, and never an optional lock.
  const read = new Set(['rev-parse', 'symbolic-ref', 'status', 'for-each-ref', 'worktree', 'log', 'rev-list'])
  for (const run of opened) {
    const args = run.argv.slice(1 + GIT_READ_OPTIONS.length)
    expect(read.has(args[0] ?? '')).toBe(true)
    expect(run.argv.slice(1, 1 + GIT_READ_OPTIONS.length)).toEqual([...GIT_READ_OPTIONS])
    expect(args[0] === 'worktree' ? args[1] : 'list').toBe('list')
  }
  // No button that acts on the repository.
  const keys = (await ui.findAll({ type: 'Button' })).map(button => String(button.key)).filter(key => key.startsWith('git-'))
  expect(keys.sort()).toEqual(['git-cut', 'git-reload'])

  // No timer: time goes by, nothing more is read.
  const count = () => gitTabCommands(ran).length
  const before = count()
  await clock.advance(600_000)
  await settle()
  expect(count()).toBe(before)

  // ↻ reads again, and so does each turn's end, the tab shown or not.
  await ui.press({ key: 'git-reload' })
  await settle()
  const afterReload = count()
  expect(afterReload).toBeGreaterThan(before)
  await ui.press({ key: 'tab-files' })
  await $.turn.complete({ turnId: 't2', answer: 'ok', durationMs: 1_000, isAborted: false, reason: 'answer' })
  await settle()
  const afterTurn = count()
  expect(afterTurn).toBeGreaterThan(afterReload)

  // A subagent's turn is not one of yours.
  await $.turn.complete({ turnId: 't3', agentId: 'a1', answer: 'ok', durationMs: 1_000, isAborted: false, reason: 'answer' })
  await settle()
  expect(count()).toBe(afterTurn)
  await ui.unmount()
})

test('outside a git repository the Git tab says so in a line, and the pane stays', async ($, on) => {
  engine(on, false)
  mock.store(on, {})
  gitTabAnswers.run = async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-git' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /^Not a git repository\.$/ })).toBeDefined()
  expect(await ui.find({ key: 'git-reload' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Context/ })).toBeDefined()
  await ui.unmount()
})

test('git that fails or hangs shows a message, breaks nothing, and ↻ gets it back', async ($, on) => {
  const ran: string[] = []
  engine(on, true, ran)
  mock.store(on, {})
  on('turn.complete', () => ({ text: 'ok' }))
  // A run that cannot start or outlasts its 30 s rejects.
  gitTabAnswers.run = async () => {
    throw new Error('timed out after 30000ms')
  }
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-git' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /Couldn’t read git/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Context/ })).toBeDefined()

  // A later turn still ends, and the failure does not stick.
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1_000, isAborted: false, reason: 'answer' })
  await settle()
  gitTabAnswers.run = fakeGit(STRAIGHT)
  await ui.press({ key: 'git-reload' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /Couldn’t read git/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /nothing to merge/ })).toBeDefined()

  // git answering with an error is a failure too, said in its own words.
  gitTabAnswers.run = async args =>
    args[0] === 'rev-parse'
      ? { exitCode: 128, stdout: '', stderr: 'fatal: detected dubious ownership in repository\nmore\n' }
      : { exitCode: 0, stdout: '', stderr: '' }
  await ui.press({ key: 'git-reload' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /dubious ownership/ })).toBeDefined()
  await ui.unmount()
})

test('a slow branch comparison reads ? and leaves the rest of the tab whole', async ($, on) => {
  engine(on)
  mock.store(on, {})
  const fake = fakeGit(BRANCHES)
  gitTabAnswers.run = async args => {
    if (args.join(' ').includes('...refs/heads/feat/search')) throw new Error('timed out')
    return fake(args)
  }
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 61 } })
  await ui.press({ key: 'tab-git' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /\+\? -\?  Debounce/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+3 -6  Add invoice/ })).toBeDefined()
  await ui.unmount()
})

test('the Git tab draws what the room allows, and a press unfolds the rest', async ($, on) => {
  engine(on)
  mock.store(on, {})
  gitTabAnswers.run = fakeGit(BRANCHES)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  // A terminal of 32 rows: far less room than the 14 rows the tabs take.
  const short = { ...PANE, props: { ...PANE.props, bodyColumns: 61, scroll: { offset: 0, bodyRows: 24 } } }
  const ui = await $.ui.mount(short)
  await ui.press({ key: 'tab-git' })
  await settle()

  const rowsDrawn = async () => treeRows(await ui.drawn(), 61)
  // The tree fits the window, the grip included: nothing falls below in silence.
  expect(await rowsDrawn()).toBeLessThanOrEqual(24)
  expect(await ui.find({ key: 'tabs-handle' })).toBeDefined()
  const cut = await ui.find({ key: 'git-cut' })
  expect(String(cut?.props.label)).toContain('merged branches')
  expect(await ui.find({ type: 'Text', text: /f9d4ad1/ })).toBeUndefined()

  // A press unfolds: the zone grows past the window, which the pane scrolls.
  await ui.press({ key: 'git-cut' })
  expect(await ui.find({ type: 'Text', text: /f9d4ad1 Initial commit/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ chore\/deps/ })).toBeDefined()
  expect(await rowsDrawn()).toBeGreaterThan(24)

  // And folds again.
  await ui.press({ key: 'git-fold' })
  expect(await ui.find({ type: 'Text', text: /f9d4ad1/ })).toBeUndefined()
  expect(await rowsDrawn()).toBeLessThanOrEqual(24)
  await ui.unmount()

  // The graph folds on its own row, and opens again.
  const big = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 61 } })
  await settle()
  expect(await big.find({ type: 'Text', text: /3ae20f1/ })).toBeDefined()
  await big.press({ key: 'git-graph-toggle' })
  expect(await big.find({ type: 'Text', text: /3ae20f1/ })).toBeUndefined()
  await big.press({ key: 'git-graph-toggle' })
  expect(await big.find({ type: 'Text', text: /3ae20f1/ })).toBeDefined()
  await big.unmount()
})

test('the grip still sizes the Git tab, up to the room there is', async ($, on) => {
  engine(on)
  mock.store(on, {})
  gitTabAnswers.run = fakeGit(STRAIGHT)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 61, scroll: { offset: 0, bodyRows: 50 } } })
  await ui.press({ key: 'tab-git' })
  await settle()
  expect(String((await ui.find({ key: 'git-cut' }))?.props.label)).toContain('older commits')
  // Dragged down, the journal has room for all it read.
  await ui.pointer({ type: 'down', x: 10, y: 0, button: 'left', in: 'tabs-handle' })
  await ui.pointer({ type: 'up', x: 10, y: 6, button: 'left', in: 'tabs-handle' })
  expect(await ui.find({ type: 'Text', text: /The oldest commit/ })).toBeDefined()
  expect(String((await ui.find({ key: 'git-cut' }))?.props.label)).toContain('6 older commits')
  await ui.unmount()
})

// ── What waits for you: the live row and the blocked band ────────────────────

const GUARDED = { tool_name: 'Bash', tool_input: { command: 'echo git push' } }
const WAITING = { type: 'Text', text: /^\? Waiting for you$/ } as const
const BAND = {
  plugin: 'cockpit',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: SCROLL, view: {} },
} as const

// The calls of this tool stay open from now on, as one does behind a dialog, until the test
// answers them.
function heldCalls(tool: string): (answer: CallAnswer) => void {
  let answer: (value: CallAnswer) => void = () => undefined
  held.tool = tool
  held.answer = new Promise<CallAnswer>(resolve => {
    answer = resolve
  })
  return value => answer(value)
}
// How the kit is told a /clear happened.
const CLEAR = { reason: 'clear', sessionId: 's1', resume: {} } as never

test('what a permission question asks you to approve reads as the command itself', () => {
  expect(approvalLabel('Bash', { command: 'echo git push', description: 'Say it' }, '/project')).toBe('approve: echo git push')
  expect(approvalLabel('Bash', { command: '\n  pnpm build\n  pnpm test' }, '/project')).toBe('approve: pnpm build')
  expect(approvalLabel('Edit', { file_path: '/project/src/a.ts' }, '/project')).toBe('approve: Edit src/a.ts')
  expect(approvalLabel('mcp__claude_ai_Supabase__execute_sql', {}, '/project')).toBe('approve: Supabase · Run SQL')
  // An input of no known shape still says something, and never throws.
  expect(approvalLabel('Bash', null, '/project')).toBe('approve: Run')
  expect(approvalLabel('Odd', 3, '/project')).toBe('approve: Odd')
})

test('a permission question names no call: it is found by its tool and input', () => {
  const calls = [
    { id: 'a', tool: 'Bash', fields: { command: 'ls' } },
    { id: 'b', tool: 'Bash', fields: { command: 'echo git push', description: 'Say it' } },
    { id: 'c', tool: 'Bash', fields: { command: 'echo git push' }, agentId: 'agent-1' },
    { id: 'd', tool: 'Read', fields: { file_path: '/a' } },
  ]
  expect(questionedCall(calls, 'Bash', { command: 'echo git push' }, undefined)).toBe('b')
  expect(questionedCall(calls, 'Bash', { command: 'echo git push' }, 'agent-1')).toBe('c')
  // An input a hook rewrote on the way: the oldest open call of that tool.
  expect(questionedCall(calls, 'Bash', { command: 'something else' }, undefined)).toBe('a')
  expect(questionedCall(calls, 'Write', { file_path: '/a' }, undefined)).toBeUndefined()
  expect(questionedCall(calls, 'Bash', null, undefined)).toBe('a')
})

test('a permission question takes over the live row until it is answered', async ($, on) => {
  const clock = engine(on)
  const answer = heldCalls('Bash')
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)

  const call = $.tool.call({ tool: 'Bash', command: 'echo git push' })
  await settle()
  // Asked, but the question has not come: the row still says what Claude does, and the
  // command's activity row turns.
  expect(await ui.find(WAITING)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^\? $/ })).toBeUndefined()

  await clock.advance(1_000)
  await $.classic.PermissionRequest(GUARDED)
  const row = await ui.find(WAITING)
  expect(row?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: /Waiting for you/ }))?.text).toBe('? Waiting for you 0:00 · approve: echo git push')
  // One row, cut at the pane's width: nothing wraps or spills over.
  expect((await ui.find({ type: 'Text', text: /Waiting for you/ }))?.props.wrap).toBe('truncate-end')
  expect(await ui.find({ type: 'Text', text: /Preparing|Thinking|Working|Writing|Waiting for Claude/ })).toBeUndefined()
  // Its activity row says it waits too: it is not running yet.
  expect((await ui.find({ type: 'Text', text: /^\? $/ }))?.props.color).toBe('warning')

  // The time runs from the question, not from the turn's start.
  await clock.advance(2_000)
  expect((await ui.find({ type: 'Text', text: /Waiting for you/ }))?.text).toBe('? Waiting for you 0:02 · approve: echo git push')

  answer({ result: {} })
  await call
  await settle()
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^\? $/ })).toBeUndefined()
  await ui.unmount()
})

test('once you said yes, the command is not shown as waiting for you, however long it runs', async ($, on) => {
  const clock = engine(on)
  const answer = heldCalls('Bash')
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  const spinner = {
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'Spinner',
    requestId: 'main',
    props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' },
  } as const

  const call = $.tool.call({ tool: 'Bash', command: 'sleep 300; echo git push' })
  await settle()
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'sleep 300; echo git push' } })

  // A spinner already on its way as the dialog opens is no answer.
  let drawn = await $.ui.mount(spinner)
  await drawn.unmount()
  await clock.advance(400)
  expect(await ui.find(WAITING)).toBeDefined()

  // The dialog closed: the spinner is drawn again, the row says Claude works, the call still open.
  await clock.advance(5_000)
  drawn = await $.ui.mount(spinner)
  await drawn.unmount()
  await clock.advance(200)
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Working$/ })).toBeDefined()
  // Its activity row turns again.
  expect(await ui.find({ type: 'Text', text: /^\? $/ })).toBeUndefined()

  answer({ result: {} })
  await call
  await ui.unmount()
})

test('a yes closes one question: the next one still waits for you', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  const drawSpinner = async () => {
    const drawn = await $.ui.mount({
      plugin: 'cockpit',
      surface: 'terminal',
      component: 'Spinner',
      requestId: 'main',
      props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' },
    })
    await drawn.unmount()
    await clock.advance(200)
  }

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'echo one' } })
  await clock.advance(100)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'echo two' } })
  await clock.advance(600)
  expect(await ui.find({ type: 'Text', text: /approve: echo one/ })).toBeDefined()

  // One drawing, between the two dialogs: the second still waits, and says so.
  await drawSpinner()
  expect(await ui.find({ type: 'Text', text: /approve: echo one/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /approve: echo two/ })).toBeDefined()

  // Too soon after that yes to say anything of the second.
  await drawSpinner()
  expect(await ui.find({ type: 'Text', text: /approve: echo two/ })).toBeDefined()

  // Its own dialog has closed.
  await clock.advance(600)
  await drawSpinner()
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  await ui.unmount()
})

test('a command that shows it runs is not waiting for you, even with no new spinner', async ($, on) => {
  const clock = engine(on)
  const answer = heldCalls('Bash')
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  const other = $.tool.call({ tool: 'Bash', command: 'sleep 300; echo git push' })
  await settle()
  const callId = held.callId
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'sleep 300; echo git push' } })
  await clock.advance(1_000)
  expect(await ui.find(WAITING)).toBeDefined()

  const hint = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'ToolProgress',
    requestId: callId,
    props: { tool_use_id: callId, kind: 'background_hint', hint: '(ctrl+b to run in background)' },
  })
  await hint.unmount()
  await clock.advance(200)
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  answer({ result: {} })
  await other
  await ui.unmount()
})

test('a question already answered by a settings hook is no wait', async ($, on) => {
  engine(on)
  beneath.permission = { decision: { behavior: 'deny', message: 'no' } }
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  await $.classic.PermissionRequest(GUARDED)
  expect(await ui.find(WAITING)).toBeUndefined()
  await ui.unmount()
})

test('the permission hook only watches: it never answers for you', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })

  // Nobody beneath decides: nothing comes back, and the dialog stays yours.
  expect(await $.classic.PermissionRequest(GUARDED)).toEqual({})

  // What a settings hook answers comes back as it was, allow or deny.
  beneath.permission = { decision: { behavior: 'allow' } }
  expect(await $.classic.PermissionRequest(GUARDED)).toEqual({ decision: { behavior: 'allow' } })
  beneath.permission = { decision: { behavior: 'deny', message: 'not today' } }
  expect(await $.classic.PermissionRequest(GUARDED)).toEqual({ decision: { behavior: 'deny', message: 'not today' } })
})

test('a call that asks is refused for want of a person, never allowed by the mod', async ($, on) => {
  engine(on)
  on('tool.check', () => ({ decision: 'ask' as const }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)

  const asked = await $.tool.call({ tool: 'Bash', command: 'echo git push' })
  expect(asked.deny ?? asked.isError).toBeTruthy()
  await settle()
  // The tool did not run, the row is not left behind, and Activity says it was refused.
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  await ui.unmount()
})

test('an input that breaks the watcher never fails the question being watched', async ($, on) => {
  engine(on)
  const answer = heldCalls('Bash')
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  beneath.permission = { decision: { behavior: 'allow' } }

  for (const tool_input of [null, 3, 'text', undefined, { command: 12 }]) {
    expect(await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input })).toEqual(beneath.permission)
  }

  // A call open beside it, and an input that cannot be compared with it: no row, no failure.
  beneath.permission = {}
  const call = $.tool.call({ tool: 'Bash', command: 'ls' })
  await settle()
  const ui = await $.ui.mount(PANE)
  const loop: Record<string, unknown> = {}
  loop.self = loop
  expect(await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: loop })).toEqual({})
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  answer({ result: {} })
  await call
  await ui.unmount()
})

test('an odd input still shows a row, and no failure reaches the tool', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: null })
  expect((await ui.find({ type: 'Text', text: /Waiting for you/ }))?.text).toBe('? Waiting for you 0:00 · approve: Run')
  await ui.unmount()
})

test('a refusal at the dialog ends the wait at once', async ($, on) => {
  engine(on)
  const answer = heldCalls('Bash')
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  const call = $.tool.call({ tool: 'Bash', command: 'echo git push' })
  await settle()
  await $.classic.PermissionRequest(GUARDED)
  expect(await ui.find(WAITING)).toBeDefined()

  // As the engine ends a refused call: an errored result the model reads.
  answer({ result: {}, isError: true })
  await call
  await settle()
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  // The turn goes on, so the row says what Claude does again.
  expect(await ui.find({ type: 'Text', text: /Thinking|Waiting for Claude|Working|Preparing|Writing/ })).toBeDefined()
  await ui.unmount()
})

test('a hook’s or the engine’s refusal of the call ends the wait too', async ($, on) => {
  engine(on)
  const answer = heldCalls('Bash')
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  const call = $.tool.call({ tool: 'Bash', command: 'echo git push' })
  await settle()
  await $.classic.PermissionRequest(GUARDED)
  answer({ deny: 'Refused.' })
  await call
  await settle()
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  await ui.unmount()
})

test('Esc, an interrupted turn or a call that throws never leaves the wait stuck', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  const answer = heldCalls('Bash')
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)

  // The call is still open when the turn ends: the end alone clears the row.
  const call = $.tool.call({ tool: 'Bash', command: 'echo git push' }).catch(() => 'rejected')
  await settle()
  await $.classic.PermissionRequest(GUARDED)
  expect(await ui.find(WAITING)).toBeDefined()
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1_000, isAborted: true, reason: 'aborted' })
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()

  // The call then fails, and a question left over from it does not come back.
  answer(new Error('aborted'))
  await call
  await settle()
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  await ui.unmount()
})

test('a call that throws behind the dialog ends the wait, the turn still running', async ($, on) => {
  engine(on)
  const answer = heldCalls('Bash')
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  const call = $.tool.call({ tool: 'Bash', command: 'echo git push' }).catch(() => 'rejected')
  await settle()
  await $.classic.PermissionRequest(GUARDED)
  answer(new Error('aborted'))
  await call
  await settle()
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  await ui.unmount()
})

test('a new prompt or /clear clears what waited', async ($, on) => {
  engine(on)
  on('session.end', () => ({ sessionId: 's1' }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  await $.classic.PermissionRequest(GUARDED)
  expect(await ui.find(WAITING)).toBeDefined()
  await $.turn.start({ text: 'go on', turnId: 't2' })
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()

  await $.classic.PermissionRequest(GUARDED)
  expect(await ui.find(WAITING)).toBeDefined()
  await $.session.end(CLEAR)
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  await ui.unmount()
})

test('a question from AskUserQuestion waits the same way, as "question"', async ($, on) => {
  const clock = engine(on)
  const answer = heldCalls('AskUserQuestion')
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)

  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await settle()
  await clock.advance(3_000)
  expect((await ui.find({ type: 'Text', text: /Waiting for you/ }))?.text).toBe('? Waiting for you 0:03 · question')

  // The engine also raises the permission event for it: still one row, still a question.
  await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: { questions: [] } })
  expect((await ui.find({ type: 'Text', text: /Waiting for you/ }))?.text).toBe('? Waiting for you 0:03 · question')

  answer({ result: {} })
  await call
  await settle()
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  await ui.unmount()
})

test('an MCP form waits until its result, whatever the answer', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)

  const form = { mcp_server_name: 'claude_ai_Supabase', message: 'Which project?', elicitation_id: 'f1' }
  expect(await $.classic.Elicitation(form)).toEqual({})
  await clock.advance(2_000)
  expect((await ui.find({ type: 'Text', text: /Waiting for you/ }))?.text).toBe('? Waiting for you 0:02 · form: Supabase')

  await $.classic.ElicitationResult({ mcp_server_name: 'claude_ai_Supabase', elicitation_id: 'f1', action: 'cancel' })
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  await ui.unmount()
})

test('the oldest wait shows first, the next one when it is answered', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)
  await $.classic.Elicitation({ mcp_server_name: 'Notion', message: 'Which page?', elicitation_id: 'f2' })
  await $.classic.PermissionRequest(GUARDED)
  expect((await ui.find({ type: 'Text', text: /Waiting for you/ }))?.text).toBe('? Waiting for you 0:00 · form: Notion')
  await $.classic.ElicitationResult({ mcp_server_name: 'Notion', elicitation_id: 'f2', action: 'accept' })
  expect((await ui.find({ type: 'Text', text: /Waiting for you/ }))?.text).toBe('? Waiting for you 0:00 · approve: echo git push')
  await ui.unmount()
})

test('the waits outlive no turn, even one of a background agent’s calls', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  const answer = heldCalls('Bash')
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)

  // A subagent's own turn ending does not touch what the main conversation waits for.
  const call = $.tool.call({ tool: 'Bash', command: 'echo git push' }).catch(() => 'rejected')
  await settle()
  await $.classic.PermissionRequest(GUARDED)
  await $.turn.complete({ turnId: 'a1', answer: '', durationMs: 1_000, isAborted: false, reason: 'answer', agentId: 'agent-1' })
  expect(await ui.find(WAITING)).toBeDefined()

  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1_000, isAborted: false, reason: 'answer' })
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  answer({ result: {} })
  await call
  await ui.unmount()
})

test('a late engine notice shows the wait no other signal showed, and a settled turn stays quiet', async ($, on) => {
  const ran: string[] = []
  const clock = engine(on, true, ran)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)

  // With no turn running, the row has nothing that could clear it: only the alert.
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  await settle()
  expect(ran.some(argv => argv.includes('Ping.aiff'))).toBe(true)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  // The notice comes ~6 s after the question: the time counts from the question.
  expect((await ui.find({ type: 'Text', text: /Waiting for you/ }))?.text).toBe(
    '? Waiting for you 0:06 · Claude needs your permission',
  )
  await clock.advance(1_000)
  // The next result of a tool means the question is behind us.
  await $.tool.call({ tool: 'Read', file_path: '/project/a.ts' })
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  await ui.unmount()
})

test('background sessions ring without taking the live row; the end of a turn has its own alert', async ($, on) => {
  const ran: string[] = []
  const clock = engine(on, true, ran)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(PANE)

  await $.classic.Notification({ message: 'Finished, idle', notification_type: 'idle_prompt' })
  await settle()
  expect(ran.some(argv => argv.includes('Ping.aiff'))).toBe(false)

  await $.classic.Notification({ message: 'Research needs your input', notification_type: 'agent_needs_input' })
  await settle()
  expect(ran.some(argv => argv.includes('Ping.aiff'))).toBe(true)
  // Another session waits, not this one.
  expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeUndefined()
  await clock.advance(1_000)
  await ui.unmount()
})

test('only a blocked verdict leaves a blocker, in its own words', () => {
  expect(pendingBlocker('{blocked|Le build échoue sur une **clé** manquante}\n\nDétails.')).toBe(
    'Le build échoue sur une clé manquante',
  )
  expect(pendingBlocker('{decide|A ou B}')).toBeNull()
  expect(pendingBlocker('{done|Fini}')).toBeNull()
  expect(pendingBlocker('Bloqué, sans badge.')).toBeNull()
  expect(pendingBlocker('{blocked|}')).toBeNull()
  // The decide band reads as before.
  expect(pendingDecision('{blocked|Le build échoue}')).toBeNull()
})

test('a blocked answer waits above the prompt until you answer, close it or clear', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.end', () => ({ sessionId: 's1' }))
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const end = (turnId: string, answer: string) =>
    $.turn.complete({ turnId, answer, durationMs: 1_000, isAborted: false, reason: 'answer' })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await end('t1', '{blocked|Le build échoue sur une clé manquante}\n\nDétails.')
  let ui = await $.ui.mount(BAND)
  const badge = await ui.find({ type: 'Text', text: /^ ✗ BLOCKED $/ })
  expect(badge?.props.backgroundColor).toBe('error')
  expect(await ui.find({ type: 'Text', text: /^ Le build échoue sur une clé manquante$/ })).toBeDefined()
  // It is the blocker's band, not the decision's.
  expect(await ui.find({ type: 'Text', text: /DECIDE/ })).toBeUndefined()
  // × closes it.
  await ui.press({ key: 'cockpit-decision-close' })
  expect(await ui.find({ type: 'Text', text: /BLOCKED/ })).toBeUndefined()
  await ui.unmount()

  // You answer: the row leaves.
  await $.turn.start({ text: 'go on', turnId: 't2' })
  await end('t2', '{blocked|Toujours bloqué}')
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /^ ✗ BLOCKED $/ })).toBeDefined()
  await ui.unmount()
  await $.turn.start({ text: 'try this', turnId: 't3' })
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /BLOCKED/ })).toBeUndefined()
  await ui.unmount()

  // /clear takes it too.
  await end('t3', '{blocked|Encore bloqué}')
  await $.session.end(CLEAR)
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /BLOCKED/ })).toBeUndefined()
  await ui.unmount()

  // A turn you stopped leaves none; a done answer replaces it.
  await $.turn.start({ text: 'again', turnId: 't4' })
  await $.turn.complete({ turnId: 't4', answer: '{blocked|Stoppé}', durationMs: 1_000, isAborted: true, reason: 'aborted' })
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /BLOCKED/ })).toBeUndefined()
  await ui.unmount()
})

const editCode = (path = '/project/src/app.ts') => ({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' }) as const

test('Proof stays away until code is edited or a check is run', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Proof/ })).toBeUndefined()

  // Notes and scratch files are not code: nothing to prove yet.
  await $.tool.call(editCode('/project/README.md'))
  await $.tool.call({ tool: 'Write', file_path: '/private/tmp/x/scratchpad/draft.ts', content: 'x' })
  await $.tool.call({ tool: 'Read', file_path: '/project/src/app.ts' })
  expect(await ui.find({ type: 'Text', text: /Proof/ })).toBeUndefined()

  // Code, with nothing run: the warning says so, and what was not run.
  await $.tool.call(editCode())
  expect(await ui.find({ type: 'Text', text: /^Proof {4}⚠ 1 code edit with no passing check$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {9}tests, types, build not run$/ })).toBeDefined()
  await ui.unmount()
})

test('Proof counts Edit, Write and NotebookEdit, the agents’ included', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call(editCode())
  await $.tool.call({ tool: 'Write', file_path: '/project/src/new.ts', content: 'x' })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/project/n.ipynb', new_source: 'x' })
  await $.tool.call({ ...editCode('/project/src/agent.ts'), agentId: 'a1' })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /⚠ 4 code edits with no passing check/ })).toBeDefined()
  await ui.unmount()
})

test('a check that passes clears the count, one that fails does not', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call(editCode())
  await $.tool.call(editCode())
  await clock.advance(60_000)
  const ui = await $.ui.mount(PANE)

  // A failure leaves the edits unchecked, and shows.
  await $.tool.call({ tool: 'Bash', command: 'pnpm build', description: 'Build' })
  expect(await ui.find({ type: 'Text', text: /⚠ 2 code edits with no passing check/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {9}build ✗ now · tests, types not run$/ })).toBeDefined()

  // Another check passing covers nothing while that one fails, and says what holds it.
  await $.tool.call({ tool: 'Bash', command: 'pnpm test', description: 'Test' })
  expect(await ui.find({ type: 'Text', text: /code edit/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /⚠ build failing/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {9}tests ✓ now · build ✗ now · types not run$/ })).toBeDefined()
  await ui.unmount()
})

test('a pass clears the count once nothing fails, and later edits count from it', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call(editCode())
  await $.tool.call(editCode())
  await clock.advance(60_000)
  const ui = await $.ui.mount(PANE)

  await $.tool.call({ tool: 'Bash', command: 'pnpm test', description: 'Test' })
  expect(await ui.find({ type: 'Text', text: /code edit/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Proof {4}tests ✓ now$/ })).toBeDefined()

  // The mockup's three lines: what failed ran before these edits, so the count stands.
  await clock.advance(12 * 60_000)
  await $.tool.call({ tool: 'Bash', command: 'tsc --build', description: 'Types' })
  await clock.advance(2 * 60_000)
  for (let index = 0; index < 3; index++) await $.tool.call(editCode())
  expect(await ui.find({ type: 'Text', text: /^Proof {4}⚠ 3 code edits since the last test$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {9}tests ✓ 14m · types ✗ 2m · build not run$/ })).toBeDefined()
  await ui.unmount()
})

test('a check that failed is not forgotten because a lint passed', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await $.tool.call(editCode())
  await clock.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'tsc --build', description: 'Types' })
  await clock.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'pnpm lint', description: 'Lint' })
  expect(await ui.find({ type: 'Text', text: /since the last/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /⚠ types failing/ })).toBeDefined()

  // The same check passes again: everything before it is covered.
  await clock.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'tsc --noEmit', description: 'Types' })
  expect(await ui.find({ type: 'Text', text: /failing|code edit/ })).toBeUndefined()
  await ui.unmount()
})

test('Proof reads as in the mockup the author validated', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'pnpm test', description: 'Test' })
  await clock.advance(12 * 60_000)
  await $.tool.call({ tool: 'Bash', command: 'tsc --build', description: 'Types' })
  await clock.advance(2 * 60_000)
  for (let index = 0; index < 3; index++) await $.tool.call(editCode())

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^Proof {4}⚠ 3 code edits since the last test$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {9}tests ✓ 14m · types ✗ 2m · build not run$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Checks/ })).toBeUndefined()
  await ui.unmount()
})

test('a refused check counts for nothing', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call(editCode())
  await $.tool.call({ tool: 'Bash', command: 'pnpm test refused', description: 'Test' }).catch(() => undefined)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /⚠ 1 code edit/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /tests ✓/ })).toBeUndefined()
  await ui.unmount()
})

test('a hidden exit code reads ? and clears nothing, a false check shows nothing', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call(editCode())
  const ui = await $.ui.mount(PANE)

  for (const command of ['wc -l tests/x', 'jest --help', 'ls tests', 'node scripts/test-data.js']) {
    await $.tool.call({ tool: 'Bash', command, description: 'Look' })
  }
  expect(await ui.find({ type: 'Text', text: /tests, types, build not run/ })).toBeDefined()

  await $.tool.call({ tool: 'Bash', command: 'pnpm test | tail -5', description: 'Test' })
  expect(await ui.find({ type: 'Text', text: /^ {9}\? tests now · types, build not run$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /tests ✓/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /⚠ 1 code edit with no passing check/ })).toBeDefined()

  // Its code tells nothing either way: `pnpm build | tail` that exits 1 is no ✗.
  await $.tool.call({ tool: 'Bash', command: 'pnpm build | tail -5', description: 'Build' })
  expect(await ui.find({ type: 'Text', text: /\? tests now · \? build now/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /build ✗/ })).toBeUndefined()

  // In the background, the command's code only says it started.
  await $.tool.call({ tool: 'Bash', command: 'pytest -q', description: 'Test', run_in_background: true })
  expect(await ui.find({ type: 'Text', text: /⚠ 1 code edit/ })).toBeDefined()
  await ui.unmount()
})

test('the bench and a look through Playwright clear the count', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)

  await $.tool.call(editCode())
  await clock.advance(60_000)
  await $.tool.call({ tool: 'Bash', command: 'python3 dev/drive.py tests', description: 'Bench' })
  expect(await ui.find({ type: 'Text', text: /code edit/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Proof {4}bench ✓ now$/ })).toBeDefined()

  await clock.advance(60_000)
  await $.tool.call(editCode())
  expect(await ui.find({ type: 'Text', text: /⚠ 1 code edit since the last bench run/ })).toBeDefined()
  // Opening a page is not looking at it.
  await $.tool.call({ tool: 'mcp__plugin_playwright_playwright__browser_navigate', url: 'http://x' })
  expect(await ui.find({ type: 'Text', text: /⚠ 1 code edit/ })).toBeDefined()
  await clock.advance(60_000)
  await $.tool.call({ tool: 'mcp__plugin_playwright_playwright__browser_take_screenshot' })
  expect(await ui.find({ type: 'Text', text: /code edit/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /browser ✓ now/ })).toBeDefined()
  await ui.unmount()
})

test('an edit that lands while a check runs is still unchecked', async ($, on) => {
  const clock = engine(on)
  let release: () => void = () => undefined
  shellGate.until = new Promise<void>(resolve => {
    release = resolve
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call(editCode())
  await clock.advance(60_000)
  const running = $.tool.call({ tool: 'Bash', command: 'pnpm test slow', description: 'Test' })
  await settle()
  await clock.advance(60_000)
  await $.tool.call(editCode())
  release()
  await running

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /⚠ 1 code edit since the last test/ })).toBeDefined()
  await ui.unmount()
})

test('the row says what a ✓ is whenever one shows, folded or not', async ($, on) => {
  engine(on)
  mock.store(on, {})
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /not proof/ })).toBeUndefined()

  // No ✓ to explain yet: an edit and a failure leave it out.
  await $.tool.call(editCode())
  await $.tool.call({ tool: 'Bash', command: 'pnpm build', description: 'Build' })
  expect(await ui.find({ type: 'Text', text: /not proof/ })).toBeUndefined()

  await $.tool.call({ tool: 'Bash', command: 'pnpm test', description: 'Test' })
  expect(await ui.find({ type: 'Text', text: /✓ = exit code 0, not proof the work is right$/ })).toBeDefined()
  await ui.press({ key: 'details-toggle' })
  expect(await ui.find({ type: 'Text', text: /✓ = exit code 0, not proof the work is right$/ })).toBeDefined()
  await ui.unmount()

  // In the label column at full width; narrow, the indent gives way before the words do.
  const wide = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 61 } })
  expect(await wide.find({ type: 'Text', text: /^ {9}✓ = exit code 0, not proof the work is right$/ })).toBeDefined()
  await wide.unmount()
  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 48 } })
  expect(await narrow.find({ type: 'Text', text: /^ {4}✓ = exit code 0, not proof the work is right$/ })).toBeDefined()
  await narrow.unmount()
})

test('the rule closing a turn says when code was left unchecked', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const rule = async (requestId: string) => {
    const row = await $.ui.mount({
      plugin: 'cockpit',
      surface: 'terminal',
      component: 'TurnDuration',
      requestId,
      props: { word: 'Cogitated', durationMs: 192_000 },
    })
    const text = (await row.find({ type: 'Text', text: /Done in/ }))?.text
    await row.unmount()
    return text ?? ''
  }
  const play = async (turnId: string, ...calls: readonly Parameters<typeof $.tool.call>[0][]) => {
    await clock.advance(60_000)
    await $.turn.start({ text: 'go', turnId })
    spend.usd += 0.42
    for (const call of calls) await $.tool.call(call)
    await $.turn.complete({ turnId, answer: 'ok', durationMs: 1_000, isAborted: false, reason: 'answer' })
  }

  // An edit with no check after it: the notice beside the time, and the cost still there.
  await play('t1', editCode())
  expect(await rule('r1')).toMatch(/^── ✓ Done in 3m 12s · \d\d:\d\d · no check since last edit · API \$0\.42 ─/)

  // The next turn edits nothing: last turn's edit is not this rule's business.
  await play('t2')
  expect(await rule('r2')).not.toContain('no check')

  // Edited then checked: nothing to say. The rule already drawn keeps its words.
  await play('t3', editCode(), { tool: 'Bash', command: 'pnpm test', description: 'Test' })
  expect(await rule('r3')).not.toContain('no check')
  expect(await rule('r1')).toContain('no check since last edit')

  // Checked then edited, or checked and failed: said.
  await play('t4', { tool: 'Bash', command: 'pnpm test', description: 'Test' }, editCode())
  expect(await rule('r4')).toContain('no check since last edit')
  await play('t5', editCode(), { tool: 'Bash', command: 'pnpm build', description: 'Build' })
  expect(await rule('r5')).toContain('no check since last edit')
  await play('t5b', { tool: 'Bash', command: 'pnpm test', description: 'Test' })

  // A note edited is no code edited; an agent's code edit is.
  await play('t6', editCode('/project/README.md'))
  expect(await rule('r6')).not.toContain('no check')
  await play('t7', { ...editCode(), agentId: 'a1' })
  expect(await rule('r7')).toContain('no check since last edit')
})

test('a check failing elsewhere does not make the closing rule deny the test just passed', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await clock.advance(60_000)
  await $.tool.call({ tool: 'Bash', command: 'tsc --build', description: 'Types' })
  await clock.advance(1_000)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(editCode())
  await clock.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'pnpm test', description: 'Test' })
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1_000, isAborted: false, reason: 'answer' })
  const row = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'TurnDuration',
    requestId: 'r1',
    props: { word: 'Cogitated', durationMs: 192_000 },
  })
  const text = (await row.find({ type: 'Text', text: /Done in/ }))?.text ?? ''
  await row.unmount()
  expect(text).toContain('Done in')
  expect(text).not.toContain('no check since last edit')
  // The Proof row still says what holds the edits.
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /⚠ types failing/ })).toBeDefined()
  await ui.unmount()
})

test('on a narrow terminal the notice stays and the cost goes whole', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const rule = async (requestId: string, columns: number) => {
    const row = await $.ui.mount({
      plugin: 'cockpit',
      surface: 'terminal',
      component: 'TurnDuration',
      requestId,
      props: { word: 'Cogitated', durationMs: 192_000 },
      viewport: { columns, rows: 50 },
    })
    const text = (await row.find({ type: 'Text', text: /Done in/ }))?.text
    await row.unmount()
    return text ?? ''
  }
  await clock.advance(60_000)
  await $.turn.start({ text: 'go', turnId: 't1' })
  spend.usd += 0.42
  await $.tool.call(editCode())
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1_000, isAborted: false, reason: 'answer' })
  const narrow = await rule('r1', 110)
  expect(narrow).toContain('no check since last edit')
  expect(narrow).not.toContain('API')
  await $.turn.start({ text: 'go', turnId: 't2' })
  spend.usd += 0.42
  await $.tool.call(editCode())
  await $.turn.complete({ turnId: 't2', answer: 'ok', durationMs: 1_000, isAborted: false, reason: 'answer' })
  expect(await rule('r2', 172)).toMatch(/no check since last edit · API \$0\.42/)
})

test('✓ DONE with steps still open is flagged beside Steps, until the next turn', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const steps = (...statuses: readonly ('pending' | 'completed')[]) =>
    $.tool.call({
      tool: 'TodoWrite',
      todos: statuses.map((status, index) => ({ content: `Step ${index + 1}`, status, activeForm: 'Doing' })),
    })
  const say = (turnId: string, answer: string, isAborted = false) =>
    $.turn.complete({ turnId, answer, durationMs: 1_000, isAborted, reason: 'answer' })

  await steps('pending', 'pending')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^Steps · 0\/2$/ })).toBeDefined()

  // Another verdict, or none, or an interrupted turn: nothing to flag.
  await say('t1', '{info|Une réponse}')
  expect(await ui.find({ type: 'Text', text: /DONE announced/ })).toBeUndefined()
  await say('t1', 'Rien de spécial.')
  expect(await ui.find({ type: 'Text', text: /DONE announced/ })).toBeUndefined()
  await say('t1', '{done|Tout est fini}', true)
  expect(await ui.find({ type: 'Text', text: /DONE announced/ })).toBeUndefined()

  await say('t2', '{done|Tout est fini}\n\nDétails.')
  expect(await ui.find({ type: 'Text', text: /^Steps · 0\/2 ⚠ DONE announced, 2 steps open$/ })).toBeDefined()

  // Gone as soon as the next turn starts.
  await clock.advance(1_000)
  await $.turn.start({ text: 'go', turnId: 't3' })
  expect(await ui.find({ type: 'Text', text: /DONE announced/ })).toBeUndefined()

  // One step left: said in the singular.
  await steps('completed', 'pending')
  await say('t3', '{done|Fini}')
  expect(await ui.find({ type: 'Text', text: /^Steps · 1\/2 ⚠ DONE announced, 1 step open$/ })).toBeDefined()

  // Every step closed: DONE is what they say too.
  await $.turn.start({ text: 'go', turnId: 't4' })
  await steps('completed', 'completed')
  await say('t4', '{done|Fini}')
  expect(await ui.find({ type: 'Text', text: /Steps 2\/2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /DONE announced/ })).toBeUndefined()
  await ui.unmount()
})

test('after a restart, the edits left unchecked come back, and /clear forgets them', async ($, on) => {
  engine(on)
  on('session.id', () => ({ value: 'abc' }))
  on('session.end', () => ({ sessionId: 'abc' }))
  mock.store(on, { 'session:abc': { ...SAVED_OLD, codeEdits: [1, 2, 'bad'] } })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /⚠ 2 code edits with no passing check/ })).toBeDefined()
  await $.session.end({ reason: 'clear', sessionId: 'abc', resume: { id: 'abc' } })
  expect(await ui.find({ type: 'Text', text: /Proof/ })).toBeUndefined()
  await ui.unmount()
})

test('a session saved before Proof, or saved wrong, starts with nothing to prove', async ($, on) => {
  engine(on)
  on('session.id', () => ({ value: 'abc' }))
  mock.store(on, { 'session:abc': { ...SAVED_OLD, codeEdits: 'not a list' } })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Proof/ })).toBeUndefined()
  await ui.unmount()
})

// ── Agents and workflows ─────────────────────────────────────────────────────

// A workflow script's agent(), as the engine raises it: a caller's own types leave `workflow` out.
const spawnInRun = ($: Engine, agentIndex: number, description: string, runId = RUN_ID) =>
  $.agent.spawn({ prompt: 'go', description, subagentType: 'workflow-subagent', workflow: { runId, agentIndex } } as never)
// The end of an agent's own turn.
const endTurnOf = ($: Engine, agentId: string, reason: 'answer' | 'aborted' | 'error' = 'answer') =>
  $.turn.complete({ turnId: `turn-${agentId}`, agentId, answer: 'ok', durationMs: 1_000, isAborted: reason === 'aborted', reason } as never)
const endMainTurn = async ($: Engine) => {
  await $.turn.start({ text: 'go', turnId: 'main' })
  await $.turn.complete({ turnId: 'main', answer: 'ok', durationMs: 1_000, isAborted: false, reason: 'answer' })
}
const rowsOf = async (ui: { findAll: (query: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(row => row.text)
const rowAt = (rows: readonly string[], pattern: RegExp) => rows.findIndex(row => pattern.test(row))

const runAgent = (index: number, status: WorkflowAgent['status'] = 'running'): WorkflowAgent => ({
  id: `a${index}`,
  index,
  description: `agent ${index}`,
  type: 'workflow-subagent',
  model: 'opus',
  status,
  startedAt: 0,
})

test('a run counts its ended agents, keeps its name, and bounds its rows without losing the count', () => {
  let runs = addRunAgent([], RUN_ID, runAgent(1))
  runs = addRunAgent(runs, RUN_ID, runAgent(2))
  expect(runLabel(runs[0]!)).toBe('wf_78595e9c')
  runs = nameRun(runs, RUN_ID, 'audit-supervision')
  expect(runLabel(runs[0]!)).toBe('audit-supervision')
  runs = endRunAgent(runs, 'a1', 'completed', 5)
  expect(runCounts(runs[0]!)).toEqual({ ended: 1, total: 2, noResult: 0 })
  // An id on no row changes nothing.
  expect(endRunAgent(runs, 'nobody', 'failed', 6)).toEqual(runs)
  runs = endRunAgent(runs, 'a2', 'failed', 6)
  expect(runCounts(runs[0]!)).toEqual({ ended: 2, total: 2, noResult: 1 })

  // A resumed run raises the failed agent again: the new try takes its place, a finished one stays.
  runs = addRunAgent(runs, RUN_ID, { ...runAgent(2), id: 'a2-again' })
  expect(runs[0]!.agents.map(agent => agent.id)).toEqual(['a1', 'a2-again'])

  let big = addRunAgent([], RUN_ID, runAgent(1, 'completed'))
  for (let index = 2; index <= 101; index++) big = addRunAgent(big, RUN_ID, runAgent(index))
  expect(big[0]!.agents.length).toBe(100)
  expect(runCounts(big[0]!)).toEqual({ ended: 1, total: 101, noResult: 0 })

  // Five runs at most, the newest.
  let many = addRunAgent([], 'wf_0', runAgent(1))
  for (const run of ['wf_1', 'wf_2', 'wf_3', 'wf_4', 'wf_5']) many = addRunAgent(many, run, runAgent(1))
  expect(many.map(run => run.runId)).toEqual(['wf_1', 'wf_2', 'wf_3', 'wf_4', 'wf_5'])

  expect(runLabel({ runId: '', name: null, agents: [], dropped: 0 })).toBe('workflow')
  expect(agentEnd('answer')).toBe('completed')
  expect(agentEnd('aborted')).toBe('killed')
  expect(agentEnd('error')).toBe('failed')
  expect(agentEnd('refusal')).toBe('failed')
  expect(modelFamily('claude-opus-5-5[1m]')).toBe('opus')
  expect(modelFamily('haiku')).toBe('haiku')
  expect(modelFamily('some-other-model')).toBe('some-other-model')
  expect(clip('etat-actuel', 20)).toBe('etat-actuel')
  expect(clip('a description far too long to fit', 20)).toBe('a description far t…')
  expect(clip('a description far too long to fit', 20).length).toBe(20)
})

test('with the turn over, the live row says agents run, and since when Claude last replied', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  listed.agents = [
    { id: 'a1', description: 'one', type: 'general-purpose', status: 'running' },
    { id: 'a2', description: 'two', type: 'general-purpose', status: 'running' },
  ]
  await endMainTurn($)
  await clock.advance(3 * 60_000)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^◌ 2 agents running · last reply 3m ago$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /○ Ready/ })).toBeUndefined()
  await ui.unmount()

  // The agents gone, the pane rests again.
  listed.agents = []
  await clock.advance(2_000)
  const rest = await $.ui.mount(PANE)
  expect(await rest.find({ type: 'Text', text: /○ Ready/ })).toBeDefined()
  expect(await rest.find({ type: 'Text', text: /agents? running/ })).toBeUndefined()
  await rest.unmount()
})

test('the live row counts a workflow’s agents, and the spinner too', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await spawnInRun($, 1, 'etat-actuel')
  await endMainTurn($)
  await clock.advance(60_000)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^◌ 1 agent running · last reply 1m ago$/ })).toBeDefined()
  await ui.unmount()

  await $.turn.start({ text: 'go', turnId: 't2' })
  const spinner = await $.ui.mount({
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'Spinner',
    requestId: 'main',
    props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
  })
  expect((await spinner.find({ type: 'Text', text: /Thinking/ }))?.text).toBe('Thinking · 1 agent…')
  await spinner.unmount()
})

test('an agent that leaves the list with no proof gets no ✓', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  listed.agents = [{ id: 'a1', description: 'silent', type: 'general-purpose', status: 'running' }]
  await $.tool.call({ tool: 'Agent', prompt: 'go', description: 'silent' } as never)
  listed.agents = []
  await clock.advance(2_000)

  const ui = await $.ui.mount(PANE)
  // Shown at rest: nothing else says it, and it is what a supervisor looks for.
  expect(await ui.find({ type: 'Text', text: /^\? ended without a result: general-purpose$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ .*silent/ })).toBeUndefined()
  // Fifteen minutes later it has left the rows at rest, not the list.
  await clock.advance(16 * 60_000)
  expect(await ui.find({ type: 'Text', text: /ended without a result/ })).toBeUndefined()
  await ui.press({ key: 'activity-toggle' })
  expect(await ui.find({ type: 'Text', text: /ended without a result/ })).toBeDefined()
  await ui.unmount()
})

test('an agent seen completed, or whose turn ended, keeps a ✓; a failed one gets ✗', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  listed.agents = [
    { id: 'seen', description: 'seen done', type: 'general-purpose', status: 'completed' },
    { id: 'ended', description: 'ended well', type: 'general-purpose', status: 'running' },
    { id: 'broke', description: 'ended badly', type: 'general-purpose', status: 'running' },
    { id: 'stopped', description: 'stopped', type: 'general-purpose', status: 'running' },
  ]
  await $.tool.call({ tool: 'Agent', prompt: 'go', description: 'x' } as never)
  listed.agents = listed.agents.filter(agent => agent.id !== 'seen')
  await endTurnOf($, 'ended')
  await endTurnOf($, 'broke', 'error')
  await endTurnOf($, 'stopped', 'aborted')
  listed.agents = []
  await clock.advance(2_000)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'activity-toggle' })
  expect(await ui.find({ type: 'Text', text: /^✓ seen done · general-purpose$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ ended well · general-purpose$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✗ ended badly · general-purpose$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^◼ stopped · general-purpose$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ended without a result/ })).toBeUndefined()
  await ui.unmount()
})

test('an idle teammate is neither done nor running', async ($, on) => {
  engine(on)
  listed.agents = [{ id: 'lead@team', description: 'lead', type: 'teammate', status: 'idle' }]
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'activity-toggle' })
  expect(await ui.find({ type: 'Text', text: /^○ lead · teammate · idle$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ lead/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /agents? running/ })).toBeUndefined()
  await ui.unmount()
})

test('after a restart, an agent that was running has no result to show, one seen done keeps it', async ($, on) => {
  engine(on)
  on('session.id', () => ({ value: 'abc' }))
  mock.store(on, {
    'session:abc': {
      commands: [],
      files: [{ path: '/project/a.ts', action: 'read', count: 1, at: 1 }],
      agents: [
        { id: 'a1', description: 'was running', type: 'Explore', status: 'running' },
        { id: 'a2', description: 'was done', type: 'general-purpose', status: 'completed' },
      ],
      todos: [],
      plan: null,
      history: [],
    },
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^\? ended without a result: Explore$/ })).toBeDefined()
  await ui.press({ key: 'activity-toggle' })
  expect(await ui.find({ type: 'Text', text: /^✓ was done · general-purpose$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /was running/ })).toBeUndefined()
  await ui.unmount()
})

test('an agent’s command carries its name, an unknown agent’s keeps ↳', async ($, on) => {
  engine(on)
  listed.agents = [
    { id: 'a1', description: 'read the code', type: 'Explore', status: 'running' },
    { id: 'a2', description: 'a description far too long to fit', type: 'Explore', status: 'running', name: 'scout' },
    { id: 'a3', description: 'a description far too long to fit', type: 'Explore', status: 'running' },
    { id: 'a4', description: '', type: 'Explore', status: 'running' },
  ]
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await settle()
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List the files', agentId: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'Named', agentId: 'a2' })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'Clipped', agentId: 'a3' })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'Nameless', agentId: 'a4' })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'Stranger', agentId: 'nobody' })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'From Claude' })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'activity-toggle' })
  expect(await ui.find({ type: 'Text', text: /^✓ read the code: List the files$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ scout: Named$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ a description far t…: Clipped$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ ↳ Nameless$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ ↳ Stranger$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ From Claude$/ })).toBeDefined()
  await ui.unmount()
})

test('a workflow reads as the mockup: its name, its count, its running agents, then the rest', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Workflow', script: 'export const meta = {}' })
  for (const [index, name] of ['historique', 'memoire', 'usage', 'doc', 'github'].entries()) {
    await spawnInRun($, index + 1, name)
    await endTurnOf($, `agent-${name}`)
  }
  await spawnInRun($, 6, 'etat-actuel')
  await clock.advance(3 * 60_000)
  await spawnInRun($, 7, 'terminaux')
  await clock.advance(9 * 60_000)
  // A plain agent that vanished, then a command of the workflow's: the newest row comes first.
  listed.agents = [{ id: 'lost', description: 'lost', type: 'general-purpose', status: 'running' }]
  await $.tool.call({ tool: 'Agent', prompt: 'go', description: 'lost' } as never)
  listed.agents = []
  await clock.advance(2_000)
  await $.tool.call({ tool: 'Bash', command: 'echo older', description: 'older command' })
  await $.tool.call({ tool: 'Bash', command: 'claude plugin test', description: 'claude plugin test', agentId: 'agent-etat-actuel' })

  const ui = await $.ui.mount(PANE)
  const rows = await rowsOf(ui)
  // The seven agents, the lost one, the Agent call is untracked, the two commands.
  expect(rows).toContain('Activity · 10')
  const order = [
    rowAt(rows, /^⚙ audit-supervision · 5\/7 agents$/),
    rowAt(rows, /^◌ etat-actuel · opus · 12m$/),
    rowAt(rows, /^◌ terminaux · opus · 9m$/),
    rowAt(rows, /^✓ etat-actuel: claude plugin test$/),
    rowAt(rows, /^\? ended without a result: general-purpose$/),
  ]
  expect(order.every(index => index >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  // On a narrow pane each row is cut with "…", never spilled onto a second line.
  for (const row of [/^⚙ /, /^◌ etat-actuel/, /^✓ etat-actuel: /, /^\? ended/]) {
    expect((await ui.find({ type: 'Text', text: row }))?.props.wrap).toBe('truncate-end')
  }
  // Four rows under the workflow's own: the older command waits under ▸ all, with the finished agents.
  expect(rowAt(rows, /older command/)).toBe(-1)
  expect(rowAt(rows, /historique/)).toBe(-1)

  await ui.press({ key: 'activity-toggle' })
  const all = await rowsOf(ui)
  expect(rowAt(all, /older command/)).toBeGreaterThan(-1)
  expect(rowAt(all, /^◌ etat-actuel · opus · 12m$/)).toBeLessThan(rowAt(all, /^✓ historique · opus · 0s$/))
  expect(rowAt(all, /^✓ historique · opus · 0s$/)).toBeGreaterThan(-1)
  await ui.unmount()
})

test('a workflow of seven running agents does not flood Activity', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Workflow', script: 'export const meta = {}' })
  for (const index of [1, 2, 3, 4, 5, 6, 7]) await spawnInRun($, index, `agent${index}`)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'A command', agentId: 'agent-agent1' })

  const ui = await $.ui.mount(PANE)
  const rows = await rowsOf(ui)
  expect(rows).toContain('⚙ audit-supervision · 0/7 agents')
  expect(rows.filter(row => /^◌ agent\d/.test(row)).length).toBe(4)
  expect(rowAt(rows, /^◌ agent1 ·/)).toBeLessThan(rowAt(rows, /^◌ agent4 ·/))
  expect(rowAt(rows, /A command/)).toBe(-1)
  expect(await ui.find({ type: 'Text', text: /^◌ 7 agents running$/ })).toBeDefined()

  await ui.press({ key: 'activity-toggle' })
  const all = await rowsOf(ui)
  expect(all.filter(row => /^◌ agent\d/.test(row)).length).toBe(7)
  expect(rowAt(all, /A command/)).toBeGreaterThan(-1)
  await ui.unmount()
})

test('a workflow agent’s end, good or bad, moves the count; those with no result are said', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  for (const [index, name] of ['good', 'broken', 'stopped'].entries()) await spawnInRun($, index + 1, name)
  await endTurnOf($, 'agent-good')
  await endTurnOf($, 'agent-broken', 'error')
  await endTurnOf($, 'agent-stopped', 'aborted')

  const ui = await $.ui.mount(PANE)
  // Nothing runs: the run waits under ▸ all, and the pane rests. Its name was never given.
  expect(await ui.find({ type: 'Text', text: /⚙/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /○ Ready/ })).toBeDefined()
  await ui.press({ key: 'activity-toggle' })
  expect(await ui.find({ type: 'Text', text: /^⚙ wf_78595e9c · 3\/3 agents · 2 no result$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ good · opus · 0s$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✗ broken · opus · 0s$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^◼ stopped · opus · 0s$/ })).toBeDefined()
  await ui.unmount()
})

test('what the pane does not know of a workflow never breaks what it watches', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

  // Ids on no row: an engine's fork, a stalled agent's retry.
  await endTurnOf($, 'nobody')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls', description: 'Stranger', agentId: 'nobody' })).isError).not.toBe(true)
  // A Workflow call that failed or answered in an unknown shape names nothing and is left as it was.
  const broken = await $.tool.call({ tool: 'Workflow', script: 'broken' })
  expect(broken.isError).toBe(true)
  const odd = await $.tool.call({ tool: 'Workflow', script: 'odd' })
  expect(odd.result as unknown).toBe('Workflow launched in background.')
  // A refused spawn starts nothing, and the refusal stands; a remote agent has no id to follow.
  expect((await spawnInRun($, 1, 'refused')).deny).toBe('no')
  expect((await spawnInRun($, 2, 'remote')).model).toBe('claude-opus-5-5')
  // Empty only outside a real run.
  await spawnInRun($, 1, 'plain', '')

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^⚙ workflow · 0\/1 agents$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /refused|remote/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^✓ ↳ Stranger$/ })).toBeDefined()
  await ui.unmount()
})

test('a spawn the pane chokes on still starts, and the agent keeps its id', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const started = await $.agent.spawn({ prompt: 'go', description: 'odd', subagentType: 'x', workflow: null } as never)
  expect(started.agentId).toBe('agent-odd')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /⚙|odd/ })).toBeUndefined()
  await ui.unmount()
})

test('a plain agent’s spawn is left to the engine’s list', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const started = await $.agent.spawn({ prompt: 'go', description: 'plain' } as never)
  expect(started.agentId).toBe('agent-plain')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /⚙|plain/ })).toBeUndefined()
  await ui.unmount()
})

test('a workflow’s rows are not saved, and neither is more than the newest 50 commands', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.id', () => ({ value: 'abc' }))
  const saved = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: saved.get(e.key) }))
  on('store.delete', () => ({ value: undefined }))
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('store.set', (_, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Workflow', script: 'export const meta = {}' })
  await spawnInRun($, 1, 'etat-actuel')
  for (let step = 1; step <= 60; step++) await $.tool.call({ tool: 'Bash', command: 'ls', description: `Step ${step}` })
  await endMainTurn($)
  await settle()

  const session = saved.get('session:abc') as { commands: unknown[]; agents: unknown[] }
  expect(session.commands.length).toBe(50)
  expect(JSON.stringify([...saved.values()])).not.toContain('audit-supervision')
  expect(JSON.stringify([...saved.values()])).not.toContain('etat-actuel')

  // In the pane, the 60 remain: the bound in memory is higher than a run's commands at the median.
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'activity-toggle' })
  expect(await ui.find({ type: 'Text', text: 'Commands & skills · 60' })).toBeDefined()
  await ui.unmount()
})

test('/clear forgets the workflows', async ($, on) => {
  engine(on)
  on('session.end', () => ({ sessionId: 'abc' }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await spawnInRun($, 1, 'etat-actuel')
  await $.session.end({ reason: 'clear', sessionId: 'abc' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /⚙|etat-actuel|running/ })).toBeUndefined()
  await ui.unmount()
})

test('once no workflow is in flight, an agent still running is said to have no result', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('classic.Stop', () => ({}))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await spawnInRun($, 1, 'stuck')

  // Still in flight, or no word on it: it runs.
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'w1', type: 'workflow', status: 'running', description: 'x' }],
  })
  await $.classic.Stop({ stop_hook_active: false })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^◌ stuck · opus · 0s$/ })).toBeDefined()

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  expect(await ui.find({ type: 'Text', text: /^\? ended without a result: workflow-subagent$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agents? running/ })).toBeUndefined()

  // The end heard after all corrects it.
  await endTurnOf($, 'agent-stuck')
  expect(await ui.find({ type: 'Text', text: /ended without a result/ })).toBeUndefined()
  await ui.press({ key: 'activity-toggle' })
  expect(await ui.find({ type: 'Text', text: /^✓ stuck · opus · 0s$/ })).toBeDefined()
  await ui.unmount()
})

// ── The other sessions ───────────────────────────────────────────────────────

// A store in memory the test can look into (the kit's has no window): what it holds, and every
// key written or deleted, in order.
const memory = { data: new Map<string, unknown>(), writes: [] as string[] }
function memoryStore(on: On, entries: Record<string, unknown> = {}): void {
  memory.data = new Map(Object.entries(entries))
  memory.writes = []
  on('store.get', (_, e) => ({ value: memory.data.get(e.key) }))
  on('store.set', (_, e) => {
    memory.writes.push(`set ${e.key}`)
    memory.data.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    memory.writes.push(`delete ${e.key}`)
    memory.data.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...memory.data.keys()] }))
}
const storedKeys = (prefix = '') => [...memory.data.keys()].filter(key => key.startsWith(prefix)).sort()

const ALL_WORDS = (n: number, word = 'x') => word.repeat(n)

// The Sessions section as drawn: its header, and the text of each row in order.
async function sectionOf(ui: { findAll: (query: { type?: string }) => Promise<{ key?: string; text?: string }[]> }) {
  const texts = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
  const boxes = await ui.findAll({ type: 'Box' })
  const head = texts.find(item => /^([▸▾] )?Sessions · /.test(item.text ?? ''))?.text
  return {
    header: head?.replace(/^[▸▾] /, ''),
    arrow: /^[▸▾]/.exec(head ?? '')?.[0],
    rows: boxes.filter(item => item.key?.startsWith('session-')).map(item => item.text ?? ''),
    keys: boxes.filter(item => item.key?.startsWith('session-')).map(item => item.key),
  }
}

// A session of the fake engine that starts, shows its pane and reads the list once.
async function withSessions(
  on: On,
  agents: unknown[],
  store: Record<string, unknown> = {},
  ran: string[] = [],
): Promise<MockClock> {
  const clock = engine(on, true, ran)
  on('session.id', () => ({ value: 'own-id' }))
  memoryStore(on, store)
  fx.agents = JSON.stringify(agents)
  fx.tree = GHOSTTY_TREE
  return clock
}

const OWN = sessionRow({ sessionId: 'own-id', pid: 4242, name: 'cockpit-itself', status: 'busy' })

test('sessions: those that wait come first, the longest wait on top, then working, then idle', async ($, on) => {
  const clock = await withSessions(
    on,
    [
      OWN,
      sessionRow({ name: 'billing-app', sessionId: 'd', pid: 5004 }),
      sessionRow({ name: 'journal', sessionId: 'b', pid: 5002, status: 'busy' }),
      sessionRow({ name: 'Acme-co', sessionId: 'a', pid: 5001, status: 'waiting', waitingFor: 'permission prompt' }),
      sessionRow({ name: 'billing-app', sessionId: 'c', pid: 5003 }),
    ],
    { 'verdict:5003': published({ sessionId: 'c', pid: 5003 }) },
  )
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)

  // What was already so at this Cockpit's first look has no time: nobody knows since when. A wait
  // of unknown age goes first: it has lasted at least that long.
  let section = await sectionOf(ui)
  expect(section.header).toBe('Sessions · 4 open · 2 wait for you')
  expect(section.keys).toEqual(['session-a', 'session-c', 'session-b', 'session-d'])
  expect(section.rows[0]).toMatch(/^\? Acme-co +permission ↗ go$/)
  expect(section.rows[1]).toMatch(/^\? billing-app {2}Choisir A ou B · 14m ↗ go$/)
  expect(section.rows[2]).toMatch(/^◉ journal +working ↗ go$/)
  expect(section.rows[3]).toMatch(/^○ billing-app +idle ↗ go$/)
  // This session is not in its own list.
  expect(section.keys).not.toContain('session-own-id')

  // A change it saw has a time, counted by the mod, as of the pane's last redraw (every minute).
  fx.agents = JSON.stringify([
    OWN,
    sessionRow({ name: 'billing-app', sessionId: 'd', pid: 5004, status: 'busy' }),
    sessionRow({ name: 'journal', sessionId: 'b', pid: 5002, status: 'waiting', waitingFor: 'input needed' }),
    sessionRow({ name: 'Acme-co', sessionId: 'a', pid: 5001, status: 'waiting', waitingFor: 'permission prompt' }),
    sessionRow({ name: 'billing-app', sessionId: 'c', pid: 5003 }),
  ])
  await clock.advance(25_000)
  await clock.advance(190_000)
  section = await sectionOf(ui)
  expect(section.rows[0]).toMatch(/^\? Acme-co +permission ↗ go$/)
  expect(section.rows[1]).toContain('Choisir A ou B · 17m')
  expect(section.rows[2]).toContain('question · 2m')
  expect(section.rows[3]).toContain('working · 2m')
  await ui.unmount()
})

test('sessions: a question and the other waits read as Claude Code says them', () => {
  const at = NOW
  const item = (fields: Record<string, unknown>) => describe(parseSessions(JSON.stringify([sessionRow(fields)]))![0]!, [], at)
  expect(item({ status: 'waiting', waitingFor: 'input needed' })?.detail).toBe('question')
  expect(item({ status: 'waiting', waitingFor: 'permission prompt' })?.detail).toBe('permission')
  expect(item({ status: 'waiting', waitingFor: 'sandbox request' })?.detail).toBe('sandbox')
  expect(item({ status: 'waiting', waitingFor: 'something new' })?.detail).toBe('something new')
  expect(item({ status: 'waiting' })?.detail).toBe('blocked')
  expect(item({ status: 'busy' })?.group).toBe('work')
  expect(item({ status: 'idle', state: 'working' })?.group).toBe('work')
  expect(item({ status: 'idle', state: 'done' })?.group).toBe('idle')
})

test('sessions: with nothing waiting there is one line, pressed to show the rows', async ($, on) => {
  const clock = await withSessions(on, [
    OWN,
    sessionRow({ name: 'journal', sessionId: 'b', pid: 5002, status: 'busy' }),
    sessionRow({ name: 'site', sessionId: 'd', pid: 5004 }),
  ])
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)

  // The arrow says the line unfolds: nothing else on screen would tell.
  let section = await sectionOf(ui)
  expect(section.header).toBe('Sessions · 2 open · none waits')
  expect(section.arrow).toBe('▸')
  expect(section.rows).toEqual([])
  await ui.press({ key: 'sessions-toggle' })
  section = await sectionOf(ui)
  expect(section.header).toBe('Sessions · 2 open · none waits')
  expect(section.arrow).toBe('▾')
  expect(section.rows).toHaveLength(2)
  await ui.press({ key: 'sessions-toggle' })
  section = await sectionOf(ui)
  expect(section.arrow).toBe('▸')
  expect(section.rows).toEqual([])
  await ui.unmount()
})

test('sessions: rows shown because one waits need no arrow', async ($, on) => {
  const clock = await withSessions(on, [OWN, sessionRow({ name: 'site', sessionId: 'a', status: 'waiting', waitingFor: 'input needed' })])
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  const section = await sectionOf(ui)
  expect(section.arrow).toBeUndefined()
  expect(section.rows).toHaveLength(1)
  await ui.unmount()
})

test('sessions: a background session has delete and attach, an open tab keeps go and neither', async ($, on) => {
  const clock = await withSessions(on, [
    OWN,
    sessionRow({ name: 'in-the-back', id: '9b949703', kind: 'background', sessionId: 'back', pid: 7105, state: 'working', status: 'idle' }),
    sessionRow({ name: 'a-tab', id: 'tab1', sessionId: 'tab', pid: 5002, status: 'busy' }),
  ])
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  await ui.press({ key: 'sessions-toggle' })
  expect(await ui.find({ key: 'go-tab' })).toBeDefined()
  expect(await ui.find({ key: 'go-back' })).toBeUndefined()
  expect((await ui.find({ key: 'delete-back' }))?.text).toBe(' ✕ delete')
  expect(await ui.find({ key: 'delete-tab' })).toBeUndefined()
  expect((await ui.find({ key: 'attach-back' }))?.text).toBe(' ↗ go')
  expect(await ui.find({ key: 'attach-tab' })).toBeUndefined()
  expect((await sectionOf(ui)).keys).toContain('session-back')
  await ui.unmount()
})

test('sessions: no other session, no section', async ($, on) => {
  const clock = await withSessions(on, [OWN])
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  const section = await sectionOf(ui)
  expect(section.header).toBeUndefined()
  expect(section.rows).toEqual([])
  await ui.unmount()
})

test('sessions: four rows at most, the rest on a "+N more" line that unfolds', async ($, on) => {
  const many = Array.from({ length: 6 }, (_, index) =>
    sessionRow({ name: `agent-${index}`, sessionId: `s${index}`, pid: 6000 + index, status: 'waiting', waitingFor: 'input needed' }),
  )
  const clock = await withSessions(on, [OWN, ...many])
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)

  expect((await sectionOf(ui)).rows).toHaveLength(4)
  expect((await ui.find({ key: 'sessions-more' }))?.text).toBe('+2 more')
  await ui.press({ key: 'sessions-more' })
  expect((await sectionOf(ui)).rows).toHaveLength(6)
  await ui.press({ key: 'sessions-more' })
  expect((await sectionOf(ui)).rows).toHaveLength(4)
  await ui.unmount()
})

test('sessions: an old row goes under "N old", counts nowhere, and is deleted on a second press', async ($, on) => {
  const ran: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const clock = await withSessions(
    on,
    [
      OWN,
      sessionRow({ name: 'journal', sessionId: 'b', pid: 5002, status: 'busy' }),
      sessionRow({ name: 'Phase 0 pilot', id: 'old1', kind: 'background', sessionId: 'o1', pid: null, state: 'working', status: null }),
      sessionRow({
        name: 'Audit instructions',
        id: 'old2',
        kind: 'background',
        sessionId: 'o2',
        pid: null,
        state: 'blocked',
        status: null,
        waitingFor: 'input needed',
        startedAt: NOW - 30 * 3_600_000,
      }),
    ],
    {},
    ran,
  )
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)

  let section = await sectionOf(ui)
  // 1 open, nothing waits: the old ones are in neither count.
  expect(section.header).toBe('Sessions · 1 open · none waits')
  expect((await ui.find({ key: 'sessions-old' }))?.text).toBe(' ▸ 2 old')
  expect(section.rows).toEqual([])

  await ui.press({ key: 'sessions-old' })
  section = await sectionOf(ui)
  expect(section.rows).toHaveLength(2)
  expect(section.rows.join('\n')).toContain('"working", no process')
  expect(section.rows.join('\n')).toMatch(/Audit instructio… +blocked, started 21\/10 ✕ delete/)
  expect((await ui.find({ key: 'sessions-old' }))?.text).toBe(' ▾ 2 old')

  const removals = () => ran.filter(argv => argv.includes('"rm"')).length
  const reads = () => ran.filter(argv => argv.includes('"agents"')).length
  const readsBefore = reads()
  await ui.press({ key: 'delete-o1' })
  expect(removals()).toBe(0)
  // A press on another row does not confirm this one.
  await ui.press({ key: 'delete-o2' })
  expect(removals()).toBe(0)
  await clock.advance(6_000)
  await ui.press({ key: 'delete-o2' })
  expect(removals()).toBe(0)
  await ui.press({ key: 'delete-o2' })
  expect(removals()).toBe(1)
  expect(ran.some(argv => argv.includes('"claude","rm","old2"'))).toBe(true)
  // No process, so nothing to stop.
  expect(ran.some(argv => argv.includes('"stop"'))).toBe(false)
  expect(toasts.at(-1)).toBe('Deleted Audit instructions')
  // The list is read again after the delete (the timer's own reads are 25 s apart).
  expect(reads()).toBe(readsBefore + 1)

  // A failure gives its reason from stderr, and the row stays: nothing is read again.
  fx.rmExit = 1
  fx.rmStderr = "\nNo job matching 'old1'\nsecond line\n"
  await clock.advance(1_000)
  await ui.press({ key: 'delete-o1' })
  const readsAfterArm = reads()
  await ui.press({ key: 'delete-o1' })
  expect(removals()).toBe(2)
  expect(reads()).toBe(readsAfterArm)
  expect(toasts.at(-1)).toBe("Couldn’t delete Phase 0 pilot: No job matching 'old1'")
  await ui.unmount()
})

test('sessions: ↗ go on a background session attaches to it in a new tab', async ($, on) => {
  const ran: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const clock = await withSessions(
    on,
    [
      OWN,
      sessionRow({ name: 'in-the-back', id: '9b949703', kind: 'background', sessionId: 'back', pid: 7105, state: 'working', status: 'idle' }),
      sessionRow({ name: 'bad-id', id: 'a b;c', kind: 'background', sessionId: 'bad', pid: 7106, state: 'working', status: 'idle' }),
      sessionRow({ name: 'no-process', id: 'old1', kind: 'background', sessionId: 'o1', pid: null, state: 'working' }),
    ],
    {},
    ran,
  )
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  await ui.press({ key: 'sessions-toggle' })
  await ui.press({ key: 'sessions-old' })
  // The new-tab script names its configuration `GScI`, the title one its `bare` helper.
  const newTabs = () => ran.filter(argv => argv.includes('GScI') && argv.includes('claude attach'))
  const lookups = () => ran.filter(argv => argv.includes('bare('))

  // Nothing to attach to without a process: it could start its work again.
  expect(await ui.find({ key: 'delete-o1' })).toBeDefined()
  expect(await ui.find({ key: 'attach-o1' })).toBeUndefined()

  // No tab has its name: a new one attaches to it.
  await ui.press({ key: 'attach-back' })
  expect(lookups()).toHaveLength(1)
  expect(lookups()[0]).toContain('"in-the-back","claude attach 9b949703"')
  expect(newTabs()).toHaveLength(1)
  expect(newTabs()[0]).toContain('"osascript"')
  expect(newTabs()[0]).toContain('claude attach 9b949703')
  expect(toasts.at(-1)).toBe('Opening in-the-back in a new tab…')

  // A press right after does nothing: the new tab has no title yet, so it would open a second one.
  await ui.press({ key: 'attach-back' })
  expect(lookups()).toHaveLength(1)
  expect(newTabs()).toHaveLength(1)
  await clock.advance(9_000)

  // A tab with its name comes forward, silently, and none opens.
  fx.titleExit = 0
  const toastsBefore = toasts.length
  await ui.press({ key: 'attach-back' })
  expect(lookups()).toHaveLength(2)
  expect(newTabs()).toHaveLength(1)
  expect(toasts).toHaveLength(toastsBefore)
  fx.titleExit = 1

  // A strange id never reaches the shell.
  await ui.press({ key: 'attach-bad' })
  expect(lookups()).toHaveLength(2)
  expect(newTabs()).toHaveLength(1)
  expect(toasts.at(-1)).toBe('Couldn’t open bad-id')

  // Ghostty refusing is said, and so is a command that fails outright.
  await clock.advance(9_000)
  fx.osascriptExit = 1
  await ui.press({ key: 'attach-back' })
  expect(toasts.at(-1)).toBe('Couldn’t open in-the-back')
  await clock.advance(9_000)
  fx.osascriptExit = 0
  fx.osascriptFails = true
  toasts.length = 0
  await ui.press({ key: 'attach-back' })
  expect(toasts).toEqual(['Couldn’t open in-the-back'])
  fx.osascriptFails = false
  await ui.unmount()
})

test('sessions: a recent blocked session with no process can be deleted, not attached to', async ($, on) => {
  const clock = await withSessions(on, [
    OWN,
    sessionRow({
      name: 'blocked-now',
      id: 'b1',
      kind: 'background',
      sessionId: 'bn',
      pid: null,
      state: 'blocked',
      status: null,
      waitingFor: 'input needed',
      startedAt: NOW - 3_600_000,
    }),
  ])
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  // It waits, so its row shows, not under "old": this is the row the process guard is there for.
  expect((await sectionOf(ui)).keys).toContain('session-bn')
  expect(await ui.find({ key: 'delete-bn' })).toBeDefined()
  expect(await ui.find({ key: 'attach-bn' })).toBeUndefined()
  await ui.unmount()
})

test('sessions: outside Ghostty a background session keeps delete, with nothing to attach in', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const clock = await withSessions(on, [
    OWN,
    sessionRow({ name: 'in-the-back', id: '9b949703', kind: 'background', sessionId: 'back', pid: 7105, state: 'working', status: 'idle' }),
  ])
  fx.tree = null
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  await ui.press({ key: 'sessions-toggle' })
  expect(await ui.find({ key: 'attach-back' })).toBeUndefined()
  expect(await ui.find({ key: 'delete-back' })).toBeDefined()
  // No Ghostty to ask: the plain words.
  fx.titleExit = 0
  await ui.press({ key: 'delete-back' })
  expect(toasts.at(-1)).toBe('Press delete again within 5 s to delete in-the-back')
  await ui.unmount()
})

test('sessions: ✕ delete warns when a tab shows the session, without bringing that tab forward', async ($, on) => {
  const ran: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const clock = await withSessions(
    on,
    [
      OWN,
      sessionRow({ name: 'in-the-back', id: '9b949703', kind: 'background', sessionId: 'back', pid: 7105, state: 'working', status: 'idle' }),
      sessionRow({ name: 'other', id: 'other1', kind: 'background', sessionId: 'oth', pid: 7106, state: 'working', status: 'idle' }),
      sessionRow({ name: 'no-process', id: 'old1', kind: 'background', sessionId: 'o1', pid: null, state: 'working' }),
    ],
    {},
    ran,
  )
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  await ui.press({ key: 'sessions-toggle' })
  await ui.press({ key: 'sessions-old' })
  const verbs = () => ran.filter(argv => argv.includes('"stop"') || argv.includes('"rm"'))
  const looks = () => ran.filter(argv => argv.includes('titledTab('))

  // A tab has its name: the first press says so, runs nothing, and leaves the tabs as they are.
  fx.titleExit = 0
  await ui.press({ key: 'delete-back' })
  expect(toasts.at(-1)).toBe('in-the-back is open in a tab. Press delete again within 5 s to stop and delete it')
  expect(verbs()).toEqual([])
  expect(looks()).toHaveLength(1)
  expect(looks()[0]).toContain('"in-the-back","claude attach 9b949703"')
  expect(looks()[0]).not.toContain('selectTab')
  expect(looks()[0]).not.toContain('app.focus')

  // The second press confirms, with no look of its own.
  await ui.press({ key: 'delete-back' })
  expect(verbs()).toHaveLength(2)
  expect(looks()).toHaveLength(1)
  expect(toasts.at(-1)).toBe('Deleted in-the-back')

  // A look that fails leaves the plain words, and the button still works.
  fx.osascriptFails = true
  await ui.press({ key: 'delete-back' })
  expect(toasts.at(-1)).toBe('Press delete again within 5 s to delete in-the-back')
  await ui.press({ key: 'delete-back' })
  expect(verbs()).toHaveLength(4)
  fx.osascriptFails = false

  // With no process there is nothing to stop, and a tab of that name is not its own: no look.
  const looksBefore = looks().length
  await ui.press({ key: 'delete-o1' })
  expect(toasts.at(-1)).toBe('Press delete again within 5 s to delete no-process')
  expect(looks()).toHaveLength(looksBefore)

  // A press on another row disarms at once: coming back while it still looks deletes nothing.
  const verbsBefore = verbs().length
  await ui.press({ key: 'delete-back' })
  let open = () => {}
  fx.titleGate = new Promise<void>(resolve => {
    open = resolve
  })
  const onOther = ui.press({ key: 'delete-oth' })
  const onBack = ui.press({ key: 'delete-back' })
  open()
  await Promise.all([onOther, onBack])
  fx.titleGate = null
  expect(verbs()).toHaveLength(verbsBefore)
  await ui.unmount()
})

test('sessions: ✕ delete stops a running session first and says how far it went', async ($, on) => {
  const ran: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const clock = await withSessions(
    on,
    [
      OWN,
      sessionRow({ name: 'in-the-back', id: '9b949703', kind: 'background', sessionId: 'back', pid: 7105, state: 'working', status: 'idle' }),
      sessionRow({ name: 'bad-id', id: 'a b;c', kind: 'background', sessionId: 'bad', pid: 7106, state: 'working', status: 'idle' }),
    ],
    {},
    ran,
  )
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  await ui.press({ key: 'sessions-toggle' })
  const verbs = () => ran.filter(argv => argv.includes('"stop"') || argv.includes('"rm"'))
  const reads = () => ran.filter(argv => argv.includes('"agents"')).length
  const deleteTwice = async (key: string) => {
    await ui.press({ key })
    await ui.press({ key })
  }

  // The first press only arms it.
  await ui.press({ key: 'delete-back' })
  expect(verbs()).toEqual([])
  expect(toasts.at(-1)).toBe('Press delete again within 5 s to delete in-the-back')
  await ui.press({ key: 'delete-back' })
  expect(verbs()).toHaveLength(2)
  expect(verbs()[0]).toContain('"claude","stop","9b949703"')
  expect(verbs()[1]).toContain('"claude","rm","9b949703"')
  expect(toasts.at(-1)).toBe('Deleted in-the-back')

  // Stop refused: nothing is removed, and the list has not changed.
  fx.stopExit = 1
  let readsBefore = reads()
  await deleteTwice('delete-back')
  expect(verbs()).toHaveLength(3)
  expect(verbs()[2]).toContain('"stop"')
  expect(reads()).toBe(readsBefore)
  expect(toasts.at(-1)).toBe('Couldn’t delete in-the-back')

  // Stopped, then removal refused on stdout over unsaved work: the session did stop, so it leaves
  // the list. Say so, and say where the work is.
  fx.stopExit = 0
  fx.rmExit = 1
  fx.rmStdout = 'kept 9b949703 — its worktree is still at /tmp/wt\n  2 unpushed commits\n'
  readsBefore = reads()
  await deleteTwice('delete-back')
  expect(reads()).toBe(readsBefore + 1)
  expect(toasts.at(-1)).toBe('Stopped in-the-back, not deleted: kept 9b949703 — its worktree is still at /tmp/wt')

  // Nothing that throws work away is ever passed, and a strange id never reaches a command.
  const before = verbs().length
  await deleteTwice('delete-bad')
  expect(verbs()).toHaveLength(before)
  expect(toasts.at(-1)).toBe('Couldn’t delete bad-id')
  expect(verbs().join()).not.toContain('--')
  await ui.unmount()
})

test('sessions: a verdict is published under this Cockpit’s own key and removed with the next turn', async ($, on) => {
  const clock = engine(on)
  on('session.id', () => ({ value: 'own-id' }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  memoryStore(on, { pins: [{ id: 'p' }], 'notes:/project': { text: 'witness' } })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const end = (turnId: string, answer: string, isAborted = false) =>
    $.turn.complete({ turnId, answer, durationMs: 1_000, isAborted, reason: isAborted ? 'aborted' : 'answer' })
  const keys = async () => storedKeys('verdict:')

  await $.turn.start({ text: 'go', turnId: 't1' })
  await end('t1', '{decide|Choisis **A** ou B pour la suite}\n\nDétails.')
  await clock.settle()
  expect(await keys()).toEqual(['verdict:4242'])
  expect(memory.data.get('verdict:4242')).toEqual({
    kind: 'decide',
    words: 'Choisis A ou B pour la suite',
    at: clock.now(),
    sessionId: 'own-id',
    pid: 4242,
  })

  // The next turn takes it back.
  await $.turn.start({ text: 'A', turnId: 't2' })
  await clock.settle()
  expect(await keys()).toEqual([])

  // A blocked verdict, bounded to 120 characters.
  await end('t2', `{blocked|${ALL_WORDS(200, 'mot ')}}\n\nDétails.`)
  await clock.settle()
  const blocked = (memory.data.get('verdict:4242')) as { kind: string; words: string }
  expect(blocked.kind).toBe('blocked')
  expect(blocked.words.length).toBeLessThanOrEqual(120)
  expect(blocked.words.endsWith('…')).toBe(true)

  // An answer with no verdict, a done verdict or a stopped turn publishes nothing and takes it back.
  await end('t3', 'Fait. Rien à décider.')
  await clock.settle()
  expect(await keys()).toEqual([])
  await end('t4', '{done|Publié}\n\nTerminé.')
  await clock.settle()
  expect(await keys()).toEqual([])
  await end('t5', '{decide|On continue ?}', true)
  await clock.settle()
  expect(await keys()).toEqual([])

  // /clear takes it back too.
  await end('t6', '{decide|Garder ou retirer ?}')
  await clock.settle()
  expect(await keys()).toEqual(['verdict:4242'])
  await $.session.end({ reason: 'clear', sessionId: 'own-id', resume: {} as never })
  await clock.settle()
  expect(await keys()).toEqual([])

  // Only that key was written: the others are as they were.
  expect(memory.data.get('pins')).toEqual([{ id: 'p' }])
  expect(memory.data.get('notes:/project')).toEqual({ text: 'witness' })
  expect(toasts).toEqual([])
})

test('sessions: a verdict from another Cockpit shows on its idle row, and goes when the session works again', async ($, on) => {
  const clock = await withSessions(
    on,
    [OWN, sessionRow({ name: 'billing-app', sessionId: 's-1', pid: 5001 })],
    { 'verdict:5001': published({ words: 'Valider le plan ?', at: NOW - 60_000 }) },
  )
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  expect((await sectionOf(ui)).rows[0]).toMatch(/^\? billing-app +Valider le plan \? · 1m/)

  // Its session works again: the words are not shown, whatever the store still holds.
  fx.agents = JSON.stringify([OWN, sessionRow({ name: 'billing-app', sessionId: 's-1', pid: 5001, status: 'busy' })])
  await clock.advance(30_000)
  expect((await sectionOf(ui)).header).toBe('Sessions · 1 open · none waits')
  await ui.press({ key: 'sessions-toggle' })
  expect((await sectionOf(ui)).rows[0]).toMatch(/^◉ billing-app +working/)
  await ui.unmount()
})

test('sessions: a verdict still finds its row when the session id changed, not when the process number was reused', () => {
  const [session] = parseSessions(JSON.stringify([sessionRow({ sessionId: 'after-clear', pid: 5001, startedAt: NOW - 3_600_000 })]))!
  expect(belongsTo(published({ sessionId: 'before-clear', pid: 5001, at: NOW - 60_000 }), session!)).toBe(true)
  // Written before this process began: it belonged to an earlier process under the same number.
  expect(belongsTo(published({ sessionId: 'earlier', pid: 5001, at: NOW - 7_200_000 }), session!)).toBe(false)
  expect(belongsTo(published({ sessionId: 'other', pid: 7777 }), session!)).toBe(false)
})

test('sessions: a conversation resumed in a new process does not wait on what the old one asked', async ($, on) => {
  const day = 24 * 3_600_000
  // The same conversation id, another process: its answer to that verdict is not the old key's.
  const [session] = parseSessions(JSON.stringify([sessionRow({ sessionId: 's-1', pid: 5001, startedAt: NOW - 3_600_000 })]))!
  expect(belongsTo(published({ sessionId: 's-1', pid: 4000, at: NOW - 60_000 }), session!)).toBe(false)
  expect(belongsTo(published({ sessionId: 's-1', pid: 5001, at: NOW - 60_000 }), session!)).toBe(true)
  // Written before this process began, by the same number or by none.
  expect(belongsTo(published({ sessionId: 's-1', pid: 5001, at: NOW - 7_200_000 }), session!)).toBe(false)
  // With no process on one side, the conversation's id is all there is.
  const [gone] = parseSessions(JSON.stringify([sessionRow({ sessionId: 's-1', pid: null, startedAt: NOW - 3_600_000 })]))!
  expect(belongsTo(published({ sessionId: 's-1', pid: 4000, at: NOW - 60_000 }), gone!)).toBe(true)

  const clock = await withSessions(on, [OWN, sessionRow({ name: 'site', sessionId: 's-1', pid: 5001, startedAt: NOW - 3_600_000 })], {
    'verdict:4000': published({ sessionId: 's-1', pid: 4000, at: NOW - 2 * day }),
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  expect((await sectionOf(ui)).header).toBe('Sessions · 1 open · none waits')
  // The key of a process long gone leaves with the clean-up, though its conversation is listed.
  await clock.settle()
  expect(await storedKeys('verdict:')).toEqual([])
  await ui.unmount()
})

test('sessions: a Cockpit that cannot learn its process publishes nothing, and asks again next time', async ($, on) => {
  const clock = await withSessions(on, [OWN])
  on('turn.complete', () => ({ text: 'ok' }))
  fx.ownPid = 0
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const end = (turnId: string) =>
    $.turn.complete({ turnId, answer: '{decide|Choisir A ou B}', durationMs: 1_000, isAborted: false, reason: 'answer' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await end('t1')
  await clock.settle()
  expect(await storedKeys('verdict:')).toEqual([])

  fx.ownPid = 4242
  await $.turn.start({ text: 'go', turnId: 't2' })
  await end('t2')
  await clock.settle()
  expect(await storedKeys('verdict:')).toEqual(['verdict:4242'])
})

test('sessions: whatever ends the conversation takes its published verdict, /resume too', async ($, on) => {
  const clock = await withSessions(on, [OWN])
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '{decide|Choisir A ou B}', durationMs: 1_000, isAborted: false, reason: 'answer' })
  await clock.settle()
  expect(await storedKeys('verdict:')).toEqual(['verdict:4242'])
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: {} } as never)
  await clock.settle()
  expect(await storedKeys('verdict:')).toEqual([])
})

test('sessions: a list not read for a while says so, and the next good read takes it back', async ($, on) => {
  const clock = await withSessions(on, [OWN, sessionRow({ name: 'Acme-co', sessionId: 'a', status: 'waiting', waitingFor: 'input needed' })])
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  expect((await sectionOf(ui)).header).toBe('Sessions · 1 open · 1 waits for you')

  fx.agentsFails = true
  await clock.advance(125_000)
  expect((await sectionOf(ui)).header).toBe('Sessions · 1 open · 1 waits for you · stale')

  fx.agentsFails = false
  await clock.advance(65_000)
  expect((await sectionOf(ui)).header).toBe('Sessions · 1 open · 1 waits for you')
  await ui.unmount()
})

test('sessions: a short terminal shows three rows, a waiting one is never hidden unsaid', async ($, on) => {
  const clock = await withSessions(on, [
    OWN,
    ...['a', 'b', 'c', 'd', 'e'].map((sessionId, index) =>
      sessionRow({ name: `s-${sessionId}`, sessionId, pid: 5001 + index, status: 'waiting', waitingFor: 'input needed' }),
    ),
  ])
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 30 } } })
  await clock.advance(3_000)
  const section = await sectionOf(ui)
  expect(section.header).toBe('Sessions · 5 open · 5 wait for you')
  expect(section.rows).toHaveLength(3)
  expect((await ui.find({ key: 'sessions-more' }))?.props.label).toBe('+2 more')
  await ui.unmount()
})

test('sessions: a failed, invalid or late read keeps the last list, without an error', async ($, on) => {
  const clock = await withSessions(on, [OWN, sessionRow({ name: 'Acme-co', sessionId: 'a', status: 'waiting', waitingFor: 'input needed' })])
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  const before = await sectionOf(ui)
  expect(before.header).toBe('Sessions · 1 open · 1 waits for you')

  // Not JSON, JSON that is not a list, a failing command, a command that never answers.
  for (const [agents, exitCode, fails] of [
    ['Error: not signed in', 0, false],
    ['{"error":"x"}', 0, false],
    ['[]', 1, false],
    ['[]', 0, true],
  ] as const) {
    fx.agents = agents
    fx.agentsExit = exitCode
    fx.agentsFails = fails
    await clock.advance(25_000)
    const after = await sectionOf(ui)
    expect(after.header?.startsWith(before.header ?? 'none')).toBe(true)
    expect(after.keys).toEqual(before.keys)
  }
  // The first good read afterwards replaces it.
  fx.agents = JSON.stringify([OWN])
  fx.agentsExit = 0
  fx.agentsFails = false
  await clock.advance(25_000)
  expect((await sectionOf(ui)).header).toBeUndefined()
  expect(toasts).toEqual([])
  await ui.unmount()
})

test('sessions: the list is read only while the pane is in view, one read at a time', async ($, on) => {
  const ran: string[] = []
  const clock = await withSessions(on, [OWN, sessionRow({ sessionId: 'a' })], {}, ran)
  const reads = () => ran.filter(argv => argv.includes('"agents"')).length
  fx.isPaneShown = false
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await clock.advance(3_000)
  await clock.advance(60_000)
  expect(reads()).toBe(0)

  // Back in view: read within 5 s, not at the next turn of a long timer.
  fx.isPaneShown = true
  await clock.advance(5_000)
  expect(reads()).toBe(1)
  expect(ran.find(argv => argv.includes('"agents"'))).toContain('"--json"')
  expect(ran.some(argv => argv.includes('--all'))).toBe(false)
  await clock.advance(25_000)
  expect(reads()).toBe(2)
})

test('sessions: outside Ghostty there is no go', async ($, on) => {
  const ran: string[] = []
  const clock = await withSessions(on, [OWN, sessionRow({ name: 'Acme-co', sessionId: 'a', pid: 5001, status: 'waiting', waitingFor: 'input needed' })], {}, ran)
  fx.tree = null
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  expect((await sectionOf(ui)).rows[0]).toMatch(/^\? Acme-co +question$/)
  expect(await ui.find({ key: 'go-a' })).toBeUndefined()
  expect(ran.some(argv => argv.includes('osascript') || argv.includes('"-o","tty="'))).toBe(false)
  await ui.unmount()
})

test('sessions: go works on a click, and finds the tab by its terminal', async ($, on) => {
  const ran: string[] = []
  const toasts: string[] = []
  const clock = await withSessions(on, [OWN, sessionRow({ name: 'Acme-co', sessionId: 'a', pid: 5001, status: 'waiting', waitingFor: 'input needed' })], {}, ran)
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  // Reading the list alone touches neither ps nor osascript.
  expect(ran.some(argv => argv.includes('"ps"') || argv.includes('osascript'))).toBe(false)

  // The session's terminal device, then the tab.
  await ui.press({ key: 'go-a' })
  const focus = JSON.parse(ran.find(argv => argv.includes('osascript'))!) as { argv: string[] }
  expect(focus.argv).toEqual(['osascript', '-l', 'JavaScript', '-e', FOCUS_SCRIPT, '100', '/dev/ttys004'])
  expect(ran.some(argv => argv.includes('"-o","tty=","-p","5001"'))).toBe(true)

  // Ghostty refuses: a short message.
  fx.osascriptExit = 1
  await ui.press({ key: 'go-a' })
  expect(toasts.at(-1)).toBe('Couldn’t switch to Acme-co')
  await ui.unmount()
})

test('sessions: go finds the Ghostty the other session runs under', () => {
  const tree = [
    '500',
    '  500   400 sh',
    '  400   100 claude',
    '  100     1 /Applications/Ghostty.app/Contents/MacOS/ghostty',
    ' 5001    90 claude',
    '   90     1 /Applications/Ghostty.app/Contents/MacOS/ghostty',
    ' 5002    80 claude',
    '   80     1 /usr/bin/tmux',
  ].join('\n')
  expect(ghosttyHost(tree)).toBe(100)
  expect(ghosttyHostOf(tree, 5001)).toBe(90)
  expect(ghosttyHostOf(tree, 5002)).toBeNull()
  // The tab first: `focus` is only said to bring the window to the front.
  expect(FOCUS_SCRIPT.indexOf('selectTab(tab)')).toBeGreaterThan(-1)
  expect(FOCUS_SCRIPT.indexOf('selectTab(tab)')).toBeLessThan(FOCUS_SCRIPT.indexOf('focus(terminal)'))
})

test('sessions: go has no terminal to reach when ps does not say, and says so', async ($, on) => {
  const ran: string[] = []
  const toasts: string[] = []
  const clock = await withSessions(on, [OWN, sessionRow({ name: 'Acme-co', sessionId: 'a', pid: 5001 })], { 'verdict:5001': published({}) }, ran)
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  fx.tree = GHOSTTY_TREE
  fx.psOut = '??\n'
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)
  await ui.press({ key: 'go-a' })
  expect(toasts.at(-1)).toBe('Couldn’t find Acme-co’s tab')
  expect(ran.some(argv => argv.includes('osascript'))).toBe(false)
  await ui.unmount()
})

test('sessions: published keys of sessions gone for over a day are removed, nothing else', async ($, on) => {
  const day = 24 * 3_600_000
  const witnesses = {
    pins: [{ id: 'p' }],
    'notes:/project': { text: 'witness' },
    'session:abc': { commands: [], files: [], agents: [], todos: [], history: [] },
    latest: { sessionId: 'abc', cwd: '/project', savedAt: 1 },
  }
  const clock = await withSessions(on, [OWN, sessionRow({ sessionId: 'kept', pid: 5001, name: 'kept', startedAt: NOW - 3 * day })], {
    ...witnesses,
    'verdict:111': published({ sessionId: 'gone', pid: 111, at: NOW - day - 60_000 }),
    'verdict:222': published({ sessionId: 'recent', pid: 222, at: NOW - 3_600_000 }),
    'verdict:5001': published({ sessionId: 'kept', pid: 5001, at: NOW - 2 * day }),
    'verdict:junk': 'not a verdict',
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await clock.advance(3_000)

  const verdictKeys = storedKeys('verdict:')
  // The old unlisted one goes; a recent one, a listed one and a value that is no verdict stay.
  expect(verdictKeys).toEqual(['verdict:222', 'verdict:5001', 'verdict:junk'])
  for (const [key, value] of Object.entries(witnesses)) expect(memory.data.get(key)).toEqual(value)
  await ui.unmount()
})

test('sessions: published keys are bounded, the oldest unlisted ones first', async ($, on) => {
  const store: Record<string, unknown> = {}
  for (let index = 0; index < 45; index++) {
    store[`verdict:${9000 + index}`] = published({ sessionId: `x${index}`, pid: 9000 + index, at: NOW - 3_600_000 + index * 1_000 })
  }
  const clock = await withSessions(on, [OWN], store)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await clock.advance(3_000)
  const kept = storedKeys('verdict:')
  expect(kept).toHaveLength(40)
  expect(kept).not.toContain('verdict:9000')
  expect(kept).toContain('verdict:9044')
})

test('sessions: a row keeps its time and its "go" at 48 and 53 columns, on one line', async ($, on) => {
  const clock = await withSessions(
    on,
    [
      OWN,
      sessionRow({ name: 'a-very-long-session-name-indeed', sessionId: 'a', pid: 5001, status: 'waiting', waitingFor: 'permission prompt' }),
      sessionRow({ name: 'billing-app', sessionId: 'c', pid: 5003 }),
    ],
    {
      'verdict:5003': published({
        sessionId: 'c',
        pid: 5003,
        words: 'Choisis entre la version A, la version B ou les deux, puis dis-moi laquelle garder',
      }),
    },
  )
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  for (const columns of [48, 53, 61]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns } })
    await clock.advance(3_000)
    const section = await sectionOf(ui)
    expect(section.rows).toHaveLength(2)
    for (const row of section.rows) {
      expect(row.length).toBeLessThanOrEqual(columns)
      expect(row).toMatch(/( · \d+[smh]+)? ↗ go$/)
    }
    const text = await ui.findAll({ type: 'Text' })
    const line = text.find(item => item.text?.startsWith('? a-very'))
    expect(line).toBeDefined()
    await ui.unmount()
  }
})

test('sessions: the rows are cut to fit by their name first, then their words', () => {
  const items = describeAll(
    parseSessions(
      JSON.stringify([
        sessionRow({ name: 'a-very-long-session-name-indeed', sessionId: 'a', status: 'waiting', waitingFor: 'permission prompt' }),
        sessionRow({ name: 'short', sessionId: 'b', pid: 5002 }),
      ]),
    )!,
    [published({ sessionId: 'b', pid: 5002, words: 'Choisis entre la version A, la version B ou les deux, puis dis-moi' })],
    { sessionId: null, pid: null },
    NOW,
  )
  const lines = layOut(items, updatePhases({}, items, NOW)).lines
  for (const columns of [30, 48, 53, 61, 110]) {
    for (const cells of fitLines(lines, columns, 5, NOW)) {
      const text = `x ${cells.name}  ${cells.detail} · ${cells.age}`
      expect(text.length + 5).toBeLessThanOrEqual(Math.max(columns, 8 + 5 + 2 + 3 + 4))
      expect(cells.age).not.toBe('')
    }
  }
  const long = fitLines(lines, 53, 5, NOW).find(cells => cells.name.startsWith('a-very'))
  expect(long!.name.trim().length).toBeLessThanOrEqual(22)
  expect(long!.name.trim().endsWith('…')).toBe(true)
})

test('sessions: the list is read with care, and each phase keeps the time it began', () => {
  expect(parseSessions('')).toBeNull()
  expect(parseSessions('{"sessions":[]}')).toBeNull()
  expect(parseSessions('[1, null, "x", {"cwd":"/a/b"}]')).toEqual([])
  const [row] = parseSessions(JSON.stringify([{ cwd: '/home/me/site', sessionId: 's', pid: 12, kind: 'background', status: 'weird' }]))!
  expect(row!.name).toBe('site')
  expect(row!.kind).toBe('background')
  expect(row!.status).toBeNull()

  const first = updatePhases({}, describeAll([row!], [], { sessionId: null, pid: null }, NOW), NOW)
  const again = updatePhases(first, describeAll([row!], [], { sessionId: null, pid: null }, NOW + 60_000), NOW + 60_000)
  expect(again.s).toEqual(first.s)
  const busy = { ...row!, status: 'busy' as const }
  const changed = updatePhases(again, describeAll([busy], [], { sessionId: null, pid: null }, NOW + 120_000), NOW + 120_000)
  expect(changed.s!.since).toBe(NOW + 120_000)
  expect(updatePhases(changed, [], NOW + 180_000)).toEqual({})
  // At the first look, nobody knows since when; a later change has a time.
  const seenFirst = updatePhases({}, describeAll([row!], [], { sessionId: null, pid: null }, NOW), NOW, true)
  expect(seenFirst.s!.since).toBeNull()
  const seenLater = updatePhases(seenFirst, describeAll([busy], [], { sessionId: null, pid: null }, NOW + 60_000), NOW + 60_000)
  expect(seenLater.s!.since).toBe(NOW + 60_000)
  expect(headerText(1, 1)).toBe('Sessions · 1 open · 1 waits for you')
})

test('sessions: only decide and blocked verdicts are published, plain and short', () => {
  expect(sessionVerdict('{decide|Choisir A ou B}\n\nx')).toEqual({ kind: 'decide', words: 'Choisir A ou B' })
  expect(sessionVerdict('{blocked|Il manque la clé}')).toEqual({ kind: 'blocked', words: 'Il manque la clé' })
  expect(sessionVerdict('{done|Publié}')).toBeNull()
  expect(sessionVerdict('Pas de verdict')).toBeNull()
  expect(sessionVerdict('{decide|}')).toBeNull()
  expect(sessionVerdict(`{decide|${'a'.repeat(300)}}`)!.words).toHaveLength(120)
})
