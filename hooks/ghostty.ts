// A new tab in the Ghostty window this session runs in, right of this one as cmd+t opens
// it, with a command typed into it: for Fork and for starting the dev server. Several
// copies of Ghostty can run at once (`open -na` starts one), and `tell application
// "Ghostty"` reaches whichever answers first, so the tab is sent to the copy found above
// this session in the process tree, by its pid.

const GHOSTTY_BINARY = /\/Ghostty\.app\/Contents\/MacOS\/ghostty$/
const MAX_DEPTH = 64

// `sh -c 'echo $$; ps -axo pid=,ppid=,comm='` → the pid of the Ghostty this shell runs
// under; null when there is none above it (another terminal, tmux).
export function ghosttyHost(output: string): number | null {
  const [first = '', ...rows] = output.split('\n')
  const parents = new Map<number, { ppid: number; command: string }>()
  for (const row of rows) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row)
    if (match !== null) parents.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] ?? '' })
  }
  let pid = Number(first.trim())
  for (let depth = 0; depth < MAX_DEPTH && pid > 1; depth++) {
    const entry = parents.get(pid)
    if (entry === undefined) return null
    if (GHOSTTY_BINARY.test(entry.command)) return pid
    pid = entry.ppid
  }
  return null
}

// JXA, run with: pid (empty: any Ghostty), folder, command. The new-tab event of Ghostty's
// dictionary (`Ghst`/`NTab`) with a configuration: the tab's folder (`GScD`) and its first
// input (`GScI`), ending in a return so the shell runs it. Sent without waiting for a
// reply: Ghostty opens the tab, then fails to return it (-1708).
export const NEW_TAB_SCRIPT = [
  "ObjC.import('Foundation')",
  'const code = s => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0',
  'function run(argv) {',
  '  const [pid, dir, command] = argv',
  '  const target = pid === ""',
  '    ? $.NSAppleEventDescriptor.descriptorWithBundleIdentifier("com.mitchellh.ghostty")',
  '    : $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(Number(pid))',
  "  const event = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(code('Ghst'), code('NTab'), target, -1, 0)",
  '  const config = $.NSAppleEventDescriptor.recordDescriptor',
  "  config.setDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithString(dir), code('GScD'))",
  "  config.setDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithString(command + '\\r'), code('GScI'))",
  "  event.setParamDescriptorForKeyword(config, code('GNtS'))",
  // Asking for the NSError (a Ref) crashes osascript when the pid is gone: nil says enough.
  "  if (event.sendEventWithOptionsTimeoutError(1, 10, null).isNil()) throw new Error('not sent')",
  '}',
].join('\n')

// The Ghostty a given process runs under, from the same `ps` listing: the listing's first
// line (this shell's own pid) is swapped for the process asked about.
export function ghosttyHostOf(output: string, pid: number): number | null {
  return ghosttyHost([String(pid), ...output.split('\n').slice(1)].join('\n'))
}

// JXA, run with: the pid of a Ghostty, a tty device (/dev/ttys004). Ghostty's dictionary lists
// each tab's terminals with their tty. Its `focus` is only said to bring the window to the front:
// `select tab` shows the right tab first.
export const FOCUS_SCRIPT = [
  'function run(argv) {',
  '  const [host, tty] = argv',
  '  const app = Application(Number(host))',
  '  for (const window of app.windows()) {',
  '    for (const tab of window.tabs()) {',
  '      const terminal = tab.terminals().find(item => item.tty() === tty)',
  '      if (terminal !== undefined) {',
  '        app.selectTab(tab)',
  '        app.focus(terminal)',
  '        return',
  '      }',
  '    }',
  '  }',
  "  throw new Error('no such tab')",
  '}',
].join('\n')

// JXA: the first tab with one of these titles, the status glyph a session puts before its title left
// aside (and only that: `~/site`, a shell's title, stays whole and is no session called `site`). Throws
// when there is none.
const TITLED_TAB = [
  'function titledTab(app, titles) {',
  "  const bare = title => title.replace(/^[^\\p{L}\\p{N}\\s]+\\s+/u, '')",
  '  const wanted = titles.map(bare)',
  '  for (const window of app.windows()) {',
  '    for (const tab of window.tabs()) {',
  '      if (wanted.includes(bare(tab.name()))) return tab',
  '    }',
  '  }',
  "  throw new Error('no such tab')",
  '}',
]

// Both run with: pid, then the titles to look for. This one brings the tab forward.
export const FOCUS_TITLE_SCRIPT = [
  ...TITLED_TAB,
  'function run(argv) {',
  '  const [host, ...titles] = argv',
  '  const app = Application(Number(host))',
  '  const tab = titledTab(app, titles)',
  '  app.selectTab(tab)',
  '  app.focus(tab.terminals()[0])',
  '}',
].join('\n')

// This one only says, by its exit code, whether there is one: the tab you look at does not change.
export const HAS_TITLE_SCRIPT = [
  ...TITLED_TAB,
  'function run(argv) {',
  '  const [host, ...titles] = argv',
  '  titledTab(Application(Number(host)), titles)',
  '}',
].join('\n')
