// Seeing what Claude does, to understand it: the ★ Insight points it writes, the project
// map of the files it read and changed, what fills its context, and the question asked
// when you press "?" on one of its actions.

import type { Breakdown, ContextShare, FileTouch, Insight } from '../types'
import { readVerdict, stripMarks } from './colors'

// ── ★ Insight blocks ─────────────────────────────────────────────────────────

// Between a "★ Insight ───" line and a closing rule, in or out of backticks. The heading
// starts its line: "★ Insight" named mid-sentence is not a block.
const INSIGHT_BLOCK = /^[ \t`]*★ Insight[^\n]*\n([\s\S]*?)\n[ \t`]*─{5,}[`]*/gm
const ITEM_START = /^\s*(?:[-*•]|\d+[.)])\s+/

// A short stable id for a piece of text (djb2), so an insight seen twice is kept once.
export function textId(text: string): string {
  let hash = 5381
  const normal = text.replace(/\s+/g, ' ').trim()
  for (let index = 0; index < normal.length; index++) hash = ((hash * 33) ^ normal.charCodeAt(index)) >>> 0
  return hash.toString(36)
}

export const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

// "**Title.** body" → title and body; without bold, the first sentence is the title.
function splitTitle(item: string): { title: string; body: string } {
  const bold = /^\*\*(.+?)\*\*[\s:.—–-]*([\s\S]*)$/.exec(item)
  if (bold !== null) return { title: bold[1]!.replace(/[.:]\s*$/, '').trim(), body: capital(bold[2]!.trim()) }
  const sentence = /^(.{10,90}?[.:!?])\s+([\s\S]+)$/.exec(item)
  if (sentence !== null) return { title: sentence[1]!.replace(/[.:]$/, ''), body: sentence[2]!.trim() }
  return { title: item.length > 90 ? item.slice(0, 89) + '…' : item, body: item.length > 90 ? item : '' }
}

// The points of every ★ Insight block in a reply: one per bullet, or the block as one.
export function parseInsights(text: string): { id: string; title: string; body: string }[] {
  const found: { id: string; title: string; body: string }[] = []
  for (const match of text.matchAll(INSIGHT_BLOCK)) {
    const items: string[] = []
    for (const line of match[1]!.split('\n')) {
      if (line.trim() === '') continue
      if (ITEM_START.test(line) || items.length === 0) items.push(line.replace(ITEM_START, '').trim())
      else items[items.length - 1] += ' ' + line.trim()
    }
    for (const item of items) found.push({ id: textId(item), ...splitTitle(item) })
  }
  return found
}

// The note's section for insights not yet in it: a dated heading per project.
export function noteSection(insights: readonly Insight[], date: string): string {
  const byDir = new Map<string, Insight[]>()
  for (const insight of insights) byDir.set(insight.dir, [...(byDir.get(insight.dir) ?? []), insight])
  return [...byDir]
    .map(
      ([dir, list]) =>
        `## ${date}${dir !== '' ? ` · ${dir}` : ''}\n\n` +
        list.map(insight => `- **${insight.title}.** ${insight.body}`.trimEnd()).join('\n') +
        '\n',
    )
    .join('\n')
}

export const noteHeader = (name: string) =>
  `# ${name}\n\nClaude’s ★ Insight blocks, added from the Cockpit.\n\n`

// The note with the new section after what it holds: nothing in it is changed or dropped.
export function appendToNote(existing: string | null, section: string, name = 'Claude Code learnings'): string {
  const base = existing === null || existing.trim() === '' ? noteHeader(name) : existing.replace(/\s*$/, '\n\n')
  return base + section
}

// ── Project map ──────────────────────────────────────────────────────────────

export type MapFolder = { dir: string; files: (FileTouch & { name: string })[] }

// The files by folder, folders and files in alphabetical order: the project's shape, with
// what Claude read and what it changed. Past `limit` files, changes come first, then the
// latest reads. Paths in the folder are relative; others start at ~.
export function projectMap(list: readonly FileTouch[], cwd: string, limit = 24): MapFolder[] {
  const ranked = [...list].sort((a, b) =>
    a.action === 'read' && b.action !== 'read' ? 1 : a.action !== 'read' && b.action === 'read' ? -1 : b.at - a.at,
  )
  const folders = new Map<string, (FileTouch & { name: string })[]>()
  for (const file of ranked.slice(0, limit)) {
    const relative =
      cwd !== '' && file.path.startsWith(cwd + '/') ? file.path.slice(cwd.length + 1) : file.path.replace(/^\/(?:Users|home)\/[^/]+/, '~')
    const cut = relative.lastIndexOf('/')
    const dir = cut === -1 ? '' : relative.slice(0, cut + 1)
    folders.set(dir, [...(folders.get(dir) ?? []), { ...file, name: relative.slice(cut + 1) }])
  }
  // The folder's own files first, its subfolders next, then files outside it (~/…, /…).
  const rank = (dir: string) => (dir === '' ? 0 : /^[~/]/.test(dir) ? 2 : 1)
  return [...folders]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([dir, files]) => ({ dir, files: files.sort((a, b) => a.name.localeCompare(b.name)) }))
}

// A file touch: a change replaces a read; a read of a changed file leaves it as it was.
export function touch(
  list: readonly FileTouch[],
  path: string,
  action: FileTouch['action'],
  at: number,
  max: number,
): FileTouch[] {
  const previous = list.find(file => file.path === path)
  let touched: FileTouch
  if (previous === undefined) touched = { path, action, count: 1, at }
  else if (action === 'read') {
    if (previous.action !== 'read') return [...list]
    touched = { ...previous, count: previous.count + 1, at }
  } else if (previous.action === 'read') touched = { path, action, count: 1, at }
  else touched = { ...previous, count: previous.count + 1, at }
  return [...list.filter(file => file.path !== path), touched].slice(-max)
}

// ── What fills the context ───────────────────────────────────────────────────

type Category = { name: string; tokens: number; kind: string }
type Skills = { totalSkills: number; includedSkills: number } | undefined

const SHORT_NAMES: readonly (readonly [RegExp, string])[] = [
  [/message/i, 'chat'],
  [/mcp/i, 'MCP'],
  [/system tool/i, 'tools'],
  [/system prompt/i, 'system'],
  [/memory/i, 'memory'],
  [/skill/i, 'skills'],
  [/agent/i, 'agents'],
  [/command/i, 'commands'],
]

// /context's rows in use, short-named and biggest first; deferred, free and reserve left out.
export function contextShares(categories: readonly Category[], skills: Skills): Breakdown {
  const shares: ContextShare[] = categories
    .filter(category => category.kind === 'used' && category.tokens > 0)
    .map(category => ({
      label: SHORT_NAMES.find(([pattern]) => pattern.test(category.name))?.[1] ?? category.name.toLowerCase(),
      tokens: category.tokens,
    }))
    .sort((a, b) => b.tokens - a.tokens)
  const skillsCut = skills !== undefined ? Math.max(0, skills.totalSkills - skills.includedSkills) : 0
  return { shares, skillsCut }
}

// ── Why? ─────────────────────────────────────────────────────────────────────

// The question put to Claude on a fork of the conversation: it answers from what it knew
// when it acted, and the answer stays out of the conversation.
export function whyPrompt(subject: string): string {
  return (
    `Question posée depuis le tableau de bord du Cockpit, sans rien faire d'autre : pourquoi ${subject} ? ` +
    'Réponds en français, en 2 à 3 phrases simples pour quelqu’un qui ne code pas : ce que tu cherchais à faire ' +
    'ou à vérifier à ce moment-là, et l’alternative que tu as écartée s’il y en a une. Texte brut, sans markdown.'
  )
}

// ── What Claude waits for ────────────────────────────────────────────────────

// A line as read in the band: no marks, bullet, heading, bold or code ticks.
function plainLine(line: string): string {
  return stripMarks(line)
    .replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
}

// What a turn's last answer leaves you to decide: the words of its `{decide|…}` verdict. A
// question without that badge, such as a polite offer closing finished work, waits on no choice.
export function pendingDecision(answer: string): string | null {
  const verdict = readVerdict(answer)
  return verdict?.kind === 'decide' && verdict.text !== '' ? plainLine(verdict.text) : null
}

// What stops Claude until you help: the words of the answer's `{blocked|…}` verdict.
export function pendingBlocker(answer: string): string | null {
  const verdict = readVerdict(answer)
  return verdict?.kind === 'blocked' && verdict.text !== '' ? plainLine(verdict.text) : null
}

// A tool call that has not ended yet, with the fields its `tool.call` carried.
export type OpenCall = { id: string; tool: string; fields: Readonly<Record<string, unknown>>; agentId?: string }

// The call a permission question is about. The question names no call (no tool_use_id), so it
// goes by the tool and its input, in the same loop if it can; an input a hook rewrote on the way
// falls back on the oldest open call of that tool.
export function questionedCall(
  calls: readonly OpenCall[],
  tool: string,
  input: unknown,
  agentId: string | undefined,
): string | undefined {
  const fields = Object.entries(typeof input === 'object' && input !== null ? input : {})
  const sameTool = calls.filter(call => call.tool === tool)
  const sameInput = sameTool.filter(call =>
    fields.every(([key, value]) => JSON.stringify(call.fields[key]) === JSON.stringify(value)),
  )
  return (sameInput.find(call => call.agentId === agentId) ?? sameInput[0] ?? sameTool[0])?.id
}

// What a turn's last answer leaves for the other Cockpits to show: the words of its
// `{decide|…}` or `{blocked|…}` verdict, plain and at most 120 characters. Any other
// answer, or one with no words, publishes nothing.
export function sessionVerdict(answer: string, max = 120): { kind: 'decide' | 'blocked'; words: string } | null {
  const verdict = readVerdict(answer)
  if (verdict === null || (verdict.kind !== 'decide' && verdict.kind !== 'blocked')) return null
  const words = plainLine(verdict.text).replace(/\s+/g, ' ')
  if (words === '') return null
  return { kind: verdict.kind, words: words.length > max ? `${words.slice(0, max - 1)}…` : words }
}
