import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  askUserQuestionOutputPlugin,
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  confirmActionOutputPlugin,
  type AgentEvent,
  type ChannelMapping,
  type ChannelMappingRepository,
  type ConfigRepository,
  type DeclarativeOutputPluginManifest,
  type RuntimeTurnEvent,
  type RuntimeTurnStartedEvent,
  type Session,
  type TaskRecord
} from '@agent-dock/agent-dock-shared';
import { OutputPluginService } from '../../output-plugins/service.js';
import { LARK_ASK_CARD_CHANNEL } from '../ask-user-question-card.js';
import { defaultHighRiskPattern, saveLarkConfig, type StoredLarkConfig } from '../config.js';
import {
  LarkMessageCoordinator,
  larkHandoverChannel,
  type LarkListenerPool,
  type LarkMessageEvent,
  type LarkRuntime
} from '../listener.js';
import { registerLarkRoutes } from '../routes.js';
import { buildLarkOriginSourceBadge, LarkServiceError, type LarkCardService } from '../service.js';
import { LarkTurnSyncService, type LarkTurnSyncCardPort } from '../turn-sync.js';
import { LarkTurnTracker } from '../turn-tracker.js';
import {
  buildLarkOutputPluginCardIdempotencyKey,
  createDefaultLarkOutputPluginAdapterRegistry,
  dispatchLarkOutputPluginCard,
  LARK_OUTPUT_PLUGIN_CARD_CHANNEL
} from './index.js';

function createMemoryConfig(): ConfigRepository {
  const store = new Map<string, string>();
  return {
    get: async key => store.get(key),
    set: async (key, value) => { store.set(key, value); }
  };
}

function createMemoryMappings(): ChannelMappingRepository {
  const store = new Map<string, ChannelMapping>();
  return {
    get: async (channel, externalId) => store.get(`${channel}:${externalId}`),
    list: async channel => [...store.values()].filter(row => row.channel === channel),
    save: async mapping => { store.set(`${mapping.channel}:${mapping.externalId}`, mapping); }
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const baseBotConfig: StoredLarkConfig = {
  appId: 'cli_dedup_bot',
  appSecret: 'secret_dedup_placeholder',
  name: '防重测试机器人',
  defaultAgentId: 'codex',
  listening: true,
  groupToolsEnabled: false,
  groupToolsAllowSend: false,
  groupSessionScope: 'chat',
  pushIntervalMs: 500,
  hideTraceOnComplete: false,
  quietReply: false,
  webBaseUrl: 'http://127.0.0.1:4310',
  allowedUsers: [],
  allowedUserNames: {},
  allowedEmails: [],
  allowedBots: [],
  allowedBotNames: {},
  peerBotsAllowed: true,
  highRiskAllowedUsers: [],
  highRiskAllowedUserNames: {},
  highRiskAllowedEmails: [],
  highRiskPattern: defaultHighRiskPattern,
  gateEnabled: false,
  softGateEnabled: false,
  hardGateEnabled: false,
  hookTrustConfirmed: false
};

const deployApprovalManifest: DeclarativeOutputPluginManifest = {
  id: 'local:deploy-approval',
  name: '发布审批单',
  description: '发布审批卡片',
  icon: 'shield-check',
  tagName: 'agentdock-deploy-approval',
  version: '1.0.0',
  defaultEnabled: true,
  kind: 'action-card',
  card: {
    accentTone: 'emerald',
    headerTitle: '发布审批',
    allowNote: true,
    actions: [
      { value: 'approve', label: '批准发布', style: 'primary' },
      { value: 'reject', label: '打回', style: 'danger' }
    ]
  }
};

function createLocalPluginFixture(): { dir: string; outputPlugins: OutputPluginService; config: ConfigRepository; mappings: ChannelMappingRepository } {
  const dir = mkdtempSync(join(tmpdir(), 'agentdock-lark-dedup-'));
  writeFileSync(join(dir, 'deploy-approval.json'), JSON.stringify(deployApprovalManifest, null, 2));
  const config = createMemoryConfig();
  const mappings = createMemoryMappings();
  const outputPlugins = new OutputPluginService({
    config,
    channelMappings: mappings,
    localPluginsDir: dir
  });
  return { dir, outputPlugins, config, mappings };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('Lark output plugin card strong idempotency & cross-path dedup', () => {
  it('deduplicates concurrent in-flight dispatches across AskUserQuestion, ConfirmAction, and declarative plugins before DB save', async () => {
    const fixture = createLocalPluginFixture();
    cleanups.push(() => rmSync(fixture.dir, { recursive: true, force: true }));

    const adapters = createDefaultLarkOutputPluginAdapterRegistry();
    const tracker = new LarkTurnTracker();

    const askSpec = askUserQuestionOutputPlugin.parseOutput([
      '请确认方案：',
      '<agentdock-ask-user-question id="ordinary_interrupted_recovery" title="普通会话中断恢复方案确认">',
      '  <question id="q1"><prompt>选择方案</prompt><option value="auto" recommended="true">自动安全续跑</option></question>',
      '</agentdock-ask-user-question>'
    ].join('\n'))!.spec;

    const confirmSpec = confirmActionOutputPlugin.parseOutput([
      '高风险确认：',
      '<agentdock-confirm-action id="confirm_drop_1" title="清理归档表" risk="high"><summary>释放磁盘</summary></agentdock-confirm-action>'
    ].join('\n'))!.spec;

    const declarativeSpec = fixture.outputPlugins.registry.parseTrailingOutput(
      '等待审批：\n<agentdock-deploy-approval id="rel_101" env="prod"><summary>v0.3.29 发布</summary></agentdock-deploy-approval>'
    )!.spec;

    const askGate = createDeferred<{ messageId: string; chatId: string }>();
    const confirmGate = createDeferred<{ messageId: string; chatId: string }>();
    const declGate = createDeferred<{ messageId: string; chatId: string }>();

    const sendInteractiveCard = vi.fn(async (input: { chatId?: string; idempotencyKey?: string }) => {
      if (input.idempotencyKey?.startsWith('askq-')) return askGate.promise;
      if (confirmSendCount++ === 0) return confirmGate.promise;
      return declGate.promise;
    });
    let confirmSendCount = 0;

    // 1) AskUserQuestion：三条并发调用（相同五元组 + 缺少 taskId 的另一条路径）同时到达，在首次网络请求返回前即同步拦截
    const askP1 = dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: { sendInteractiveCard },
      turnTracker: tracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_race',
      taskId: 'task_race_1',
      chatId: 'oc_group_race',
      chatType: 'group',
      pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      spec: askSpec
    });
    const askP2 = dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: { sendInteractiveCard },
      turnTracker: tracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_race',
      taskId: 'task_race_1',
      chatId: 'oc_group_race',
      chatType: 'group',
      pluginId: 'ask-user-question',
      spec: askSpec
    });
    const askP3 = dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: { sendInteractiveCard },
      turnTracker: tracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_race',
      chatId: 'oc_group_race',
      chatType: 'group',
      pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      spec: askSpec
    });

    // 2) ConfirmAction：两条并发调用
    const confirmP1 = dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: { sendInteractiveCard },
      turnTracker: tracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_race',
      taskId: 'task_race_2',
      chatId: 'oc_group_race',
      chatType: 'group',
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      spec: confirmSpec
    });
    const confirmP2 = dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: { sendInteractiveCard },
      turnTracker: tracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_race',
      taskId: 'task_race_2',
      chatId: 'oc_group_race',
      chatType: 'group',
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      spec: confirmSpec
    });

    // 3) 声明式本地插件：两条并发调用
    const declP1 = dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: { sendInteractiveCard },
      turnTracker: tracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_race',
      taskId: 'task_race_3',
      chatId: 'oc_group_race',
      chatType: 'group',
      pluginId: 'local:deploy-approval',
      spec: declarativeSpec
    });
    const declP2 = dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: { sendInteractiveCard },
      turnTracker: tracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_race',
      taskId: 'task_race_3',
      chatId: 'oc_group_race',
      chatType: 'group',
      pluginId: 'local:deploy-approval',
      spec: declarativeSpec
    });

    askGate.resolve({ messageId: 'om_ask_only_1', chatId: 'oc_group_race' });
    confirmGate.resolve({ messageId: 'om_confirm_only_1', chatId: 'oc_group_race' });
    declGate.resolve({ messageId: 'om_decl_only_1', chatId: 'oc_group_race' });

    const [askR1, askR2, askR3, confirmR1, confirmR2, declR1, declR2] = await Promise.all([
      askP1, askP2, askP3, confirmP1, confirmP2, declP1, declP2
    ]);

    expect(askR1?.messageId).toBe('om_ask_only_1');
    expect(askR2).toBeUndefined();
    expect(askR3).toBeUndefined();
    expect(confirmR1?.messageId).toBe('om_confirm_only_1');
    expect(confirmR2).toBeUndefined();
    expect(declR1?.messageId).toBe('om_decl_only_1');
    expect(declR2).toBeUndefined();

    // 三类插件各严格仅发出 1 次飞书 API 调用
    expect(sendInteractiveCard).toHaveBeenCalledTimes(3);
    const expectedAskIdem = buildLarkOutputPluginCardIdempotencyKey({
      sessionId: 'ses_race',
      taskId: 'task_race_1',
      pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      widgetId: 'ordinary_interrupted_recovery',
      chatId: 'oc_group_race'
    });
    expect(expectedAskIdem.length).toBeLessThanOrEqual(50);
    expect(sendInteractiveCard.mock.calls[0]![0]).toMatchObject({
      chatId: 'oc_group_race',
      idempotencyKey: expectedAskIdem
    });

    // 出站 messageId 全部登记防自激，DB 持久化精确 1+2 条
    expect(tracker.isOutboundMessage('om_ask_only_1')).toBe(true);
    expect(tracker.isOutboundMessage('om_confirm_only_1')).toBe(true);
    expect(tracker.isOutboundMessage('om_decl_only_1')).toBe(true);
    expect(await fixture.mappings.list(LARK_ASK_CARD_CHANNEL)).toHaveLength(1);
    expect(await fixture.mappings.list(LARK_OUTPUT_PLUGIN_CARD_CHANNEL)).toHaveLength(2);

    // 不同 chatId 不应被误伤；但重启后新 tracker 实例查库仍对同一 chatId 严格防重
    const freshTracker = new LarkTurnTracker();
    const afterRestartDup = await dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: { sendInteractiveCard: vi.fn(async () => ({ messageId: 'om_should_not_send', chatId: 'oc_group_race' })) },
      turnTracker: freshTracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_race',
      taskId: 'task_race_1',
      chatId: 'oc_group_race',
      chatType: 'group',
      pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      spec: askSpec
    });
    expect(afterRestartDup).toBeUndefined();

    const otherChatSend = vi.fn(async () => ({ messageId: 'om_ask_other_chat', chatId: 'oc_other_group' }));
    const otherChatSent = await dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: { sendInteractiveCard: otherChatSend },
      turnTracker: freshTracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_race',
      taskId: 'task_race_1',
      chatId: 'oc_other_group',
      chatType: 'group',
      pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      spec: askSpec
    });
    expect(otherChatSent?.messageId).toBe('om_ask_other_chat');
    expect(otherChatSend).toHaveBeenCalledTimes(1);
  });

  it('releases the in-flight claim on pre-send failure so a subsequent retry succeeds, and handles open_id -> oc_ chatId dedup', async () => {
    const fixture = createLocalPluginFixture();
    cleanups.push(() => rmSync(fixture.dir, { recursive: true, force: true }));
    const adapters = createDefaultLarkOutputPluginAdapterRegistry();
    const tracker = new LarkTurnTracker();

    const confirmSpec = confirmActionOutputPlugin.parseOutput(
      '<agentdock-confirm-action id="retry_action_1" title="发布" risk="medium"><summary>测试重试</summary></agentdock-confirm-action>'
    )!.spec;

    let attempts = 0;
    const flakyService = {
      sendInteractiveCard: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient network timeout');
        return { messageId: 'om_retry_ok', chatId: 'oc_resolved_dm_chat' };
      })
    };

    await expect(dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: flakyService,
      turnTracker: tracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_retry',
      taskId: 'task_retry_1',
      chatId: 'ou_user_dm_1',
      receiveIdType: 'open_id',
      chatType: 'p2p',
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      spec: confirmSpec
    })).rejects.toThrow('transient network timeout');

    // 首次发卡前失败后占坑释放，重试应成功发出 1 张卡片
    const retried = await dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: flakyService,
      turnTracker: tracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_retry',
      taskId: 'task_retry_1',
      chatId: 'ou_user_dm_1',
      receiveIdType: 'open_id',
      chatType: 'p2p',
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      spec: confirmSpec
    });
    expect(retried?.messageId).toBe('om_retry_ok');
    expect(retried?.receiveId).toBe('ou_user_dm_1');
    expect(retried?.chatId).toBe('oc_resolved_dm_chat');
    expect(flakyService.sendInteractiveCard).toHaveBeenCalledTimes(2);

    // 即使重启后用原始 open_id 或返回后的 oc_ chatId 再次尝试，均因 DB 持久化（含 receiveId + chatId）被幂等拦截
    const freshTracker = new LarkTurnTracker();
    const dupByOpenId = await dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: flakyService,
      turnTracker: freshTracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_retry',
      taskId: 'task_retry_1',
      chatId: 'ou_user_dm_1',
      receiveIdType: 'open_id',
      chatType: 'p2p',
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      spec: confirmSpec
    });
    const dupByChatId = await dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: flakyService,
      turnTracker: freshTracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_retry',
      taskId: 'task_retry_1',
      chatId: 'oc_resolved_dm_chat',
      chatType: 'p2p',
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      spec: confirmSpec
    });
    expect(dupByOpenId).toBeUndefined();
    expect(dupByChatId).toBeUndefined();
    expect(flakyService.sendInteractiveCard).toHaveBeenCalledTimes(2);
  });

  it('reproduces the 06:47 incident: with registerLarkRoutes (turn-sync active) + LarkMessageCoordinator and >550ms slow trace card update, Lark-inbound turns emit exactly 1 Ask/Confirm/Declarative card', async () => {
    const fixture = createLocalPluginFixture();
    cleanups.push(() => rmSync(fixture.dir, { recursive: true, force: true }));

    await saveLarkConfig(fixture.config, undefined, {
      appId: baseBotConfig.appId,
      appSecret: baseBotConfig.appSecret,
      name: baseBotConfig.name,
      defaultAgentId: baseBotConfig.defaultAgentId,
      listening: true,
      quietReply: false,
      webBaseUrl: baseBotConfig.webBaseUrl
    });

    const session: Session = {
      id: 'ses_incident_repro',
      agentId: 'codex',
      cwd: '/tmp/agent-dock',
      state: 'idle',
      source: 'assistant-main',
      title: '小A同学',
      createdAt: '2026-11-27T22:00:00.000Z',
      updatedAt: '2026-11-27T22:00:00.000Z'
    };

    // 绑定托管群（与 06:47 现场完全一致：assistant-main + lark-handover）
    await fixture.mappings.save({
      id: `${larkHandoverChannel(baseBotConfig.appId)}:oc_incident_group`,
      channel: larkHandoverChannel(baseBotConfig.appId),
      externalId: 'oc_incident_group',
      sessionId: session.id,
      extra: JSON.stringify({
        appId: baseBotConfig.appId,
        chatId: 'oc_incident_group',
        sessionId: session.id,
        name: '小A同学 · AgentDock'
      }),
      createdAt: '2026-11-27T22:00:00.000Z'
    });

    const eventBus = new EventEmitter();
    const sessionEvents: AgentEvent[] = [];
    const tasks: TaskRecord[] = [];
    let taskSeq = 0;

    const replies = [
      [
        '我整理了恢复方案，请拍板：',
        '<agentdock-ask-user-question id="ordinary_interrupted_recovery" title="普通会话中断恢复方案确认">',
        '  <question id="q1"><prompt>选择方案</prompt><option value="both" recommended="true">两种都支持</option></question>',
        '</agentdock-ask-user-question>'
      ].join('\n'),
      [
        '请确认执行高风险操作：',
        '<agentdock-confirm-action id="incident_confirm_1" title="执行清理" risk="high"><summary>清理旧表</summary></agentdock-confirm-action>'
      ].join('\n'),
      [
        '请审批本次发布：',
        '<agentdock-deploy-approval id="incident_rel_1" env="prod"><summary>上线修复</summary></agentdock-deploy-approval>'
      ].join('\n')
    ];

    const runtime = {
      getSession: async (id: string) => (id === session.id ? session : undefined),
      createSession: async () => session,
      listAgents: async () => [{ id: 'codex', name: 'Codex', command: 'codex', available: true }],
      getTasks: async () => tasks,
      getRecentEvents: async () => [...sessionEvents],
      getEvents: async () => [...sessionEvents],
      interrupt: async () => undefined,
      send: async () => { throw new Error('unexpected send'); },
      dispatch: async (_id: string, prompt: string) => {
        const idx = taskSeq++;
        const taskId = `task_incident_${idx + 1}`;
        const replyText = replies[idx]!;
        const taskRec: TaskRecord = {
          id: taskId,
          sessionId: session.id,
          prompt,
          finalText: replyText,
          status: 'running',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        tasks.push(taskRec);
        // 异步推进：onTurnStart -> task running -> assistant text -> task completed + onTurnEvent completed
        setTimeout(() => {
          eventBus.emit('turn_start', {
            sessionId: session.id,
            taskId,
            prompt,
            agentId: 'codex',
            sessionSource: session.source,
            timestamp: new Date().toISOString()
          } satisfies RuntimeTurnStartedEvent);
          const runningEvt: AgentEvent = {
            id: `evt_run_${taskId}`,
            sessionId: session.id,
            sequence: sessionEvents.length + 1,
            type: 'task',
            timestamp: new Date().toISOString(),
            data: { task: { ...taskRec, status: 'running' } }
          };
          sessionEvents.push(runningEvt);
          eventBus.emit(`session:${session.id}`, runningEvt);

          const textEvt: AgentEvent = {
            id: `evt_txt_${taskId}`,
            sessionId: session.id,
            sequence: sessionEvents.length + 1,
            type: 'text',
            timestamp: new Date().toISOString(),
            data: { role: 'assistant', text: replyText }
          };
          sessionEvents.push(textEvt);
          eventBus.emit(`session:${session.id}`, textEvt);

          taskRec.status = 'completed';
          const doneEvt: AgentEvent = {
            id: `evt_done_${taskId}`,
            sessionId: session.id,
            sequence: sessionEvents.length + 1,
            type: 'task',
            timestamp: new Date().toISOString(),
            data: { task: { ...taskRec, status: 'completed' } }
          };
          sessionEvents.push(doneEvt);
          eventBus.emit(`session:${session.id}`, doneEvt);

          eventBus.emit('turn', {
            id: `tevt_${taskId}`,
            kind: 'completed',
            sessionId: session.id,
            taskId,
            agentId: 'codex',
            sessionSource: session.source,
            summary: replyText,
            timestamp: new Date().toISOString()
          } satisfies RuntimeTurnEvent);
        }, 10);
        return { id: taskId, status: 'running' };
      },
      subscribe: (id: string, listener: (event: AgentEvent) => void) => {
        const key = `session:${id}`;
        eventBus.on(key, listener);
        return () => { eventBus.off(key, listener); };
      },
      onTurnStart: (listener: (event: RuntimeTurnStartedEvent) => void) => {
        eventBus.on('turn_start', listener);
        return () => { eventBus.off('turn_start', listener); };
      },
      onTurnEvent: (listener: (event: RuntimeTurnEvent) => void) => {
        eventBus.on('turn', listener);
        return () => { eventBus.off('turn', listener); };
      }
    };

    // 模拟真实飞书 HTTP 延迟：终态 trace 卡片 update 耗时 550ms（超过旧版 450ms setTimeout 竞态窗口！）
    let msgSeq = 0;
    const replyInteractiveCard = vi.fn(async (input: { messageId: string; card: Record<string, unknown> }) => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return { messageId: `om_reply_plugin_${++msgSeq}`, chatId: 'oc_incident_group', ...({ _replyTo: input.messageId }) };
    });
    const sendInteractiveCard = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return { messageId: `om_send_plugin_${++msgSeq}`, chatId: 'oc_incident_group' };
    });
    const mockLarkService = {
      addReaction: vi.fn(async () => ({ messageId: 'om_user', reactionId: 'r1', emojiType: 'OK' })),
      deleteReaction: vi.fn(async () => undefined),
      reply: vi.fn(async () => ({ messageId: `om_trace_${++msgSeq}`, chatId: 'oc_incident_group' })),
      send: vi.fn(async () => ({ messageId: `om_sync_trace_${++msgSeq}`, chatId: 'oc_incident_group' })),
      sendText: vi.fn(async () => ({ messageId: `om_text_${++msgSeq}`, chatId: 'oc_incident_group' })),
      update: vi.fn(async (input: { state?: string }) => {
        if (input.state === 'completed') {
          await new Promise(resolve => setTimeout(resolve, 550));
        }
        return { messageId: 'om_trace_1', chatId: 'oc_incident_group' };
      }),
      replyInteractiveCard,
      sendInteractiveCard,
      updateInteractiveCard: vi.fn(async (input: { messageId: string }) => ({ messageId: input.messageId, chatId: 'oc_incident_group' })),
      getUserName: vi.fn(async () => '暮雪离歌'),
      getChat: vi.fn(async () => ({ chatId: 'oc_incident_group', name: '小A同学 · AgentDock', userCount: 1 })),
      listChats: vi.fn(async () => ({ items: [], hasMore: false }))
    } as unknown as LarkCardService;

    const tracker = new LarkTurnTracker();
    const fakeListenerPool: LarkListenerPool = {
      listening: true,
      activeAppIds: [baseBotConfig.appId],
      sync: vi.fn(async () => undefined),
      stop: vi.fn()
    };

    // 拦截 registerLarkRoutes -> turnSyncService 真实调用飞书 OpenAPI 的 HTTP 流量，验证卡片与幂等键
    const fetchedCardBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    let fetchMsgSeq = 0;
    let slowNextTraceSend = false;
    const mockFetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok_test', expire: 7200 }));
      }
      if (url.includes('/im/v1/messages') && init?.body) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (slowNextTraceSend && body.msg_type === 'interactive' && !String(body.uuid ?? '').startsWith('askq-') && !String(body.uuid ?? '').startsWith('outp-')) {
          slowNextTraceSend = false;
          await new Promise(resolve => setTimeout(resolve, 550));
        }
        fetchedCardBodies.push({ url, body });
        return new Response(JSON.stringify({
          code: 0,
          data: { message_id: `om_http_sent_${++fetchMsgSeq}`, chat_id: 'oc_incident_group' }
        }));
      }
      return new Response(JSON.stringify({ code: 0, data: {} }));
    }) as unknown as typeof globalThis.fetch;

    const app = Fastify();
    cleanups.push(() => app.close());
    await registerLarkRoutes(app, {
      config: fixture.config,
      cardMappings: fixture.mappings,
      runtime: runtime as any,
      outputPlugins: fixture.outputPlugins,
      turnTracker: tracker,
      listener: fakeListenerPool,
      fetcher: mockFetcher,
      listeningDisabled: false
    });

    const coordinator = new LarkMessageCoordinator(
      runtime as unknown as LarkRuntime,
      mockLarkService,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      () => 0,
      'ou_bot',
      undefined,
      fixture.mappings,
      fixture.config,
      undefined,
      fixture.outputPlugins,
      createDefaultLarkOutputPluginAdapterRegistry(),
      tracker
    );
    cleanups.push(() => coordinator.stop());

    // 连续验证 3 个飞书入站轮次：AskUserQuestion、ConfirmAction、声明式本地插件
    const inboundMessageIds = ['om_x100b7f94ca6618a8b32895ae78d374e', 'om_confirm_in_2', 'om_decl_in_3'];
    for (let i = 0; i < inboundMessageIds.length; i++) {
      const incoming: LarkMessageEvent = {
        messageId: inboundMessageIds[i]!,
        chatId: 'oc_incident_group',
        chatType: 'group',
        messageType: 'text',
        content: JSON.stringify({ text: `测试第 ${i + 1} 轮` }),
        senderOpenId: 'ou_user_muxue',
        senderType: 'user',
        mentions: [{ key: '@bot', name: '防重测试机器人', openId: 'ou_bot' }]
      };
      await coordinator.handle(incoming, baseBotConfig);
      await vi.waitFor(() => {
        expect(replyInteractiveCard).toHaveBeenCalledTimes(i + 1);
      }, { timeout: 3_000 });
    }

    // 额外等待 600ms（超过旧版 450ms 延迟桥接窗口），确认 turn-sync 与路由层 0 次补发第 2 张卡片
    await new Promise(resolve => setTimeout(resolve, 600));

    expect(replyInteractiveCard).toHaveBeenCalledTimes(3);
    expect(replyInteractiveCard.mock.calls[0]![0].messageId).toBe('om_x100b7f94ca6618a8b32895ae78d374e');
    expect(sendInteractiveCard).toHaveBeenCalledTimes(0);
    expect(fetchedCardBodies).toHaveLength(0);
    expect(await fixture.mappings.list(LARK_ASK_CARD_CHANNEL)).toHaveLength(1);
    expect(await fixture.mappings.list(LARK_OUTPUT_PLUGIN_CARD_CHANNEL)).toHaveLength(2);

    // 同一套注册路由下，非飞书触发（Web）轮次即便主卡发送耗时 550ms 且并发收到两次 onTurnEvent，也严格只发 1 张主卡 + 1 张交互卡
    slowNextTraceSend = true;
    const webAskReply = [
      '网页触发的询问：',
      '<agentdock-ask-user-question id="web_ask_once_1" title="网页询问">',
      '  <question id="q1"><prompt>继续吗？</prompt><option value="yes" recommended="true">继续</option></question>',
      '</agentdock-ask-user-question>'
    ].join('\n');
    const webTurnEvent: RuntimeTurnEvent = {
      id: 'tevt_web_once_1',
      kind: 'completed',
      sessionId: session.id,
      taskId: 'task_web_once_1',
      agentId: 'codex',
      sessionSource: session.source,
      summary: webAskReply,
      timestamp: new Date().toISOString()
    };
    // 故意并发触发两次同一轮次的 onTurnEvent
    eventBus.emit('turn', webTurnEvent);
    eventBus.emit('turn', webTurnEvent);

    await vi.waitFor(() => {
      expect(fetchedCardBodies.filter(item => String(item.body.uuid ?? '').startsWith('askq-'))).toHaveLength(1);
    }, { timeout: 3_000 });
    await new Promise(resolve => setTimeout(resolve, 550));

    const webPluginCards = fetchedCardBodies.filter(item => String(item.body.uuid ?? '').startsWith('askq-'));
    const webTraceCards = fetchedCardBodies.filter(item => !String(item.body.uuid ?? '').startsWith('askq-'));
    expect(webTraceCards).toHaveLength(1);
    expect(webPluginCards).toHaveLength(1);
    expect(await fixture.mappings.list(LARK_ASK_CARD_CHANNEL)).toHaveLength(2);
  });

  it('keeps legacy runtime.send Lark-owned through finalizeCard and still delivers trailing plugin card once on group_send_deduped turns', async () => {
    const fixture = createLocalPluginFixture();
    cleanups.push(() => rmSync(fixture.dir, { recursive: true, force: true }));
    await saveLarkConfig(fixture.config, undefined, {
      appId: baseBotConfig.appId,
      appSecret: baseBotConfig.appSecret,
      name: baseBotConfig.name,
      defaultAgentId: baseBotConfig.defaultAgentId,
      groupSessionScope: baseBotConfig.groupSessionScope,
      listening: true,
      quietReply: false
    });

    const session: Session = {
      id: 'ses_legacy_send',
      agentId: 'codex',
      cwd: '/tmp/ws',
      state: 'idle',
      source: 'lark',
      sourceId: `${baseBotConfig.appId}:oc_legacy_grp:group:chat`,
      createdAt: '2026-11-27T22:00:00.000Z',
      updatedAt: '2026-11-27T22:00:00.000Z'
    };

    const eventBus = new EventEmitter();
    const askReply = [
      '请确认：',
      '<agentdock-ask-user-question id="legacy_send_ask_1" title="兼容路径确认">',
      '  <question id="q1"><prompt>是否继续？</prompt><option value="yes">继续</option></question>',
      '</agentdock-ask-user-question>'
    ].join('\n');

    const tracker = new LarkTurnTracker();
    const syncCardService: LarkTurnSyncCardPort = {
      send: vi.fn(async () => ({ messageId: 'om_sync_1', chatId: 'oc_legacy_grp' })),
      update: vi.fn(async () => ({ messageId: 'om_sync_1', chatId: 'oc_legacy_grp' })),
      sendText: vi.fn(async () => ({ messageId: 'om_sync_txt_1', chatId: 'oc_legacy_grp' })),
      sendInteractiveCard: vi.fn(async () => ({ messageId: 'om_sync_plugin_1', chatId: 'oc_legacy_grp' }))
    };

    const legacyRuntime = {
      getSession: async () => session,
      listSessions: async () => [session],
      start: async () => session,
      listAgents: async () => [{ id: 'codex', name: 'Codex', command: 'codex', available: true }],
      interrupt: async () => undefined,
      subscribe: (id: string, listener: (event: AgentEvent) => void) => {
        const key = `session:${id}`;
        eventBus.on(key, listener);
        return () => { eventBus.off(key, listener); };
      },
      onTurnEvent: (listener: (event: RuntimeTurnEvent) => void) => {
        eventBus.on('turn', listener);
        return () => { eventBus.off('turn', listener); };
      },
      send: async () => {
        const textEvt: AgentEvent = {
          id: 'evt_legacy_1',
          sessionId: session.id,
          sequence: 1,
          type: 'text',
          timestamp: new Date().toISOString(),
          data: { role: 'assistant', text: askReply }
        };
        const doneEvt: AgentEvent = {
          id: 'evt_legacy_2',
          sessionId: session.id,
          sequence: 2,
          type: 'completed',
          timestamp: new Date().toISOString(),
          data: {}
        };
        eventBus.emit(`session:${session.id}`, textEvt);
        eventBus.emit(`session:${session.id}`, doneEvt);
        // 在 runtime.send 结束时同步触发 onTurnEvent，验证 beginLarkSend 持续覆盖到 finalizeCard 结束
        eventBus.emit('turn', {
          id: 'tevt_legacy_1',
          kind: 'completed',
          sessionId: session.id,
          taskId: 'task_legacy_1',
          agentId: 'codex',
          sessionSource: session.source,
          sessionSourceId: session.sourceId,
          summary: askReply,
          timestamp: new Date().toISOString()
        } satisfies RuntimeTurnEvent);
      }
    };

    const syncService = new LarkTurnSyncService({
      runtime: legacyRuntime as any,
      configRepository: fixture.config,
      cardMappings: fixture.mappings,
      turnTracker: tracker,
      resolveService: async () => syncCardService,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      outputPlugins: fixture.outputPlugins
    });
    syncService.start();
    cleanups.push(() => syncService.close());

    const replyInteractiveCard = vi.fn(async () => ({ messageId: 'om_legacy_ask_1', chatId: 'oc_legacy_grp' }));
    const listenerService = {
      addReaction: vi.fn(async () => ({ messageId: 'om_in_1', reactionId: 'r1', emojiType: 'OK' })),
      deleteReaction: vi.fn(async () => undefined),
      reply: vi.fn(async () => ({ messageId: 'om_trace_legacy_1', chatId: 'oc_legacy_grp' })),
      send: vi.fn(async () => ({ messageId: 'om_trace_legacy_2', chatId: 'oc_legacy_grp' })),
      update: vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
        return { messageId: 'om_trace_legacy_1', chatId: 'oc_legacy_grp' };
      }),
      replyInteractiveCard,
      sendInteractiveCard: vi.fn(async () => ({ messageId: 'om_should_not_send', chatId: 'oc_legacy_grp' })),
      updateInteractiveCard: vi.fn(async () => ({ messageId: 'om_legacy_ask_1', chatId: 'oc_legacy_grp' })),
      getUserName: vi.fn(async () => '暮雪离歌'),
      getChat: vi.fn(async () => ({ chatId: 'oc_legacy_grp', name: '测试群', userCount: 1 })),
      listChats: vi.fn(async () => ({ items: [], hasMore: false }))
    } as unknown as LarkCardService;

    const coordinatorLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const coordinator = new LarkMessageCoordinator(
      legacyRuntime as unknown as LarkRuntime,
      listenerService,
      coordinatorLog,
      () => 0,
      'ou_bot',
      undefined,
      fixture.mappings,
      fixture.config,
      undefined,
      fixture.outputPlugins,
      createDefaultLarkOutputPluginAdapterRegistry(),
      tracker
    );
    cleanups.push(() => coordinator.stop());

    await coordinator.handle({
      messageId: 'om_legacy_in_1',
      chatId: 'oc_legacy_grp',
      chatType: 'group',
      messageType: 'text',
      content: JSON.stringify({ text: '旧路径测试' }),
      senderOpenId: 'ou_user_1',
      senderType: 'user',
      mentions: [{ key: '@bot', name: '防重测试机器人', openId: 'ou_bot' }]
    }, baseBotConfig);
    await vi.waitFor(() => {
      expect(coordinatorLog.error.mock.calls).toEqual([]);
      expect(replyInteractiveCard).toHaveBeenCalledTimes(1);
    }, { timeout: 2_000 });
    await syncService.flushPending();

    expect(replyInteractiveCard).toHaveBeenCalledTimes(1);
    expect(syncCardService.send).not.toHaveBeenCalled();
    expect(syncCardService.sendInteractiveCard).not.toHaveBeenCalled();

    // 2) 非飞书轮次调用了 group send 导致正文去重，但末尾带有 ConfirmAction XML 时，仍补推且仅补推 1 张交互卡
    const nowTs = Date.now();
    tracker.recordGroupSend({
      sessionId: session.id,
      appId: baseBotConfig.appId,
      chatId: 'oc_legacy_grp',
      messageId: 'om_group_tool_1',
      timestamp: nowTs + 10
    });
    const dedupConfirmReply = [
      '我已通过群消息说明情况，请确认是否继续：',
      '<agentdock-confirm-action id="confirm_after_group_send" title="确认发布" risk="high"><summary>上线变更</summary></agentdock-confirm-action>'
    ].join('\n');
    const dedupOutcome = await syncService.handleTurnEvent({
      id: 'tevt_group_dedup_confirm',
      kind: 'completed',
      sessionId: session.id,
      taskId: 'task_group_dedup_confirm',
      agentId: 'codex',
      sessionSource: session.source,
      sessionSourceId: session.sourceId,
      durationMs: 1_000,
      summary: dedupConfirmReply,
      timestamp: new Date(nowTs + 20).toISOString()
    });
    expect(dedupOutcome).toEqual({ action: 'skipped', reason: 'group_send_deduped' });
    expect(syncCardService.send).not.toHaveBeenCalled();
    expect(syncCardService.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(await fixture.mappings.list(LARK_OUTPUT_PLUGIN_CARD_CHANNEL)).toHaveLength(1);
  });

  it('gracefully falls back to a minimal Schema 2.0 summary card when Lark OpenAPI rejects an AskUserQuestion card with 230099, and dispatches JSON-in-XML end-to-end', async () => {
    const fixture = createLocalPluginFixture();
    cleanups.push(() => rmSync(fixture.dir, { recursive: true, force: true }));
    const adapters = createDefaultLarkOutputPluginAdapterRegistry();
    const tracker = new LarkTurnTracker();

    const parsedJsonAsk = askUserQuestionOutputPlugin.parseOutput(`请拍板：\n\n<agentdock-ask-user-question>
{
  "id": "rich_text_upgrade_plan",
  "title": "原生富文本渲染升级范围确认",
  "questions": [
    {
      "id": "scope",
      "question": "这次落地范围选哪一档？",
      "options": [
        { "value": "full", "label": "全套原生富文本渲染（推荐）" },
        { "value": "render_only", "label": "只做前端渲染器" }
      ]
    },
    {
      "id": "release_order",
      "question": "发版顺序？",
      "options": [
        { "value": "ship_0331_first", "label": "先发 0.3.31" },
        { "value": "bundle_together", "label": "合并发一版" }
      ]
    }
  ]
}
</agentdock-ask-user-question>`);
    expect(parsedJsonAsk).not.toBeNull();

    const sentCards: Array<{ card: Record<string, unknown>; idempotencyKey?: string }> = [];
    const replyInteractiveCard = vi.fn(async (input: { messageId: string; card: Record<string, unknown>; idempotencyKey?: string }) => {
      sentCards.push({ card: input.card, idempotencyKey: input.idempotencyKey });
      if (sentCards.length === 1) {
        throw new LarkServiceError('LARK_API_ERROR', 'Failed to create card content', 502, { upstreamCode: 230099 });
      }
      return { messageId: 'om_ask_fallback_ok', chatId: 'oc_group_fb' };
    });

    const record = await dispatchLarkOutputPluginCard({
      pluginRegistry: fixture.outputPlugins.registry,
      larkPluginAdapters: adapters,
      service: { replyInteractiveCard },
      turnTracker: tracker,
      cardMappings: fixture.mappings,
      appId: 'cli_dedup_bot',
      sessionId: 'ses_fb',
      taskId: 'task_fb_1',
      chatId: 'oc_group_fb',
      chatType: 'group',
      replyToMessageId: 'om_x100b7f987da0c8a0df8d4da59123c68',
      webBaseUrl: 'http://127.0.0.1:4310',
      pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      spec: parsedJsonAsk!.spec,
      sourceBadge: buildLarkOriginSourceBadge('zh-CN')
    });

    expect(record?.messageId).toBe('om_ask_fallback_ok');
    expect(replyInteractiveCard).toHaveBeenCalledTimes(2);
    expect(sentCards[0]!.card.body).toBeDefined();
    expect((sentCards[0]!.card.body as any).elements.some((el: any) => el.tag === 'form')).toBe(true);
    // 降级重发不含 form，保留单一来源徽标并带 -fb 幂等键
    expect((sentCards[1]!.card.body as any).elements.some((el: any) => el.tag === 'form')).toBe(false);
    expect((sentCards[1]!.card.body as any).elements[0]?.element_id).toBe('task_source_badge');
    expect(sentCards[1]!.idempotencyKey?.endsWith('-fb')).toBe(true);
    expect((sentCards[1]!.idempotencyKey ?? '').length).toBeLessThanOrEqual(50);
  });
});
