// Local dev servers, read from `lsof` field output (-F): a `p` line per process, then its
// `c` command and one `n` line per listening address.

import type { DevServer, Project } from '../types'

const DEV_COMMAND = /^(node|bun|deno|python|ruby|php|next|vite|uvicorn|gunicorn|flask)/i
const FIRST_PORT = 3000
const LAST_PORT = 9999

export type Listener = { port: number; pid: number; name: string }

// `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` → one listener per dev port
export function parseListeners(output: string): Listener[] {
  const found = new Map<number, Listener>()
  let pid = 0
  let name = ''
  for (const line of output.split('\n')) {
    const field = line.charAt(0)
    const value = line.slice(1)
    if (field === 'p') pid = Number(value)
    if (field === 'c') name = value
    if (field !== 'n' || !DEV_COMMAND.test(name)) continue
    const port = Number(value.slice(value.lastIndexOf(':') + 1))
    if (Number.isInteger(port) && port >= FIRST_PORT && port <= LAST_PORT && !found.has(port)) {
      found.set(port, { port, pid, name })
    }
  }
  return [...found.values()].sort((a, b) => a.port - b.port)
}

// `lsof -a -d cwd -p <pids> -Fpn` → the folder each process runs in
export function parseFolders(output: string): Map<number, string> {
  const folders = new Map<number, string>()
  let pid = 0
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    if (line.startsWith('n') && pid !== 0) folders.set(pid, line.slice(1))
  }
  return folders
}

// A process running from `/` was started by macOS, not from a project: an app's helper
// such as Raycast's node backend. Those are left out.
export function withFolders(listeners: readonly Listener[], folders: ReadonlyMap<number, string>): DevServer[] {
  return listeners
    .map(listener => ({ ...listener, dir: folders.get(listener.pid) ?? '' }))
    .filter(server => server.dir !== '/')
}

// The dev script of a package.json, and the manager its lock file names.
export function readProject(packageJson: string, lockFiles: readonly string[]): Project {
  let scripts: unknown
  try {
    scripts = (JSON.parse(packageJson) as { scripts?: unknown }).scripts
  } catch {
    return null
  }
  if (typeof scripts !== 'object' || scripts === null) return null
  const script = ['dev', 'start'].find(name => typeof (scripts as Record<string, unknown>)[name] === 'string')
  if (script === undefined) return null
  const manager = lockFiles.includes('pnpm-lock.yaml')
    ? 'pnpm'
    : lockFiles.includes('bun.lockb') || lockFiles.includes('bun.lock')
      ? 'bun'
      : lockFiles.includes('yarn.lock')
        ? 'yarn'
        : 'npm'
  return { manager, script }
}

// What the button runs: `pnpm dev`, `npm run dev`…
export function startCommand(project: NonNullable<Project>): string {
  return project.manager === 'npm' && project.script !== 'start'
    ? `npm run ${project.script}`
    : `${project.manager} ${project.script}`
}
