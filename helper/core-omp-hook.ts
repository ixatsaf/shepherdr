// Oh My Pi extension for one launch: its lifecycle goes to helper/core-hook.ts in the hook shape every CLI uses, and its
// permission prompts become Shepherdr's cards through ui.approve, the slot omp keeps for a host that answers them.
import { spawn } from 'node:child_process'

type Call = { id: string; tool: string; name: string; use: string; input: unknown }

// Shepherdr's card and its own-command check know Claude Code's name for a shell.
const STOP_KEY = /^(?:\x03|\x1b|\x1b\[(?:27|99;5)(?:;\d+)*u)$/ // Esc or Ctrl-C, plain or in the kitty keyboard protocol
const toolName = (name: string) => name === 'bash' ? 'Bash' : name

export default function (omp: any) {
  const calls = new Map<string, Call>()
  let count = 0
  const asks: Call[] = []
  const running = new Set<ReturnType<typeof spawn>>()

  /** Which call this prompt is for: an answer must never reach a tool its card didn't show, so any doubt is a no. */
  const askedBy = (prompt: string) => {
    if (asks.length < 2) return asks[0]
    // The call whose own words the prompt shows most of: `ls -la` is also `ls`. Identical calls are the same to allow.
    const shown = (call: Call) => Math.max(0, ...Object.values(call.input ?? {}).map(value => typeof value === 'string' && prompt.includes(value) ? value.length : 0))
    const same = asks.filter(call => prompt.includes(`Allow tool: ${call.tool}`))
    const most = Math.max(0, ...same.map(shown)), found = same.filter(call => shown(call) === most)
    return found.length === 1 || found.every(call => JSON.stringify(call.input) === JSON.stringify(found[0]!.input)) ? found[0] : undefined
  }

  const hook = (event: string, ctx: any, fields: Record<string, unknown> = {}) => new Promise<string>(resolve => {
    // A subagent runs in this process with no UI: its own ends and session aren't the task's. The task tool stands for it.
    if (!ctx.hasUI) return resolve('')
    const child = spawn('sh', ['-c', `exec ${process.env.SHEPHERDR_OMP_HOOK ?? 'false'}`], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    running.add(child)
    child.stdout!.on('data', chunk => { out += chunk })
    const done = () => { running.delete(child); resolve(out) }
    child.on('error', done).on('close', done)
    child.stdin!.on('error', () => {})
    child.stdin!.end(JSON.stringify({
      hook_event_name: event, session_id: ctx.sessionManager?.getSessionId?.(), transcript_path: ctx.sessionManager?.getSessionFile?.(),
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, ...fields,
    }))
  })

  const approve = async (prompt: any, ctx: any) => {
    const ask = askedBy(String(prompt?.full ?? ''))
    if (!ask) return 'deny'
    asks.splice(asks.indexOf(ask), 1)
    // omp gives ui.approve no abort signal: a stop key is the only word that this prompt's turn was interrupted. The hook then closes the card.
    const off = ctx.ui.onTerminalInput?.((key: string) => { if (STOP_KEY.test(key)) for (const child of running) child.kill('SIGTERM') })
    try {
      const out = await hook('PermissionRequest', ctx, { tool_name: ask.name, tool_use_id: ask.use, tool_input: ask.input })
      return JSON.parse(out).hookSpecificOutput.decision.behavior === 'allow' ? 'once' : 'deny'
    } catch { return 'deny' } finally { off?.() }
  }

  omp.on('session_start', (_: unknown, ctx: any) => hook('SessionStart', ctx))
  omp.on('agent_start', (_: unknown, ctx: any) => hook('UserPromptSubmit', ctx))
  omp.on('agent_end', async (event: any, ctx: any) => { if (!event.willContinue) await hook('Stop', ctx) })
  omp.on('session_shutdown', async (_: unknown, ctx: any) => {
    if (ctx.hasUI) for (const child of running) child.kill('SIGTERM') // A card still open goes with this process.
    await hook('SessionEnd', ctx)
  })
  omp.on('tool_call', async (event: any, ctx: any) => {
    // Its own question box is only on a screen the human doesn't read.
    if (event.toolName === 'ask') return { block: true, reason: 'Your human reads a chat, not this terminal: ask with your shepherdr ask command, then end your turn.' }
    // Some providers number a call's id per turn: a card must not take an earlier call's end for its own.
    const call = { id: event.toolCallId, tool: event.toolName, name: toolName(event.toolName), use: `${event.toolCallId}#${++count}`, input: event.input }
    calls.set(event.toolCallId, call)
    await hook('PreToolUse', ctx, { tool_name: call.name, tool_use_id: call.use, tool_input: call.input })
  })
  omp.on('tool_result', async (event: any, ctx: any) => {
    const call = calls.get(event.toolCallId)
    calls.delete(event.toolCallId)
    if (call) await hook(event.isError ? 'PostToolUseFailure' : 'PostToolUse', ctx, { tool_name: call.name, tool_use_id: call.use, tool_input: call.input })
  })
  // omp reads ui.approve right after this event; set here so it is ours whatever replaced the context since the start.
  omp.on('tool_approval_requested', (event: any, ctx: any) => {
    asks.push(calls.get(event.toolCallId) ?? { id: event.toolCallId, tool: event.toolName, name: toolName(event.toolName), use: event.toolCallId, input: {} })
    ctx.ui.approve = (prompt: unknown) => approve(prompt, ctx)
  })
  omp.on('tool_approval_resolved', (event: any) => {
    const at = asks.findIndex(ask => ask.id === event.toolCallId)
    if (at >= 0) asks.splice(at, 1)
  })
}
