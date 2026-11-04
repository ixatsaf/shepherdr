import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreAgents, ompApprovalMode } from '../server/core/agents.ts'
import { CoreStore } from '../server/core/store.ts'
import type { CoreAgent } from '../server/core/model.ts'
import type { CoreSession } from '../server/core/session.ts'
import type { Mailbox } from '../server/core/mailbox.ts'

test('late hooks cannot overwrite a replacement agent or erase its confirmed terminal', () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-agent-race-'))
  const store = new CoreStore(home)
  try {
    const agents = new CoreAgents({ home, port: 17887, session: 'test', socket: '/unused', binary: 'hc' },
      { format: 'shepherdr-core', schema: 1, id: 'installation' }, {} as CoreSession, store, {} as Mailbox, async () => undefined, () => {})
    const first: CoreAgent = { chat: 'chat', space: 'space', machine: 'machine', role: 'coordinator', kind: 'claude', launch: 'launch-one', grant: 'grant-one', hook: '/one', started: 1, state: 'starting' }
    store.set('agent', 'chat', first)
    // A hook file read began before terminal.run confirmed the terminal.
    store.set('agent', 'chat', { ...first, terminal: 't1' })
    agents.hook(first, { id: 'event-one', event: 'SessionStart', at: 2, session: 'native-one', model: 'reported-model' })
    expect(first.model).toBeUndefined()
    expect(agents.get('chat')?.runtime).toMatchObject({ model: 'reported-model', source: 'hook', at: 2 })
    expect(agents.get('chat')).toMatchObject({ terminal: 't1', session: 'native-one', state: 'idle' })
    agents.hook(first, { id: 'new-stop', event: 'Stop', at: 20, session: 'latest', transcript: '/latest' })
    agents.hook(first, { id: 'old-start', event: 'UserPromptSubmit', at: 10, session: 'older', transcript: '/older' })
    expect(agents.get('chat')).toMatchObject({ state: 'idle', activityAt: 20, session: 'latest', transcript: '/latest' })
    const replacement: CoreAgent = { ...first, kind: 'codex', launch: 'launch-two', grant: 'grant-two', terminal: 't2', hook: '/two', state: 'working' }
    store.set('agent', 'chat', replacement)
    agents.hook(first, { id: 'event-late', event: 'SessionEnd', at: 3, session: 'old-native' })
    expect(agents.get('chat')).toEqual(replacement)
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('the end of a session that never began leaves its start unfinished', () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-agent-end-'))
  const store = new CoreStore(home)
  try {
    const agents = new CoreAgents({ home, port: 17887, session: 'test', socket: '/unused', binary: 'hc' },
      { format: 'shepherdr-core', schema: 1, id: 'installation' }, {} as CoreSession, store, {} as Mailbox, async () => undefined, () => {})
    const record: CoreAgent = { chat: 'chat', space: 'space', machine: 'machine', role: 'coordinator', kind: 'claude', launch: 'launch', grant: 'grant', hook: '/one', started: 1, state: 'starting', session: 'gone' }
    store.set('agent', 'chat', record)
    agents.hook(record, { id: 'end', event: 'SessionEnd', at: 2, session: 'gone' })
    expect(agents.get('chat')?.state).toBe('starting')
    agents.hook(record, { id: 'start', event: 'SessionStart', at: 3, session: 'gone' })
    agents.hook(record, { id: 'end-two', event: 'SessionEnd', at: 4, session: 'gone' })
    expect(agents.get('chat')?.state).toBe('idle')
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('terminal confirmation preserves hooks received while terminal.run was pending', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-agent-start-'))
  const store = new CoreStore(home)
  try {
    let agents: CoreAgents
    const core = { call: async (_method: string, input: { argv: string[] }) => {
      expect(input.argv).not.toContain('--dangerously-bypass-hook-trust')
      const record = agents.get('chat')!
      agents.hook(record, { id: 'fast-hook', event: 'SessionStart', at: Date.now(), session: 'native-session', transcript: '/native.jsonl' })
      return { address: 't1', pid: 123 }
    } } as unknown as CoreSession
    const mailbox = { issue: () => ({ id: 'grant', credential: { version: 1, grant: 'grant', server: 'server', machine: 'machine', key: '' } }) } as unknown as Mailbox
    agents = new CoreAgents({ home, port: 17887, session: 'test', socket: '/unused', binary: 'hc' },
      { format: 'shepherdr-core', schema: 1, id: 'installation' }, core, store, mailbox, async () => undefined, () => {})
    const result = await agents.launch({ id: 'space', name: 'Example', machine: 'machine', folder: '/unused', base: 'main', prefix: 'EX', mode: 'regular', added: 1 }, 'chat', 'codex', 'hello')
    expect(result).toMatchObject({ terminal: 't1', pid: 123, state: 'idle', session: 'native-session', transcript: '/native.jsonl' })
    agents.hook(result, { id: 'answered-permission', event: 'PermissionRequest', at: Date.now() })
    expect(agents.get('chat')?.permission).toBeUndefined()
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})


test('read-only Codex reviewers capture native JSON events without bypassing hook trust', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-review-start-')), store = new CoreStore(home)
  try {
    let argv: string[] = []
    const core = { call: async (_method: string, input: { argv: string[] }) => { argv = input.argv; return { address: 't1', pid: 123 } } } as unknown as CoreSession
    const mailbox = { issue: () => ({ id: 'review-grant', credential: {} }) } as unknown as Mailbox
    const agents = new CoreAgents({ home, port: 17887, session: 'test', socket: '/unused', binary: 'hc' },
      { format: 'shepherdr-core', schema: 1, id: 'installation' }, core, store, mailbox, async () => undefined, () => {})
    const result = await agents.launch({ id: 'space', name: 'Example', machine: 'machine', folder: '/unused', base: 'main', prefix: 'EX', mode: 'regular', added: 1 },
      'TASK-1/Reviewer-1', 'codex', 'Review only', { role: 'reviewer', readOnly: true })
    expect(argv[1]).toEndWith('/helper/core-review.ts')
    const launch = JSON.parse(readFileSync(argv[2], 'utf8'))
    expect(launch.argv.slice(0, 5)).toEqual(['codex', 'exec', '--json', '--sandbox', 'read-only'])
    expect(launch.argv).not.toContain('--dangerously-bypass-hook-trust')
    expect(launch.argv).not.toContain('sandbox_workspace_write.network_access=true')
    expect(launch.argv.some((word: string) => word.startsWith('hooks.'))).toBe(false)
    expect(result).toMatchObject({ transcript: launch.log, transcriptFormat: 'codex-exec', state: 'working' })
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('a picked speed reaches each CLI in its own words, for that launch only', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-speed-start-')), store = new CoreStore(home)
  try {
    let argv: string[] = [], count = 0
    const core = { current: { terminals: new Map() }, call: async (_method: string, input: { argv: string[] }) => { argv = input.argv; return { address: `t${++count}`, pid: count } } } as unknown as CoreSession
    const mailbox = { issue: () => ({ id: `speed-grant-${count}`, credential: {} }) } as unknown as Mailbox
    const agents = new CoreAgents({ home, port: 0, session: 'test', socket: '/unused', binary: 'hc' }, { format: 'shepherdr-core', schema: 1, id: 'installation' }, core, store, mailbox, async () => undefined, () => {})
    const space = { id: 'space', name: 'Example', machine: 'machine', folder: '/unused', base: 'main', prefix: 'EX', mode: 'regular' as const, added: 1 }
    const start = async (chat: string, kind: 'claude' | 'codex', speed?: string) => { await agents.launch(space, chat, kind, 'Wait', { speed }); return argv.join(' ') }
    expect(await start('a', 'claude', 'fast')).toContain('--fast-mode on')
    expect(await start('b', 'claude', 'normal')).toContain('--fast-mode off')
    expect(await start('c', 'claude')).not.toContain('--fast-mode')
    expect(await start('d', 'codex', 'fast')).toContain('service_tier="fast"')
    expect(await start('e', 'codex', 'normal')).toContain('service_tier="default"')
    expect(await start('f', 'codex')).not.toContain('service_tier')
    expect(store.get('agent', 'd')).toMatchObject({ speed: 'fast' })
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('ordinary replacement preserves both private launch identities for later descendant cleanup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-ordinary-history-')), store = new CoreStore(home)
  try {
    const terminals = new Map<string, import('../server/core/protocol.ts').CoreTerminal>()
    let count = 0, launchWords: string[] = []
    const core = { current: { terminals }, call: async (_method: string, input: { labels: Record<string, string>; argv: string[] }) => {
      launchWords = input.argv
      const address = `t${++count}`, terminal = { address, labels: input.labels, pid: count * 10, state: 'live', created_ms: count } as import('../server/core/protocol.ts').CoreTerminal
      terminals.set(address, terminal); return terminal
    } } as unknown as CoreSession
    const mailbox = { issue: () => ({ id: `grant-${count}`, credential: {} }) } as unknown as Mailbox
    const agents = new CoreAgents({ home, port: 0, session: 'test', socket: '/unused', binary: 'hc' }, { format: 'shepherdr-core', schema: 1, id: 'installation' }, core, store, mailbox, async () => undefined, () => {})
    const space = { id: 'space', name: 'Example', machine: 'machine', folder: '/unused', base: 'main', prefix: 'EX', mode: 'regular' as const, added: 1 }
    const first = await agents.launch(space, 'EX-1/Agent', 'codex', 'Wait', { role: 'task', task: 'EX-1' })
    terminals.get(first.terminal!)!.state = 'finished'
    first.session = 'native-session'; store.set('agent', first.chat, first)
    const second = await agents.launch(space, first.chat, 'codex', 'Wait', { role: 'task', task: 'EX-1', resume: true })
    expect(launchWords.at(-1)).toContain(`Your current owning authenticated command is ${second.command}`)
    expect(launchWords.at(-1)).toContain('replaces every helper path in earlier conversation history')
    expect(launchWords.at(-1)).not.toContain('credential.json')
    expect(first.launch).not.toBe(second.launch)
    expect(store.get('agent-launch', first.launch)).toMatchObject({ terminal: 't1', pid: 10, role: 'task' })
    expect(store.get('agent-launch', second.launch)).toMatchObject({ terminal: 't2', pid: 20, role: 'task' })
    expect(store.all('pilot-capture')).toHaveLength(0)
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

for (const kind of ['claude', 'codex'] as const) test(`${kind} coordinator launch includes house rules, full role guide and authoritative core routing`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-agent-guide-')), store = new CoreStore(home)
  try {
    let argv: string[] = [], env: Record<string, string> = {}
    const core = { call: async (_method: string, input: { argv: string[]; env: Record<string, string> }) => { argv = input.argv; env = input.env; return { address: 't1', pid: 123 } } } as unknown as CoreSession
    const mailbox = { issue: () => ({ id: 'guide-grant', credential: {} }) } as unknown as Mailbox
    store.set('meta', 'local', { id: 'machine' })
    const agents = new CoreAgents({ home, port: 17887, session: 'test', socket: '/unused', binary: 'hc' },
      { format: 'shepherdr-core', schema: 1, id: 'installation' }, core, store, mailbox, async () => undefined, () => {})
    await agents.launch({ id: 'home', name: '~', home: true, machine: 'machine', folder: '/unused', base: 'main', prefix: 'EX', mode: 'regular', added: 1 }, 'home', kind, 'Wait')
    const words = kind === 'claude' ? readFileSync(argv[argv.indexOf('--append-system-prompt-file') + 1], 'utf8') : JSON.parse(argv.find(word => word.startsWith('developer_instructions='))!.slice('developer_instructions='.length)) as string
    expect(words).toContain('# Shepherdr coordinator')
    expect(words).toContain('### Chat lines you receive')
    expect(words).toContain('The main machine\'s home space')
    expect(words).toContain('Your role is the main machine’s home coordinator')
    expect(words).toContain('repeat with `--after`')
    expect(words).toContain(`Your authoritative authenticated command is ${env.SHEPHERDR_COMMAND}`)
    expect(words).toContain('Never borrow another launch’s credential')
    expect(words).not.toContain('which uses `helper/main.sock`')
    expect(env.SHEPHERDR_CORE_CREDENTIAL).toBe(join(home, 'sessions/guide-grant.credential.json'))
    if (kind === 'codex') {
      expect(argv.some(word => word.startsWith('shell_environment_policy.set=') && word.includes(env.SHEPHERDR_CORE_CREDENTIAL))).toBe(true)
      expect(argv).not.toContain('--sandbox')
      expect(argv).not.toContain('--ask-for-approval')
      expect(argv.some(word => word.startsWith('sandbox_workspace_write.'))).toBe(false)
      expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')
      expect(argv.some(word => word.startsWith('hooks.PermissionRequest='))).toBe(true)
    } else {
      expect(argv).not.toContain('--permission-mode')
      expect(argv).not.toContain('--dangerously-skip-permissions')
    }
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('Oh My Pi starts as a task with its extension, and nowhere else', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-omp-start-')), store = new CoreStore(home)
  try {
    let run: { argv: string[]; env: Record<string, string> } | undefined, count = 0
    const core = { current: { terminals: new Map() }, call: async (_method: string, input: { argv: string[]; env: Record<string, string> }) => { run = input; return { address: `t${++count}`, pid: count } } } as unknown as CoreSession
    const mailbox = { issue: () => ({ id: `omp-grant-${count}`, credential: {} }), revoke: () => {} } as unknown as Mailbox
    const route = async (machine: string) => machine === 'remote' ? 'remote' : undefined
    const agents = new CoreAgents({ home, port: 0, session: 'test', socket: '/unused', binary: 'hc' }, { format: 'shepherdr-core', schema: 1, id: 'installation' }, core, store, mailbox, route, () => {})
    const space = { id: 'space', name: 'Example', machine: 'machine', folder: '/unused', base: 'main', prefix: 'EX', mode: 'regular' as const, added: 1 }
    await agents.launch(space, 'task', 'omp', 'Go', { role: 'task', model: 'p/m', effort: 'high' })
    expect(run!.argv[0]).toBe('omp')
    expect(run!.argv.slice(-2)).toEqual(['--', 'Go'])
    expect(run!.argv.join(' ')).toContain('--model p/m --thinking high')
    expect(run!.argv[run!.argv.indexOf('--hook') + 1]).toEndWith('helper/core-omp-hook.ts')
    expect(readFileSync(run!.argv[run!.argv.indexOf('--append-system-prompt') + 1], 'utf8')).toContain('Your role is task')
    expect(run!.env.SHEPHERDR_OMP_HOOK).toContain('helper/core-hook.ts')
    expect(run!.argv).toContain('--approval-mode')
    expect(run!.env.SHEPHERDR_CORE_HOOK_FILE).toBeTruthy()
    count = 0
    const refused = async (promise: Promise<unknown>) => expect(promise).rejects.toThrow('only as a task agent')
    await refused(agents.launch(space, 'coordinator', 'omp', 'Go'))
    await refused(agents.launch(space, 'reviewer', 'omp', 'Go', { role: 'reviewer', readOnly: true }))
    await refused(agents.launch(space, 'pilot', 'omp', 'Go', { role: 'task', pilot: { run: 'r', hosts: [], repo: 'x' } }))
    await refused(agents.launch({ ...space, machine: 'remote' }, 'far', 'omp', 'Go', { role: 'task' }))
    expect(count).toBe(0)
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('only the card says an Oh My Pi task waits on a permission; its own word for the rest still counts', () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-omp-status-')), store = new CoreStore(home)
  try {
    const labels = { 'shepherdr.installation': 'installation', 'shepherdr.launch': 'launch' }
    const terminals = new Map<string, unknown>()
    const agents = new CoreAgents({ home, port: 0, session: 'test', socket: '/unused', binary: 'hc' }, { format: 'shepherdr-core', schema: 1, id: 'installation' }, { current: { terminals } } as unknown as CoreSession, store, {} as Mailbox, async () => undefined, () => {})
    const agent: CoreAgent = { chat: 'chat', space: 'space', machine: 'machine', role: 'task', kind: 'omp', launch: 'launch', grant: 'grant', hook: '/hook', terminal: 't1', started: 1, state: 'working' }
    terminals.set('t1', { address: 't1', labels, status: { state: 'blocked', kind: 'permission', msg: 'Allow tool: bash' } })
    expect(agents.terminal(agent)?.status).toBeNull()
    expect(agents.terminal({ ...agent, kind: 'claude' })?.status?.state).toBe('blocked')
    terminals.set('t1', { address: 't1', labels, status: { state: 'blocked', kind: 'question' } })
    expect(agents.terminal(agent)?.status?.state).toBe('blocked')
    terminals.set('t1', { address: 't1', labels, status: { state: 'done' } })
    expect(agents.terminal(agent)?.status?.state).toBe('done')
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('an Oh My Pi task keeps the approval mode its human chose, and asks where none is chosen', () => {
  const config = (value: unknown) => JSON.stringify({ 'tools.approvalMode': { value, type: 'enum' } })
  expect(ompApprovalMode(config('always-ask'))).toBe('always-ask')
  expect(ompApprovalMode(config('yolo'))).toBe('yolo')
  for (const unset of ['{}', '', 'not json', config('odd')]) expect(ompApprovalMode(unset)).toBe('write')
})

