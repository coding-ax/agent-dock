import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeStore } from 'acpx/runtime';
import { AcpxAdapter, buildAcpxSessionOptions, normalizeAcpxEvent, renderAgentCommand, resolveTurnTimeouts } from './index.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe('turn idle timeouts', () => {
  it('caps the tool-call window at 30 minutes for the shared default timeout of 600s', () => {
    // 共享默认 timeout=600（packages/shared/src/index.ts）。此前实现为 idle*30，
    // 得到 18,000,000ms（5 小时），与注释所称的 30 分钟不符。
    const { idle, toolCall } = resolveTurnTimeouts(600);
    expect(idle).toBe(600_000);
    expect(toolCall).toBe(30 * 60_000);
    expect(toolCall).not.toBe(600_000 * 30);
  });

  it('never scales the stuck-tool window up as the configured timeout shrinks', () => {
    // 配小 timeout 是为了更快失败，不能反而拉长卡死窗口。
    const short = resolveTurnTimeouts(60);
    const long = resolveTurnTimeouts(600);
    expect(short.idle).toBeLessThan(long.idle);
    expect(short.toolCall).toBeLessThanOrEqual(long.toolCall);
    expect(short.toolCall).toBe(30 * 60_000);
  });

  it('lets an idle timeout longer than 30 minutes win', () => {
    const { idle, toolCall } = resolveTurnTimeouts(45 * 60);
    expect(idle).toBe(45 * 60_000);
    expect(toolCall).toBe(45 * 60_000);
  });
});

describe('acpx ACP boundary', () => {
  it('switches to a newly advertised model when the persisted catalog is stale', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-stale-model-catalog-')); dirs.push(cwd);
    const fixture = join(cwd, 'agent.mjs');
    await writeFile(fixture, `import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const options = currentValue => [{ id: 'model', category: 'model', currentValue, options: ['model-a', 'model-b'].map(value => ({ value, name: value })) }];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [] } });
  if (method === 'session/new' || method === 'session/load') return send({ jsonrpc: '2.0', id, result: { sessionId: params.sessionId || 'model-session', configOptions: options('model-a') } });
  if (method === 'session/set_config_option') return send(params.value === 'model-b'
    ? { jsonrpc: '2.0', id, result: { configOptions: options('model-b') } }
    : { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unsupported model' } });
});`);
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, model: 'model-a', permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { sessionKey: 'stale-model-catalog', onEvent() {} });
    try {
      await adapter.start();
      const store = createRuntimeStore({ stateDir: join(cwd, '.agentdock', 'acpx') });
      const record = (await store.load('stale-model-catalog'))!;
      record.acpx!.config_options!.find(option => option.id === 'model')!.options = [{ value: 'model-a', name: 'model-a' }];
      await store.save(record);
      await expect(adapter.setModel('model-b')).resolves.toBeUndefined();
      expect(adapter.agent.model).toBe('model-b');
    } finally { await adapter.stop({ discardSession: true }); }
  });

  it('applies Codex full access before prompts and restores or revokes it across persistent sessions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-codex-mode-')); dirs.push(cwd);
    const log = join(cwd, 'requests.jsonl');
    const agent = { id: 'codex', name: 'Codex', command: process.execPath, args: [resolve('tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp' as const, cwd, env: { mock_echo_mode: '1', mock_request_log: log }, permissionMode: 'full-trust' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
    const events: any[] = [];
    const options = { sessionKey: 'codex-mode-regression', onEvent: (event: any) => events.push(event) };
    const adapter = new AcpxAdapter(agent, options);
    try {
      await adapter.start();
      await adapter.send('first');
      await adapter.stop();
      await adapter.resume();
      await adapter.send('resumed');
      adapter.setPermissionMode('ask');
      await adapter.send('restricted');
      expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual([
        'Mock reply: first mode=agent-full-access', 'Mock reply: resumed mode=agent-full-access', 'Mock reply: restricted mode=read-only'
      ]);
    } finally { await adapter.stop(); }
    // 同一个持久化会话以更低权限重新打开，也不得继承旧的 full-access。
    const restricted = new AcpxAdapter({ ...agent, permissionMode: 'deny-all' }, options);
    try { await restricted.start(); await restricted.send('reopened'); }
    finally { await restricted.stop(); }
    expect(events.filter(event => event.type === 'text').at(-1)?.data.text).toContain('mode=read-only');
    let mode = 'agent';
    for (const request of (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))) {
      if (request.method === 'session/set_mode') mode = request.params.modeId;
      if (request.method === 'session/prompt') {
        const text = request.params.prompt[0].text;
        expect(mode).toBe(['first', 'resumed'].includes(text) ? 'agent-full-access' : 'read-only');
      }
    }
  });

  it('fails without sending a Codex prompt when the permission mode is rejected', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-codex-mode-rejected-')); dirs.push(cwd);
    const log = join(cwd, 'requests.jsonl');
    const adapter = new AcpxAdapter({ id: 'codex', name: 'Codex', command: process.execPath, args: [resolve('tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp', cwd, env: { mock_reject_mode: '1', mock_request_log: log }, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: () => {} });
    try { await expect(adapter.send('must not execute')).rejects.toThrow('无法将 Codex 权限模式设为 agent-full-access'); }
    finally { await adapter.stop(); }
    expect(await readFile(log, 'utf8')).not.toContain('session/prompt');
  });

  it('initializes a custom Mock ACP agent and streams normalized events', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-acp-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock ACP', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: e => events.push(e) });
    await adapter.start();
    await adapter.send('hello');
    expect(events.some(e => e.type === 'thinking')).toBe(true);
    expect(events.some(e => e.type === 'tool_call' && e.data.id === 'mock-tool-1')).toBe(true);
    expect(events.some(e => e.type === 'tool_result' && e.data.id === 'mock-tool-1')).toBe(true);
    expect(events.some(e => e.type === 'text' && e.data.text.includes('Mock reply'))).toBe(true);
    await adapter.stop();
  });

  it('treats timeout as inactivity and lets an active turn exceed its configured duration', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-acp-active-timeout-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock ACP', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'deny-all', timeout: 2, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: event => events.push(event) });
    await adapter.start();
    await expect(adapter.send('active longer than timeout')).resolves.toBeUndefined();
    expect(events.filter(event => event.type === 'thinking')).toHaveLength(3);
    expect(events.some(event => event.type === 'text' && event.data.text === 'long task completed')).toBe(true);
    await adapter.stop();
  });

  it('maps ACP cancel to acpx cancel and retains the session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-cancel-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent() {} });
    await adapter.start(); await adapter.interrupt(); await adapter.resume(); await adapter.stop();
  });

  it('resolves a live ACP permission request from an external Web decision', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-permission-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'); const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: e => events.push(e) });
    await adapter.start(); const sending = adapter.send('request permission');
    await expect.poll(() => events.find(e => e.type === 'permission_request')?.data.id).toBe('permission-tool');
    expect(await adapter.resolvePermission('permission-tool', true)).toBe(true); await sending;
    expect(events.some(e => e.type === 'text' && e.data.text.includes('selected'))).toBe(true); await adapter.stop();
  });

  it('auto-approves ACP permission requests in full-trust mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-full-trust-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'); const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: event => events.push(event) });
    await adapter.start(); await adapter.send('request permission');
    expect(events.some(event => event.type === 'text' && event.data.text.includes('selected'))).toBe(true);
    expect(events.some(event => event.type === 'permission_request')).toBe(false);
    await adapter.stop();
  });

  it('rejects a matching ACP permission before it reaches the Web approval UI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-risk-gate-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'); const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: event => events.push(event) });
    adapter.setRiskPolicy({ enabled: true, authorized: false, pattern: 'Edit\\s+a\\s+file', actorEmail: 'user@example.com' });
    await adapter.start();
    await adapter.send('request permission');
    expect(events).toContainEqual(expect.objectContaining({ type: 'permission_request', data: expect.objectContaining({ id: 'permission-tool', status: 'rejected', title: expect.stringContaining('AgentDock') }) }));
    expect(events.some(event => event.type === 'permission_request' && event.data.status === 'pending')).toBe(false);
    expect(await adapter.resolvePermission('permission-tool', true)).toBe(false);
    await adapter.stop();
  });

  it('hard-stops an active turn even while permission is pending', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-hard-stop-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'); const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: event => events.push(event) });
    await adapter.start(); const sending = adapter.send('request permission');
    await expect.poll(() => events.some(event => event.type === 'permission_request')).toBe(true);
    await expect(adapter.stop()).resolves.toBeUndefined();
    await expect(sending).resolves.toBeUndefined();
  });

  it('recreates a persistent ACP session when the agent no longer recognizes its id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-stale-session-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const config = { id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp' as const, cwd, env: { mock_acp_reject_unknown_load: '1' }, permissionMode: 'deny-all' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
    const first = new AcpxAdapter(config, { sessionKey: 'same-agentdock-session', onEvent() {} });
    await first.start(); await first.stop();
    const second = new AcpxAdapter(config, { sessionKey: 'same-agentdock-session', onEvent() {} });
    await expect(second.start()).resolves.toBeUndefined();
    await expect(second.send('after stale session')).resolves.toBeUndefined();
    await second.stop();
  });

  // 线上事故：配置里存了 Agent 不支持的模型（"auto_model/alwaysday1"，实际只有 "alwaysday1"），
  // acpx 直接拒绝建会话 → 整个 Session 起不来。而模型列表本身要靠这个 Agent 才能查，
  // 用户被锁死在「改不了配置」里。一个写错的模型配置不该让机器人彻底不可用。
  it('falls back to the agent default model instead of failing to start on an unadvertised model', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-bad-model-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const events: any[] = [];
    const adapter = new AcpxAdapter(
      { id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, model: 'auto_model/does-not-exist', permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false },
      { onEvent: event => events.push(event) }
    );
    await expect(adapter.start()).resolves.toBeUndefined();
    const fallback = events.find(event => event.type === 'status' && event.data?.state === 'model_fallback');
    expect(fallback?.data).toMatchObject({ rejectedModel: 'auto_model/does-not-exist' });
    expect(fallback?.data?.message).toContain('auto_model/does-not-exist');
    // 退回默认模型后会话可用，而不是整个 Session 失败。
    await expect(adapter.send('still works')).resolves.toBeUndefined();
    await adapter.stop();
  });

  it('does not silently replace an explicit Codex model if the adapter still rejects it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-codex-rejected-model-')); dirs.push(cwd);
    const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'codex', name: 'Codex', command: process.execPath, args: [resolve('tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp', cwd, env: {}, model: 'gateway-selected', permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { sessionKey: `codex-rejected-${crypto.randomUUID()}`, onEvent: event => events.push(event) });
    try {
      await expect(adapter.start()).rejects.toThrow();
      expect(events.some(event => event.data?.state === 'model_fallback')).toBe(false);
    } finally { await adapter.stop({ discardSession: true }); }
  });

  it('safely renders configurable custom agent argv', () => {
    const command = renderAgentCommand({ id: 'trae', name: 'Trae', command: '/path/with space/trae', args: ['--acp', "it's-safe"], protocol: 'acp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false });
    expect(command).toContain("'/path/with space/trae'");
    expect(command).toContain("'it'\\''s-safe'");
  });

  it('passes the selected model into ACP session creation options', () => {
    expect(buildAcpxSessionOptions({ ...agentConfig(), model: 'model-selected-in-web' })).toMatchObject({ model: 'model-selected-in-web' });
  });

  it('persists the system prompt with ACPX keys and reuses it for the same session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-system-prompt-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const sessionKey = 'system-prompt-session';
    const base = { ...agentConfig(), cwd, command: process.execPath, args: [fixture] };
    const first = new AcpxAdapter({ ...base, systemPrompt: 'original session prompt' }, { sessionKey, onEvent() {} });
    await first.start(); await first.stop();

    const store = createRuntimeStore({ stateDir: join(cwd, '.agentdock', 'acpx') });
    expect((await store.load(sessionKey))?.acpx?.session_options?.system_prompt).toBe('original session prompt');

    const restored = new AcpxAdapter({ ...base, systemPrompt: 'new global prompt' }, { sessionKey, onEvent() {} });
    await restored.start(); await restored.stop();
    expect((await store.load(sessionKey))?.acpx?.session_options?.system_prompt).toBe('original session prompt');
  });

  it('preserves uppercase and mixed-case environment names across persistent sessions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-env-case-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const sessionKey = 'case-sensitive-environment';
    const env = { AGENTDOCK_TEST_UPPER: 'VaLuE=中文', AgentDock_Test_Mixed: 'MiXeD', agentdock_test_lower: 'lower' };
    const base = { ...agentConfig(), cwd, command: process.execPath, args: [fixture] };
    const events: any[] = [];
    const first = new AcpxAdapter({ ...base, env }, { sessionKey, onEvent: event => events.push(event) });
    try {
      await first.start(); await first.send('inspect test environment');
      expect(JSON.parse(events.filter(event => event.type === 'text').map(event => event.data.text).join(''))).toEqual(env);
    } finally { await first.stop(); }
    const store = createRuntimeStore({ stateDir: join(cwd, '.agentdock', 'acpx') });
    expect((await store.load(sessionKey))?.acpx?.session_options?.env).toEqual(env);
    events.length = 0;
    // A new adapter process restores the saved environment, not the old child.
    const restored = new AcpxAdapter({ ...base, env: {} }, { sessionKey, onEvent: event => events.push(event) });
    try {
      await restored.start(); await restored.send('inspect test environment');
      expect(JSON.parse(events.filter(event => event.type === 'text').map(event => event.data.text).join(''))).toEqual(env);
    } finally { await restored.stop(); }
    expect((await store.load(sessionKey))?.acpx?.session_options?.env).toEqual(env);
  });

  it('persists AgentDock group capability environment with snake_case keys', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-group-env-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const adapter = new AcpxAdapter({
      ...agentConfig(), cwd, command: process.execPath, args: [fixture],
      env: { agentdock_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', agentdock_group_tools_token: 'scoped-token' }
    }, { sessionKey: 'group-capability-session', onEvent() {} });
    await expect(adapter.start()).resolves.toBeUndefined();
    await adapter.stop();
  });

  it('recreates a persisted ACP session once when its scoped group capability changes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-group-env-refresh-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const sessionKey = 'group-capability-refresh-session';
    const base = { ...agentConfig(), cwd, command: process.execPath, args: [fixture] };
    const first = new AcpxAdapter({
      ...base,
      env: { agentdock_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', agentdock_group_tools_token: 'legacy-random-token' }
    }, { sessionKey, onEvent() {} });
    await first.start(); await first.stop();
    const store = createRuntimeStore({ stateDir: join(cwd, '.agentdock', 'acpx') });
    expect((await store.load(sessionKey))?.acpx?.session_options?.env?.agentdock_group_tools_token).toBe('legacy-random-token');

    const second = new AcpxAdapter({
      ...base,
      env: { agentdock_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', agentdock_group_tools_token: 'v1.stable-token' }
    }, { sessionKey, onEvent() {} });
    await second.start(); await second.stop();
    expect((await store.load(sessionKey))?.acpx?.session_options?.env?.agentdock_group_tools_token).toBe('v1.stable-token');
  });

  it('normalizes raw ACP session/update envelopes', () => {
    expect(normalizeAcpxEvent({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Trae says hi' } } } })).toMatchObject({ type: 'text', data: { text: 'Trae says hi' } });
    expect(normalizeAcpxEvent({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'pwd' } } })).toMatchObject({ type: 'tool_call', data: { id: 'tool-1', status: 'running' } });
    expect(normalizeAcpxEvent({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' } } })).toMatchObject({ type: 'tool_result', data: { id: 'tool-1', status: 'completed' } });
    expect(normalizeAcpxEvent({ type: 'status', tag: 'usage_update', used: 1200, size: 200000, breakdown: { totalTokens: 1300 } })).toEqual({ type: 'status', data: { state: 'usage', used: 1200, size: 200000, breakdown: { totalTokens: 1300 }, cost: undefined } });
    expect(normalizeAcpxEvent({ type: 'status', tag: 'available_commands_update', availableCommands: [{ name: 'compact' }] })).toEqual({ type: 'status', data: { state: 'commands', availableCommands: [{ name: 'compact' }] } });
  });

  it('maps context-compaction banners to status events instead of agent messages', () => {
    const chunk = (text: string) => ({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    expect(normalizeAcpxEvent(chunk('Compacting...'))).toEqual({ type: 'status', data: { state: 'compaction', phase: 'start' } });
    expect(normalizeAcpxEvent(chunk('\n\nCompacting completed.'))).toEqual({ type: 'status', data: { state: 'compaction', phase: 'completed' } });
    expect(normalizeAcpxEvent(chunk('\n\nCompacting failed: context window exceeded'))).toEqual({ type: 'status', data: { state: 'compaction', phase: 'failed', detail: 'context window exceeded' } });
    // 普通回复文本不应被误判为压缩横幅。
    expect(normalizeAcpxEvent(chunk('Compacting the workspace is done.'))).toMatchObject({ type: 'text', data: { text: 'Compacting the workspace is done.' } });
  });

  it('maps cursor-agent stream errors to status instead of assistant text', () => {
    const chunk = (text: string) => ({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    expect(normalizeAcpxEvent(chunk('\n\nError: RetriableError: WritableIterable is closed'))).toEqual({
      type: 'status', data: { state: 'agent_stream_error', detail: 'Error: RetriableError: WritableIterable is closed' }
    });
    expect(normalizeAcpxEvent(chunk('Error: T: WritableIterable is closed'))).toMatchObject({ type: 'status', data: { state: 'agent_stream_error' } });
    expect(normalizeAcpxEvent(chunk('排查一下 Error: RetriableError: WritableIterable is closed'))).toMatchObject({
      type: 'text', data: { text: '排查一下 Error: RetriableError: WritableIterable is closed' }
    });
  });
});

function agentConfig() {
  return { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp' as const, env: {}, permissionMode: 'ask' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
}

describe('会话名采集', () => {
  /** 起一个用 mock agent 的会话；`title` 会通过环境变量让 mock 走 session_info_update。 */
  const bootAdapter = async (sessionKey: string, title?: string) => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-session-title-')); dirs.push(cwd);
    const events: any[] = [];
    const adapter = new AcpxAdapter(
      { id: 'mock', name: 'Mock', command: process.execPath, args: [resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp', cwd, env: title ? { mock_acp_session_title: title } : {}, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false },
      { sessionKey, onEvent: event => events.push(event) }
    );
    return { adapter, cwd, events, titles: () => events.filter(event => event.type === 'session_title').map(event => event.data.title) };
  };

  // 这条走的是完整真实链路：mock agent 推 session_info_update → acpx 落进会话记录
  // → 适配层在轮次收尾读出来上报。不能靠手写记录文件伪造——acpx 每轮会用内存态重写记录，
  // 手写的标题会在轮次中被它自己覆盖掉（第一版测试就是这么失败的）。
  it('轮次结束后把 acpx 记录里的标题上报出去', async () => {
    const { adapter, titles } = await bootAdapter('title-report', '清理磁盘');
    await adapter.start();
    await adapter.send('清理下电脑磁盘空间');
    // start() 时 agent 还没推过标题，所以只该有一条，且来自轮次收尾。
    expect(titles()).toEqual(['清理磁盘']);
    await adapter.stop();
  });

  it('标题没变不重复上报（Agent 每轮都可能重发同一个名字）', async () => {
    const { adapter, titles } = await bootAdapter('title-dedupe', '同一个名字');
    await adapter.start();
    await adapter.send('第一轮');
    await adapter.send('第二轮');
    expect(titles()).toEqual(['同一个名字']);
    await adapter.stop();
  });

  it('开始一轮前就有的标题在 start() 阶段回填', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentdock-session-title-backfill-')); dirs.push(cwd);
    const config = { id: 'mock', name: 'Mock', command: process.execPath, args: [resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp' as const, cwd, env: {}, permissionMode: 'deny-all' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
    // 先跑一次让记录落盘，再把标题写进去，然后新建 adapter 重新打开同一个会话。
    const first = new AcpxAdapter(config, { sessionKey: 'title-backfill', onEvent() {} });
    await first.start(); await first.stop();
    const store = createRuntimeStore({ stateDir: join(cwd, '.agentdock', 'acpx') });
    const record = (await store.load('title-backfill'))!;
    record.title = '老会话的名字';
    await store.save(record);

    const events: any[] = [];
    const second = new AcpxAdapter(config, { sessionKey: 'title-backfill', onEvent: event => events.push(event) });
    await second.start();
    expect(events.filter(event => event.type === 'session_title').map(event => event.data.title)).toEqual(['老会话的名字']);
    await second.stop();
  });

  it('Agent 没给标题时一条都不上报', async () => {
    const { adapter, titles } = await bootAdapter('title-absent');
    await adapter.start();
    await adapter.send('随便聊聊');
    expect(titles()).toEqual([]);
    await adapter.stop();
  });
});
