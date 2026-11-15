// Reads a superpowers plan (docs/superpowers/plans/*.md) and works out its progress.
// The file's `- [ ]` boxes are never ticked in practice: progress comes from the
// session's task list (TaskCreate / TaskUpdate / TodoWrite).

import type { PlanTask, TodoItem } from '../types'

export type ParsedPlan = { title: string; tasks: PlanTask[]; requirements: string[] }

export type PlanProgress = {
  done: readonly number[]
  current: number | null
  coveredRequirements: readonly string[]
  hasMatchedTodos: boolean
}

export const PLAN_PATH = /docs\/superpowers\/plans\/[^/]+\.md$/

const TASK_HEADING = /^#{2,4}\s+Task\s+(\d+)\s*[:.—–-]?\s*(.*)$/i
const COVERS_LINE = /^(?:[-*]\s+)?(?:\*\*)?Couvre\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)$/i
const TASK_IN_TODO = /\b(?:Task|Tâche)\s*(\d+)\b/i

function requirementIds(text: string): string[] {
  return [...text.matchAll(/\bD(\d+)\b/g)].map(match => `D${match[1]}`)
}

function byNumber(a: string, b: string): number {
  return Number(a.slice(1)) - Number(b.slice(1))
}

function stripMarkdown(text: string): string {
  return text.replace(/[`*_]/g, '').trim()
}

export function parsePlan(text: string): ParsedPlan {
  let title = ''
  let isInFence = false
  const tasks: PlanTask[] = []

  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      isInFence = !isInFence
      continue
    }
    if (isInFence) continue

    if (title === '' && line.startsWith('# ')) {
      title = stripMarkdown(line.slice(2).replace(/\s*[—–-]\s*Implementation Plan\s*$/i, ''))
      continue
    }

    const heading = TASK_HEADING.exec(line)
    if (heading !== null) {
      tasks.push({ n: Number(heading[1]), name: stripMarkdown(heading[2] ?? ''), covers: [] })
      continue
    }

    const covers = COVERS_LINE.exec(line.trim())
    const last = tasks.at(-1)
    if (covers !== null && last !== undefined) {
      tasks[tasks.length - 1] = { ...last, covers: [...last.covers, ...requirementIds(covers[1] ?? '')] }
    }
  }

  const requirements = [...new Set(tasks.flatMap(task => task.covers))].sort(byNumber)
  return { title, tasks, requirements }
}

export function planProgress(tasks: readonly PlanTask[], todos: readonly TodoItem[]): PlanProgress {
  const done = new Set<number>()
  let current: number | null = null
  let hasMatchedTodos = false

  for (const todo of todos) {
    const match = TASK_IN_TODO.exec(todo.subject)
    if (match === null) continue
    hasMatchedTodos = true
    const n = Number(match[1])
    if (todo.status === 'completed') done.add(n)
    if (todo.status === 'in_progress') current = n
  }

  // A requirement is covered once every task that covers it is done.
  const requirements = [...new Set(tasks.flatMap(task => task.covers))]
  const coveredRequirements = requirements.filter(id =>
    tasks.filter(task => task.covers.includes(id)).every(task => done.has(task.n)),
  )

  return { done: [...done], current, coveredRequirements, hasMatchedTodos }
}
