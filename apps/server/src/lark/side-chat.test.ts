import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import type { AgentConfig, Session } from '@agent-dock/agent-dock-shared';
import { saveLarkConfig, type StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator, larkSideChatThreadChannel } from './listener.js';
import { SideChatConfigService } from '../side-chat-config.js';

const reposToClose: ReturnType<typeof createRepositories>[] = [];
afterEach(() => reposToClose.splice(0).forEach(repo => repo.close()));

const baseBotConfig: StoredLarkConfig = {
  appId: 'cli_side_test',
  appSecret: 'secret',
  workspace: '/workspace/project',
  defaultAgentId: 'codex',
  defaultModel: 'gpt-5',
  defaultReasoningEffort: 'medium',
  listening: true,
  preInjectPrompt: '',
  groupToolsEnabled: false,
  groupToolsAllowSend: false,
  groupSessionScope: 'chat',
  pushIntervalMs: 1_000,
  hideTraceOnComplete: false,
  quietReply: false,
  allowedUsers: [],
  allowedEmails: [],
  highRiskAllowedUsers: [],
  highRiskAllowedEmails: [],
  highRiskPattern: 'rm\\b',
  gateEnabled: false,
  softGateEnabled: false,
  hardGateEnabled: false,
  hookTrustConfirmed: false
};

const fakeAgents: AgentConfig[] = [
  { id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', env: {}, permissionMode: 'full-trust', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true },
  { id: 'claude', name: 'Claude Code', command: 'claude', args: [], protocol: 'acp', env: {}, permissionMode: 'full-trust', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true }
];

function createFakeRuntime() {
  const sessions = new Map<string, Session>();
  let seq = 0;
  return {
    sessions,
    listAgents: vi.fn(async () => fakeAgents),
    listSessions: vi.fn(async () => [...sessions.values()]),
    getSession: vi.fn(async (id: string) => sessions.get(id)),
    start: vi.fn(async (input: any) => {
      seq += 1;
      const created: Session = {
        id: `ses_${seq}`,
        agentId: input.agentId,
        state: 'idle',
        cwd: input.cwd ?? '/workspace/project',
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        systemPrompt: input.systemPrompt,
        permissionMode: input.permissionMode ?? 'full-trust',
        source: input.source,
        sourceId: input.sourceId,
        runId: `run_${seq}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      sessions.set(created.id, created);
      return created;
    }),
    subscribe: vi.fn(() => vi.fn()),
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {})
  };
}

function createFakeLarkService() {
  return {
    getUserName: vi.fn(async () => '小明'),
    getChat: vi.fn(async () => ({ name: '研发群' })),
    listChats: vi.fn(async () => ({ items: [] })),
    addReaction: vi.fn(async () => ({ reactionId: 'r1' })),
    deleteReaction: vi.fn(async () => {}),
    reply: vi.fn(async () => ({ messageId: 'om_card_reply' })),
    send: vi.fn(async () => ({ messageId: 'om_card_send' })),
    update: vi.fn(async () => ({})),
    replyText: vi.fn(async () => ({ messageId: 'om_text_reply' })),
    sendText: vi.fn(async () => ({ messageId: 'om_text_send' }))
  };
}

describe('飞书机器人侧边对话（/btw 与话题续聊）', () => {
  it('群聊命中默认 /btw：创建关联主会话的 side-chat 会话、不污染主会话，并以话题回复（replyInThread: true）', async () => {
    const repo = createRepositories(':memory:');
    reposToClose.push(repo);
    await saveLarkConfig(repo.config, undefined, baseBotConfig);
    const runtime = createFakeRuntime();
    const service = createFakeLarkService();
    const coordinator = new LarkMessageCoordinator(
      runtime as any,
      service as any,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      Math.random,
      'ou_bot',
      undefined,
      repo.channelMappings,
      repo.config
    );

    // 1. 先发一条普通消息建立主会话
    await coordinator.handle({
      messageId: 'om_main_1',
      chatId: 'oc_group_1',
      chatType: 'group',
      messageType: 'text',
      content: JSON.stringify({ text: '@_user_1 帮我重构这个模块' }),
      senderOpenId: 'ou_user_1',
      mentions: [{ key: '@_user_1', name: 'Lucy', openId: 'ou_bot' }]
    }, baseBotConfig);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(1));
    const mainSessionId = runtime.send.mock.calls[0]?.[0] as string;
    expect(mainSessionId).toBe('ses_1');

    // 2. 发一条 /btw 侧聊消息
    await coordinator.handle({
      messageId: 'om_btw_root',
      chatId: 'oc_group_1',
      chatType: 'group',
      messageType: 'text',
      content: JSON.stringify({ text: '@_user_1 /btw remind 灰度是什么，是本次新增的吗' }),
      senderOpenId: 'ou_user_1',
      mentions: [{ key: '@_user_1', name: 'Lucy', openId: 'ou_bot' }]
    }, baseBotConfig);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(2));

    // 验证新建了 side-chat 会话且关联主会话
    expect(runtime.start).toHaveBeenCalledTimes(2);
    const sideStartInput = runtime.start.mock.calls[1]?.[0];
    expect(sideStartInput).toMatchObject({
      agentId: 'codex',
      cwd: '/workspace/project',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      source: 'side-chat',
      sourceId: mainSessionId
    });
    expect(sideStartInput.systemPrompt).toContain(mainSessionId);

    // 验证发给侧边会话的正文已剥离 /btw，且没有发进主会话
    const sideSessionId = runtime.send.mock.calls[1]?.[0] as string;
    expect(sideSessionId).toBe('ses_2');
    expect(runtime.send.mock.calls[1]?.[1]).toBe('小明: remind 灰度是什么，是本次新增的吗');

    // 验证飞书回复强制使用话题回复 replyInThread: true，并携带「🕊️ 飞书 · 侧边对话」青绿 Tag
    expect(service.reply).toHaveBeenLastCalledWith(expect.objectContaining({
      messageId: 'om_btw_root',
      replyInThread: true,
      sessionId: sideSessionId,
      sourceBadge: { label: '🕊️ 飞书 · 侧边对话', color: 'turquoise' }
    }));

    // 验证话题映射已持久化到 channelMappings
    const persisted = await repo.channelMappings.get(larkSideChatThreadChannel(baseBotConfig.appId), 'om_btw_root');
    expect(persisted?.sessionId).toBe(sideSessionId);

    // 3. 在同一侧聊话题下追问（无需 @ 机器人，也无需再敲 /btw），应直接路由到同一侧边会话
    await coordinator.handle({
      messageId: 'om_btw_followup',
      rootId: 'om_btw_root',
      threadId: 'omt_thread_1',
      chatId: 'oc_group_1',
      chatType: 'group',
      messageType: 'text',
      content: JSON.stringify({ text: '那它的配置开关在哪里？' }),
      senderOpenId: 'ou_user_1',
      mentions: []
    }, baseBotConfig);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(3));

    expect(runtime.start).toHaveBeenCalledTimes(2); // 没有新建第三个会话
    expect(runtime.send.mock.calls[2]?.[0]).toBe(sideSessionId);
    expect(runtime.send.mock.calls[2]?.[1]).toBe('小明: 那它的配置开关在哪里？');
    expect(service.reply).toHaveBeenLastCalledWith(expect.objectContaining({
      messageId: 'om_btw_followup',
      replyInThread: true,
      sessionId: sideSessionId
    }));

    // 4. 在侧聊话题里 @ 了别人（未 @ 机器人）时跳过，不打扰
    await coordinator.handle({
      messageId: 'om_btw_other_mention',
      rootId: 'om_btw_root',
      threadId: 'omt_thread_1',
      chatId: 'oc_group_1',
      chatType: 'group',
      messageType: 'text',
      content: JSON.stringify({ text: '@_user_2 你看下上面结论' }),
      senderOpenId: 'ou_user_1',
      mentions: [{ key: '@_user_2', name: '同事', openId: 'ou_colleague' }]
    }, baseBotConfig);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(runtime.send).toHaveBeenCalledTimes(3);

    coordinator.stop();
  });

  it('复用用户自定义的触发前缀（btw:）与独立 Agent/模型/思考深度配置', async () => {
    const repo = createRepositories(':memory:');
    reposToClose.push(repo);
    await saveLarkConfig(repo.config, undefined, baseBotConfig);
    const configService = new SideChatConfigService({ config: repo.config, listAgents: () => fakeAgents });
    await configService.save({
      targetMode: 'custom_agent',
      agentId: 'claude',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'high',
      openMode: 'side_pane',
      btwEnabled: true,
      triggerPrefix: 'btw:',
      btwSessionReuse: 'new_session'
    });

    const runtime = createFakeRuntime();
    const service = createFakeLarkService();
    const coordinator = new LarkMessageCoordinator(
      runtime as any,
      service as any,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      Math.random,
      'ou_bot',
      undefined,
      repo.channelMappings,
      repo.config
    );

    await coordinator.handle({
      messageId: 'om_custom_btw',
      chatId: 'oc_group_2',
      chatType: 'group',
      messageType: 'text',
      content: JSON.stringify({ text: '@_user_1 btw: remind 灰度是什么' }),
      senderOpenId: 'ou_user_1',
      mentions: [{ key: '@_user_1', name: 'Lucy', openId: 'ou_bot' }]
    }, baseBotConfig);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(1));

    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'claude',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'high',
      source: 'side-chat'
    }));
    expect(runtime.send.mock.calls[0]?.[1]).toBe('小明: remind 灰度是什么');
    expect(service.reply).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'om_custom_btw',
      replyInThread: true
    }));

    coordinator.stop();
  });

  it('关闭快捷触发（btwEnabled: false）时 /btw 按普通主会话消息处理', async () => {
    const repo = createRepositories(':memory:');
    reposToClose.push(repo);
    await saveLarkConfig(repo.config, undefined, baseBotConfig);
    const configService = new SideChatConfigService({ config: repo.config, listAgents: () => fakeAgents });
    await configService.save({
      targetMode: 'follow_current',
      openMode: 'side_pane',
      btwEnabled: false,
      triggerPrefix: '/btw',
      btwSessionReuse: 'new_session'
    });

    const runtime = createFakeRuntime();
    const service = createFakeLarkService();
    const coordinator = new LarkMessageCoordinator(
      runtime as any,
      service as any,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      Math.random,
      'ou_bot',
      undefined,
      repo.channelMappings,
      repo.config
    );

    await coordinator.handle({
      messageId: 'om_disabled_btw',
      chatId: 'oc_group_3',
      chatType: 'group',
      messageType: 'text',
      content: JSON.stringify({ text: '@_user_1 /btw 走主会话' }),
      senderOpenId: 'ou_user_1',
      mentions: [{ key: '@_user_1', name: 'Lucy', openId: 'ou_bot' }]
    }, baseBotConfig);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledTimes(1));

    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      source: 'lark'
    }));
    expect(runtime.send.mock.calls[0]?.[1]).toBe('小明: /btw 走主会话');

    coordinator.stop();
  });
});
