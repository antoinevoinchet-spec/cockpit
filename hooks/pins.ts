// Pinned replies: a reply of Claude's (or a passage of one) kept across sessions, to read,
// copy or hand back to Claude later.

import type { SessionMessage } from 'claude-code'
import type { Pin } from '../types'
import { readVerdict, stripMarks } from './colors'
import { textId } from './understand'

const TITLE_MAX = 70

// Claude's replies in the transcript, newest first: for each prompt of yours, the last text
// Claude wrote before the next one, the answer that closes the turn (what /copy takes).
export function recentReplies(messages: readonly SessionMessage[]): string[] {
  const replies: string[] = []
  let last: string | null = null
  for (const message of messages) {
    const isPrompt = message.role === 'user' && (message.toolResults ?? []).length === 0 && message.text.trim() !== ''
    if (isPrompt) {
      if (last !== null) replies.push(last)
      last = null
    } else if (message.role === 'assistant' && message.text.trim() !== '') {
      last = message.text.trim()
    }
  }
  if (last !== null) replies.push(last)
  return replies.reverse()
}

// A name for the list: the first heading, bold run or sentence, without its markdown.
export function pinTitle(text: string): string {
  const lines = text.split('\n').map(line => line.trim())
  const heading = lines.find(line => /^#{1,6}\s/.test(line))
  const first = lines.find(line => line !== '' && !/^[`─★-]{3,}/.test(line) && !line.startsWith('★')) ?? ''
  const source = heading ?? first
  const bold = /\*\*(.+?)\*\*/.exec(source)
  const plain = (bold !== null && source.startsWith('**') ? bold[1]! : source)
    .replace(/^#{1,6}\s+|^[-*>]\s+|^\d+[.)]\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
  const sentence = /^(.{12,}?[.:!?])(\s|$)/.exec(plain)
  const title = (sentence !== null ? sentence[1]! : plain).replace(/[.:]$/, '')
  return title.length > TITLE_MAX ? title.slice(0, TITLE_MAX - 1) + '…' : title === '' ? 'Untitled reply' : title
}

// What /pin's argument asks for: a reply by its rank (1 = the last one), and a title.
export function pinRequest(args: string): { rank: number; title: string | null } {
  const trimmed = args.trim()
  const ranked = /^(\d{1,2})(?:\s+(.*))?$/.exec(trimmed)
  if (ranked !== null) return { rank: Math.max(1, Number(ranked[1])), title: ranked[2]?.trim() || null }
  return { rank: 1, title: trimmed === '' ? null : trimmed }
}

export function makePin(
  text: string,
  where: { dir: string; at: number; sessionId: string },
  options: { title?: string | null; isExcerpt?: boolean } = {},
): Pin {
  // Kept without its marks: a pin is read, copied and handed back as plain markdown. A reply
  // that opens with a verdict is named by it.
  const plain = stripMarks(text)
  const verdict = readVerdict(text)
  return {
    id: textId(plain),
    title: options.title ?? pinTitle(verdict !== null && verdict.text !== '' ? stripMarks(verdict.text) : plain),
    text: plain,
    dir: where.dir,
    at: where.at,
    sessionId: where.sessionId,
    isExcerpt: options.isExcerpt === true,
  }
}

// The newest last; a reply pinned twice moves to the end with its new title.
export function addPin(list: readonly Pin[], pin: Pin, max: number): Pin[] {
  return [...list.filter(item => item.id !== pin.id), pin].slice(-max)
}

// What Reuse writes in the prompt box: the reply, framed so Claude knows where it is from.
export function reusePrompt(pin: Pin, date: string): string {
  return `Voici ${pin.isExcerpt ? 'un passage d’une réponse' : 'une réponse'} que tu m’avais donnée (épinglée le ${date}${pin.dir !== '' ? `, projet ${pin.dir}` : ''}) :\n\n${pin.text}\n\n`
}
