import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setWebPassword } from './web-password.js';
import { webAccessCookieName } from './web-access.js';
import { buildApp, RECORD_EVENT_LIMIT, TURN_EVENT_BYTE_LIMIT, TURN_EVENT_ROW_LIMIT } from './app.js';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { larkBotsConfigKey, larkCredentialsConfigKey } from './lark/config.js';

const apps: any[] = [];
const tempDirectories: string[] = [];
const repositories: Array<ReturnType<typeof createRepositories>> = [];
function listenerPool() {
  let activeAppIds: string[] = [];
  return {
    get listening() { return activeAppIds.length > 0; },
    get activeAppIds() { return activeAppIds; },
    sync: vi.fn(async (configs: Array<{ appId: string; listening: boolean }>) => { activeAppIds = configs.filter(config => config.listening).map(config => config.appId); }),
    stop: vi.fn(() => { activeAppIds = []; })
  };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const repository of repositories.splice(0)) repository.close();
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('HTTP API boundary', () => {
  it('only forwards whitelisted fields when creating a session', async () => {
    const start = vi.fn(async (input: unknown) => ({ id: 'ses_new', input }));
    const app = await buildApp({ start } as any); apps.push(app);

    const created = await app.inject({ method: 'POST', url: '/api/sessions', payload: { agentId: 'codex', source: 'side-chat', sourceId: 'ses_parent', resumeSessionId: 'ext-1', importTurns: [{ prompt: 'forged', events: [] }] } });
    expect(created.statusCode).toBe(200);
    expect(start).toHaveBeenCalledWith({ agentId: 'codex', cwd: undefined, model: undefined, reasoningEffort: undefined, systemPrompt: undefined, source: 'side-chat', sourceId: 'ses_parent' });

    for (const source of ['import', 'lark']) {
      const forged = await app.inject({ method: 'POST', url: '/api/sessions', payload: { agentId: 'codex', source, sourceId: 'ext-1' } });
      expect(forged.statusCode).toBe(400);
      expect(forged.json().error.code).toBe('INVALID_SOURCE');
    }
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('refuses to hand over Lark-originated sessions and only binds a session to one group', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_bot', appSecret: 'secret_bot' }]));
    const sessions: Record<string, any> = { ses_lark: { id: 'ses_lark', agentId: 'codex', source: 'lark', sourceId: 'cli_bot:oc_origin:group:chat' }, ses_web: { id: 'ses_web', agentId: 'codex', title: 'Web' } };
    const runtime = { getSession: vi.fn(async (id: string) => sessions[id]) };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { chat_id: 'oc_handover' } }), { status: 200 }));
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, cardMappings: repos.channelMappings, fetcher: fetcher as typeof fetch, listener: listenerPool(), runtime: runtime as any } }); apps.push(app);

    const lark = await app.inject({ method: 'POST', url: '/api/sessions/ses_lark/handover', payload: { appId: 'cli_bot' } });
    expect(lark.statusCode).toBe(409);
    expect(lark.json().error.code).toBe('LARK_SESSION_NOT_HANDOVERABLE');

    const created = await app.inject({ method: 'POST', url: '/api/sessions/ses_web/handover', payload: { appId: 'cli_bot' } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ sessionId: 'ses_web', chatId: 'oc_handover' });

    const duplicate = await app.inject({ method: 'POST', url: '/api/sessions/ses_web/handover', payload: { appId: 'cli_bot' } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('SESSION_ALREADY_HANDED_OVER');
    // 只建了一次群：token + createChat 各一次，重复提交没有触发飞书调用。
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('mounts optional Lark status, send, and update routes', async () => {
    const lark: any = { send: vi.fn(async () => ({ messageId: 'om_sent', chatId: 'oc_chat' })), update: vi.fn(async () => ({ messageId: 'om_sent' })) };
    const app = await buildApp({} as any, { lark: { env: { LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test', LARK_AGENT_NAME: 'My Agent' }, service: lark } }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/lark/status' })).json()).toMatchObject({ configured: true, listening: false, defaultAgentName: 'My Agent' });
    expect((await app.inject({ method: 'POST', url: '/api/lark/send', payload: { receiveId: 'user@example.com', markdown: 'done' } })).json()).toEqual({ messageId: 'om_sent', chatId: 'oc_chat' });
    expect((await app.inject({ method: 'POST', url: '/api/lark/update', payload: { messageId: 'om_sent', markdown: 'updated' } })).json()).toEqual({ messageId: 'om_sent' });
    expect(lark.send).toHaveBeenCalledWith(expect.objectContaining({ markdown: 'done' }));
    expect(lark.update).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_sent', markdown: 'updated' }));
  });

  it('keeps AgentDock available when Lark is not configured', async () => {
    const app = await buildApp({} as any, { lark: { env: {} } }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/lark/status' })).json()).toMatchObject({ configured: false, missing: ['LARK_APP_ID', 'LARK_APP_SECRET'] });
    const response = await app.inject({ method: 'POST', url: '/api/lark/send', payload: { receiveId: 'user@example.com', markdown: 'done' } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('LARK_NOT_CONFIGURED');
  });

  it('persists Lark credentials in SQLite without returning the secret', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true, version: 'codex-cli test' });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: 'om_saved', chat_id: 'oc_group' } }), { status: 200 }));
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, fetcher: fetcher as typeof fetch } }); apps.push(app);
    const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', defaultModel: 'model-a', defaultReasoningEffort: 'high' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ configured: true, bots: [{ configured: true, appId: 'cli_saved', name: 'cli_saved', tabLabel: 'cli_saved', setupComplete: true, defaultAgentId: 'codex', defaultModel: 'model-a', defaultReasoningEffort: 'high', listening: false, activeListening: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, traceLimit: 50, hideTraceOnComplete: true, allowedEmails: [], highRiskAllowedEmails: [], gateEnabled: false, softGateEnabled: false, hardGateEnabled: false, hookTrustConfirmed: false }], listeningDisabled: false });
    expect(saved.body).not.toContain('secret_saved');
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0]).toMatchObject({ appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', defaultModel: 'model-a', defaultReasoningEffort: 'high', listening: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, traceLimit: 50, hideTraceOnComplete: true, allowedEmails: [], highRiskAllowedEmails: [], gateEnabled: false, softGateEnabled: false, hardGateEnabled: false, hookTrustConfirmed: false });
    const loaded = await app.inject({ method: 'GET', url: '/api/lark/config' });
    expect(loaded.json()).toEqual(saved.json());
    expect(loaded.body).not.toContain('secret_saved');
    expect((await app.inject({ method: 'GET', url: '/api/lark/status' })).json()).toMatchObject({ configured: true });
    expect((await app.inject({ method: 'POST', url: '/api/lark/send', payload: { chatId: 'oc_group', markdown: 'hello', state: 'completed' } })).json()).toEqual({ messageId: 'om_saved', chatId: 'oc_group' });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ app_id: 'cli_saved', app_secret: 'secret_saved' });
  });

  it('persists names without querying group membership while saving', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { items: [{ chat_id: 'oc_group', name: '研发群', external: false }], has_more: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { users: [{ member_id: 'ou_user', member_id_type: 'open_id', open_id: 'ou_user', name: '涂泽国' }], has_more: false, user_total: 1 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, bot: { app_name: '真实姓名机器人', open_id: 'ou_bot' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { items: [{ chat_id: 'oc_group', name: '研发群', external: false }], has_more: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { users: [{ member_id: 'ou_user', member_id_type: 'open_id', open_id: 'ou_user', name: '涂泽国' }], has_more: false, user_total: 1 } }), { status: 200 }));
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, fetcher: fetcher as typeof fetch, listener: listenerPool() } }); apps.push(app);
    await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_named', appSecret: 'secret_named' } });

    const chats = await app.inject({ method: 'GET', url: '/api/lark/bots/cli_named/chats' });
    expect(chats.json()).toEqual({ items: [{ chatId: 'oc_group', name: '研发群', external: false }], hasMore: false });
    const members = await app.inject({ method: 'GET', url: '/api/lark/bots/cli_named/chats/oc_group/members' });
    expect(members.json()).toMatchObject({ items: [{ memberId: 'ou_user', openId: 'ou_user', memberType: 'user', name: '涂泽国' }], hasMore: false, memberTotal: 1 });

    const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'lark', originalAppId: 'cli_named', allowedUserNames: ['涂泽国'], allowedEmails: [] } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().bots[0]).toMatchObject({ allowedUsers: [], allowedUserNames: ['涂泽国'], allowedEmails: [] });
    expect(fetcher).toHaveBeenCalledTimes(6);
    const loaded = await app.inject({ method: 'GET', url: '/api/lark/config' });
    expect(loaded.json().bots[0].allowedUserNames).toEqual(['涂泽国']);
  });

  it('keeps existing open_id bindings when the form resubmits unchanged names', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, listener: listenerPool() } }); apps.push(app);
    await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_bound', appSecret: 'secret', allowedUsers: [{ openId: 'ou_member', name: '成员' }] } });
    const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_bound', allowedUserNames: ['成员'], traceLimit: 60 } });
    expect(saved.json().bots[0]).toMatchObject({ allowedUsers: [{ openId: 'ou_member', name: '成员' }], allowedUserNames: [], traceLimit: 60 });
    const cleared = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_bound', allowedUserNames: [] } });
    expect(cleared.json().bots[0]).toMatchObject({ allowedUsers: [], allowedUserNames: [] });
  });

  it('preserves deferred lists on partial updates and clears them explicitly', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, listener: listenerPool() } }); apps.push(app);
    const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_deferred', appSecret: 'secret', allowedUserNames: [' 成员 ', '成员'], allowedBotNames: ['机器人'], highRiskAllowedUserNames: ['管理员'], gateEnabled: false } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().bots[0]).toMatchObject({ allowedUserNames: ['成员'], allowedBotNames: ['机器人'], highRiskAllowedUserNames: ['管理员'], traceLimit: 50 });
    expect(saved.json().bots[0].webBaseUrl).toBeUndefined();
    const updated = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_deferred', webBaseUrl: 'https://example.com' } });
    expect(updated.json().bots[0]).toMatchObject({ allowedUserNames: ['成员'], allowedBotNames: ['机器人'], highRiskAllowedUserNames: ['管理员'] });
    const cleared = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_deferred', allowedUserNames: [], allowedBotNames: [], highRiskAllowedUserNames: [], webBaseUrl: '' } });
    expect(cleared.json().bots[0]).toMatchObject({ allowedUsers: [], allowedUserNames: [], allowedBots: [], allowedBotNames: [], highRiskAllowedUsers: [], highRiskAllowedUserNames: [] });
    expect(cleared.json().bots[0].webBaseUrl).toBeUndefined();
  });

  it('starts and stops the optional Lark listener from persisted config', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    const listener = listenerPool();
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, listener } }); apps.push(app);
    await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', listening: false } });
    listener.sync.mockClear();
    const enabled = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_saved', listening: true } });
    expect(enabled.json().bots[0]).toMatchObject({ appId: 'cli_saved', listening: true, activeListening: true });
    expect(listener.sync).toHaveBeenCalledOnce();
    const disabled = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_saved', listening: false } });
    expect(disabled.json().bots[0]).toMatchObject({ appId: 'cli_saved', listening: false, activeListening: false });
  });

  it('persists the listener switch and retries a transient first connection failure within one save', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    let activeAppIds: string[] = []; let failedOnce = false;
    const listener = {
      get listening() { return activeAppIds.length > 0; },
      get activeAppIds() { return activeAppIds; },
      sync: vi.fn(async (configs: Array<{ appId: string; listening: boolean }>) => {
        if (configs.some(config => config.listening) && !failedOnce) { failedOnce = true; throw new Error('transient websocket failure'); }
        activeAppIds = configs.filter(config => config.listening).map(config => config.appId);
      }),
      stop: vi.fn()
    };
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, listener } }); apps.push(app);
    await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_saved', appSecret: 'secret_saved', listening: false } });
    listener.sync.mockClear();
    const response = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_saved', listening: true } });
    expect(response.statusCode).toBe(200);
    expect(response.json().bots[0]).toMatchObject({ listening: true, activeListening: true });
    expect(listener.sync).toHaveBeenCalledTimes(2);
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0].listening).toBe(true);
  });

  it('allows listening with valid Lark credentials before an Agent is configured', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const listener = listenerPool();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, bot: { app_name: 'Listener only', open_id: 'ou_bot' } }), { status: 200 }));
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, listener, fetcher: fetcher as typeof fetch } }); apps.push(app);
    const response = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'lark', appId: 'cli_saved', appSecret: 'secret_saved', listening: true } });
    expect(response.statusCode).toBe(200);
    expect(response.json().bots[0]).toMatchObject({ appId: 'cli_saved', setupComplete: false, listening: true, activeListening: true });
    expect(listener.sync).toHaveBeenLastCalledWith([expect.objectContaining({ appId: 'cli_saved', listening: true })]);
    expect(listener.sync.mock.calls.at(-1)?.[0]?.[0]).not.toHaveProperty('defaultAgentId');
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0]).toMatchObject({ appId: 'cli_saved', listening: true });
  });

  it('keeps the persisted listener switch unchanged when startup disables listening', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    await repos.config.set(larkCredentialsConfigKey, JSON.stringify({ appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', listening: true, pushIntervalMs: 1200, hideTraceOnComplete: false }));
    const listener = listenerPool();
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, listener, listeningDisabled: true } }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/lark/config' })).json()).toMatchObject({ listeningDisabled: true, bots: [expect.objectContaining({ listening: true, activeListening: false, pushIntervalMs: 1200 })] });
    const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_saved', listening: false, pushIntervalMs: 1500 } });
    expect(saved.json()).toMatchObject({ listeningDisabled: true, bots: [expect.objectContaining({ listening: true, activeListening: false, pushIntervalMs: 1500 })] });
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0].listening).toBe(true);
    expect(listener.sync).not.toHaveBeenCalled();
  });

  it('restores an enabled listener from SQLite on startup', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.config.set(larkCredentialsConfigKey, JSON.stringify({ appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', listening: true, pushIntervalMs: 1000, hideTraceOnComplete: false }));
    const listener = listenerPool();
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, listener } }); apps.push(app);
    expect(listener.sync).toHaveBeenCalledWith([expect.objectContaining({ listening: true, pushIntervalMs: 1000, traceLimit: 50 })]);
    expect((await app.inject({ method: 'GET', url: '/api/lark/config' })).json()).toMatchObject({ bots: [expect.objectContaining({ listening: true, activeListening: true, groupToolsEnabled: false, groupToolsAllowSend: false, traceLimit: 50 })] });
  });

  it('validates and persists Lark delivery policy', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents } }); apps.push(app);
    const invalid = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', pushIntervalMs: 499 } });
    expect(invalid.statusCode).toBe(400);
    const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex', pushIntervalMs: 20000, traceLimit: 8, hideTraceOnComplete: true } });
    expect(saved.json().bots[0]).toMatchObject({ pushIntervalMs: 20000, traceLimit: 8, hideTraceOnComplete: true });
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0]).toMatchObject({ pushIntervalMs: 20000, traceLimit: 8, hideTraceOnComplete: true });
    const reset = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_saved', traceLimit: null } });
    expect(reset.json().bots[0]).toMatchObject({ traceLimit: 50 });
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0]).toMatchObject({ traceLimit: 50 });
  });

  it('persists independent group-tool discovery and send policies', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents } }); apps.push(app);
    await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_saved', appSecret: 'secret_saved', defaultAgentId: 'codex' } });
    const saved = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_saved', groupToolsEnabled: true, groupToolsAllowSend: false } });
    expect(saved.json().bots[0]).toMatchObject({ groupToolsEnabled: true, groupToolsAllowSend: false });
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0]).toMatchObject({ groupToolsEnabled: true, groupToolsAllowSend: false });
  });

  it('keeps one unique panel per bot and persists each workspace independently', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    const listener = listenerPool();
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, listener } }); apps.push(app);
    const first = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { name: '超级智慧大脑', appId: 'cli_one', appSecret: 'secret_one', workspace: '/work/one', defaultAgentId: 'codex' } });
    expect(first.statusCode).toBe(200);
    const duplicate = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { name: '重复机器人', appId: 'cli_one', appSecret: 'secret_other', workspace: '/work/duplicate', defaultAgentId: 'codex' } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('LARK_BOT_ALREADY_CONFIGURED');
    const relative = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { name: '机器人二号', appId: 'cli_two', appSecret: 'secret_two', workspace: 'relative/path', defaultAgentId: 'codex' } });
    expect(relative.statusCode).toBe(400);
    const second = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { name: '机器人二号', appId: 'cli_two', appSecret: 'secret_two', workspace: '/work/two', defaultAgentId: 'codex' } });
    expect(second.json().bots).toEqual([
      expect.objectContaining({ appId: 'cli_one', name: '超级智慧大脑', workspace: '/work/one' }),
      expect.objectContaining({ appId: 'cli_two', name: '机器人二号', workspace: '/work/two' })
    ]);
  });

  it('creates a bot in two stages, auto-resolves its name, and disambiguates duplicate tab labels', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token-one', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, bot: { app_name: '同名机器人', open_id: 'ou_one' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { user_ids: ['ou_visible'] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { user: { name: '可见用户', email: 'user@example.com' } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token-listen', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, bot: { app_name: '同名机器人', open_id: 'ou_one' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token-two', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, bot: { app_name: '同名机器人', open_id: 'ou_two' } }), { status: 200 }));
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, fetcher: fetcher as typeof fetch, listener: listenerPool() } }); apps.push(app);

    const first = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'lark', appId: 'cli_one', appSecret: 'secret_one', name: '伪造名称', workspace: '/work/one', allowedEmails: ['USER@EXAMPLE.COM'] } });
    expect(first.statusCode).toBe(200);
    expect(first.json().bots[0]).toMatchObject({ appId: 'cli_one', name: '同名机器人', setupComplete: false, allowedEmails: ['user@example.com'], listening: false });
    const firstAgent = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_one', defaultAgentId: 'codex' } });
    expect(firstAgent.json().bots[0]).toMatchObject({ setupComplete: true, defaultAgentId: 'codex' });
    const listeningFromFirstStep = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'lark', originalAppId: 'cli_one', listening: true, allowedEmails: [] } });
    expect(listeningFromFirstStep.json().bots[0]).toMatchObject({ setupComplete: true, listening: true, activeListening: true });

    const second = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'lark', appId: 'cli_two', appSecret: 'secret_two', workspace: '/work/two' } });
    expect(second.json().bots).toEqual([
      expect.objectContaining({ appId: 'cli_one', tabLabel: '同名机器人 · cli_one' }),
      expect.objectContaining({ appId: 'cli_two', tabLabel: '同名机器人 · cli_two', setupComplete: false })
    ]);
  });

  it('requires an installed hook, then locks the Agent while allowing model changes', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const workspace = await mkdtemp(join(tmpdir(), 'agentdock-hard-gate-')); tempDirectories.push(workspace);
    for (const id of ['codex', 'claude']) await repos.agents.save({ id, name: id, command: id, args: [], protocol: 'acp', cwd: workspace, env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true });
    const listener = listenerPool();
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, agents: repos.agents, listener } }); apps.push(app);
    await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { appId: 'cli_guard', appSecret: 'secret', workspace, defaultAgentId: 'codex' } });

    const invalidSyntax = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_guard', gateEnabled: true, highRiskPattern: '(unclosed' } });
    expect(invalidSyntax.statusCode).toBe(400);
    expect(invalidSyntax.json().error).toMatchObject({ code: 'INVALID_HIGH_RISK_PATTERN', message: expect.stringContaining('语法错误') });
    const catastrophic = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_guard', gateEnabled: true, highRiskPattern: '^(a+)+$' } });
    expect(catastrophic.statusCode).toBe(400);
    expect(catastrophic.json().error).toMatchObject({ code: 'INVALID_HIGH_RISK_PATTERN', message: expect.stringContaining('灾难性回溯') });
    const unsafeInstall = await app.inject({ method: 'POST', url: '/api/lark/hooks/install', payload: { appId: 'cli_guard', highRiskPattern: '^(a+)+$' } });
    expect(unsafeInstall.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/lark/hooks/status?appId=cli_guard' })).json()).toMatchObject({ installed: false });

    const beforeInstall = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_guard', gateEnabled: true, hardGateEnabled: true } });
    expect(beforeInstall.statusCode).toBe(409);
    expect(beforeInstall.json().error.code).toBe('HARD_GATE_NOT_READY');

    const installed = await app.inject({ method: 'POST', url: '/api/lark/hooks/install', payload: { appId: 'cli_guard', highRiskPattern: 'rm\\b|examplecli\\b' } });
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toMatchObject({ supported: true, installed: true, writable: true, trustRequired: true });
    expect((await app.inject({ method: 'GET', url: '/api/lark/config' })).json().bots[0]).toMatchObject({ highRiskPattern: 'rm\\b|examplecli\\b', gateEnabled: true, softGateEnabled: true, hardGateEnabled: false, hookTrustConfirmed: true });

    const enabled = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_guard', hardGateEnabled: true } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().bots[0]).toMatchObject({ gateEnabled: true, softGateEnabled: true, hardGateEnabled: true });

    const modelChanged = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_guard', defaultModel: 'model-b', defaultReasoningEffort: 'high' } });
    expect(modelChanged.statusCode).toBe(200);
    expect(modelChanged.json().bots[0]).toMatchObject({ defaultAgentId: 'codex', defaultModel: 'model-b', defaultReasoningEffort: 'high', hardGateEnabled: true });

    const locked = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_guard', defaultAgentId: 'claude' } });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('HARD_GATE_AGENT_LOCKED');
  });

  it('selects the requested persisted bot for service card calls', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_one', appSecret: 'secret_one', defaultAgentId: 'codex', listening: false, pushIntervalMs: 1000, hideTraceOnComplete: false },
      { appId: 'cli_two', appSecret: 'secret_two', defaultAgentId: 'codex', listening: false, pushIntervalMs: 1000, hideTraceOnComplete: false }
    ]));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token_two', expire: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: 'om_two', chat_id: 'oc_group' } }), { status: 200 }));
    const app = await buildApp({} as any, { lark: { env: {}, config: repos.config, fetcher: fetcher as typeof fetch } }); apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/api/lark/send', payload: { botAppId: 'cli_two', chatId: 'oc_group', markdown: 'hello', state: 'completed' } })).json()).toMatchObject({ messageId: 'om_two' });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ app_id: 'cli_two', app_secret: 'secret_two' });
    const missing = await app.inject({ method: 'POST', url: '/api/lark/send', payload: { botAppId: 'cli_missing', chatId: 'oc_group', markdown: 'hello' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('LARK_BOT_NOT_FOUND');
  });

  it('exposes the real macOS directory picker through a guarded system API', async () => {
    const selectDirectory = vi.fn(async () => '/Users/test/project');
    const selectFile = vi.fn(async () => '/Users/test/project/App.tsx');
    const discoverSkills = vi.fn(async () => [{ name: 'review', description: 'Review code', path: '/Users/test/.codex/skills/review/SKILL.md', source: 'user' as const }]);
    const app = await buildApp({} as any, { system: { platform: 'darwin', selectDirectory, selectFile, discoverSkills } }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/system/capabilities' })).json()).toEqual({ platform: 'darwin', directoryPicker: true, filePicker: true, workingDirectory: process.cwd() });
    expect((await app.inject({ method: 'POST', url: '/api/system/select-directory' })).json()).toEqual({ path: '/Users/test/project' });
    expect((await app.inject({ method: 'POST', url: '/api/system/select-file' })).json()).toEqual({ path: '/Users/test/project/App.tsx' });
    expect((await app.inject({ method: 'GET', url: '/api/system/skills?cwd=%2Frepo' })).json()).toEqual([{ name: 'review', description: 'Review code', path: '/Users/test/.codex/skills/review/SKILL.md', source: 'user' }]);
    expect(selectDirectory).toHaveBeenCalledOnce();
    expect(selectFile).toHaveBeenCalledOnce();
    expect(discoverSkills).toHaveBeenCalledWith('/repo');
  });

  it('routes lifecycle actions exclusively through Runtime', async () => {
    const session = { id: 's1', agentId: 'mock', state: 'idle', cwd: '/tmp', permissionMode: 'full-trust', runId: 'r1', createdAt: '', updatedAt: '' };
    const task = { id: 't1', sessionId: 's1', prompt: 'hello', status: 'queued', createdAt: '', updatedAt: '' };
    const runtime: any = { listAgents: vi.fn(async () => []), listSessions: vi.fn(async () => [session]), start: vi.fn(async () => session), getSession: vi.fn(async () => session), getEvents: vi.fn(async () => []), subscribe: vi.fn(() => () => {}), dispatch: vi.fn(async () => task), setModel: vi.fn(async () => ({ ...session, model: 'model-b' })), setReasoningEffort: vi.fn(async () => ({ ...session, reasoningEffort: 'high' })), cancelQueued: vi.fn(async () => ({ ...task, status: 'cancelled' })), steerQueued: vi.fn(async () => task), updateQueued: vi.fn(async () => ({ ...task, prompt: 'edited' })), interrupt: vi.fn(async () => {}), pause: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}), restart: vi.fn(async () => session), archive: vi.fn(async () => ({ ...session, archivedAt: 'now' })), resolvePermission: vi.fn() };
    const app = await buildApp(runtime); apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/api/sessions', payload: { agentId: 'mock', model: 'model-selected-in-web', reasoningEffort: 'high' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: 'hello' } })).statusCode).toBe(202);
    expect((await app.inject({ method: 'PATCH', url: '/api/sessions/s1/config', payload: { model: 'model-b' } })).json()).toMatchObject({ model: 'model-b' });
    expect((await app.inject({ method: 'PATCH', url: '/api/sessions/s1/config', payload: { reasoningEffort: 'high' } })).json()).toMatchObject({ reasoningEffort: 'high' });
    expect((await app.inject({ method: 'DELETE', url: '/api/sessions/s1/queue/t1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/api/sessions/s1/queue/t1', payload: { prompt: 'edited' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/queue/t1/steer' })).statusCode).toBe(200);
    for (const action of ['interrupt', 'pause', 'resume', 'stop', 'restart']) expect((await app.inject({ method: 'POST', url: `/api/sessions/s1/${action}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/archive' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/sessions/s1/permission-mode', payload: { mode: 'ask' } })).statusCode).toBe(404);
    expect(runtime.start).toHaveBeenCalledWith({ agentId: 'mock', model: 'model-selected-in-web', reasoningEffort: 'high' }); expect(runtime.dispatch).toHaveBeenCalledWith('s1', 'hello', 'queue'); expect(runtime.setModel).toHaveBeenCalledWith('s1', 'model-b'); expect(runtime.setReasoningEffort).toHaveBeenCalledWith('s1', 'high'); expect(runtime.cancelQueued).toHaveBeenCalledWith('s1', 't1'); expect(runtime.updateQueued).toHaveBeenCalledWith('s1', 't1', 'edited'); expect(runtime.steerQueued).toHaveBeenCalledWith('s1', 't1'); expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it('exports the complete saved session record, including its initial prompt', async () => {
    const session = { id: 's1', agentId: 'mock', systemPrompt: 'initial instructions' };
    const tasks = [{ id: 't1', sessionId: 's1', prompt: 'hello', sentPrompt: '[bot context]\nhello' }];
    const events = [{ id: 'e1', sessionId: 's1', sequence: 1, type: 'thinking', data: { text: 'reasoning' } }];
    const runtime: any = {
      getSession: vi.fn(async (id: string) => id === 's1' ? session : undefined),
      getTasks: vi.fn(async () => tasks),
      getRecentEvents: vi.fn(async () => events),
      countEvents: vi.fn(async () => 1),
    };
    const app = await buildApp(runtime); apps.push(app);
    const result = await app.inject({ method: 'GET', url: '/api/sessions/s1/record' });
    expect(result.json()).toEqual({ session, tasks, events, eventTotal: 1, eventsTruncated: false });
    expect((await app.inject({ method: 'GET', url: '/api/sessions/missing/record' })).statusCode).toBe(404);
    expect(runtime.getTasks).toHaveBeenCalledOnce();
    // 事件必须有界：全量读在百万行的会话上会把 daemon 拖进 OOM。
    expect(runtime.getRecentEvents).toHaveBeenCalledWith('s1', RECORD_EVENT_LIMIT);
    expect(runtime.countEvents).toHaveBeenCalledOnce();
  });

  it('tells the caller when the record event page is a truncation', async () => {
    const runtime: any = {
      getSession: vi.fn(async () => ({ id: 's1', agentId: 'mock' })),
      getTasks: vi.fn(async () => []),
      getRecentEvents: vi.fn(async () => [{ id: 'e1', sessionId: 's1', sequence: 9000, type: 'text', data: {} }]),
      countEvents: vi.fn(async () => 1450713),
    };
    const app = await buildApp(runtime); apps.push(app);
    const result = await app.inject({ method: 'GET', url: '/api/sessions/s1/record' });
    // 「完整记录」档不能静默少给事件：总数与截断标记必须回给前端，否则用户会拿这份记录对账。
    expect(result.json()).toMatchObject({ eventTotal: 1450713, eventsTruncated: true });
  });

  it('serves the turn map without any event bodies', async () => {
    const turns = [
      { taskId: 'task_1', startSequence: 1, endSequence: 4, segments: 2 },
      { taskId: 'task_2', startSequence: 4, endSequence: 8, segments: 0 }
    ];
    const runtime: any = { getSession: vi.fn(async (id: string) => id === 's1' ? { id: 's1', agentId: 'mock' } : undefined), getTurns: vi.fn(async () => turns) };
    const app = await buildApp(runtime); apps.push(app);
    const result = await app.inject({ method: 'GET', url: '/api/sessions/s1/turns' });
    expect(result.json()).toEqual({ turns });
    expect((await app.inject({ method: 'GET', url: '/api/sessions/missing/turns' })).statusCode).toBe(404);
  });

  it('reads one turn of events with the caller-supplied bounds', async () => {
    const events = [{ id: 'e2', sessionId: 's1', sequence: 2, type: 'thinking', data: { text: '想' } }];
    const runtime: any = {
      getSession: vi.fn(async () => ({ id: 's1', agentId: 'mock' })),
      getTurns: vi.fn(async () => [{ taskId: 'task_1', startSequence: 1, endSequence: 4, segments: 2 }]),
      getTurnEvents: vi.fn(async () => events),
    };
    const app = await buildApp(runtime); apps.push(app);
    const result = await app.inject({ method: 'GET', url: '/api/sessions/s1/turns/task_1/events?after=1&before=4' });
    expect(result.json()).toEqual({ taskId: 'task_1', after: 1, before: 4, events, nextAfter: 2, truncated: true });
    // 客户端带着边界时要跳过一次锚点扫描（重会话上那是一次 184 ms 的全会话读）。
    expect(runtime.getTurns).not.toHaveBeenCalled();
    expect(runtime.getTurnEvents).toHaveBeenCalledWith('s1', { after: 1, before: 4, limit: TURN_EVENT_ROW_LIMIT, maxBytes: TURN_EVENT_BYTE_LIMIT });
  });

  it('derives the turn bounds on the server when the caller has none', async () => {
    const runtime: any = {
      getSession: vi.fn(async () => ({ id: 's1', agentId: 'mock' })),
      getTurns: vi.fn(async () => [{ taskId: 'task_1', startSequence: 1, endSequence: 4, segments: 2 }]),
      getTurnEvents: vi.fn(async () => [{ id: 'e3', sessionId: 's1', sequence: 3, type: 'thinking', data: {} }]),
    };
    const app = await buildApp(runtime); apps.push(app);
    const result = await app.inject({ method: 'GET', url: '/api/sessions/s1/turns/task_1/events' });
    // 取到 before-1 就是整轮都拿到了，不能再报「还有更多」。
    expect(result.json()).toMatchObject({ after: 1, before: 4, nextAfter: 3, truncated: false });
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s1/turns/task_missing/events' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s1/turns/task_1/events?limit=0' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/sessions/s1/turns/task_1/events?limit=${TURN_EVENT_ROW_LIMIT + 1}` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s1/turns/task_1/events?after=-1' })).statusCode).toBe(400);
  });

  it('validates queued send input before handing it to Runtime', async () => {
    const runtime: any = { dispatch: vi.fn() };
    const app = await buildApp(runtime); apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: '   ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/s1/send', payload: { prompt: 'hello', mode: 'later' } })).statusCode).toBe(400);
    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it('validates queued task edit input before handing it to Runtime', async () => {
    const runtime: any = { updateQueued: vi.fn() };
    const app = await buildApp(runtime); apps.push(app);
    expect((await app.inject({ method: 'PATCH', url: '/api/sessions/s1/queue/t1', payload: { prompt: '   ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/sessions/s1/queue/t1', payload: {} })).statusCode).toBe(400);
    expect(runtime.updateQueued).not.toHaveBeenCalled();
  });

  it('does not rewrite Lark bot defaults when a session model changes', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_one', appSecret: 'secret', defaultAgentId: 'codex', defaultModel: 'model-a', defaultReasoningEffort: 'low', listening: false, pushIntervalMs: 1000, hideTraceOnComplete: false }]));
    const runtime: any = { setModel: vi.fn(async () => ({ id: 's1', model: 'model-b' })) };
    const app = await buildApp(runtime, { lark: { env: {}, config: repos.config, fetcher: vi.fn() as any } }); apps.push(app);
    expect((await app.inject({ method: 'PATCH', url: '/api/sessions/s1/config', payload: { model: 'model-b' } })).statusCode).toBe(200);
    expect(runtime.setModel).toHaveBeenCalledWith('s1', 'model-b');
    expect(JSON.parse((await repos.config.get(larkBotsConfigKey))!)[0]).toMatchObject({ defaultModel: 'model-a', defaultReasoningEffort: 'low' });
  });

  it('replays missed SSE events after Last-Event-ID reconnect', async () => {
    const missed = { id: 'e2', sessionId: 's1', sequence: 2, type: 'text', timestamp: new Date().toISOString(), data: { text: 'replayed' } };
    const runtime: any = { listAgents: async () => [], listSessions: async () => [], getSession: async () => undefined, start: vi.fn(), send: vi.fn(), interrupt: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), restart: vi.fn(), resolvePermission: vi.fn(), getEventPage: vi.fn(async (_id: string, after: number) => after === 1 ? [missed] : []), subscribe: vi.fn(() => () => {}) };
    const app = await buildApp(runtime); apps.push(app); await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    const controller = new AbortController(); const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/s1/stream`, { headers: { 'Last-Event-ID': '1' }, signal: controller.signal });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let chunk = '';
    while (!chunk.includes('id: 2')) { const next = await reader.read(); if (next.done) break; chunk += decoder.decode(next.value); }
    controller.abort();
    expect(chunk).toContain('id: 2'); expect(chunk).toContain('replayed'); expect(runtime.getEventPage).toHaveBeenCalledWith('s1', 1, expect.any(Number));
  });

  it('continues after the newest SSE cursor without replaying acknowledged events', async () => {
    const runtime: any = { listAgents: async () => [], listSessions: async () => [], getSession: async () => undefined, start: vi.fn(), send: vi.fn(), interrupt: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), restart: vi.fn(), resolvePermission: vi.fn(), getEventPage: vi.fn(async () => []), subscribe: vi.fn(() => () => {}) };
    const app = await buildApp(runtime); apps.push(app); await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    const controller = new AbortController(); await fetch(`http://127.0.0.1:${address.port}/api/sessions/s1/stream?after=4`, { headers: { 'Last-Event-ID': '9' }, signal: controller.signal }); controller.abort();
    expect(runtime.getEventPage).toHaveBeenCalledWith('s1', 9, expect.any(Number));
  });

  // 无 limit 的 /events 改成流式输出后，响应体必须还是原来那个 JSON 数组：客户端拿它直接
  // 当数组用，形状变了就是静默的契约破坏。这里连空数组（[] 而不是空响应体）一起守住。
  it('streams the unbounded events route as a JSON array', async () => {
    const events = [
      { id: 'e1', sessionId: 's1', sequence: 1, type: 'text', timestamp: '2026-09-24T00:00:01.000Z', data: { text: '一' } },
      { id: 'e2', sessionId: 's1', sequence: 2, type: 'thinking', timestamp: '2026-09-24T00:00:02.000Z', data: { text: '二', role: 'assistant' } }
    ];
    const runtime: any = { listAgents: async () => [], listSessions: async () => [], getSession: async () => undefined, start: vi.fn(), subscribe: vi.fn(() => () => {}), maxEventSequence: vi.fn(async () => 2), getEventPage: vi.fn(async (_id: string, after: number, limit: number) => events.filter(event => event.sequence > after).slice(0, limit)) };
    const app = await buildApp(runtime); apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/sessions/s1/events' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual(events);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s1/events?after=2' })).json()).toEqual([]);
    expect(runtime.getEventPage).toHaveBeenCalledWith('s1', 0, expect.any(Number));
  });

  // 分页回放每次都是新查询：活跃会话上新行不断，不钉上界就永远收不了尾。
  // 这里让取页永远返回「满一页」，只有快照上界能让它停。
  it('bounded replay stops at the snapshot max even while new rows keep arriving', async () => {
    const runtime: any = {
      listAgents: async () => [], listSessions: async () => [], getSession: async () => undefined, start: vi.fn(), subscribe: vi.fn(() => () => {}),
      maxEventSequence: vi.fn(async () => 3),
      getEventPage: vi.fn(async (_id: string, after: number, limit: number) => Array.from({ length: limit }, (_, index) => ({
        id: `e${after + 1 + index}`, sessionId: 's1', sequence: after + 1 + index, type: 'text', timestamp: '2026-09-24T00:00:01.000Z', data: { text: 'x' }
      })))
    };
    const app = await buildApp(runtime); apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/sessions/s1/events' });
    expect(response.statusCode).toBe(200);
    expect(response.json().map((event: { sequence: number }) => event.sequence)).toEqual([1, 2, 3]);
    expect(runtime.maxEventSequence).toHaveBeenCalledWith('s1');
  });

  it('serves the bundled Web UI while preserving API 404 responses', async () => {
    const webRoot = await mkdtemp(join(tmpdir(), 'agent-dock-web-')); tempDirectories.push(webRoot);
    await mkdir(join(webRoot, 'assets'));
    await writeFile(join(webRoot, 'index.html'), '<main>AgentDock UI</main>');
    await writeFile(join(webRoot, 'assets', 'app.js'), 'globalThis.agentDock = true;');
    const runtime: any = { listAgents: async () => [], listSessions: async () => [], getSession: async () => undefined, start: vi.fn(), send: vi.fn(), interrupt: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), restart: vi.fn(), resolvePermission: vi.fn(), getEvents: vi.fn(async () => []), getTasks: vi.fn(async () => []), subscribe: vi.fn(() => () => {}) };
    const app = await buildApp(runtime, { webRoot }); apps.push(app);

    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200); expect(index.headers['content-type']).toContain('text/html'); expect(index.body).toContain('AgentDock UI');
    expect(index.headers['cache-control']).toContain('must-revalidate');
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200); expect(asset.headers['cache-control']).toContain('immutable');
    const sessionPage = await app.inject({ method: 'GET', url: '/sessions/s1' });
    expect(sessionPage.body).toContain('AgentDock UI');
    expect(sessionPage.headers['cache-control']).toContain('must-revalidate');
    const api = await app.inject({ method: 'GET', url: '/api/not-real' });
    expect(api.statusCode).toBe(404); expect(api.json().error.code).toBe('NOT_FOUND');
  });

  describe('session file uploads', () => {
    const uploadRuntime = () => ({
      listAgents: async () => [], listSessions: async () => [], getSession: async (id: string) => ({ id, agentId: 'mock', state: 'idle', cwd: '/tmp', runId: 'run', createdAt: '', updatedAt: '' }),
      start: vi.fn(), send: vi.fn(), interrupt: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), restart: vi.fn(), resolvePermission: vi.fn(),
      getEvents: vi.fn(async () => []), getTasks: vi.fn(async () => []), subscribe: vi.fn(() => () => {})
    } as any);

    // 浏览器对 .md / .heic / .zip 等的 content-type 上报很不一致；固定白名单会以
    // 一个无法读懂的 415 FST_ERR_CTP_INVALID_MEDIA_TYPE 拒绝这些合法文件。
    for (const [contentType, filename, expectedExt] of [
      ['text/markdown', 'notes.md', '.md'],
      ['image/heic', 'IMG_0001.heic', '.heic'],
      ['application/x-zip-compressed', 'bundle.zip', '.zip'],
      ['image/png', 'shot.png', '.png']
    ] as const) {
      it(`accepts a ${contentType} upload and keeps a sensible extension`, async () => {
        const app = await buildApp(uploadRuntime()); apps.push(app);
        const response = await app.inject({
          method: 'POST', url: '/api/sessions/ses_up/uploads',
          headers: { 'content-type': contentType, 'x-upload-filename': encodeURIComponent(filename) },
          payload: Buffer.from('binary-body')
        });
        expect(response.statusCode).toBe(201);
        expect(response.json().filename.endsWith(expectedExt)).toBe(true);
        tempDirectories.push(join(homedir(), '.agentdock', 'uploads', 'ses_up'));
      });
    }

    it('stores a JSON upload as raw bytes instead of a parsed object', async () => {
      // application/json 若走 JSON parser，writeFile 会收到已解析对象并抛 ERR_INVALID_ARG_TYPE（500）。
      const app = await buildApp(uploadRuntime()); apps.push(app);
      const body = JSON.stringify({ hello: 'world' });
      const response = await app.inject({
        method: 'POST', url: '/api/sessions/ses_json/uploads',
        headers: { 'content-type': 'application/json', 'x-upload-filename': 'data.json' },
        payload: body
      });
      expect(response.statusCode).toBe(201);
      const saved = response.json();
      expect(saved.filename.endsWith('.json')).toBe(true);
      expect(await readFile(saved.path, 'utf8')).toBe(body);
      tempDirectories.push(join(homedir(), '.agentdock', 'uploads', 'ses_json'));
    });

    it('still parses application/json for ordinary API routes', async () => {
      const runtime = uploadRuntime();
      runtime.dispatch = vi.fn(async () => ({ id: 'task_1', status: 'queued' }));
      const app = await buildApp(runtime); apps.push(app);
      const response = await app.inject({ method: 'POST', url: '/api/sessions/ses_1/send', payload: { prompt: 'hello' } });
      expect(response.statusCode).toBe(202);
      expect(runtime.dispatch).toHaveBeenCalledWith('ses_1', 'hello', 'queue');
    });

    // 上传文件此前只写不删，磁盘会被无声占满（截图/视频尤其明显）。
    it('garbage-collects uploads past the TTL and keeps recent ones', async () => {
      const sessionDir = join(homedir(), '.agentdock', 'uploads', 'ses_gc');
      await mkdir(sessionDir, { recursive: true });
      const stale = join(sessionDir, 'stale.png');
      const fresh = join(sessionDir, 'fresh.png');
      await writeFile(stale, 'old'); await writeFile(fresh, 'new');
      // 把一个文件的 mtime 推到 8 天前（TTL 为 7 天）。
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
      await utimes(stale, eightDaysAgo, eightDaysAgo);
      // buildApp 启动时会跑一次回收。
      const app = await buildApp(uploadRuntime()); apps.push(app);
      await vi.waitFor(async () => expect(existsSync(stale)).toBe(false));
      expect(existsSync(fresh)).toBe(true);
      tempDirectories.push(sessionDir);
    });

    it('rejects an empty upload with a readable error rather than a 415', async () => {
      const app = await buildApp(uploadRuntime()); apps.push(app);
      const response = await app.inject({
        method: 'POST', url: '/api/sessions/ses_empty/uploads',
        headers: { 'content-type': 'text/markdown' }, payload: Buffer.alloc(0)
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({ code: 'INVALID_UPLOAD', message: expect.stringContaining('空') });
    });
  });

});

describe('agent enable/disable route', () => {
  const mount = async () => {
    const runtime = {
      listAgents: vi.fn(async () => [{ id: 'claude', name: 'Claude Code', builtin: true, disabled: true }]),
      setAgentDisabled: vi.fn(async (id: string, disabled: boolean) => ({ id, name: 'Claude Code', builtin: true, disabled }))
    };
    const app = await buildApp(runtime as any, {});
    apps.push(app);
    return { app, runtime };
  };

  it('re-enables through the dedicated route', async () => {
    const { app, runtime } = await mount();
    const response = await app.inject({ method: 'POST', url: '/api/agents/claude/disabled', payload: { disabled: false } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'claude', disabled: false });
    expect(runtime.setAgentDisabled).toHaveBeenCalledWith('claude', false);
  });

  it('rejects a non-boolean so it cannot be used to smuggle other fields', async () => {
    const { app, runtime } = await mount();
    for (const payload of [{}, { disabled: 'false' }, { disabled: 1 }, { disabled: null }]) {
      const response = await app.inject({ method: 'POST', url: '/api/agents/claude/disabled', payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_DISABLED');
    }
    expect(runtime.setAgentDisabled).not.toHaveBeenCalled();
  });
});

describe('web access gate', () => {
  const secret = 'gate-test-secret-0123456789abcdef';
  // 访问门新增「本机直连即机器所有者」：inject 默认源地址就是 127.0.0.1、Host 是 localhost，
  // 恰好等价于本机，所以模拟外部访问必须显式给出局域网源地址与 Host。
  const remote = { remoteAddress: '192.168.1.9', headers: { host: '192.168.1.9:4310' } };
  const build = async () => {
    const app = await buildApp({ listAgents: vi.fn(async () => []), listSessions: vi.fn(async () => []), getEventPage: vi.fn(async () => []), maxEventSequence: vi.fn(async () => 0) } as any, { webAuth: { enabled: true, secret }, lark: { env: {} } });
    apps.push(app);
    return app;
  };

  it('访问密码：未设置时不可登录；设置后输对密码发放全权 cookie，输错被拒并限流', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentdock-login-')); tempDirectories.push(dir);
    const passwordFile = join(dir, 'web-password');
    const app = await buildApp({ listAgents: vi.fn(async () => []), listSessions: vi.fn(async () => []), getEventPage: vi.fn(async () => []), maxEventSequence: vi.fn(async () => 0) } as any, { webAuth: { enabled: true, secret, passwordFile }, lark: { env: {} } });
    apps.push(app);
    const login = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { password }, ...remote });

    expect((await app.inject({ method: 'GET', url: '/api/auth/status', ...remote })).json()).toEqual({ passwordEnabled: false });
    expect((await login('anything')).statusCode).toBe(404);

    setWebPassword('open-sesame', passwordFile);
    expect((await app.inject({ method: 'GET', url: '/api/auth/status', ...remote })).json()).toEqual({ passwordEnabled: true });
    const wrong = await login('nope');
    expect(wrong.statusCode).toBe(400);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const ok = await login('open-sesame');
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    expect(cookie.startsWith(`${webAccessCookieName}=`)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/agents', ...remote, headers: { ...remote.headers, cookie } })).statusCode).toBe(200);

    for (let i = 0; i < 10; i += 1) await login('nope');
    expect((await login('open-sesame')).statusCode).toBe(429);
  });

  it('blocks APIs without a token while leaving the SPA shell public', async () => {
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/api/agents', ...remote })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/health', ...remote })).statusCode).toBe(200);
    // 非 /api 的壳页面不经门（无 webRoot 时走 notFound，重点是不返 401）。
    expect((await app.inject({ method: 'GET', url: '/', ...remote })).statusCode).not.toBe(401);
  });

  it('keeps host account quotas out of session links', async () => {
    const app = await build();
    const { issueSessionToken } = await import('./web-access.js');
    const token = issueSessionToken('ses_x', secret);
    for (const provider of ['codex', 'claude', 'cursor']) {
      const response = await app.inject({ method: 'GET', url: `/api/${provider}/usage?t=${token}`, ...remote });
      expect(response.statusCode).toBe(403);
    }
  });

  it('trusts a bare local visit as the machine owner and plants a long-lived master cookie', async () => {
    const app = await build();
    // 不带任何凭证、不带 ?t=，只是本机打开控制台——这正是用户「cookie 有效期很短」的真身：
    // 凭证是 cookie，cookie 按源隔离，localhost / 127.0.0.1 / [::1] 三个源互不相通，
    // 而启动只打印其中一个的带凭证链接。本机直连必须自己就能拿到全权凭证。
    const response = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(response.statusCode).not.toBe(401);
    const cookie = (response.headers['set-cookie'] ?? '') as string;
    expect(cookie).toContain('agentdock_web=');
    expect(cookie).toContain('HttpOnly');
    // master 一年有效，对齐 defaultMasterTokenTtlMs。
    const maxAge = Number(cookie.match(/Max-Age=(\d+)/)?.[1]);
    expect(maxAge).toBeGreaterThan(360 * 24 * 60 * 60);
    // 管理面同样放行：本机主人不应被自己机器的门挡住。
    expect((await app.inject({ method: 'PUT', url: '/api/lark/config', payload: {} })).statusCode).not.toBe(401);
  });

  it('does not let a cross-site page ride the loopback free pass', async () => {
    const app = await build();
    // Sec-Fetch-Site 由浏览器自己填写，页面改不了。任意网页都能借本机回环直连 daemon，
    // 没有这一条就等于给所有网页开了本机写权限（含终端 pty）。
    const csrf = await app.inject({ method: 'GET', url: '/api/sessions', headers: { 'sec-fetch-site': 'cross-site' } });
    expect(csrf.statusCode).toBe(401);
    // same-site（同站不同端口，如另一个本地 dev server）同样不放行。
    const sameSite = await app.inject({ method: 'GET', url: '/api/sessions', headers: { 'sec-fetch-site': 'same-site' } });
    expect(sameSite.statusCode).toBe(401);
    // 显式同源与直接导航（地址栏输入）才认。
    expect((await app.inject({ method: 'GET', url: '/api/sessions', headers: { 'sec-fetch-site': 'same-origin' } })).statusCode).not.toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/sessions', headers: { 'sec-fetch-site': 'none' } })).statusCode).not.toBe(401);
  });

  it('rejects a rebound host header even when the source address is loopback', async () => {
    const app = await build();
    // DNS rebinding：攻击者把域名解析到 127.0.0.1，浏览器发来的请求源地址也是回环。
    // 只信源地址会把本机控制台交给任意网页，Host 头必须也是回环名。
    const rebound = await app.inject({ method: 'GET', url: '/api/sessions', headers: { host: 'evil.example.com:4310' } });
    expect(rebound.statusCode).toBe(401);
  });

  it('keeps a session card link from overwriting the console master cookie', async () => {
    const app = await build();
    const { issueSessionToken } = await import('./web-access.js');
    const token = issueSessionToken('ses_x', secret);
    const probe = await app.inject({ method: 'GET', url: `/sessions/ses_x?t=${token}` });
    const cookie = (probe.headers['set-cookie'] ?? '') as string;
    // 会话凭证写进独立 cookie 名：两者同名时，打开一张卡片链接会把控制台的全权 cookie
    // 覆盖成会话级，之后管理面全部 403，用户看到的是「鉴权自己坏了」。
    expect(cookie).toContain('agentdock_web_session=');
    expect(cookie).not.toContain('agentdock_web=');
  });

  it('exchanges a valid ?t= visit for a cookie and strips the token from the URL', async () => {
    const app = await build();
    const { issueSessionToken } = await import('./web-access.js');
    const token = issueSessionToken('ses_x', secret);
    const probe = await app.inject({ method: 'GET', url: `/sessions/ses_x?t=${token}` });
    expect([302, 301]).toContain(probe.statusCode);
    expect(probe.headers.location).toBe('/sessions/ses_x');
    const cookie = probe.headers['set-cookie'] as string;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // cookie 必须带 Max-Age 且对齐 token TTL（30 天），否则退化为会话 cookie，关浏览器就没权限。
    expect(cookie).toContain('Max-Age=');
    const maxAge = Number(cookie.match(/Max-Age=(\d+)/)?.[1]);
    expect(maxAge).toBeGreaterThan(29 * 24 * 60 * 60);
    expect(maxAge).toBeLessThanOrEqual(30 * 24 * 60 * 60);
    // 带 cookie 访问本会话 API 放行；带 token 直接访问 API 也认。
    expect((await app.inject({ method: 'GET', url: '/api/sessions/ses_x/events', headers: { cookie } })).statusCode).not.toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/sessions/ses_x/events?t=${token}` })).statusCode).not.toBe(401);
  });

  it('scopes a session token to its own session and keeps management routes closed', async () => {
    const app = await build();
    const { issueSessionToken } = await import('./web-access.js');
    const token = issueSessionToken('ses_x', secret);
    const other = await app.inject({ method: 'GET', url: `/api/sessions/ses_y/events?t=${token}` });
    expect(other.statusCode).toBe(403);
    const management = await app.inject({ method: 'PUT', url: `/api/lark/config?t=${token}`, payload: {} });
    expect(management.statusCode).toBe(403);
    // 打开会话页时 SPA 无条件拉这几个全局只读接口：任何一个 403 都会把整页打成「访问被拒」，
    // 让持有效卡片链接的用户被再要一次密码。这里断言它们确实过门；fake runtime 下路由可能没注册，
    // 所以只要不是 401/403 即算过门（404 = 路由缺失，500 = fake 缺方法）。
    for (const url of ['/api/system/skills', '/api/system/update', '/api/schedules?sessionId=ses_x']) {
      const response = await app.inject({ method: 'GET', url: `${url}${url.includes('?') ? '&' : '?'}t=${token}` });
      expect([401, 403]).not.toContain(response.statusCode);
    }
    const foreignSchedules = await app.inject({ method: 'GET', url: `/api/schedules?sessionId=ses_y&t=${token}` });
    expect(foreignSchedules.statusCode).toBe(403);
    const updateTrigger = await app.inject({ method: 'POST', url: `/api/system/update?t=${token}` });
    expect(updateTrigger.statusCode).toBe(403);
  });

  it('lets a master token through everywhere', async () => {
    const app = await build();
    const { issueMasterToken } = await import('./web-access.js');
    const token = issueMasterToken(secret);
    const response = await app.inject({ method: 'GET', url: `/api/lark/config?t=${token}` });
    expect([200, 500]).toContain(response.statusCode); // 非 401/403 即过门（500 只是 fake runtime 缺方法）
  });

  it('does not gate the in-agent group tools API: it has its own per-session bearer auth', async () => {
    const app = await build();
    // 未注册 group tools service 时路由不存在 → 404；关键是不能被访问门拦成 401。
    // 带 Bearer 也一样：路由自身鉴权 fail-closed，由 agent-tools 的测试覆盖。
    const response = await app.inject({ method: 'GET', url: '/api/lark/agent-tools/self' });
    expect(response.statusCode).not.toBe(401);
  });
});
