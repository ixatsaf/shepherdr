// Oh My Pi's extension, driven as omp drives it: its events go to a fake of helper/core-hook.ts that records each line.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import extension from '../helper/core-omp-hook.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); delete process.env.SHEPHERDR_OMP_HOOK })

/** The fake hook records what it read and answers a permission with `answer`. */
function omp(answer = '{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}') {
  const dir = mkdtempSync(join(tmpdir(), 'shep-omp-hook-')), log = join(dir, 'lines'), reply = join(dir, 'reply')
  dirs.push(dir)
  writeFileSync(reply, answer)
  process.env.SHEPHERDR_OMP_HOOK = `sh -c 'read -r line || true; echo "$line" >> ${log}; case "$line" in *PermissionRequest*) cat ${reply};; esac'`
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  extension({ on: (name: string, run: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, run) })
  const ctx = { hasUI: true, ui: {} as { approve?: () => Promise<string> }, model: { provider: 'acme', id: 'one' }, sessionManager: { getSessionId: () => 'session', getSessionFile: () => '/log.jsonl' } }
  return {
    ctx,
    fire: (name: string, event: unknown = {}, at: unknown = ctx) => handlers.get(name)!(event, at),
    lines: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
  }
}

test('its lifecycle reaches Shepherdr as the hooks every CLI sends, with its session and log', async () => {
  const { fire, lines } = omp()
  await fire('session_start')
  await fire('agent_start')
  await fire('agent_end', { willContinue: true })
  await fire('agent_end')
  await fire('session_shutdown')
  expect(lines().map(line => line.hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'])
  expect(lines()[0]).toMatchObject({ session_id: 'session', transcript_path: '/log.jsonl', model: 'acme/one' })
})

test('a card and its tool call share a name, an input and an id of their own, even where the provider repeats one', async () => {
  const { ctx, fire, lines } = omp()
  for (const _ of [1, 2]) {
    await fire('tool_call', { toolName: 'bash', toolCallId: 'p:0:bash', input: { command: 'ls' } })
    await fire('tool_approval_requested', { toolName: 'bash', toolCallId: 'p:0:bash' })
    expect(await ctx.ui.approve!()).toBe('once')
    await fire('tool_result', { toolName: 'bash', toolCallId: 'p:0:bash' })
  }
  const [pre, ask, post] = lines()
  expect(pre).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
  expect(ask).toMatchObject({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: pre.tool_use_id })
  expect(post).toMatchObject({ hook_event_name: 'PostToolUse', tool_use_id: pre.tool_use_id })
  expect(lines()[3].tool_use_id).not.toBe(pre.tool_use_id)
})

test('two calls asking at once get their own cards, in the order omp asked', async () => {
  const { ctx, fire, lines } = omp()
  await fire('tool_call', { toolName: 'bash', toolCallId: 'a', input: { command: 'first' } })
  await fire('tool_call', { toolName: 'bash', toolCallId: 'b', input: { command: 'second' } })
  await fire('tool_approval_requested', { toolName: 'bash', toolCallId: 'a' })
  await fire('tool_approval_requested', { toolName: 'bash', toolCallId: 'b' })
  await ctx.ui.approve!()
  await ctx.ui.approve!()
  expect(lines().filter(line => line.hook_event_name === 'PermissionRequest').map(line => line.tool_input.command)).toEqual(['first', 'second'])
})

for (const [why, answer] of [['says no', '{"hookSpecificOutput":{"decision":{"behavior":"deny"}}}'], ['answers nothing', ''], ['answers nonsense', 'not json']] as const) {
  test(`a tool stays refused when Shepherdr ${why}`, async () => {
    const { ctx, fire } = omp(answer)
    await fire('tool_call', { toolName: 'bash', toolCallId: 'a', input: { command: 'rm' } })
    await fire('tool_approval_requested', { toolName: 'bash', toolCallId: 'a' })
    expect(await ctx.ui.approve!()).toBe('deny')
  })
}

test('an approval with nothing asked is refused', async () => {
  const { ctx, fire } = omp()
  await fire('tool_call', { toolName: 'bash', toolCallId: 'a', input: {} })
  await fire('tool_approval_requested', { toolName: 'bash', toolCallId: 'a' })
  await ctx.ui.approve!()
  expect(await ctx.ui.approve!()).toBe('deny')
})

test('a subagent, with no UI, says nothing about the task', async () => {
  const { ctx, fire, lines } = omp()
  const sub = { ...ctx, hasUI: false, sessionManager: { getSessionId: () => 'sub', getSessionFile: () => '/sub.jsonl' } }
  await fire('session_start', {}, sub)
  await fire('agent_start', {}, sub)
  await fire('tool_call', { toolName: 'bash', toolCallId: 'a', input: {} }, sub)
  await fire('tool_result', { toolName: 'bash', toolCallId: 'a' }, sub)
  await fire('agent_end', {}, sub)
  await fire('session_shutdown', {}, sub)
  expect(lines()).toEqual([])
})

test('its question box, on a screen the human never reads, is refused for the chat card', async () => {
  const { fire, lines } = omp()
  expect(await fire('tool_call', { toolName: 'ask', toolCallId: 'a', input: {} })).toMatchObject({ block: true, reason: expect.stringContaining('shepherdr ask') })
  expect(lines()).toEqual([])
})
