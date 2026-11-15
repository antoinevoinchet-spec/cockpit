// The project's state outside the conversation: the checks Claude ran in the shell, the
// branch's pull request on GitHub, the folder's latest Vercel deployment.

import type { CheckKind, DeployStatus, PrStatus } from '../types'

// A word that runs a check wherever it stands early in a command: `jest`, `npx jest`,
// `uv run pytest`, `node_modules/.bin/tsc`. Two words where the tool does other things too.
const RUNNERS: ReadonlyMap<string, CheckKind> = new Map<string, CheckKind>([
  ['vitest', 'tests'],
  ['jest', 'tests'],
  ['pytest', 'tests'],
  ['mocha', 'tests'],
  ['cypress run', 'tests'],
  ['tsc', 'types'],
  ['mypy', 'types'],
  ['pyright', 'types'],
  ['eslint', 'lint'],
  ['ruff check', 'lint'],
  ['biome check', 'lint'],
  ['biome ci', 'lint'],
])
// A subcommand or a script: `cargo test`, `claude plugin test`, `pnpm build:css`, `make lint`.
const VERB = /^(test|build|lint|typecheck|type-check)(?::[\w:.-]+)?$/
const VERB_KINDS: Readonly<Record<string, CheckKind>> = {
  test: 'tests',
  build: 'build',
  lint: 'lint',
  typecheck: 'types',
  'type-check': 'types',
}
const verbKind = (word: string): CheckKind | undefined => {
  const verb = VERB.exec(word)?.[1]
  return verb !== undefined ? VERB_KINDS[verb] : undefined
}
// `tests` is a folder more often than a verb: it counts only as the script a tool runs.
const SCRIPT_TOOL = /^(pnpm|npm|yarn|bun|make|just)$/
// Commands that read, move or fetch files mention these words without running a check.
const NOT_A_RUNNER =
  /^(git|gh|grep|rg|cat|bat|echo|printf|ls|find|sed|awk|head|tail|less|more|nl|wc|file|stat|du|df|tree|diff|sort|uniq|cut|tr|tee|jq|open|cd|pushd|popd|pwd|mkdir|cp|mv|rm|rmdir|rimraf|trash|touch|ln|chmod|chown|rsync|scp|tar|zip|unzip|curl|wget|kill|pkill|pgrep|ps|lsof|which|whereis|type|command|man|export|source|read|sleep|date|prettier|vim|nano|code|pbcopy|basename|dirname|realpath)$/
// The shell's own `test -f x` and `[ -f x ]`.
const SHELL_TEST = /^(test|\[\[?)$/
// Words that ask a tool about itself instead of running it.
const ASKS_ONLY = /^(help|--help|-h|--version|-V|--collect-only|--co|--listTests|--showConfig|--dry-run|--init)$/
// Installing or listing a package names it: `pnpm add vitest`, `pip install pytest`.
const MANAGES_PACKAGES =
  /^(add|install|i|ci|remove|rm|uninstall|update|up|upgrade|why|info|view|list|ls|outdated|audit|init|create|get|pip|link|unlink|config|version|store|cache)$/
// A script takes its meaning from its own name, never from the words it is given.
const INTERPRETER = /^(node|python[\d.]*|bash|sh|zsh|ruby|perl|tsx|ts-node)$/
const SCRIPT_FILE = /\.(sh|py|js|mjs|cjs|ts|rb|pl)$/
// This mod's own bench, run in a real session.
const BENCH = /(^|\/)dev\/drive\.py$/

const lastPart = (word: string) => word.slice(word.lastIndexOf('/') + 1)

// The kinds of check one simple command runs, its quoted text already taken out.
function kindsOf(command: string): CheckKind[] {
  const words = command.split(/\s+/).filter(word => word !== '' && !/^\w+=/.test(word))
  const first = lastPart(words[0] ?? '')
  if (first === '' || NOT_A_RUNNER.test(first) || SHELL_TEST.test(first) || words.some(word => ASKS_ONLY.test(word))) return []
  if (words.some(word => BENCH.test(word))) return ['bench']
  const args = words.slice(1).filter(word => !word.startsWith('-'))
  if (MANAGES_PACKAGES.test(args[0] ?? '') || args.slice(0, 2).some(word => NOT_A_RUNNER.test(word))) return []

  const isInterpreted = INTERPRETER.test(first) && !words.includes('-m')
  if (first === 'node' && words.includes('--test')) return ['tests']
  if (isInterpreted || SCRIPT_FILE.test(first)) {
    const kind = verbKind(lastPart(isInterpreted ? (args[0] ?? '') : first).replace(/\.\w+$/, ''))
    return kind !== undefined ? [kind] : []
  }

  const kinds = new Set<CheckKind>()
  const names = [first, ...args.slice(0, 3)].map(lastPart)
  names.forEach((name, index) => {
    const kind = RUNNERS.get(name) ?? RUNNERS.get(`${name} ${names[index + 1] ?? ''}`)
    if (kind !== undefined) kinds.add(kind)
  })
  for (const word of args.slice(0, 3)) {
    const kind = verbKind(word)
    if (kind !== undefined) kinds.add(kind)
  }
  if (SCRIPT_TOOL.test(first) && (args[0] === 'run' ? args[1] : args[0]) === 'tests') kinds.add('tests')
  return [...kinds]
}

type Link = { text: string; after: string }

// A command's simple commands and what joins each to the next.
function linksOf(text: string): Link[] {
  const pieces = text.split(/(&&|\|\||\|&?|;|\n|&)/)
  const links: Link[] = []
  for (let index = 0; index < pieces.length; index += 2) {
    const piece = (pieces[index] ?? '').trim()
    if (piece === '') continue
    const previous = links.at(-1)
    const after = pieces[index + 1] ?? ''
    // `pnpm test || exit 1` fails when the test fails: it hides nothing.
    if (previous?.after === '||' && /^(exit\s+([1-9]\d*|\$\?)|false)$/.test(piece)) previous.after = after
    else links.push({ text: piece, after })
  }
  return links
}

// Whether exit 0 for the whole command says nothing of this link's own exit code.
function hidesExitCode(links: readonly Link[], index: number, text: string): boolean {
  if (links[index - 1]?.after === '||') return true
  const stopsOnError = /\bset\s+-[a-zA-Z]*e[a-zA-Z]*\b|\berrexit\b/.test(text)
  const keepsPipeFailure = /\bpipefail\b/.test(text)
  for (let at = index; at < links.length; at++) {
    const after = links[at]!.after
    if (after === '&') return true
    if (at === links.length - 1) return false
    if (after === '||') return true
    if ((after === ';' || after === '\n') && !stopsOnError) return true
    if (after.startsWith('|') && at === index && !keepsPipeFailure) return true
  }
  return false
}

export type CheckRun = { kind: CheckKind; isMasked: boolean }

// The checks a shell command runs: `pnpm lint && pnpm test` runs lint and tests. `isMasked`:
// the command's exit code is not the check's (`pnpm test | tail -5`, `pytest -q || true`).
// Read on the command's text only: a real runner under an unusual name goes unseen.
export function checkRuns(command: string): CheckRun[] {
  // What cannot run: a heredoc's body, quoted text, comments; then redirections and subshells.
  const text = command
    .replace(/\\\n/g, ' ')
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2(?=\s|$)/g, ' ')
    .replace(/'[^']*'|"[^"]*"/g, ' ')
    .replace(/(^|\s)#[^\n]*/g, '$1')
    .replace(/\d*&?>>?\s*&?[^\s;|&]*/g, ' ')
    .replace(/[()]/g, ' ')
  const links = linksOf(text)
  const runs = new Map<CheckKind, boolean>()
  links.forEach((link, index) => {
    for (const kind of kindsOf(link.text)) runs.set(kind, hidesExitCode(links, index, text))
  })
  return [...runs].map(([kind, isMasked]) => ({ kind, isMasked }))
}

export function checkKinds(command: string): CheckKind[] {
  return checkRuns(command).map(run => run.kind)
}

// A look at the page through Playwright; opening a page or clicking in it proves less.
export function isBrowserCheck(tool: string): boolean {
  return /^mcp__\w*playwright\w*__browser_(snapshot|take_screenshot|evaluate|run_code\w*)$/.test(tool)
}

// Files that are not code: edits to them need no test (notes, Claude's memory, scratch work).
// A working copy kept in a scratch folder is code: that is where a workflow's agents write.
const NOT_CODE = /\.(md|txt)$|\/\.claude\/projects\/[^/]+\/memory\/|iCloud~md~obsidian|(^|\/)(scratchpad|tmp)\/(?!(.*\/)?wt\/)/i

export function isCodePath(path: string): boolean {
  return path !== '' && !NOT_CODE.test(path)
}

type RollupItem = { __typename?: string; status?: string; conclusion?: string; state?: string }

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'])

// GitHub's check rollup in one word: a check run carries status and conclusion, a commit
// status (Vercel's, for one) a state.
function foldChecks(items: readonly RollupItem[]): PrStatus['checks'] {
  if (items.length === 0) return 'none'
  const states = items.map(item =>
    item.__typename === 'StatusContext' ? (item.state ?? '') : item.status !== 'COMPLETED' ? 'PENDING' : (item.conclusion ?? ''),
  )
  if (states.some(state => FAILED.has(state))) return 'failing'
  if (states.some(state => PENDING.has(state))) return 'pending'
  return 'passing'
}

// `gh pr view --json number,state,isDraft,url,statusCheckRollup`; null when it is not that.
export function parsePr(stdout: string): PrStatus | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const fields = raw as Record<string, unknown>
  const state = fields.state
  if (typeof fields.number !== 'number' || (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED')) return null
  const rollup = Array.isArray(fields.statusCheckRollup) ? (fields.statusCheckRollup as RollupItem[]) : []
  return {
    number: fields.number,
    state,
    isDraft: fields.isDraft === true,
    checks: foldChecks(rollup),
    url: typeof fields.url === 'string' ? fields.url : '',
  }
}

const DEPLOY_STATES = new Set<DeployStatus['state']>(['READY', 'BUILDING', 'QUEUED', 'INITIALIZING', 'ERROR', 'CANCELED'])

// `vercel list --format json`: the newest deployment, first in the list.
export function parseDeploy(stdout: string): DeployStatus | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  const list = (raw as { deployments?: unknown } | null)?.deployments
  if (!Array.isArray(list) || list.length === 0) return null
  const newest = list[0] as Record<string, unknown>
  const state = newest.state ?? newest.readyState
  if (typeof state !== 'string' || !DEPLOY_STATES.has(state as DeployStatus['state'])) return null
  const at = typeof newest.createdAt === 'number' ? newest.createdAt : typeof newest.created === 'number' ? newest.created : 0
  return {
    state: state as DeployStatus['state'],
    target: newest.target === 'production' ? 'production' : 'preview',
    at,
    url: typeof newest.url === 'string' ? `https://${newest.url}` : '',
  }
}

// Whether a shell command may have changed the PR or started a deployment.
export function touchesRemote(command: string): boolean {
  return /\bgit\b[^;&|]*\bpush\b|\bgh\s+pr\b|\bvercel\b/.test(command)
}
