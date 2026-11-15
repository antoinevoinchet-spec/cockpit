// Turns a tool call into a plain-English line,
// and flags sensitive actions (delete, push, SQL, deploy…).

export type ToolLabel = {
  verb: string
  detail: string
  isSensitive: boolean
  command?: string
}

// Shell commands that destroy, publish or touch production.
// Matched on the command text: a visual cue, not a guard.
const SENSITIVE_BASH: readonly RegExp[] = [
  /\brm\s+(-\w*[rRf]|--recursive|--force)/,
  /\bgit\b(\s+-C\s+\S+)?\s+push\b/,
  /\bgit\b(\s+-C\s+\S+)?\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-\w*f/,
  /\bgit\s+checkout\s+--\s/,
  /\bgit\s+restore\b/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+(rebase|filter-branch)\b/,
  /\bgit\s+stash\s+(drop|clear)\b/,
  /\bvercel\b.*(--prod\b|\bdeploy\b|\benv\s+rm\b|\bremove\b)/,
  /\bsupabase\s+(db\s+(push|reset)|migration\s+(up|repair))\b/,
  /\bprisma\s+(migrate|db\s+push)\b/,
  /\bdrizzle-kit\s+push\b/,
  /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bsudo\b/,
  /\bchmod\s+-R\b/,
  /\bcurl\b[^|]*\|\s*(ba|z)?sh\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\bgh\s+(repo\s+delete|pr\s+merge|release\s+create)\b/,
]

// MCP tools that write to, send through or delete from an outside service.
const SENSITIVE_MCP =
  /(execute_sql|apply_migration|delete|drop|trash|send_message|send_[a-z]*mail|forward|reset_branch|merge_branch|pause_project|deploy|publish)/i

// Labels for the most common MCP tools; others keep the tool's own name.
const MCP_VERBS: Readonly<Record<string, string>> = {
  execute_sql: 'Run SQL',
  apply_migration: 'Apply migration',
  list_tables: 'List tables',
  get_advisors: 'Check advisors',
  search_docs: 'Search docs',
  send_message: 'Send email',
  create_draft: 'Draft email',
  deploy_edge_function: 'Deploy function',
}

const TASK_STATUS: Readonly<Record<string, string>> = {
  pending: 'to do',
  in_progress: 'in progress',
  completed: 'done',
  deleted: 'deleted',
}

export function isSensitiveCommand(command: string): boolean {
  return SENSITIVE_BASH.some(pattern => pattern.test(command))
}

export function isSensitiveTool(tool: string): boolean {
  return tool.startsWith('mcp__') && SENSITIVE_MCP.test(tool)
}

export function shortPath(path: string, cwd: string): string {
  if (cwd !== '' && path.startsWith(cwd + '/')) return path.slice(cwd.length + 1)
  return path
}

export function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
}

// `mcp__claude_ai_Supabase__execute_sql` → { server: 'Supabase', name: 'execute_sql' }
export function splitMcpName(tool: string): { server: string; name: string } {
  const [, server = '', ...rest] = tool.split('__')
  const pretty = server.replace(/^(claude_ai_|plugin_[a-z0-9-]+_)/i, '').replace(/[_-]+/g, ' ')
  return { server: pretty.trim(), name: rest.join('__') }
}

export function describeTool(tool: string, input: unknown, cwd: string): ToolLabel {
  const fields = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const text = (key: string): string => (typeof fields[key] === 'string' ? (fields[key] as string) : '')
  const path = (key: string): string => shortPath(text(key), cwd)

  switch (tool) {
    case 'Bash': {
      const command = text('command')
      return {
        verb: 'Run',
        detail: text('description') || firstLine(command),
        isSensitive: isSensitiveCommand(command),
        command,
      }
    }
    case 'Read':
      return { verb: 'Read', detail: path('file_path'), isSensitive: false }
    case 'Write':
      return { verb: 'Write', detail: path('file_path'), isSensitive: false }
    case 'Edit':
    case 'MultiEdit':
      return { verb: 'Edit', detail: path('file_path'), isSensitive: false }
    case 'NotebookEdit':
      return { verb: 'Edit notebook', detail: path('notebook_path'), isSensitive: false }
    case 'Glob':
      return { verb: 'Find files', detail: text('pattern'), isSensitive: false }
    case 'Grep':
      return { verb: 'Search code', detail: text('pattern'), isSensitive: false }
    case 'WebFetch':
      return { verb: 'Fetch', detail: text('url'), isSensitive: false }
    case 'WebSearch':
      return { verb: 'Web search', detail: text('query'), isSensitive: false }
    case 'Agent':
    case 'Task': {
      const type = text('subagent_type')
      return {
        verb: 'Delegate',
        detail: text('description') + (type !== '' ? ` (${type})` : ''),
        isSensitive: false,
      }
    }
    case 'Skill':
      return { verb: 'Skill', detail: text('skill'), isSensitive: false }
    case 'TaskCreate':
      return { verb: 'New task', detail: text('subject'), isSensitive: false }
    case 'TaskUpdate': {
      const status = TASK_STATUS[text('status')]
      return {
        verb: 'Task',
        detail: `#${text('taskId')}` + (status !== undefined ? ` → ${status}` : ''),
        isSensitive: false,
      }
    }
    case 'TodoWrite':
      return { verb: 'Task list', detail: 'updated', isSensitive: false }
    case 'ToolSearch':
      return { verb: 'Load tools', detail: text('query'), isSensitive: false }
    case 'AskUserQuestion':
      return { verb: 'Asks you', detail: '', isSensitive: false }
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return { verb: 'Plan mode', detail: tool === 'EnterPlanMode' ? 'on' : 'off', isSensitive: false }
    case 'SendMessage':
      return { verb: 'Message agent', detail: text('to'), isSensitive: false }
  }

  if (tool.startsWith('mcp__')) {
    const { server, name } = splitMcpName(tool)
    const verb = MCP_VERBS[name] ?? (/^send_[a-z]*mail/.test(name) ? 'Send email' : name.replace(/_/g, ' '))
    return { verb: `${server} · ${verb}`, detail: '', isSensitive: isSensitiveTool(tool) }
  }

  return { verb: tool, detail: '', isSensitive: false }
}

// What a permission question asks you to approve, as the pane names it: the command itself for a
// shell call (its description is only Claude's word for it), else the action.
export function approvalLabel(tool: string, input: unknown, cwd: string): string {
  const label = describeTool(tool, input, cwd)
  const command = firstLine(label.command ?? '')
  const action = command !== '' ? command : [label.verb, label.detail].filter(part => part !== '').join(' ')
  return `approve: ${action}`
}
