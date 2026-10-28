import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import type { AgentConfig, Session } from '@agent-dock/agent-dock-shared';
import { AgentDockRuntime, type AgentDriver } from './index.js';
import { SESSION_TITLE_MAX_CHARS } from './session-title.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };

function harness(options: { onSend?: (emit: (event: any) => void) => void; exitOnSend?: number; driverIdleTimeoutMs?: number; sessionEnvironment?: (session: Session) => Record<string, string>; createSystemPrompt?: (session: Session) => string; sessionPrompt?: (session: Session, prompt: string) => string | Promise<string> } = {}) {
  const repos = createRepositories(':memory:'); let emit!: (event: any) => void; let exit!: (code: number | null) => void; const configuredAgents: AgentConfig[] = [];
  const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => { options.onSend?.(emit); if (options.exitOnSend) exit(options.exitOnSend); }), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}), setModel: vi.fn(async () => {}), setReasoningEffort: vi.fn(async () => {}), setPermissionMode: vi.fn() };
  const runtime = new AgentDockRuntime(repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: (configuredAgent, _p, onEvent, onExit) => { configuredAgents.push(configuredAgent); emit = onEvent; exit = onExit; return driver; }, driverIdleTimeoutMs: options.driverIdleTimeoutMs, sessionEnvironment: options.sessionEnvironment, createSystemPrompt: options.createSystemPrompt, sessionPrompt: options.sessionPrompt });
  return { repos, runtime, driver, configuredAgents, emit: (event: any) => emit(event) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('runtime lifecycle acceptance', () => {
  it('removes stale built-in demo agents during configuration sync', async () => {
    const h = harness();
    await h.repos.agents.save({ ...agent, id: 'mock-acp', name: 'Mock ACP', builtin: true });
    await h.runtime.initialize([agent]);
    expect((await h.runtime.listAgents()).map(item => item.id)).toEqual(['mock']);
    h.repos.close();
  });

  it('starts, streams a prompt, and completes while preserving tool correlation', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'thinking', data: { text: 'think' } }); emit({ type: 'tool_call', data: { id: 't', name: 'read', input: '.', status: 'running' } }); emit({ type: 'tool_result', data: { id: 't', name: 'read', output: 'ok', status: 'completed' } }); emit({ type: 'text', data: { text: 'done' } }); } });
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' }); await h.runtime.send(session.id, 'work');
    expect((await h.runtime.getSession(session.id))?.state).toBe('completed');
    const events = await h.runtime.getEvents(session.id); expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['thinking', 'tool_call', 'tool_result', 'text', 'completed']));
    expect((events.find(e => e.type === 'tool_result')?.data as any).completedAt).toBeTruthy(); h.repos.close();
  });

  it('最后一次对话时间由提问与收尾刷新，纯状态切换不动它', async () => {
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'done' } }) });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    // 新会话还没聊过：留给调用方回退 updatedAt。
    expect((await h.repos.sessions.get(session.id))?.lastMessageAt ?? null).toBeNull();
    await h.runtime.send(session.id, 'work');
    const talked = (await h.repos.sessions.get(session.id))?.lastMessageAt;
    expect(talked).toBeTruthy();
    // 换模型只动 updatedAt；如果这里也跟着变，排序又会退化成「最近动过的」。
    await h.runtime.setModel(session.id, 'other');
    expect((await h.repos.sessions.get(session.id))?.lastMessageAt).toBe(talked);
    h.repos.close();
  });

  it('waits for asynchronously persisted driver events before publishing task completion', async () => {
    const gate = deferred();
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'late final answer' } }) });
    const append = h.repos.events.append.bind(h.repos.events);
    h.repos.events.append = vi.fn(async event => {
      if (event.type === 'text' && (event.data as any)?.text === 'late final answer') await gate.promise;
      await append(event);
    });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    let completed = false;
    const turn = h.runtime.send(session.id, 'work').then(result => { completed = true; return result; });
    await vi.waitFor(() => expect(h.repos.events.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'text', data: expect.objectContaining({ text: 'late final answer' }) })));
    await Promise.resolve();
    expect(completed).toBe(false);
    gate.resolve();
    await turn;
    const events = await h.runtime.getEvents(session.id);
    const finalIndex = events.findIndex(event => event.type === 'text' && (event.data as any)?.text === 'late final answer');
    const terminalTaskIndex = events.findIndex(event => event.type === 'task' && (event.data as any)?.task?.status === 'completed');
    expect(finalIndex).toBeGreaterThanOrEqual(0);
    expect(terminalTaskIndex).toBeGreaterThan(finalIndex);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('passes explicit model and reasoning effort to the Agent driver', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', model: 'model-selected-in-web', reasoningEffort: 'high' });
    expect(session.model).toBe('model-selected-in-web');
    expect(session.reasoningEffort).toBe('high');
    expect(h.configuredAgents[0]?.model).toBe('model-selected-in-web');
    expect(h.configuredAgents[0]?.reasoningEffort).toBe('high');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('archives a session and discards partial driver state when startup fails', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    h.driver.start = vi.fn(async () => { throw new Error('SDK unavailable'); });
    await expect(h.runtime.start({ agentId: 'mock' })).rejects.toMatchObject({ code: 'START_FAILED', statusCode: 503 });
    const [session] = await h.runtime.listSessions();
    expect(session).toMatchObject({ state: 'failed', error: 'SDK unavailable' });
    expect(session?.archivedAt).toBeTruthy();
    expect(h.driver.stop).toHaveBeenCalledWith({ discardSession: true });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('switches the active ACP model and persists the selection between turns', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', model: 'model-a' });
    await expect(h.runtime.setModel(session.id, 'model-b')).resolves.toMatchObject({ model: 'model-b' });
    expect(h.driver.setModel).toHaveBeenCalledWith('model-b');
    expect(await h.runtime.getSession(session.id)).toMatchObject({ model: 'model-b' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('switches reasoning effort without recreating the Session', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', reasoningEffort: 'medium' });
    await expect(h.runtime.setReasoningEffort(session.id, 'high')).resolves.toMatchObject({ reasoningEffort: 'high' });
    expect(h.driver.setReasoningEffort).toHaveBeenCalledWith('high');
    expect(await h.runtime.getSession(session.id)).toMatchObject({ reasoningEffort: 'high', runId: session.runId });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('edits a queued task prompt and persists the update', async () => {
    const gate = deferred();
    const h = harness();
    h.driver.send = vi.fn(async () => { await gate.promise; });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const turn = h.runtime.send(session.id, 'first');
    await vi.waitFor(() => expect(h.runtime.getSession(session.id)).toBeTruthy());
    const queued = await h.runtime.dispatch(session.id, 'draft', 'queue');
    await expect(h.runtime.updateQueued(session.id, queued.id, '  edited  ')).resolves.toMatchObject({ prompt: 'edited' });
    expect((await h.runtime.getTasks(session.id)).find(task => task.id === queued.id)).toMatchObject({ prompt: 'edited' });
    await expect(h.runtime.updateQueued(session.id, 'missing', 'x')).rejects.toMatchObject({ code: 'QUEUED_TASK_NOT_FOUND', statusCode: 404 });
    await expect(h.runtime.updateQueued(session.id, queued.id, '   ')).rejects.toMatchObject({ code: 'INVALID_PROMPT', statusCode: 400 });
    gate.resolve();
    await turn;
    await h.runtime.shutdown(); h.repos.close();
  });

  it('forces complete access even when Agent config or session input requests approval', async () => {
    const h = harness(); await h.runtime.initialize([{ ...agent, permissionMode: 'ask' }]);
    const session = await h.runtime.start({ agentId: 'mock', permissionMode: 'deny-all' });
    expect(session.permissionMode).toBe('full-trust');
    expect(h.configuredAgents[0]?.permissionMode).toBe('full-trust');
    expect((await h.runtime.listAgents())[0]?.permissionMode).toBe('full-trust');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('migrates persisted sessions to complete access during initialization', async () => {
    const h = harness();
    await h.repos.sessions.save({ id: 'ses_old', agentId: 'mock', state: 'idle', cwd: '/tmp', permissionMode: 'ask', runId: 'run_old', createdAt: '', updatedAt: '' });
    await h.runtime.initialize([agent]);
    expect(await h.runtime.getSession('ses_old')).toMatchObject({ permissionMode: 'full-trust' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('marks tasks left running by a previous process as interrupted during initialization', async () => {
    const h = harness();
    const timestamp = new Date().toISOString();
    await h.repos.sessions.save({ id: 'ses_orphaned', agentId: 'mock', state: 'running_tool', cwd: '/tmp', permissionMode: 'full-trust', protocol: 'acp', runId: 'run_old', createdAt: timestamp, updatedAt: timestamp });
    await h.repos.tasks.save({ id: 'task_orphaned', sessionId: 'ses_orphaned', prompt: 'long task', status: 'running', createdAt: timestamp, updatedAt: timestamp });
    await h.runtime.initialize([agent]);
    expect((await h.runtime.getTasks('ses_orphaned'))[0]?.status).toBe('interrupted');
    expect((await h.runtime.getSession('ses_orphaned'))?.state).toBe('interrupted');
    const events = await h.runtime.getEvents('ses_orphaned');
    expect(events.some(e => e.type === 'error' && e.data.message.includes('守护进程重启'))).toBe(true);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('archives incomplete startup sessions left behind by a previous process', async () => {
    const h = harness();
    const timestamp = new Date().toISOString();
    await h.repos.sessions.save({ id: 'ses_starting', agentId: 'mock', state: 'starting', cwd: '/tmp', permissionMode: 'full-trust', protocol: 'acp', runId: 'run_old', createdAt: timestamp, updatedAt: timestamp });
    await h.runtime.initialize([agent]);
    expect(await h.runtime.getSession('ses_starting')).toMatchObject({ state: 'failed', error: expect.stringContaining('未完成启动') });
    expect((await h.runtime.getSession('ses_starting'))?.archivedAt).toBeTruthy();
    await h.runtime.shutdown(); h.repos.close();
  });

  it('persists the source metadata used by external chat channels', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', source: 'lark', sourceId: 'cli_test:oc_chat' });
    expect(await h.runtime.getSession(session.id)).toMatchObject({ source: 'lark', sourceId: 'cli_test:oc_chat' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('injects session-scoped environment without replacing the Agent environment', async () => {
    const h = harness({ sessionEnvironment: current => current.source === 'lark' ? { GROUP_TOKEN: current.id, RESERVED: 'scoped' } : {} });
    await h.runtime.initialize([{ ...agent, env: { KEEP_ME: 'yes', RESERVED: 'agent' } }]);
    const session = await h.runtime.start({ agentId: 'mock', source: 'lark', sourceId: 'cli_test:oc_chat' });
    expect(h.configuredAgents[0]?.env).toEqual({ KEEP_ME: 'yes', RESERVED: 'scoped', GROUP_TOKEN: session.id });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('applies session-scoped prompt context to every entry point without changing persisted user text', async () => {
    const h = harness({ sessionPrompt: (current, prompt) => current.source === 'lark' ? `[group:${current.sourceId}]\n${prompt}` : prompt });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', source: 'lark', sourceId: 'cli_test:oc_chat:group' });
    await h.runtime.dispatch(session.id, 'from web');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('[group:cli_test:oc_chat:group]\nfrom web'));
    expect((await h.runtime.getTasks(session.id))[0]).toMatchObject({ prompt: 'from web', sentPrompt: '[group:cli_test:oc_chat:group]\nfrom web' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('persists the final request with per-turn injection before invoking the Agent', async () => {
    const h = harness({ sessionPrompt: (_session, prompt) => `[runtime context]\n${prompt}` });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', systemPrompt: 'session instructions' });
    h.driver.send = vi.fn(async () => {
      expect((await h.repos.tasks.listBySession(session.id))[0]).toMatchObject({
        prompt: 'visible user message',
        sentPrompt: '[runtime context]\n[bot context]\nvisible user message'
      });
      h.emit({ type: 'text', data: { text: 'done' } });
    });
    await h.runtime.send(session.id, 'visible user message', '[bot context]\nvisible user message');
    expect((await h.runtime.getSession(session.id))?.systemPrompt).toBe('session instructions');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('persists the turn final output alongside its status', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'thinking', data: { text: '先想一下' } }); emit({ type: 'text', data: { text: '最终' } }); emit({ type: 'text', data: { text: '输出' } }); } });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(session.id, '写点东西');
    // 这段文本 runtime 判成败时本来就算了出来（走 shared 的 pickFinalAssistantText，分片合并
    // 由它负责）。落库后轨迹面板不必为「显示每轮最终输出」再扫一遍该轮事件。
    expect((await h.runtime.getTasks(session.id))[0]).toMatchObject({ status: 'completed', finalText: '最终输出' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps each turn final output to its own turn after later turns exist', async () => {
    const h = harness();
    h.driver.send = vi.fn(async (prompt: string) => { h.emit({ type: 'text', data: { text: `答案:${prompt}` } }); });
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' });
    const first = await h.runtime.send(session.id, '第一轮');
    await h.runtime.send(session.id, '第二轮');
    expect(first.finalText).toBe('答案:第一轮');
    expect((await h.runtime.getTasks(session.id)).map(task => task.finalText)).toEqual(['答案:第一轮', '答案:第二轮']);
    // 晚到的按轮读取（飞书对账、轨迹面板）必须还拿到第一轮自己的输出。runtime 手里那个
    // 「本轮锚点序号」的快捷上界只在本轮存续期间成立，轮次结束后再被问到绝不能把后面几轮
    // 的文本算进来——宁可退回按锚点精确查边界。
    expect(await h.runtime.getTurnText(session.id, first.id)).toBe('答案:第一轮');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps the same agent session across consecutive turns', async () => {
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) });
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(session.id, 'first'); await h.runtime.send(session.id, 'second');
    expect(h.driver.start).toHaveBeenCalledOnce(); expect(h.driver.send).toHaveBeenCalledTimes(2);
    expect((await h.runtime.getTasks(session.id)).map(task => task.prompt)).toEqual(['first', 'second']); h.repos.close();
  });

  it('persists queued prompts, runs them in order, and supports cancellation', async () => {
    const gate = deferred(); const h = harness();
    h.driver.send = vi.fn(async prompt => { if (prompt === 'first') await gate.promise; h.emit({ type: 'text', data: { text: `answer:${prompt}` } }); });
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' });
    const first = await h.runtime.dispatch(session.id, 'first'); expect(first.queuedAhead).toBe(0); await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('first'));
    const second = await h.runtime.dispatch(session.id, 'second');
    const third = await h.runtime.dispatch(session.id, 'third');
    expect(second.queuedAhead).toBe(1);
    expect(third.queuedAhead).toBe(2);
    expect((await h.runtime.getTasks(session.id)).find(task => task.id === second.id)?.status).toBe('queued');
    await h.runtime.cancelQueued(session.id, second.id);
    gate.resolve();
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('third'));
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.prompt === 'third')?.status).toBe('completed'));
    expect((h.driver.send as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])).toEqual(['first', 'third']);
    expect((await h.runtime.getTasks(session.id)).find(task => task.id === second.id)?.status).toBe('cancelled');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('hard-stops the current driver before immediately sending the replacement prompt', async () => {
    const gate = deferred(); const h = harness();
    h.driver.send = vi.fn(async prompt => { if (prompt === 'first') await gate.promise; h.emit({ type: 'text', data: { text: `answer:${prompt}` } }); });
    h.driver.stop = vi.fn(async () => gate.resolve());
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.dispatch(session.id, 'first'); await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('first'));
    await h.runtime.dispatch(session.id, 'replacement', 'interrupt');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('replacement'));
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(task => task.prompt === 'replacement')?.status).toBe('completed'));
    const tasks = await h.runtime.getTasks(session.id);
    expect(tasks.find(task => task.prompt === 'first')?.status).toBe('interrupted');
    expect(h.driver.stop).toHaveBeenCalledOnce(); expect(h.driver.start).toHaveBeenCalledTimes(2);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('promotes an existing queued task, interrupts the active turn, and preserves its task id', async () => {
    const gate = deferred(); const h = harness();
    h.driver.send = vi.fn(async prompt => { if (prompt === 'first') await gate.promise; h.emit({ type: 'text', data: { text: `answer:${prompt}` } }); });
    h.driver.stop = vi.fn(async () => gate.resolve());
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.dispatch(session.id, 'first'); await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('first'));
    const second = await h.runtime.dispatch(session.id, 'second');
    const third = await h.runtime.dispatch(session.id, 'third');
    await expect(h.runtime.steerQueued(session.id, third.id)).resolves.toMatchObject({ id: third.id, prompt: 'third' });
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('third'));
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('second'));
    expect((h.driver.send as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])).toEqual(['first', 'third', 'second']);
    const tasks = await h.runtime.getTasks(session.id);
    expect(tasks.find(task => task.id === third.id)?.status).toBe('completed');
    expect(tasks.find(task => task.prompt === 'first')?.status).toBe('interrupted');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('reconnects a persisted completed session before its next turn', async () => {
    const first = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) }); await first.runtime.initialize([agent]); const session = await first.runtime.start({ agentId: 'mock' }); await first.runtime.send(session.id, 'before restart');
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const restored = new AgentDockRuntime(first.repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: () => driver });
    await restored.send(session.id, 'after restart');
    expect(driver.start).toHaveBeenCalledOnce(); expect(driver.send).toHaveBeenCalledWith('after restart');
    expect((await restored.getTasks(session.id)).map(task => task.prompt)).toEqual(['before restart', 'after restart']); first.repos.close();
  });

  it('uses the persisted session system prompt when reconnecting after config changes', async () => {
    const first = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) });
    await first.runtime.initialize([{ ...agent, systemPrompt: 'session prompt' }]);
    const session = await first.runtime.start({ agentId: 'mock' });
    await first.runtime.send(session.id, 'before restart');
    await first.repos.agents.save({ ...agent, systemPrompt: 'new global prompt' });
    let configured: AgentConfig | undefined;
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const restored = new AgentDockRuntime(first.repos, { driverFactory: current => { configured = current; return driver; } });
    await restored.send(session.id, 'after restart');
    expect(configured?.systemPrompt).toBe('session prompt');
    first.repos.close();
  });

  it('lets a caller set a per-session system prompt that overrides the agent one', async () => {
    const h = harness();
    await h.runtime.initialize([{ ...agent, systemPrompt: 'agent 级提示词' }]);
    const session = await h.runtime.start({ agentId: 'mock', systemPrompt: '会话级提示词' });
    expect(session.systemPrompt).toBe('会话级提示词');
    // 真正送到驱动上的必须是会话级那份（configureAgentForSession 里会话优先）。
    expect(h.configuredAgents[0]?.systemPrompt).toBe('会话级提示词');
    h.repos.close();
  });

  it('writes the initial system prompt once and sends later turns without repeating it', async () => {
    const createSystemPrompt = vi.fn((session: Session) => `${session.systemPrompt ?? ''}\n一次性说明`);
    const h = harness({ createSystemPrompt, onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) });
    await h.runtime.initialize([{ ...agent, systemPrompt: 'Agent 提示词' }]);
    const session = await h.runtime.start({ agentId: 'mock' });
    expect(createSystemPrompt).toHaveBeenCalledOnce();
    expect(session.systemPrompt).toBe('Agent 提示词\n一次性说明');
    expect(h.configuredAgents[0]?.systemPrompt).toBe(session.systemPrompt);
    await h.runtime.send(session.id, '第一轮');
    await h.runtime.send(session.id, '第二轮');
    expect(h.driver.send).toHaveBeenNthCalledWith(1, '第一轮');
    expect(h.driver.send).toHaveBeenNthCalledWith(2, '第二轮');
    expect(createSystemPrompt).toHaveBeenCalledOnce();
    h.repos.close();
  });

  it('falls back to the agent system prompt when the caller does not set one', async () => {
    const h = harness();
    await h.runtime.initialize([{ ...agent, systemPrompt: 'agent 级提示词' }]);
    const session = await h.runtime.start({ agentId: 'mock' });
    expect(session.systemPrompt).toBe('agent 级提示词');
    h.repos.close();
  });

  it('never renders the injected system prompt as a user message', async () => {
    // 这是侧边会话改用 systemPrompt 的全部理由：注入的上下文不能出现在转录里。
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) });
    await h.runtime.initialize([agent]);
    const seed = '【注入的上下文】主会话是 ses_main';
    const session = await h.runtime.start({ agentId: 'mock', systemPrompt: seed });
    await h.runtime.send(session.id, '用户真正打的字');
    const userTexts = (await h.runtime.getEvents(session.id)).filter(event => event.type === 'text' && (event.data as any)?.role === 'user').map(event => (event.data as any).text);
    expect(userTexts).toEqual(['用户真正打的字']);
    expect(JSON.stringify(userTexts)).not.toContain('注入的上下文');
    h.repos.close();
  });

  it('releases idle drivers and reconnects them on the next turn', async () => {
    const h = harness({ driverIdleTimeoutMs: 10, onSend: emit => emit({ type: 'text', data: { text: 'answer' } }) }); await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: 'mock' }); await h.runtime.send(session.id, 'first');
    await h.runtime.cleanupIdleDrivers(Date.now() + 100);
    expect(h.driver.stop).toHaveBeenCalledOnce();
    await h.runtime.send(session.id, 'second');
    expect(h.driver.start).toHaveBeenCalledTimes(2); expect(h.driver.send).toHaveBeenCalledTimes(2); await h.runtime.shutdown(); h.repos.close();
  });

  // acpx 会 prune 掉已 close 的 ACP session 记录文件，此后 driver.stop() 抛
  // "ACP session not found"。空闲清理里若不吞掉它，异常会经 setInterval 的 void promise
  // 变成 unhandledRejection，直接打挂整个 daemon 进程（线上已复现多次重启）。
  it('survives a driver whose ACP session record was already pruned', async () => {
    const repos = createRepositories(':memory:');
    const driver: AgentDriver = {
      start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      stop: vi.fn(async () => { throw new Error('ACP session not found'); })
    };
    const runtime = new AgentDockRuntime(repos, {
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: () => driver, driverIdleTimeoutMs: 10
    });
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: 'mock' });
    await expect(runtime.cleanupIdleDrivers(Date.now() + 100)).resolves.toBeUndefined();
    expect(driver.stop).toHaveBeenCalledOnce();
    // 即便 stop 抛错也必须释放内存，否则同一个坏 driver 每 5 分钟再炸一次。
    await runtime.send(session.id, 'still works');
    expect(driver.start).toHaveBeenCalledTimes(2);
    await runtime.shutdown(); repos.close();
  });

  it('interrupt cancels only the current turn and retains the session', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await h.runtime.interrupt(s.id); expect(h.driver.interrupt).toHaveBeenCalledOnce(); expect((await h.runtime.getSession(s.id))?.state).toBe('interrupted'); h.repos.close(); });
  it('stop delegates process-tree cleanup and marks stopped', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await h.runtime.stop(s.id); expect(h.driver.stop).toHaveBeenCalledOnce(); expect((await h.runtime.getSession(s.id))?.state).toBe('stopped'); h.repos.close(); });
  it('permanently archives a session and rejects subsequent actions', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); const archived = await h.runtime.archive(s.id); expect(archived.archivedAt).toBeTruthy(); expect(archived.state).toBe('stopped'); await expect(h.runtime.dispatch(s.id, 'not allowed')).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' }); expect((await h.runtime.listSessions())[0]?.archivedAt).toBe(archived.archivedAt); await h.runtime.shutdown(); h.repos.close(); });
  it('restart creates a new run instance', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); const old = s.runId; const restarted = await h.runtime.restart(s.id); expect(restarted.runId).not.toBe(old); expect(h.driver.stop).toHaveBeenCalledOnce(); h.repos.close(); });
  it('abnormal agent exit produces failed state and error event', async () => { const h = harness({ exitOnSend: 17 }); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await h.runtime.send(s.id, 'exit'); await vi.waitFor(async () => expect((await h.runtime.getEvents(s.id)).some(e => e.type === 'error')).toBe(true)); h.repos.close(); });
  it('permission requests can be approved and rejected', async () => { const h = harness({ onSend: emit => { emit({ type: 'permission_request', data: { id: 'p1', title: 'Write?', status: 'pending' } }); emit({ type: 'permission_request', data: { id: 'p2', title: 'Delete?', status: 'pending' } }); } }); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await h.runtime.send(s.id, 'write'); expect((await h.runtime.resolvePermission(s.id, 'p1', true)).status).toBe('approved'); expect((await h.runtime.resolvePermission(s.id, 'p2', false)).status).toBe('rejected'); await expect(h.runtime.resolvePermission(s.id, 'p1', true)).rejects.toMatchObject({ code: 'PERMISSION_NOT_FOUND' }); await h.runtime.shutdown(); h.repos.close(); });
  it('returns an explicit error for unsupported pause/resume', async () => { const h = harness(); await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' }); await expect(h.runtime.pause(s.id)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', statusCode: 422 }); h.repos.close(); });
  it('returns a clear dependency error when a scanned Agent becomes unavailable', async () => { const h = harness(); const unavailable = { ...agent, id: 'trae', name: 'Trae', command: 'missing-trae' }; const runtime = new AgentDockRuntime(h.repos, { probe: () => ({ protocol: 'acp', available: false, detail: 'command disappeared after scan', pause: false, resume: true }) }); await runtime.initialize([unavailable]); await expect(runtime.start({ agentId: 'trae' })).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' }); h.repos.close(); });

  it('marks a turn failed when the agent stops mid-thinking without final text', async () => {
    const h = harness({ onSend: emit => emit({ type: 'thinking', data: { text: 'still thinking' } }) });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    await vi.waitFor(async () => expect((await h.runtime.getEvents(s.id)).some(e => e.type === 'error' && /未返回最终输出/.test((e.data as any)?.message ?? ''))).toBe(true));
    await h.runtime.shutdown(); h.repos.close();
  });

  it('marks a turn failed when tools finish but the agent never returns final text', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'tool_call', data: { id: 't', name: 'read', input: '.', status: 'running' } }); emit({ type: 'tool_result', data: { id: 't', name: 'read', output: 'ok', status: 'completed' } }); } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    await vi.waitFor(async () => expect((await h.runtime.getEvents(s.id)).some(e => e.type === 'error' && /未返回最终输出/.test((e.data as any)?.message ?? ''))).toBe(true));
    await h.runtime.shutdown(); h.repos.close();
  });

  it('答案写在收尾动作之前时照样算完成——Trae/Codex 实测形状', async () => {
    // 线上实测：Agent 先写完回答，再执行收尾动作（飞书群里答完再 group send），末尾没有新文本。
    // 结果是完整产出了的，整轮判 failed + 报「未返回最终输出」是误报。
    const h = harness({ onSend: emit => {
      emit({ type: 'text', data: { text: '结论：没问题。' } });
      emit({ type: 'tool_call', data: { id: 'send', name: 'group send', status: 'running' } });
      emit({ type: 'tool_result', data: { id: 'send', name: 'group send', output: 'ok', status: 'completed' } });
    } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    const task = (await h.runtime.getTasks(s.id))[0];
    expect(task?.status).toBe('completed');
    expect(task?.finalText).toBe('结论：没问题。');
    expect((await h.runtime.getEvents(s.id)).some(e => e.type === 'error')).toBe(false);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('中途丢结果的工具调用不影响判完成——Agent 越过后继续作答', async () => {
    // 实测形状：一次 shell 调用没有回 tool_result（Agent 直接越过），后面又跑了多次工具，
    // 最后给出完整回答并 end_turn。老规则（只要有一个没收口就判失败）会把整轮标红。
    const h = harness({ onSend: emit => {
      emit({ type: 'text', data: { text: '先看看目录。' } });
      emit({ type: 'tool_call', data: { id: 'lost', name: 'ls', status: 'running' } });
      emit({ type: 'thinking', data: { text: '继续查。' } });
      emit({ type: 'tool_call', data: { id: 'ok', name: 'cat', status: 'running' } });
      emit({ type: 'tool_result', data: { id: 'ok', name: 'cat', output: 'ok', status: 'completed' } });
      emit({ type: 'text', data: { text: '安装完成，已验证可用。' } });
    } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    const task = (await h.runtime.getTasks(s.id))[0];
    expect(task?.status).toBe('completed');
    expect(task?.finalText).toBe('安装完成，已验证可用。');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('Agent 说完就停在未返回的工具调用上时仍判失败', async () => {
    const h = harness({ onSend: emit => {
      emit({ type: 'text', data: { text: '我先跑个命令。' } });
      emit({ type: 'tool_call', data: { id: 'hang', name: 'sleep', status: 'running' } });
    } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    await vi.waitFor(async () => expect((await h.runtime.getEvents(s.id)).some(e => e.type === 'error' && /未返回结果的工具调用/.test((e.data as any)?.message ?? ''))).toBe(true));
    await h.runtime.shutdown(); h.repos.close();
  });

  it('整轮一个字都没说仍然判失败', async () => {
    const h = harness({ onSend: emit => {
      emit({ type: 'thinking', data: { text: '想想。' } });
      emit({ type: 'tool_call', data: { id: 't', name: 'read', status: 'running' } });
      emit({ type: 'tool_result', data: { id: 't', name: 'read', output: 'ok', status: 'completed' } });
    } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    const task = (await h.runtime.getTasks(s.id))[0];
    expect(task?.status).toBe('failed');
    expect(task?.finalText ?? '').toBe('');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps a shared session reusable after a task-level "no final output" failure so the next turn runs', async () => {
    // First turn produces activity but no terminal assistant text -> task fails.
    // The session must not be poisoned into `failed`; a following turn must run.
    const h = harness({ onSend: emit => { emit({ type: 'thinking', data: { text: 'still thinking' } }); } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'first');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    await vi.waitFor(async () => expect((await h.runtime.getSession(s.id))?.state).toBe('idle'));
    // A second, well-formed turn must run on the same session.
    h.driver.send = vi.fn(async () => h.emit({ type: 'text', data: { text: 'done' } }));
    await h.runtime.send(s.id, 'second');
    expect(h.driver.send).toHaveBeenCalledWith('second');
    await vi.waitFor(async () => expect((await h.runtime.getTasks(s.id)).find(task => task.prompt === 'second')?.status).toBe('completed'));
    expect((await h.runtime.getSession(s.id))?.state).toBe('completed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps a shared session reusable after a driver error event during a task', async () => {
    const h = harness({ onSend: emit => emit({ type: 'error', data: { message: 'temporary SDK error' } }) });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'first');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    expect(await h.runtime.getSession(s.id)).toMatchObject({ state: 'idle', error: 'Agent 未返回最终输出' });
    h.driver.send = vi.fn(async () => h.emit({ type: 'text', data: { text: 'done' } }));
    await h.runtime.send(s.id, 'second');
    expect((await h.runtime.getTasks(s.id)).find(task => task.prompt === 'second')?.status).toBe('completed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('drains work already queued behind a task-level SDK failure', async () => {
    const firstTurn = deferred();
    const h = harness();
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    h.driver.send = vi.fn(async prompt => {
      if (prompt === 'fail-me') {
        await firstTurn.promise;
        throw new Error('temporary SDK error');
      }
      h.emit({ type: 'text', data: { text: 'done' } });
    });

    const first = await h.runtime.dispatch(s.id, 'fail-me');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('fail-me'));
    const second = await h.runtime.dispatch(s.id, 'queued-after-failure');
    expect(second.queuedAhead).toBe(1);
    firstTurn.resolve();

    await vi.waitFor(async () => expect((await h.runtime.getTasks(s.id)).find(task => task.id === first.id)?.status).toBe('failed'));
    await vi.waitFor(async () => expect((await h.runtime.getTasks(s.id)).find(task => task.id === second.id)?.status).toBe('completed'));
    expect(h.driver.send).toHaveBeenNthCalledWith(2, 'queued-after-failure');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('marks a turn interrupted when the driver reports a cancelled stopReason', async () => {
    const h = harness({ onSend: emit => emit({ type: 'completed', data: { stopReason: 'cancelled' } }) });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('interrupted');
    expect((await h.runtime.getSession(s.id))?.state).toBe('interrupted');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('marks a turn failed when the driver reports a max_tokens stopReason', async () => {
    const h = harness({ onSend: emit => emit({ type: 'completed', data: { stopReason: 'max_tokens' } }) });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('failed');
    await vi.waitFor(async () => expect((await h.runtime.getEvents(s.id)).some(e => e.type === 'error' && /截断/.test((e.data as any)?.message ?? ''))).toBe(true));
    await h.runtime.shutdown(); h.repos.close();
  });

  // ACP 会对同一个 toolCallId 重复推送 tool_call_update，且不保证顺序。终态出现后
  // 迟到的非终态更新只是旧快照，不得把已完成的轮次翻回「未解决」并判失败。
  for (const lateStatus of ['pending', 'in_progress', 'running', 'started'] as const) {
    it(`ignores a late ${lateStatus} tool update after the call already completed`, async () => {
      const h = harness({ onSend: emit => {
        emit({ type: 'tool_call', data: { id: 't1', name: 'read', status: 'running' } });
        emit({ type: 'tool_result', data: { id: 't1', name: 'read', output: 'ok', status: 'completed' } });
        emit({ type: 'tool_call', data: { id: 't1', name: 'read', status: lateStatus } });
        emit({ type: 'text', data: { text: 'final answer' } });
      } });
      await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
      await h.runtime.send(s.id, 'work');
      expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('completed');
      expect((await h.runtime.getEvents(s.id)).some(e => e.type === 'error')).toBe(false);
      await h.runtime.shutdown(); h.repos.close();
    });
  }

  it('工具调用没收口但答案写在它之后时判完成——Agent 已越过它继续作答', async () => {
    // 老规则只看「有没有没收口的调用」，会把这种有完整回答的轮次整轮标红（线上实测形状）。
    const h = harness({ onSend: emit => {
      emit({ type: 'tool_call', data: { id: 't1', name: 'read', status: 'running' } });
      emit({ type: 'text', data: { text: 'final answer' } });
    } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    const task = (await h.runtime.getTasks(s.id))[0];
    expect(task?.status).toBe('completed');
    expect(task?.finalText).toBe('final answer');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('resolves a long turn with more than 200 events from persisted storage', async () => {
    // 终态判定必须基于完整轮次，而不是任何被截断的最近 N 条窗口：
    // 配对的 tool_call/tool_result 相距超过 200 条事件时仍须判定为 completed。
    const h = harness({ onSend: emit => {
      emit({ type: 'tool_call', data: { id: 'early', name: 'read', status: 'running' } });
      for (let index = 0; index < 260; index++) emit({ type: 'thinking', data: { text: `step ${index}` } });
      emit({ type: 'tool_result', data: { id: 'early', name: 'read', output: 'ok', status: 'completed' } });
      emit({ type: 'text', data: { text: 'final answer' } });
    } });
    await h.runtime.initialize([agent]); const s = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(s.id, 'work');
    expect((await h.runtime.getEvents(s.id)).length).toBeGreaterThan(200);
    expect((await h.runtime.getTasks(s.id))[0]?.status).toBe('completed');
    await h.runtime.shutdown(); h.repos.close();
  });
});

describe('agent enable/disable', () => {
  // 内置 Agent 的 args 装的是真正的启动入口（claude 的 argv 是 [node, claude-acp.mjs]），
  // 而 updateAgent 是「表单全量更新」——提交体里没带的字段会走 schema 默认值。
  // 所以内置必须只读：一次表单保存就能把 args 冲成 []，让这个 Agent 再也起不来。
  it('keeps the discovered launcher args when a builtin is toggled disabled', async () => {
    const h = harness();
    const builtin = { ...agent, id: 'claude', name: 'Claude Code', args: ['/path/claude-acp.mjs'], builtin: true };
    await h.runtime.initialize([builtin]);
    expect((await h.runtime.listAgents())[0]?.args).toEqual(['/path/claude-acp.mjs']);

    await h.runtime.setAgentDisabled('claude', true);
    const after = await h.runtime.listAgents(true);
    expect(after[0]).toMatchObject({ disabled: true, builtin: true });
    // 启停不该动启动参数，否则「停用再启用」会静默弄坏这个 Agent。
    expect(after[0]?.args).toEqual(['/path/claude-acp.mjs']);
    h.repos.close();
  });

  it('can re-enable a disabled builtin — otherwise disabling is a one-way door', async () => {
    const h = harness();
    await h.runtime.initialize([{ ...agent, builtin: true }]);
    await h.runtime.setAgentDisabled('mock', true);
    expect(await h.runtime.listAgents()).toHaveLength(0);

    // updateAgent 有意忽略 disabled（防表单把人锁在外面），所以必须有这条独立入口。
    await h.runtime.updateAgent('mock', { id: 'mock', name: 'Mock', command: process.execPath });
    expect(await h.runtime.listAgents()).toHaveLength(0);

    await h.runtime.setAgentDisabled('mock', false);
    expect(await h.runtime.listAgents()).toHaveLength(1);
    h.repos.close();
  });

  it('rejects an unknown agent', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    await expect(h.runtime.setAgentDisabled('missing', true)).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND', statusCode: 404 });
    h.repos.close();
  });
});

describe('borrowed agent runs (runOnce)', () => {
  it('returns the final answer of a one-off run and archives the borrowed session', async () => {
    const h = harness({ onSend: emit => {
      emit({ type: 'text', data: { text: '先看下这段代码' } });
      emit({ type: 'thinking', data: { text: 'think' } });
      emit({ type: 'tool_call', data: { id: 't', name: 'read', status: 'running' } });
      emit({ type: 'tool_result', data: { id: 't', name: 'read', status: 'completed' } });
      emit({ type: 'text', data: { text: '这段代码做的是 X' } });
    } });
    await h.runtime.initialize([agent]);
    const result = await h.runtime.runOnce({ agentId: 'mock', prompt: '解释这段代码', source: 'platform' });
    // 最终输出是最后一次活动之后的那条，不是工具调用前的阶段描述。
    expect(result).toMatchObject({ status: 'completed', text: '这段代码做的是 X' });
    expect(result.error).toBeUndefined();
    const session = await h.runtime.getSession(result.sessionId);
    expect(session).toMatchObject({ agentId: 'mock', source: 'platform', state: 'stopped' });
    // 冷启动借来的会话不该混进默认列表，但必须留在库里可查。
    expect(session?.archivedAt).toBeTruthy();
    expect((await h.runtime.getTasks(result.sessionId)).map(task => task.status)).toEqual(['completed']);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('joins the chunked answer ACP actually streams, and drops the agent warning', async () => {
    const h = harness({ onSend: emit => {
      // 线上实测：一次真实借跑先来一条 Agent 自己的告警，再把一句回答拆成六个 chunk。
      emit({ type: 'text', data: { role: 'assistant', text: 'Warning: Skill descriptions were shortened to fit the skills context budget' } });
      for (const chunk of ['平台', ' AI', ' 已', '就', '绪', '。']) emit({ type: 'text', data: { role: 'assistant', text: chunk } });
    } });
    await h.runtime.initialize([agent]);
    const result = await h.runtime.runOnce({ agentId: 'mock', prompt: '试跑', source: 'platform' });
    // 只看最后一条 chunk 的话这里拿到的是「。」。
    expect(result).toMatchObject({ status: 'completed', text: '平台 AI 已就绪。' });
    await h.runtime.shutdown(); h.repos.close();
  });

  it('treats a turn with nothing but an agent warning as having no final output', async () => {
    const h = harness({ onSend: emit => emit({ type: 'text', data: { role: 'assistant', text: 'Warning: 技能描述被裁剪' } }) });
    await h.runtime.initialize([agent]);
    const result = await h.runtime.runOnce({ agentId: 'mock', prompt: 'work' });
    // 判「有没有最终输出」与取文本必须是同一条规则：否则这里会给出 completed + 空文本。
    expect(result.status).toBe('failed');
    expect(result.text).toBe('');
    expect(result.error).toBe('Agent 未返回最终输出');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('keeps the session when the caller asks not to archive it', async () => {
    const h = harness({ onSend: emit => emit({ type: 'text', data: { text: 'ok' } }) });
    await h.runtime.initialize([agent]);
    const result = await h.runtime.runOnce({ agentId: 'mock', prompt: 'work', archiveWhenDone: false });
    expect((await h.runtime.getSession(result.sessionId))?.archivedAt).toBeFalsy();
    await h.runtime.shutdown(); h.repos.close();
  });

  it('reports a failed run without a final output instead of throwing', async () => {
    const h = harness({ onSend: emit => emit({ type: 'thinking', data: { text: 'thinking forever' } }) });
    await h.runtime.initialize([agent]);
    const result = await h.runtime.runOnce({ agentId: 'mock', prompt: 'work', timeoutMs: 5_000 });
    expect(result.status).toBe('failed');
    expect(result.text).toBe('');
    expect(result.error).toBe('Agent 未返回最终输出');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('interrupts the turn on timeout and reports timeout rather than failed', async () => {
    const h = harness();
    let releaseSend!: (error: Error) => void;
    // 真实驱动被 stop 时会打断进程，挂起的 send 随之 reject；假驱动照此模拟。
    h.driver.send = vi.fn(() => new Promise<void>((_resolve, reject) => { releaseSend = reject; }));
    h.driver.stop = vi.fn(async () => { releaseSend(new Error('driver stopped')); });
    await h.runtime.initialize([agent]);
    const result = await h.runtime.runOnce({ agentId: 'mock', prompt: 'work', timeoutMs: 20 });
    expect(result.status).toBe('timeout');
    expect(result.text).toBe('');
    expect(result.error).toMatch(/超过 20ms/);
    // 不等了也必须真的把借来的 Agent 停掉，否则它还在后台跑工具烧 token。
    expect(h.driver.stop).toHaveBeenCalled();
    expect((await h.runtime.getSession(result.sessionId))?.archivedAt).toBeTruthy();
    await h.runtime.shutdown(); h.repos.close();
  });

  it('throws when the borrowed Agent cannot be started at all', async () => {
    const h = harness();
    const runtime = new AgentDockRuntime(h.repos, { probe: () => ({ protocol: 'acp', available: false, detail: '命令不存在', pause: false, resume: true }) });
    await runtime.initialize([{ ...agent, id: 'trae', name: 'Trae' }]);
    // 起不来就没有 sessionId / taskId 可报，返回值形状本身就是假的，只能抛。
    await expect(runtime.runOnce({ agentId: 'trae', prompt: 'work' })).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' });
    await expect(runtime.runOnce({ agentId: 'missing', prompt: 'work' })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    h.repos.close();
  });

  it('getTurnText ignores earlier chatter and turns without final output', async () => {
    const h = harness({ onSend: emit => {
      emit({ type: 'text', data: { text: '我先跑个命令' } });
      emit({ type: 'tool_call', data: { id: 't', name: 'bash', status: 'running' } });
    } });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const task = await h.runtime.send(session.id, 'work');
    expect(await h.runtime.getTurnText(session.id, task.id)).toBe('');
    expect(await h.runtime.getTurnText(session.id, 'unknown-task')).toBe('');
    await h.runtime.shutdown(); h.repos.close();
  });
});

describe('会话名的三级回退', () => {
  it('没有 Agent 标题时仍用首条 prompt 摘要（改动前的行为不能被破坏）', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(session.id, '帮我\n爬 85 个群');
    const [listed] = await h.runtime.listSessions();
    expect(listed).toMatchObject({ title: '帮我 爬 85 个群', titleSource: 'prompt' });
    h.repos.close();
  });

  it('Agent 推来的标题压过首条 prompt，并落库到 agentTitle', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'session_title', data: { title: '清理磁盘' } }); } });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(session.id, '清理下电脑磁盘空间');
    const [listed] = await h.runtime.listSessions();
    expect(listed).toMatchObject({ title: '清理磁盘', titleSource: 'agent' });
    expect((await h.repos.sessions.get(session.id))?.agentTitle).toBe('清理磁盘');
    h.repos.close();
  });

  // 会话名是元数据、不是对话内容，混进轨迹只会干扰阅读；它走的是 consume 的提前返回分支。
  it('Agent 标题事件不进时间线', async () => {
    const h = harness({ onSend: emit => { emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'session_title', data: { title: '清理磁盘' } }); } });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(session.id, 'work');
    const events = await h.runtime.getEvents(session.id);
    // 生命周期本来就会发 status（状态迁移），所以不能断言「没有 status」，
    // 只能断言没有任何一条 status 带上了标题——那才是标题混进轨迹的形态。
    expect(events.map(event => event.type)).not.toContain('session_title');
    expect(events.filter(event => event.type === 'status' && Object.hasOwn(event.data ?? {}, 'title'))).toEqual([]);
    h.repos.close();
  });

  it('用户改过名字后锁定：Agent 再推标题只更新 agentTitle，不改显示名', async () => {
    const h = harness({ onSend: emit => emit({ type: 'session_title', data: { title: 'Agent 起的' } }) });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.setSessionTitle(session.id, '我自己起的');
    await h.runtime.send(session.id, 'work');
    const [listed] = await h.runtime.listSessions();
    expect(listed).toMatchObject({ title: '我自己起的', titleSource: 'user' });
    expect((await h.repos.sessions.get(session.id))?.agentTitle).toBe('Agent 起的');
    h.repos.close();
  });

  it('清空自定义名 = 恢复自动，回落到 Agent 名而不是留一个空标题', async () => {
    const h = harness({ onSend: emit => emit({ type: 'session_title', data: { title: 'Agent 起的' } }) });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(session.id, 'work');
    await h.runtime.setSessionTitle(session.id, '我自己起的');
    expect((await h.runtime.listSessions())[0]).toMatchObject({ title: '我自己起的', titleSource: 'user' });
    await h.runtime.setSessionTitle(session.id, '   ');
    expect((await h.runtime.listSessions())[0]).toMatchObject({ title: 'Agent 起的', titleSource: 'agent' });
    expect((await h.repos.sessions.get(session.id))?.customTitle ?? null).toBeNull();
    h.repos.close();
  });

  it('改名会 emit 一条 status（用户在轨迹里看得到自己改过什么），Agent 标题则不会', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.setSessionTitle(session.id, '改个名');
    const statuses = (await h.runtime.getEvents(session.id)).filter(event => event.type === 'status');
    expect(statuses.at(-1)?.data).toMatchObject({ title: '改个名', titleSource: 'user' });
    // Agent 那条走 setAgentTitle，不发事件。
    const before = (await h.runtime.getEvents(session.id)).length;
    await h.runtime.setAgentTitle(await h.runtime.getSession(session.id) as Session, 'Agent 起的');
    expect((await h.runtime.getEvents(session.id)).length).toBe(before);
    h.repos.close();
  });

  it('getSessionWithTitle 与 listSessions 口径一致，且不存在的会话返回 undefined', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(session.id, '原问题');
    const [listed] = await h.runtime.listSessions();
    expect(await h.runtime.getSessionWithTitle(session.id)).toMatchObject({ title: listed?.title, titleSource: listed?.titleSource });
    expect(await h.runtime.getSessionWithTitle('ses_missing')).toBeUndefined();
    h.repos.close();
  });

  it('拒绝超长标题', async () => {
    const h = harness(); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    await expect(h.runtime.setSessionTitle(session.id, 'a'.repeat(SESSION_TITLE_MAX_CHARS + 1))).rejects.toMatchObject({ code: 'INVALID_SESSION_TITLE' });
    await expect(h.runtime.setSessionTitle('ses_missing', 'x')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    h.repos.close();
  });
});
