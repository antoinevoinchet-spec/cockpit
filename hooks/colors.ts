// Marks in Claude's replies, drawn in the chat: `{green|text}` and its kin as coloured text,
// `{mark|text}` highlighted, a verdict opening the reply as a badge, `{term|word|meaning}` as a
// word to learn, and a few signs (✓ ✗ ⚠, DOING / EXPECT / IF WRONG) coloured on their own.
// A paragraph or list holding one is drawn run by run; the rest stays markdown.

import type { ThemeKey } from 'claude-code'

// What each colour means, as Claude is told it, and the theme colour it draws in.
export const COLORS = {
  green: { tone: 'success', means: 'succeeded, done, safe' },
  red: { tone: 'error', means: 'failed, a problem, a danger or something irreversible' },
  orange: { tone: 'warning', means: 'to keep an eye on, or a decision to make' },
  blue: { tone: 'suggestion', means: 'a file path, a command or a setting' },
} as const satisfies Record<string, { tone: ThemeKey; means: string }>

export type ColorName = keyof typeof COLORS

// The highlighter: dark text on this colour, for the one sentence to remember.
export const HIGHLIGHT_TONE: ThemeKey = 'warning'

// The verdict a reply opens with, drawn as a badge: its words, its colour, what it means.
export const VERDICTS = {
  done: { badge: '✓ DONE', tone: 'success', means: 'the work is finished and checked' },
  decide: { badge: '? DECIDE', tone: 'warning', means: 'the person must choose before you go on' },
  blocked: { badge: '✗ BLOCKED', tone: 'error', means: 'something stops you that needs the person' },
  info: { badge: 'i INFO', tone: 'suggestion', means: 'the short answer to their question' },
} as const satisfies Record<string, { badge: string; tone: ThemeKey; means: string }>

export type VerdictName = keyof typeof VERDICTS

// The verdict line, and the reply after it.
export type Verdict = { kind: VerdictName; text: string; rest: string }

// A word Claude explained in a reply, for the lexicon.
export type Term = { term: string; meaning: string }

// Signs coloured wherever they stand in a paragraph's text, with no mark from Claude.
const SIGNS: readonly { pattern: RegExp; tone: ThemeKey; isBold: boolean }[] = [
  { pattern: /[✓✔✅]/, tone: 'success', isBold: false },
  { pattern: /[✗✘❌]/, tone: 'error', isBold: false },
  { pattern: /⚠️?/, tone: 'warning', isBold: false },
  { pattern: /\bDOING\b/, tone: 'suggestion', isBold: true },
  { pattern: /\bEXPECT\b/, tone: 'success', isBold: true },
  { pattern: /\bIF WRONG\b/, tone: 'warning', isBold: true },
]
const SIGN = new RegExp(SIGNS.map(sign => sign.pattern.source).join('|'), 'g')

const MARK = /\{(green|red|orange|blue|mark)\|([^{}\n]+?)\}/g
const TERM = /\{term\|([^{}|\n]+)\|([^{}\n]+?)\}/g
// The reply's first line: `{done|…}`, colour marks allowed inside, its closing brace still to
// come while the reply streams.
const VERDICT = /^\s*\{(done|decide|blocked|info)\|((?:[^{}\n]|\{(?:green|red|orange|blue|mark|term)\|[^{}\n]*\})*)\}?([^\n]*)/
const FENCE = /^\s*(```|~~~)/
const TOKEN =
  /(`[^`]+`)|\{(green|red|orange|blue|mark)\|([^{}\n]+?)\}|\{term\|([^{}|\n]+)\|([^{}\n]+?)\}|\*\*(.+?)\*\*|__(.+?)__|(?<![*\w])\*([^*\s][^*]*?)\*(?!\*)|\[([^\]]+)\]\([^)]*\)/g

// One stretch of a line, with its look.
export type Run = {
  text: string
  tone?: ThemeKey
  isBold?: boolean
  isItalic?: boolean
  isCode?: boolean
  isHighlight?: boolean
  isUnderline?: boolean
  isDim?: boolean
}
export type Block = { kind: 'markdown'; text: string } | { kind: 'colored'; lines: Run[][] }

// What Claude is told, once per request, in the system prompt.
export function marksPrompt(): string {
  const meanings = (Object.keys(COLORS) as ColorName[]).map(name => `{${name}|…} = ${COLORS[name].means}`).join('; ')
  const verdicts = (Object.keys(VERDICTS) as VerdictName[]).map(name => `{${name}|…} = ${VERDICTS[name].means}`).join('; ')
  return [
    '# Marks in replies',
    'The person reads your replies in a terminal that draws a few marks, with the markers hidden. Use them on your own initiative, in replies to the person only: never in files you write, commit messages, tool inputs or prompts for subagents. Never in headings, tables, code blocks or inline code, never nested, never across lines.',
    `Colour: \`{green|text}\`, \`{red|text}\`, \`{orange|text}\` and \`{blue|text}\` draw coloured text. Use them sparingly (a few short phrases per reply, never whole paragraphs), always with this meaning: ${meanings}.`,
    'Highlight: `{mark|text}` highlights text like a marker pen: at most once per reply, on the one sentence to remember or the action the person must take, and only in a reply long enough to need it.',
    '✓ ✗ ⚠ and the labels DOING, EXPECT and IF WRONG are coloured on their own: never wrap them in a marker.',
    `Verdict: the reply that ends your turn opens with a verdict line when it is long (over a dozen lines) or reports finished work, a blocker or a choice to make: ${verdicts}. It is the reply's very first line, at most 12 words giving the gist, drawn as a badge; the reply follows as usual. Never in a reply followed by tool calls, never twice in a reply.`,
    'Words: the person is not a developer and learns the vocabulary as you go. The first time a reply uses a technical term they may not know, write it `{term|word|meaning}`, the meaning in at most 8 plain words in the reply’s language, e.g. `{term|commit|instantané enregistré du code}`. The terminal shows the meaning beside the word and keeps both in their lexicon, so do not explain the word again in the sentence. At most 3 per reply, each word once per conversation.',
  ].join('\n')
}

// Every mark is a no-op outside a code block and outside inline code.
function eachOutsideCode(text: string, onText: (part: string) => string): string {
  let isFenced = false
  return text
    .split('\n')
    .map(line => {
      if (FENCE.test(line)) {
        isFenced = !isFenced
        return line
      }
      if (isFenced) return line
      return line
        .split(/(`[^`]*`)/)
        .map(part => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part : onText(part)))
        .join('')
    })
    .join('\n')
}

// The verdict a reply opens with, if it does: complete, or still streaming.
export function readVerdict(text: string): Verdict | null {
  const match = VERDICT.exec(text)
  if (match === null) return null
  const [whole, kind, inner, after] = match
  return { kind: kind as VerdictName, text: (inner! + after!).trim(), rest: text.slice(whole.length).replace(/^\n+/, '') }
}

const stripInline = (part: string) => part.replace(MARK, '$2').replace(TERM, '$1 ($2)')

// The reply without its marks, the verdict as a bold label: for a pin, a copy, a Learn
// point, the other surfaces.
export function stripMarks(text: string): string {
  if (!text.includes('{')) return text
  const verdict = readVerdict(text)
  const body = eachOutsideCode(verdict !== null ? verdict.rest : text, stripInline)
  if (verdict === null) return body
  const head = `**${VERDICTS[verdict.kind].badge}** — ${stripInline(verdict.text)}`
  return body !== '' ? `${head}\n\n${body}` : head
}

function findsOutsideCode(text: string, pattern: RegExp): boolean {
  let found = false
  eachOutsideCode(text, part => {
    pattern.lastIndex = 0
    if (pattern.test(part)) found = true
    return part
  })
  return found
}

// A mark Claude wrote, outside code: a colour, the highlighter, a verdict, a word.
export function hasMarks(text: string): boolean {
  return readVerdict(text) !== null || findsOutsideCode(text, MARK) || findsOutsideCode(text, TERM)
}

// Something to draw run by run: a mark, or a sign coloured on its own.
export function isColorful(text: string): boolean {
  return hasMarks(text) || findsOutsideCode(text, SIGN)
}

// The words a reply explains, outside code, once each: the first meaning given wins.
export function termsIn(text: string): Term[] {
  const found = new Map<string, Term>()
  eachOutsideCode(text, part => {
    for (const match of part.matchAll(TERM)) {
      const term = match[1]!.trim()
      const meaning = match[2]!.trim()
      if (term !== '' && meaning !== '' && !found.has(term.toLowerCase())) found.set(term.toLowerCase(), { term, meaning })
    }
    return part
  })
  return [...found.values()]
}

// A run of plain text cut where a sign stands, each sign in its colour.
function withSigns(run: Run): Run[] {
  if (run.tone !== undefined || run.isCode === true || run.isHighlight === true) return [run]
  const runs: Run[] = []
  let at = 0
  for (const match of run.text.matchAll(SIGN)) {
    const sign = SIGNS.find(item => new RegExp(`^(?:${item.pattern.source})$`).test(match[0]))!
    if (match.index > at) runs.push({ ...run, text: run.text.slice(at, match.index) })
    runs.push({ ...run, text: match[0], tone: sign.tone, isBold: run.isBold === true || sign.isBold })
    at = match.index + match[0].length
  }
  if (at === 0) return [run]
  if (at < run.text.length) runs.push({ ...run, text: run.text.slice(at) })
  return runs
}

// A stretch of text as runs: marks, words, **bold** (marks inside it too), *italic*, `code`,
// [links](…).
function tokenRuns(text: string): Run[] {
  const runs: Run[] = []
  let at = 0
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > at) runs.push({ text: text.slice(at, match.index) })
    const [whole, code, color, colored, term, meaning, bold, underBold, italic, link] = match
    if (code !== undefined) runs.push({ text: code.slice(1, -1), isCode: true })
    else if (color !== undefined && colored !== undefined) {
      const inner = colored.replace(/\*\*(.+?)\*\*/g, '$1')
      runs.push(
        color === 'mark'
          ? { text: inner, isHighlight: true, isBold: true }
          : { text: inner, tone: COLORS[color as ColorName].tone, isBold: inner !== colored },
      )
    } else if (term !== undefined && meaning !== undefined) {
      runs.push({ text: term.trim(), isUnderline: true }, { text: ` (${meaning.trim()})`, isDim: true })
    } else if (bold !== undefined || underBold !== undefined) {
      runs.push(...tokenRuns((bold ?? underBold)!).map(run => ({ ...run, isBold: true })))
    } else if (italic !== undefined) runs.push({ text: italic, isItalic: true })
    else if (link !== undefined) runs.push({ text: link })
    else runs.push({ text: whole })
    at = match.index + whole.length
  }
  if (at < text.length) runs.push({ text: text.slice(at) })
  return runs
}

// One line of a coloured paragraph, as runs, its bullet drawn "- " as the engine draws a list.
export function lineRuns(line: string): Run[] {
  const indent = /^\s*/.exec(line)![0]
  const body = line.slice(indent.length)
  const bullet = /^([-*+])\s+/.exec(body)
  const rest = bullet !== null ? body.slice(bullet[0].length) : body
  const lead: Run[] = indent !== '' || bullet !== null ? [{ text: indent + (bullet !== null ? '- ' : '') }] : []
  return [...lead, ...tokenRuns(rest)].flatMap(withSigns)
}

// The reply cut into blocks: each paragraph or list with something to colour drawn run by
// run, every other stretch left whole to the markdown drawing.
export function colorBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let markdown: string[] = []
  let paragraph: string[] = []
  let isFenced = false
  const flushMarkdown = () => {
    const joined = markdown.join('\n').replace(/^\n+|\n+$/g, '')
    if (joined !== '') blocks.push({ kind: 'markdown', text: joined })
    markdown = []
  }
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const isPlain = paragraph.every(line => !/^\s*(#{1,6}\s|\||>)/.test(line))
    if (isPlain && isColorful(paragraph.join('\n'))) {
      flushMarkdown()
      blocks.push({ kind: 'colored', lines: paragraph.map(lineRuns) })
    } else {
      markdown.push(...paragraph, '')
    }
    paragraph = []
  }
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      if (!isFenced) flushParagraph()
      isFenced = !isFenced
      markdown.push(line)
    } else if (isFenced) {
      markdown.push(line)
    } else if (line.trim() === '') {
      flushParagraph()
    } else {
      paragraph.push(line)
    }
  }
  flushParagraph()
  flushMarkdown()
  return blocks
}
