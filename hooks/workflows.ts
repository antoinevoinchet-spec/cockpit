// A workflow's agents are on no list of the engine's: the pane follows them from their spawn to
// their end, in memory only. A restart of Claude Code forgets them.

import type { WorkflowAgent, WorkflowRun } from '../types'

// Measured on 72 real runs (2026-11): 6 agents at the median, 39 at most.
const MAX_RUNS = 5
const MAX_AGENTS_PER_RUN = 100
const RUN_ID_CHARS = 11

export const isRunning = (agent: WorkflowAgent): boolean => agent.status === 'running'

// What the end of an agent's own turn proves.
export function agentEnd(reason: string): 'completed' | 'failed' | 'killed' {
  return reason === 'answer' ? 'completed' : reason === 'aborted' ? 'killed' : 'failed'
}

function withRun(list: readonly WorkflowRun[], run: WorkflowRun): WorkflowRun[] {
  const isKnown = list.some(item => item.runId === run.runId)
  const next = isKnown ? list.map(item => (item.runId === run.runId ? run : item)) : [...list, run]
  return next.slice(-MAX_RUNS)
}

const runOf = (list: readonly WorkflowRun[], runId: string): WorkflowRun =>
  list.find(item => item.runId === runId) ?? { runId, name: null, agents: [], dropped: 0 }

export function addRunAgent(list: readonly WorkflowRun[], runId: string, agent: WorkflowAgent): WorkflowRun[] {
  const run = runOf(list, runId)
  // A resumed run raises again the agents that gave no result: the new try takes the old one's place.
  const kept = run.agents.filter(item => item.index !== agent.index || isRunning(item) || item.status === 'completed')
  const agents = [...kept, agent]
  // Past the bound the oldest finished row goes, and stays counted.
  const oldest = agents.length > MAX_AGENTS_PER_RUN ? agents.find(item => !isRunning(item)) : undefined
  return withRun(
    list,
    oldest !== undefined
      ? { ...run, agents: agents.filter(item => item !== oldest), dropped: run.dropped + 1 }
      : { ...run, agents },
  )
}

export function nameRun(list: readonly WorkflowRun[], runId: string, name: string): WorkflowRun[] {
  return withRun(list, { ...runOf(list, runId), name })
}

// An id on no row (an engine's fork, a stalled agent's retry) changes nothing.
export function endRunAgent(
  list: readonly WorkflowRun[],
  id: string,
  status: WorkflowAgent['status'],
  at: number,
): WorkflowRun[] {
  return list.map(run =>
    run.agents.some(agent => agent.id === id)
      ? { ...run, agents: run.agents.map(agent => (agent.id === id ? { ...agent, status, endedAt: at } : agent)) }
      : run,
  )
}

// No workflow is in flight any more: an agent still shown as running ended unseen.
export function closeRuns(list: readonly WorkflowRun[], at: number): WorkflowRun[] {
  return list.map(run =>
    run.agents.some(isRunning)
      ? {
          ...run,
          agents: run.agents.map(agent => (isRunning(agent) ? { ...agent, status: 'unknown', endedAt: at } : agent)),
        }
      : run,
  )
}

// Its name, else its id cut short: "wf_78595e9c-84f" reads "wf_78595e9c".
export function runLabel(run: WorkflowRun): string {
  if (run.name !== null && run.name !== '') return run.name
  return run.runId !== '' ? run.runId.slice(0, RUN_ID_CHARS) : 'workflow'
}

// `total` counts the agents started so far: the engine does not say how many a script will start.
export function runCounts(run: WorkflowRun): { ended: number; total: number; noResult: number } {
  const finished = run.agents.filter(agent => !isRunning(agent))
  return {
    ended: finished.length + run.dropped,
    total: run.agents.length + run.dropped,
    noResult: finished.filter(agent => agent.status !== 'completed').length,
  }
}
