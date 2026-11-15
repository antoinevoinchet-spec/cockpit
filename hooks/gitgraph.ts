// The Git tab: what the repository says, read without writing anything, laid out for the pane.
// Everything here works on text and plain data, so it is tested without a process: the pane
// hands `readGitTab` a way to run git, and draws the lines `gitLayout` returns.

import type { GitBranch, GitCommit, GitFacts, GitGraphRow, GitTabView, GitWorktree } from '../types'

// Never takes an optional lock, so a status neither rewrites the index nor gets in the way of
// an agent committing. A person's color or signature settings would change what is parsed.
export const GIT_READ_OPTIONS = [
  '--no-optional-locks',
  '-c',
  'color.ui=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'core.fsmonitor=false',
] as const
export const GIT_READ_TIMEOUT_MS = 30_000
export const MAX_GRAPH_COMMITS = 40
const MAX_REFS = 200
// Branches compared with the main one, a few at a time: each takes a process.
const MAX_COMPARED = 40
const COMPARED_AT_ONCE = 8
const MAX_LISTED = 40
const MAX_READ_CHARS = 512_000
const MAX_SUBJECT_CHARS = 300

export type GitAnswer = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean }
export type GitCommand = (args: readonly string[]) => Promise<GitAnswer>

const FIELD = '\x1f'
const VALUE = '\x1e'
const TRAILERS = (key: string) => `%(trailers:key=${key},valueonly,separator=%x1e,unfold)`
const LOG_FORMAT = ['', '%h', '%ct', '%D', TRAILERS('Co-Authored-By'), TRAILERS('Claude-Session'), '%s'].join('%x1f')
const REF_FORMAT = [
  '%(refname:lstrip=2)',
  '%(objectname:short)',
  '%(committerdate:unix)',
  TRAILERS('Co-Authored-By'),
  TRAILERS('Claude-Session'),
  '%(subject)',
].join('%1f')

// Control characters out: a commit message must not move the cursor in the pane.
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()

const lines = (text: string) => text.slice(0, MAX_READ_CHARS).split('\n').filter(line => line.trim() !== '')

// "Claude Opus 5.5 <noreply@anthropic.com>" → "Opus 5.5"; another co-author is no model.
export function readModel(coAuthors: string): string | null {
  const match = /\bClaude\s+(Opus|Sonnet|Haiku|Fable)(?:\s+(\d+(?:\.\d+)?))?/i.exec(coAuthors)
  if (match === null) return null
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase()
  return match[2] !== undefined ? `${family} ${match[2]}` : family
}

// A session link ending in `session_<id>` → "<id>"
export function readSession(value: string): string | null {
  const first = value.split(VALUE)[0]?.trim() ?? ''
  const match = /session_([A-Za-z0-9]+)/.exec(first) ?? /^([A-Za-z0-9-]{5,})$/.exec(first) ?? /\/([A-Za-z0-9-]{5,})$/.exec(first)
  return match?.[1] ?? null
}

export function parseGraph(stdout: string, current: string | null, headHash: string | null): GitGraphRow[] {
  return lines(stdout).map(line => {
    const [drawing = '', hash, seconds, decoration, coAuthors, session, ...subject] = line.split(FIELD)
    if (hash === undefined) return { drawing: line.trimEnd(), commit: null }
    const labels = (decoration ?? '')
      .split(',')
      .map(label => clean(label))
      .filter(label => label !== '')
      // The active branch first: it is the one the row is read under.
      .sort((a, b) => Number(b === current) - Number(a === current))
    const commit: GitCommit = {
      hash: clean(hash),
      at: Number(seconds) * 1000,
      labels,
      subject: clean(subject.join(' ')).slice(0, MAX_SUBJECT_CHARS),
      model: readModel(coAuthors ?? ''),
      session: readSession(session ?? ''),
      isHead: headHash !== null && (hash.startsWith(headHash) || headHash.startsWith(hash)),
    }
    return { drawing, commit }
  })
}

type Ref = Omit<GitBranch, 'ahead' | 'behind' | 'isCurrent'>

function parseRefs(stdout: string): Ref[] {
  return lines(stdout).map(line => {
    const [name = '', , seconds, coAuthors, session, ...subject] = line.split(FIELD)
    return {
      name: clean(name),
      at: Number(seconds) * 1000,
      subject: clean(subject.join(' ')).slice(0, MAX_SUBJECT_CHARS),
      model: readModel(coAuthors ?? ''),
      session: readSession(session ?? ''),
    }
  })
}

// `git rev-list --left-right --count main...branch`: commits only main has, then only the branch.
export function parseAheadBehind(stdout: string): { ahead: number; behind: number } | null {
  const match = /^(\d+)\s+(\d+)\s*$/.exec(stdout.trim())
  return match === null ? null : { behind: Number(match[1]), ahead: Number(match[2]) }
}

// Every working copy but the one this session sits in.
export function parseWorktrees(stdout: string, here: string): GitWorktree[] {
  return stdout
    .slice(0, MAX_READ_CHARS)
    .split('\n\n')
    .flatMap(block => {
      const path = /^worktree (.+)$/m.exec(block)?.[1]
      if (path === undefined || path === here) return []
      return [{ path: clean(path), branch: clean(/^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? '') }]
    })
}

const repoName = (commonDir: string, top: string): string => {
  const parts = commonDir.split('/').filter(part => part !== '')
  const last = parts.at(-1)
  if (last === '.git') return parts.at(-2) ?? last
  return last ?? top.split('/').filter(part => part !== '').at(-1) ?? 'repository'
}

// One read of the repository. Commands that write have no place here: no fetch, no gc, no
// checkout. A command that cannot start or takes too long rejects, for the caller to say so.
export async function readGitTab(git: GitCommand): Promise<GitTabView> {
  const where = await git(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'])
  if (where.exitCode !== 0) {
    return /not a git repository/i.test(where.stderr)
      ? { status: 'outside' }
      : { status: 'failed', message: clean(where.stderr.split('\n')[0] ?? '') || `git stopped (${where.exitCode})` }
  }
  const [commonDir = '', top = ''] = where.stdout.split('\n').map(line => line.trim())

  const [branchAnswer, headAnswer, statusAnswer, refAnswer, originAnswer, worktreeAnswer] = await Promise.all([
    git(['symbolic-ref', '--short', '-q', 'HEAD']),
    git(['rev-parse', '-q', '--verify', '--short', 'HEAD']),
    git(['status', '--porcelain']),
    git(['for-each-ref', 'refs/heads', '--sort=-committerdate', `--count=${MAX_REFS}`, `--format=${REF_FORMAT}`]),
    git(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']),
    git(['worktree', 'list', '--porcelain']),
  ])
  if (statusAnswer.exitCode !== 0) {
    return { status: 'failed', message: clean(statusAnswer.stderr.split('\n')[0] ?? '') || `git stopped (${statusAnswer.exitCode})` }
  }
  const branch = branchAnswer.exitCode === 0 ? clean(branchAnswer.stdout) : null
  const headHash = headAnswer.exitCode === 0 ? clean(headAnswer.stdout) : null
  const refs = parseRefs(refAnswer.stdout)
  const names = new Set(refs.map(ref => ref.name))
  const fromOrigin = originAnswer.exitCode === 0 ? clean(originAnswer.stdout).replace(/^[^/]+\//, '') : ''
  const base = [fromOrigin, 'main', 'master'].find(name => name !== '' && names.has(name)) ?? null
  const statusLines = lines(statusAnswer.stdout)
  const facts: GitFacts = {
    repo: clean(repoName(commonDir, top)),
    branch,
    headHash,
    base,
    uncommitted: statusLines.length,
    isUncommittedCut: statusAnswer.isStdoutTruncated === true || statusAnswer.stdout.length > MAX_READ_CHARS,
    toMerge: 0,
    open: [],
    merged: [],
    isRefListCut: refs.length >= MAX_REFS,
    worktrees: worktreeAnswer.exitCode === 0 ? parseWorktrees(worktreeAnswer.stdout, top) : [],
    graph: [],
    totalCommits: 0,
    isStraight: true,
  }
  if (headHash === null) return { status: 'ready', facts }

  const [graphAnswer, countAnswer, unmergedAnswer] = await Promise.all([
    git([
      'log',
      '--graph',
      `-n${MAX_GRAPH_COMMITS}`,
      '--decorate-refs=refs/heads',
      `--format=${LOG_FORMAT}`,
      '--branches',
      'HEAD',
    ]),
    git(['rev-list', '--count', '--branches', 'HEAD']),
    base !== null
      ? git(['for-each-ref', 'refs/heads', `--no-merged=refs/heads/${base}`, '--format=%(refname:lstrip=2)'])
      : Promise.resolve(null),
  ])
  if (graphAnswer.exitCode !== 0) {
    return { status: 'failed', message: clean(graphAnswer.stderr.split('\n')[0] ?? '') || `git stopped (${graphAnswer.exitCode})` }
  }
  const graph = parseGraph(graphAnswer.stdout, branch, headHash)
  facts.graph = graph
  facts.totalCommits = countAnswer.exitCode === 0 ? Number(countAnswer.stdout.trim()) || 0 : graph.filter(row => row.commit !== null).length
  facts.isStraight = graph.every(row => row.commit !== null && row.drawing.trim() === '*')

  if (base === null || unmergedAnswer === null || unmergedAnswer.exitCode !== 0) return { status: 'ready', facts }
  const unmerged = new Set(lines(unmergedAnswer.stdout).map(clean))
  facts.toMerge = unmerged.size
  facts.merged = refs
    .filter(ref => !unmerged.has(ref.name) && ref.name !== base)
    .map(ref => ({ ...ref, ahead: 0, behind: 0, isCurrent: ref.name === branch }))

  // The newest branches compared; a slow or odd one reads "?" and costs nothing else.
  const toCompare = refs.filter(ref => unmerged.has(ref.name)).slice(0, MAX_COMPARED)
  for (let index = 0; index < toCompare.length; index += COMPARED_AT_ONCE) {
    const batch = toCompare.slice(index, index + COMPARED_AT_ONCE)
    const counted = await Promise.all(
      batch.map(ref =>
        git(['rev-list', '--left-right', '--count', `refs/heads/${base}...refs/heads/${ref.name}`]).catch(() => null),
      ),
    )
    batch.forEach((ref, at) => {
      const answer = counted[at]
      const figures = answer !== null && answer !== undefined && answer.exitCode === 0 ? parseAheadBehind(answer.stdout) : null
      facts.open.push({ ...ref, ahead: figures?.ahead ?? null, behind: figures?.behind ?? null, isCurrent: ref.name === branch })
    })
  }
  return { status: 'ready', facts }
}

// ── Width ────────────────────────────────────────────────────────────────────

const isWide = (code: number) =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe6f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1faff) ||
  (code >= 0x20000 && code <= 0x3fffd)
const isZeroWidth = (code: number) =>
  (code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200d) || (code >= 0xfe00 && code <= 0xfe0f)

const glyphWidth = (glyph: string) => {
  const code = glyph.codePointAt(0) ?? 0
  return isZeroWidth(code) ? 0 : isWide(code) ? 2 : 1
}

// The columns a text takes on a terminal.
export function cells(text: string): number {
  let total = 0
  for (const glyph of text) total += glyphWidth(glyph)
  return total
}

// The text cut to at most `max` columns, ending in "…" when something was left out.
export function fit(text: string, max: number): string {
  if (max <= 0) return ''
  if (cells(text) <= max) return text
  let kept = ''
  let used = 0
  for (const glyph of text) {
    const width = glyphWidth(glyph)
    if (used + width > max - 1) break
    kept += glyph
    used += width
  }
  return kept.trimEnd() + '…'
}

const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - cells(text)))

// ── Dates ────────────────────────────────────────────────────────────────────

const two = (value: number) => String(value).padStart(2, '0')

// 25/10 in local time; another year's commit says which: 25/10/25.
export function dayMonth(at: number, now: number): string {
  const date = new Date(at)
  const short = `${two(date.getDate())}/${two(date.getMonth() + 1)}`
  return date.getFullYear() === new Date(now).getFullYear() ? short : `${short}/${two(date.getFullYear() % 100)}`
}

// A branch's age in its largest unit: 45m, 2h, 1d.
export function shortAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

// ── Lines ────────────────────────────────────────────────────────────────────

export type GitTone = 'plain' | 'strong' | 'label' | 'good' | 'warn' | 'dim'
export type GitSpan = { text: string; tone: GitTone }
// A row of the tab. `right` stands at the pane's edge; `action` makes the row a button.
export type GitLine = { key: string; spans: GitSpan[]; right?: GitSpan[]; action?: 'graph' | 'unfold' }
export type GitLayoutOptions = { width: number; rows: number; now: number; isGraphOpen: boolean; isUnfolded: boolean }

const span = (text: string, tone: GitTone = 'plain'): GitSpan => ({ text, tone })
export const lineText = (line: GitLine) => line.spans.map(part => part.text).join('')

const count = (value: number, isCut: boolean) => `${value}${isCut ? '+' : ''}`
const mergedWord = (value: number, isCut = false) => `${count(value, isCut)} merged branch${value === 1 ? '' : 'es'}`

// The graph shows by itself once there are branches to read it for.
export const isGraphShown = (choice: boolean | null, facts: GitFacts) => choice ?? facts.toMerge > 0

// The room for the repository and the branch is what the status leaves: it is the status that
// informs, so a long name is what gets cut. `width` leaves the ↻ out.
function headerLine(facts: GitFacts, width: number): GitLine {
  const mergeWord =
    facts.headHash === null
      ? 'no commits yet'
      : facts.base === null
        ? 'no main branch'
        : facts.toMerge > 0
          ? `${facts.toMerge} to merge`
          : 'nothing to merge'
  const dirtyWord = facts.uncommitted > 0 ? `${count(facts.uncommitted, facts.isUncommittedCut)} uncommitted` : 'clean'
  const place = facts.branch !== null ? 'on ' : 'detached '
  const where = facts.branch ?? facts.headHash ?? '?'
  const fixed = cells(` · ${place} · ${mergeWord} · ${dirtyWord}`)
  const room = Math.max(4, width - fixed)
  const repoRoom = Math.max(Math.min(cells(facts.repo), Math.floor(room / 2)), room - cells(where))
  const repo = fit(facts.repo, repoRoom)
  const shownWhere = fit(where, Math.max(1, room - cells(repo)))
  return {
    key: 'git-header',
    spans: [
      span(repo, 'strong'),
      span(` · ${place}`, 'dim'),
      span(shownWhere),
      span(' · ', 'dim'),
      span(mergeWord, facts.toMerge > 0 ? 'warn' : facts.headHash !== null && facts.base !== null ? 'good' : 'dim'),
      span(' · ', 'dim'),
      span(dirtyWord, facts.uncommitted > 0 ? 'warn' : 'good'),
    ],
  }
}

const signatureText = (model: string | null, session: string | null) =>
  [model, session !== null ? `session ${session.slice(0, 5)}…` : null].filter(part => part !== null).join(' · ')

function signatureLine(key: string, lead: string, text: string, width: number): GitLine {
  return { key, spans: [span(fit(`${lead}${text}`, width), 'dim')] }
}

function commitLine(commit: GitCommit, width: number, now: number): GitLine {
  const date = dayMonth(commit.at, now)
  const room = width - cells(date) - 1 - 2
  const names = commit.labels.join(', ')
  const shownNames = names !== '' ? fit(names, Math.min(room, Math.max(8, Math.floor(room * 0.6)))) : ''
  const lead = shownNames !== '' ? cells(shownNames) + 2 : 0
  return {
    key: `git-commit-${commit.hash}`,
    spans: [
      span('● ', names !== '' ? 'label' : 'dim'),
      ...(shownNames !== '' ? [span(shownNames, commit.isHead ? 'strong' : 'label')] : []),
      ...(shownNames !== '' && room > lead ? [span('  ')] : []),
      span(fit(commit.subject, room - lead), commit.isHead ? 'plain' : 'dim'),
    ],
    right: [span(date, 'dim')],
  }
}

function graphLine(row: GitGraphRow, index: number, width: number): GitLine {
  const key = `git-graph-${index}`
  const commit = row.commit
  const hashText = commit !== null ? `${commit.hash} ` : ''
  const room = width - cells(row.drawing) - cells(hashText)
  // A drawing as wide as the pane keeps its own cut, its commit left out.
  if (commit === null || room <= 0) return { key, spans: [span(fit(row.drawing, width), 'dim')] }
  const names = commit.labels.join(', ')
  const shownNames = names !== '' ? fit(names, Math.min(room, Math.max(8, Math.floor(room * 0.5)))) : ''
  const lead = shownNames !== '' ? cells(shownNames) + 2 : 0
  return {
    key,
    spans: [
      span(row.drawing, 'label'),
      span(hashText, 'dim'),
      ...(shownNames !== '' ? [span(shownNames, commit.isHead ? 'strong' : 'label')] : []),
      ...(shownNames !== '' && room > lead ? [span('  ')] : []),
      span(fit(commit.subject, room - lead)),
    ],
  }
}

function branchLines(facts: GitFacts, width: number, now: number): { branch: GitLine; signature: GitLine | null }[] {
  const figures = (branch: GitBranch) => `+${branch.ahead ?? '?'} -${branch.behind ?? '?'}`
  const nameWidth = Math.min(Math.floor(width * 0.35), Math.max(0, ...facts.open.map(branch => cells(branch.name))))
  const figureWidth = Math.max(0, ...facts.open.map(branch => figures(branch).length))
  return facts.open.map(branch => {
    const family = branch.model?.split(' ')[0]
    const age = shortAge(now - branch.at)
    const rightText = family !== undefined ? `${family} ${age}` : age
    const lead = nameWidth + 2 + figureWidth + 2
    const room = width - lead - cells(rightText) - 1
    const signature = signatureText(branch.model, branch.session)
    return {
      branch: {
        key: `git-branch-${branch.name}`,
        spans: [
          span(pad(fit(branch.name, nameWidth), nameWidth + 2), branch.isCurrent ? 'strong' : 'label'),
          span(`+${branch.ahead ?? '?'}`, 'good'),
          span(' '),
          span(`-${branch.behind ?? '?'}`, branch.behind === 0 ? 'dim' : 'warn'),
          span(' '.repeat(Math.max(0, figureWidth - figures(branch).length) + 2)),
          span(fit(branch.subject, room)),
        ],
        right: [span(rightText, 'dim')],
      },
      signature: branch.isCurrent && signature !== '' ? signatureLine(`git-sign-${branch.name}`, '  ', signature, width) : null,
    }
  })
}

function listedLines(facts: GitFacts, width: number, now: number): GitLine[] {
  const merged = facts.merged.slice(0, MAX_LISTED).map(branch => {
    const date = dayMonth(branch.at, now)
    const room = width - cells(date) - 1 - 2
    const name = fit(branch.name, Math.floor(room * 0.5))
    return {
      key: `git-merged-${branch.name}`,
      spans: [span('✓ ', 'good'), span(name, 'label'), span(`  ${fit(branch.subject, room - cells(name) - 2)}`, 'dim')],
      right: [span(date, 'dim')],
    }
  })
  const worktrees = facts.worktrees.slice(0, MAX_LISTED).map(worktree => ({
    key: `git-worktree-${worktree.path}`,
    spans: [span(fit(`⌂ ${worktree.branch !== '' ? `${worktree.branch}  ` : ''}${worktree.path.split('/').slice(-2).join('/')}`, width), 'dim')],
  }))
  const moreMerged = facts.merged.length - merged.length
  const moreWorktrees = facts.worktrees.length - worktrees.length
  return [
    ...(merged.length > 0 ? [{ key: 'git-merged-title', spans: [span(fit(mergedWord(facts.merged.length, facts.isRefListCut), width), 'dim')] }] : []),
    ...merged,
    ...(moreMerged > 0 || facts.isRefListCut
      ? [{ key: 'git-merged-more', spans: [span(fit(`${moreMerged > 0 ? `${moreMerged} more` : 'more'} not listed`, width), 'dim')] }]
      : []),
    ...(worktrees.length > 0 ? [{ key: 'git-worktrees-title', spans: [span(fit(`${worktrees.length + moreWorktrees} other worktree${worktrees.length + moreWorktrees === 1 ? '' : 's'}`, width), 'dim')] }] : []),
    ...worktrees,
    ...(moreWorktrees > 0 ? [{ key: 'git-worktrees-more', spans: [span(`${moreWorktrees} more not listed`, 'dim')] }] : []),
  ]
}

// What the tab draws, at most `rows` rows unless unfolded. Whatever does not fit is named on the
// last row, which unfolds it: nothing leaves in silence.
export function gitLayout(facts: GitFacts, options: GitLayoutOptions): GitLine[] {
  const { width, rows, now, isGraphOpen, isUnfolded } = options
  const header = headerLine(facts, width - 2)
  if (facts.headHash === null) return [header]

  const commitRows = facts.graph.flatMap(row => (row.commit !== null ? [row.commit] : []))
  const hasOpen = facts.open.length > 0 || facts.toMerge > 0
  const showsGraph = !facts.isStraight && isGraphOpen
  const showsJournal = facts.isStraight || (!hasOpen && !isGraphOpen)
  const head = commitRows.find(commit => commit.isHead) ?? null
  const signature = head !== null ? signatureText(head.model, head.session) : ''
  const currentBranch = facts.open.find(branch => branch.isCurrent)

  type Item = { line: GitLine; isCommit?: boolean; isBranch?: boolean }
  const body: Item[] = []

  // The signature sits under the active branch: its own row, or the row its commit has in the
  // journal; a main branch with no row of its own takes the line under the header.
  const isHeadInJournal = showsJournal && head !== null
  if (signature !== '' && currentBranch === undefined && !isHeadInJournal) {
    body.push({ line: signatureLine('git-sign', facts.branch !== null ? `${facts.branch}  ` : '', signature, width) })
  }
  for (const { branch, signature: under } of branchLines(facts, width, now)) {
    body.push({ line: branch, isBranch: true })
    if (under !== null) body.push({ line: under })
  }

  const graphLineCount = facts.graph.length
  const toggle: GitLine = {
    key: 'git-graph-toggle',
    spans: [span(isGraphOpen ? '▾ graph' : `▸ graph · ${graphLineCount} lines`, 'dim')],
    action: 'graph',
  }
  const hasToggle = !facts.isStraight
  const isToggleLast = hasToggle && !isGraphOpen && !hasOpen
  if (hasToggle && !isToggleLast) body.push({ line: toggle })
  if (showsGraph) {
    facts.graph.forEach((row, index) => {
      body.push({ line: graphLine(row, index, width), isCommit: row.commit !== null })
    })
  }
  if (showsJournal) {
    for (const commit of commitRows) {
      body.push({ line: commitLine(commit, width, now), isCommit: true })
      if (commit.isHead && signature !== '' && currentBranch === undefined) {
        body.push({ line: signatureLine('git-sign', '│       ', signature, width) })
      }
    }
  }

  const readCommits = commitRows.length
  if (isUnfolded) {
    const limit =
      facts.totalCommits > readCommits ? ` · newest ${readCommits} of ${facts.totalCommits} commits` : ''
    const extraBranches = facts.toMerge - facts.open.length
    const more = extraBranches > 0 ? ` · ${extraBranches} branches not compared` : ''
    return [
      header,
      ...body.map(item => item.line),
      ...(isToggleLast ? [toggle] : []),
      ...listedLines(facts, width, now),
      { key: 'git-fold', spans: [span(fit(`▾ fold${limit}${more}`, width), 'dim')], action: 'unfold' },
    ]
  }

  // Row by row until the room ends, the last row kept to say what is left.
  const pinned = isToggleLast ? [toggle] : []
  const room = Math.max(0, rows - 1 - pinned.length)
  const countsCommits = showsGraph || showsJournal
  const hasMoreThanDrawn =
    facts.merged.length > 0 ||
    facts.worktrees.length > 0 ||
    facts.toMerge > facts.open.length ||
    (countsCommits && facts.totalCommits > body.filter(item => item.isCommit).length)
  const fits = body.length + (hasMoreThanDrawn ? 1 : 0) <= room
  const kept = fits ? body : body.slice(0, Math.max(0, room - 1))
  // An open graph with no room for a stroke of it is not worth its row: the last row names it.
  if (kept.at(-1)?.line.key === toggle.key && isGraphOpen) kept.pop()

  const parts: string[] = []
  const hiddenBranches = facts.toMerge - kept.filter(item => item.isBranch).length
  if (hiddenBranches > 0) parts.push(`${hiddenBranches} more branch${hiddenBranches === 1 ? '' : 'es'}`)
  if (hasToggle && !isToggleLast && !kept.some(item => item.line.key === toggle.key)) parts.push('graph')
  if (countsCommits) {
    const shownCommits = kept.filter(item => item.isCommit).length
    const hidden = facts.totalCommits - shownCommits
    if (hidden > 0) parts.push(`${hidden} ${shownCommits > 0 ? 'older ' : ''}commit${hidden === 1 ? '' : 's'}`)
  }
  if (facts.merged.length > 0) parts.push(mergedWord(facts.merged.length, facts.isRefListCut))
  if (facts.worktrees.length > 0) parts.push(`${facts.worktrees.length} worktree${facts.worktrees.length === 1 ? '' : 's'}`)
  // Only the graph's last strokes were left out.
  if (parts.length === 0 && kept.length < body.length) parts.push(`${body.length - kept.length} more lines`)

  return [
    header,
    ...kept.map(item => item.line),
    ...pinned,
    ...(parts.length > 0
      ? [{ key: 'git-cut', spans: [span(fit(`▸ ${parts.join(' · ')}`, width), 'dim')], action: 'unfold' as const }]
      : []),
  ]
}

// ── The tab row ──────────────────────────────────────────────────────────────

// `widest`: the badge at its widest, when it changes from frame to frame.
export type TabLabel = { id: string; label: string; badge: string; widest?: string }

// A button draws "[ label ]", with one column between buttons: a row wider than the pane folds
// onto a second line. The widest badge leaves first, the leftmost of equals. A badge is measured
// at its widest, so a flash that comes and goes does not make the row jump.
export function fitTabLabels(tabs: readonly TabLabel[], width: number): string[] {
  const kept = new Set(tabs.filter(tab => tab.badge !== '').map(tab => tab.id))
  const badgeCost = (tab: TabLabel) => (kept.has(tab.id) ? cells(tab.widest ?? tab.badge) + 1 : 0)
  const rowWidth = () =>
    tabs.reduce((sum, tab) => sum + cells(tab.label) + 4 + badgeCost(tab), 0) + Math.max(0, tabs.length - 1)
  while (rowWidth() > width && kept.size > 0) {
    const widest = tabs.reduce((most, tab) => (badgeCost(tab) > badgeCost(most) ? tab : most))
    kept.delete(widest.id)
  }
  return tabs.map(tab => (kept.has(tab.id) ? `${tab.label} ${tab.badge}` : tab.label))
}

// ── How much of the pane is taken ────────────────────────────────────────────

type PlainNode = { type?: unknown; props?: Record<string, unknown>; children?: unknown }

const flatten = (node: unknown): unknown[] =>
  Array.isArray(node) ? node.flatMap(flatten) : node === null || node === undefined || typeof node === 'boolean' ? [] : [node]

const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const element = node as PlainNode
  return flatten(element.children).map(textOf).join('')
}

// "[ label ]", or the bare label of a plain button.
const buttonWidth = (button: PlainNode) => {
  const label = typeof button.props?.label === 'string' ? button.props.label : textOf(button)
  return cells(label) + (button.props?.plain === true ? 0 : 4)
}

// The rows a wrapped text takes, word by word as the terminal folds it.
function wrappedRows(text: string, width: number): number {
  let total = 0
  for (const paragraph of text.split('\n')) {
    let used = 0
    let rows = 1
    for (const word of paragraph.split(' ')) {
      const size = cells(word)
      if (used > 0 && used + 1 + size > width) {
        rows += 1
        used = 0
      }
      if (size > width) {
        rows += Math.floor((size - 1) / width)
        used = size % width
      } else {
        used += (used > 0 ? 1 : 0) + size
      }
    }
    total += rows
  }
  return total
}

// How many rows a drawn tree takes in `width` columns, from what it says of itself. It is the
// only way to know how far down the pane the tabs start: the rows above them come and go.
export function treeRows(node: unknown, width: number): number {
  if (typeof node === 'string' || typeof node === 'number') return wrappedRows(String(node), width)
  const element = node as PlainNode
  const props = element.props ?? {}
  if (element.type === 'Box') {
    if (props.display === 'none') return 0
    if (typeof props.height === 'number') return props.height
    const children = flatten(element.children)
    if (props.flexDirection === 'column') return children.reduce((sum: number, child) => sum + treeRows(child, width), 0)
    if (props.flexWrap === 'wrap') {
      let rows = 1
      let used = 0
      for (const child of children) {
        const size = (child as PlainNode).type === 'Button' ? buttonWidth(child as PlainNode) : cells(textOf(child))
        if (used > 0 && used + 1 + size > width) {
          rows += 1
          used = 0
        }
        used += (used > 0 ? 1 : 0) + size
      }
      return rows
    }
    // A row of buttons wider than the pane folds a button onto a second row.
    const isButtons = children.length > 0 && children.every(child => (child as PlainNode).type === 'Button')
    if (isButtons) {
      const gap = typeof props.gap === 'number' ? props.gap : 0
      const total = children.reduce((sum: number, child) => sum + buttonWidth(child as PlainNode) + gap, -gap)
      return Math.max(1, Math.ceil(total / width))
    }
    return children.reduce((most: number, child) => Math.max(most, treeRows(child, width)), 1)
  }
  if (element.type === 'Text') {
    return typeof props.wrap === 'string' && props.wrap.startsWith('truncate') ? 1 : wrappedRows(textOf(element), width)
  }
  if (typeof props.rows === 'number') return props.rows
  if (typeof props.height === 'number') return props.height
  if (element.type === 'Markdown' && typeof props.text === 'string') return wrappedRows(props.text, width)
  return 1
}
