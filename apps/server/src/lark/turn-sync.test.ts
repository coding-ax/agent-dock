import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import type {
  AgentEvent,
  RepositoryBundle,
  RuntimeTurnEvent,
  RuntimeTurnStartedEvent,
  Session,
  TaskRecord
} from '@agent-dock/agent-dock-shared';
import { saveLarkConfig, type SaveLarkConfigInput } from './config.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './agent-tools.js';
import {
  createHandoverLookup,
  larkHandoverChannel,
  parseLarkSessionSourceBinding,
  saveSessionTurnSyncOverride
} from './handover-binding.js';
import type { HandoverCatLike } from './kitten-handover.js';
import { LARK_ASK_CARD_CHANNEL } from './ask-user-question-card.js';
import { LarkMessageCoordinator } from './listener.js';
import { registerLarkRoutes } from './routes.js';
import { buildLarkCard } from './service.js';
import { LarkTurnTracker } from './turn-tracker.js';
import {
  classifyTurnSource,
  formatSyncedTaskName,
  isSilentScheduledOutput,
  LarkTurnSyncService,
  redactSensitiveContent,
  type LarkTurnSyncCardPort,
  type LarkTurnSyncRuntime
} from './turn-sync.js';

const bundles: RepositoryBundle[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop()!;
    await fn();
  }
  bundles.splice(0).forEach(bundle => bundle.close());
});

function createTestRepos() {
  const bundle = createRepositories(':memory:');
  bundles.push(bundle);
  return bundle;
}

async function seedBot(repos: RepositoryBundle, overrides: SaveLarkConfigInput = {}) {
  return (await saveLarkConfig(repos.config, undefined, {
    appId: 'cli_bot',
    appSecret: 'super-secret-value-999',
    name: '小猫机器人',
    defaultAgentId: 'claude',
    listening: true,
    pushIntervalMs: 500,
    ...overrides
  }))[0]!;
}

async function bindHandover(
  repos: RepositoryBundle,
  input: { appId?: string; chatId?: string; sessionId: string; name?: string; turnSync?: Record<string, unknown> }
) {
  const appId = input.appId ?? 'cli_bot';
  const chatId = input.chatId ?? 'oc_handover_group';
  const channel = larkHandoverChannel(appId);
  await repos.channelMappings.save({
    id: `${channel}:${chatId}`,
    channel,
    externalId: chatId,
    sessionId: input.sessionId,
    extra: JSON.stringify({
      appId,
      chatId,
      sessionId: input.sessionId,
      name: input.name ?? '小猫 · AgentDock',
      ...(input.turnSync ? { turnSync: input.turnSync } : {})
    }),
    createdAt: new Date().toISOString()
  });
}

class FakeSyncRuntime implements LarkTurnSyncRuntime {
  private readonly emitter = new EventEmitter();
  private readonly sessions = new Map<string, Session>();
  private readonly tasks = new Map<string, TaskRecord[]>();
  private readonly events = new Map<string, AgentEvent[]>();

  addSession(session: Partial<Session> & { id: string }) {
    const full: Session = {
      agentId: 'claude',
      state: 'idle',
      cwd: '/tmp/ws',
      permissionMode: 'full-trust',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...session
    };
    this.sessions.set(full.id, full);
    return full;
  }

  addTask(task: TaskRecord) {
    this.tasks.set(task.sessionId, [...(this.tasks.get(task.sessionId) ?? []), task]);
  }

  pushSessionEvent(sessionId: string, event: AgentEvent) {
    this.events.set(sessionId, [...(this.events.get(sessionId) ?? []), event]);
    this.emitter.emit(`session:${sessionId}`, event);
  }

  emitStart(event: RuntimeTurnStartedEvent) {
    this.emitter.emit('turn_start', event);
  }

  emitTurn(event: RuntimeTurnEvent) {
    this.emitter.emit('turn', event);
  }

  async getSession(id: string) { return this.sessions.get(id); }
  async getTasks(id: string) { return this.tasks.get(id) ?? []; }
  async getRecentEvents(id: string, limit: number) { return (this.events.get(id) ?? []).slice(-limit); }
  async getEvents(id: string) { return this.events.get(id) ?? []; }

  subscribe(sessionId: string, listener: (event: AgentEvent) => void) {
    this.emitter.on(`session:${sessionId}`, listener);
    return () => this.emitter.off(`session:${sessionId}`, listener);
  }

  onTurnStart(listener: (event: RuntimeTurnStartedEvent) => void) {
    this.emitter.on('turn_start', listener);
    return () => this.emitter.off('turn_start', listener);
  }

  onTurnEvent(listener: (event: RuntimeTurnEvent) => void) {
    this.emitter.on('turn', listener);
    return () => this.emitter.off('turn', listener);
  }
}

function fakeCardService() {
  let seq = 0;
  const send = vi.fn(async (input?: { chatId?: string; receiveId?: string }) => ({ messageId: `om_card_${++seq}`, chatId: input?.chatId ?? input?.receiveId ?? 'oc_handover_group' }));
  const update = vi.fn(async (input: { messageId: string }) => ({ messageId: input.messageId, chatId: 'oc_handover_group' }));
  const sendText = vi.fn(async (input?: { chatId?: string; receiveId?: string }) => ({ messageId: `om_text_${++seq}`, chatId: input?.chatId ?? input?.receiveId ?? 'oc_handover_group' }));
  const sendInteractiveCard = vi.fn(async (input?: { chatId?: string; receiveId?: string }) => ({ messageId: `om_plugin_${++seq}`, chatId: input?.chatId ?? input?.receiveId ?? 'oc_handover_group' }));
  return { send, update, sendText, sendInteractiveCard } satisfies LarkTurnSyncCardPort;
}

describe('turn sync classification & safety helpers', () => {
  it('classifies supervision (review/plan/failed/user_stopped), web, schedule, and maintenance turns accurately', () => {
    expect(classifyTurnSource({
      taskOrigin: 'injected',
      prompt: '📋 督办 · 1 个事项有变化',
      sentPrompt: '以下是 daemon 汇总的督办信号。\n- [review] 修复登录：侧边会话这一轮结束，等待验收'
    })).toMatchObject({ category: 'supervision', badge: '🐾 小猫督办', detailLabel: '验收督办' });

    expect(classifyTurnSource({
      taskOrigin: 'injected',
      prompt: '📋 督办 · 1 个事项有变化',
      sentPrompt: '- [failed] 构建流水线：侧边会话失败'
    })).toMatchObject({ category: 'supervision', detailLabel: '异常预警' });

    expect(classifyTurnSource({
      taskOrigin: 'injected',
      prompt: '📋 督办 · 1 个事项有变化',
      sentPrompt: '- [plan] 新功能方案：计划待确认'
    })).toMatchObject({ category: 'supervision', detailLabel: '计划待确认' });

    expect(classifyTurnSource({
      taskOrigin: 'injected',
      prompt: '⏸ 用户已停止 · 1 个事项'
    })).toMatchObject({ category: 'supervision', detailLabel: '已暂停' });

    expect(classifyTurnSource({
      taskOrigin: 'schedule',
      prompt: '[AgentDock 定时任务 sch_1 · 每日巡检 · 第 3 次触发]\n检查构建状态'
    })).toMatchObject({ category: 'schedule', badge: '⏰ 定时任务' });

    expect(classifyTurnSource({
      prompt: '[AgentDock 定时任务 sch_legacy · 巡检 · 第 1 次触发]\n检查'
    })).toMatchObject({ category: 'schedule', badge: '⏰ 定时任务' });

    expect(classifyTurnSource({ prompt: '在网页端问个问题' })).toMatchObject({ category: 'web', badge: '💻 网页同步' });
    expect(classifyTurnSource({ taskOrigin: 'board-mention', prompt: '看板讨论' })).toMatchObject({ category: 'web', badge: '💻 网页同步 · 看板' });
    expect(classifyTurnSource({ taskOrigin: 'maintenance', prompt: '整理便签' })).toMatchObject({ category: 'maintenance', badge: '🧹 整理维护' });
    expect(classifyTurnSource({ taskOrigin: 'handoff', prompt: '交接说明' })).toMatchObject({ category: 'maintenance', badge: '🧹 交接说明' });
  });

  it('detects silent scheduled outputs conservatively without swallowing alerts or failures', () => {
    expect(isSilentScheduledOutput('', 'completed')).toBe(true);
    expect(isSilentScheduledOutput('HEARTBEAT_OK', 'completed')).toBe(true);
    expect(isSilentScheduledOutput('本次无异常。', 'completed')).toBe(true);
    expect(isSilentScheduledOutput('一切正常', 'completed')).toBe(true);
    expect(isSilentScheduledOutput('No updates.', 'completed')).toBe(true);

    // 失败、异常词或实质内容绝不过滤
    expect(isSilentScheduledOutput('HEARTBEAT_OK', 'failed')).toBe(false);
    expect(isSilentScheduledOutput('发现 2 条报错异常，请立即处理', 'completed')).toBe(false);
    expect(isSilentScheduledOutput('已巡检 3 个仓库，新增 2 条 PR 待 review：#120、#121。', 'completed')).toBe(false);
  });

  it('redacts secrets and internal tokens without corrupting public IDs', () => {
    const raw = '群 oc_123 bot cli_bot secret=super-secret-value-999 agentdock_group_tools_token=v1.abcdefghijklmnopqrstuvwxyz0123456789 Authorization: Bearer tok_xyz_999';
    const cleaned = redactSensitiveContent(raw, ['super-secret-value-999']);
    expect(cleaned).toContain('oc_123');
    expect(cleaned).toContain('cli_bot');
    expect(cleaned).not.toContain('super-secret-value-999');
    expect(cleaned).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(cleaned).not.toContain('tok_xyz_999');
    expect(cleaned).toContain('[REDACTED]');
  });

  it('renders sourceBadge tag and summary prefix in buildLarkCard', () => {
    const card = buildLarkCard({
      state: 'completed',
      readOnly: true,
      sourceBadge: { label: '🐾 小猫督办', color: 'purple' },
      taskName: '验收督办 · 1 个事项有变化',
      markdown: '验收通过，已关闭便签。'
    });
    expect(card.config.summary.content).toContain('[🐾 小猫督办]');
    const badgeEl = card.body.elements.find((el: any) => el.element_id === 'task_source_badge') as any;
    expect(badgeEl?.text?.content).toContain("<text_tag color='purple'>🐾 小猫督办</text_tag>");
    // readOnly=true 不渲染交互按钮
    expect(card.body.elements.some((el: any) => el.element_id === 'task_action_row')).toBe(false);
  });

  it('formats schedule, web question, and supervision task names cleanly', () => {
    const schSource = classifyTurnSource({ taskOrigin: 'schedule', prompt: '[AgentDock 定时任务 sch_1 · 晚间巡检 · 第 2 次触发]\n检查接口' });
    expect(formatSyncedTaskName('[AgentDock 定时任务 sch_1 · 晚间巡检 · 第 2 次触发]\n检查接口', schSource)).toBe('晚间巡检 · 第 2 次触发');

    const webSource = classifyTurnSource({ prompt: '帮我看下刚才那条 PR 的测试结果' });
    expect(formatSyncedTaskName('帮我看下刚才那条 PR 的测试结果', webSource)).toBe('问：帮我看下刚才那条 PR 的测试结果');

    const supSource = classifyTurnSource({ taskOrigin: 'injected', prompt: '📋 督办 · 1 个事项有变化', sentPrompt: '- [review] 登录重构：等待验收' });
    expect(formatSyncedTaskName('📋 督办 · 1 个事项有变化', supSource)).toBe('验收督办 · 1 个事项有变化');
  });
});

describe('LarkTurnSyncService', () => {
  it('syncs supervision, web, and substantive schedule turns to bound handover group main thread, while skipping maintenance by default', async () => {
    const repos = createTestRepos();
    await seedBot(repos);
    await bindHandover(repos, { sessionId: 'ses_main' });

    const runtime = new FakeSyncRuntime();
    runtime.addSession({ id: 'ses_main', source: 'assistant-main' });
    const cardService = fakeCardService();
    const tracker = new LarkTurnTracker();
    const service = new LarkTurnSyncService({
      runtime,
      configRepository: repos.config,
      cardMappings: repos.channelMappings,
      turnTracker: tracker,
      resolveService: async () => cardService,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    service.start();
    cleanups.push(() => service.close());

    // 1) 系统督办轮次 -> 默认同步
    runtime.addTask({
      id: 'task_sup',
      sessionId: 'ses_main',
      prompt: '📋 督办 · 1 个事项有变化',
      sentPrompt: '以下是 daemon 汇总的督办信号。\n- [review] 登录重构：等待验收',
      status: 'completed',
      origin: 'injected',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const supOutcome = await service.handleTurnEvent({
      id: 'tevt_1',
      kind: 'completed',
      sessionId: 'ses_main',
      taskId: 'task_sup',
      agentId: 'claude',
      taskOrigin: 'injected',
      durationMs: 4_200,
      summary: '验收通过，单测全绿！',
      timestamp: new Date().toISOString()
    });
    expect(supOutcome).toMatchObject({ action: 'synced_card', category: 'supervision', chatId: 'oc_handover_group' });
    expect(cardService.send).toHaveBeenCalledTimes(1);
    expect(cardService.send.mock.calls[0]![0]).toMatchObject({
      chatId: 'oc_handover_group',
      state: 'completed',
      readOnly: true,
      sourceBadge: { label: '🐾 小猫督办', color: 'purple' }
    });
    // 出站 messageId 自动登记到防自激集合
    expect(tracker.isOutboundMessage('om_card_1')).toBe(true);

    // 2) Web 端对话轮次 -> 默认同步
    runtime.addTask({
      id: 'task_web',
      sessionId: 'ses_main',
      prompt: '帮我查下今天的构建状态',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const webOutcome = await service.handleTurnEvent({
      id: 'tevt_2',
      kind: 'completed',
      sessionId: 'ses_main',
      taskId: 'task_web',
      agentId: 'claude',
      durationMs: 2_500,
      summary: '今日 3 次构建全部成功。',
      timestamp: new Date().toISOString()
    });
    expect(webOutcome).toMatchObject({ action: 'synced_card', category: 'web' });
    expect(cardService.send).toHaveBeenCalledTimes(2);
    expect(cardService.send.mock.calls[1]![0]).toMatchObject({
      sourceBadge: { label: '💻 网页同步', color: 'blue' }
    });

    // 3) 定时任务轮次（有实质输出）-> 默认同步；静默无动作 -> 自动过滤
    runtime.addTask({
      id: 'task_sch_silent',
      sessionId: 'ses_main',
      prompt: '[AgentDock 定时任务 sch_1 · 巡检 · 第 1 次触发]\n巡检线上',
      status: 'completed',
      origin: 'schedule',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const silentOutcome = await service.handleTurnEvent({
      id: 'tevt_3',
      kind: 'completed',
      sessionId: 'ses_main',
      taskId: 'task_sch_silent',
      agentId: 'claude',
      taskOrigin: 'schedule',
      summary: 'HEARTBEAT_OK',
      timestamp: new Date().toISOString()
    });
    expect(silentOutcome).toEqual({ action: 'skipped', reason: 'silent_schedule' });
    expect(cardService.send).toHaveBeenCalledTimes(2);

    runtime.addTask({
      id: 'task_sch_real',
      sessionId: 'ses_main',
      prompt: '[AgentDock 定时任务 sch_1 · 巡检 · 第 2 次触发]\n巡检线上',
      status: 'completed',
      origin: 'schedule',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const schOutcome = await service.handleTurnEvent({
      id: 'tevt_4',
      kind: 'completed',
      sessionId: 'ses_main',
      taskId: 'task_sch_real',
      agentId: 'claude',
      taskOrigin: 'schedule',
      summary: '巡检发现 1 个超时告警：API 延迟 3.2s。',
      timestamp: new Date().toISOString()
    });
    expect(schOutcome).toMatchObject({ action: 'synced_card', category: 'schedule' });
    expect(cardService.send).toHaveBeenCalledTimes(3);
    expect(cardService.send.mock.calls[2]![0]).toMatchObject({
      sourceBadge: { label: '⏰ 定时任务', color: 'orange' }
    });

    // 4) 整理维护轮次 -> 默认关闭
    const maintOutcome = await service.handleTurnEvent({
      id: 'tevt_5',
      kind: 'completed',
      sessionId: 'ses_main',
      taskId: 'task_maint',
      agentId: 'claude',
      taskOrigin: 'maintenance',
      summary: '已折叠 8 张已关闭便签。',
      timestamp: new Date().toISOString()
    });
    expect(maintOutcome).toEqual({ action: 'skipped', reason: 'category_disabled:maintenance' });
    expect(cardService.send).toHaveBeenCalledTimes(3);
  });

  it('follows main kitten lineage after handoff (Gen 2 inherits Gen 1 handover group)', async () => {
    const repos = createTestRepos();
    await seedBot(repos);
    await bindHandover(repos, { sessionId: 'ses_gen1', chatId: 'oc_kitten_group' });

    const lineage: HandoverCatLike[] = [
      { id: 'acat_1', familyId: 'fam_1', generation: 1, sessionId: 'ses_gen1', name: '第一代猫', state: 'retired' },
      { id: 'acat_2', familyId: 'fam_1', generation: 2, sessionId: 'ses_gen2', name: '第二代猫', state: 'active' }
    ];
    const runtime = new FakeSyncRuntime();
    runtime.addSession({ id: 'ses_gen2', source: 'assistant-main' });
    const cardService = fakeCardService();
    const service = new LarkTurnSyncService({
      runtime,
      configRepository: repos.config,
      cardMappings: repos.channelMappings,
      turnTracker: new LarkTurnTracker(),
      resolveService: async () => cardService,
      getLineage: () => lineage,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    service.start();
    cleanups.push(() => service.close());

    const outcome = await service.handleTurnEvent({
      id: 'tevt_gen2',
      kind: 'completed',
      sessionId: 'ses_gen2',
      taskId: 'task_gen2',
      agentId: 'claude',
      taskOrigin: 'injected',
      summary: '第 2 代小猫已完成督办验收。',
      timestamp: new Date().toISOString()
    });
    expect(outcome).toMatchObject({ action: 'synced_card', chatId: 'oc_kitten_group', category: 'supervision' });
  });

  it('deduplicates when Agent already called group send to the same bound chat during the turn (quietReply & streaming)', async () => {
    const repos = createTestRepos();
    await seedBot(repos, { quietReply: true });
    await bindHandover(repos, { sessionId: 'ses_quiet', chatId: 'oc_same_chat' });

    const runtime = new FakeSyncRuntime();
    runtime.addSession({ id: 'ses_quiet' });
    const cardService = fakeCardService();
    const tracker = new LarkTurnTracker();
    let clock = 1_700_000_000_000;
    const service = new LarkTurnSyncService({
      runtime,
      configRepository: repos.config,
      cardMappings: repos.channelMappings,
      turnTracker: tracker,
      resolveService: async () => cardService,
      nowMs: () => clock,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    service.start();
    cleanups.push(() => service.close());

    // 同轮调用 group send 发到同一个 chatId -> 跳过重复文本同步（0 次发送）
    await service.handleTurnStart({
      sessionId: 'ses_quiet',
      taskId: 'task_dedup_1',
      prompt: '📋 督办 · 1 个事项有变化',
      agentId: 'claude',
      taskOrigin: 'injected',
      timestamp: new Date(clock).toISOString()
    });
    clock += 500;
    tracker.recordGroupSend({
      sessionId: 'ses_quiet',
      appId: 'cli_bot',
      chatId: 'oc_same_chat',
      messageId: 'om_manual_group_send',
      timestamp: clock
    });
    clock += 500;
    const dedupOutcome = await service.handleTurnEvent({
      id: 'tevt_dedup_1',
      kind: 'completed',
      sessionId: 'ses_quiet',
      taskId: 'task_dedup_1',
      agentId: 'claude',
      taskOrigin: 'injected',
      summary: '重复摘要不应发出',
      timestamp: new Date(clock).toISOString()
    });
    expect(dedupOutcome).toEqual({ action: 'skipped', reason: 'group_send_deduped' });
    expect(cardService.sendText).not.toHaveBeenCalled();

    // 发到其他 chatId 的 group send 不影响当前绑定群同步，静默模式直发带来源徽标的纯文本
    clock += 1000;
    await service.handleTurnStart({
      sessionId: 'ses_quiet',
      taskId: 'task_quiet_ok',
      prompt: '在网页端发送的提问',
      agentId: 'claude',
      timestamp: new Date(clock).toISOString()
    });
    tracker.recordGroupSend({
      sessionId: 'ses_quiet',
      appId: 'cli_bot',
      chatId: 'oc_other_chat',
      messageId: 'om_other',
      timestamp: clock + 100
    });
    const textOutcome = await service.handleTurnEvent({
      id: 'tevt_quiet_ok',
      kind: 'completed',
      sessionId: 'ses_quiet',
      taskId: 'task_quiet_ok',
      agentId: 'claude',
      summary: '这是网页同步的最终回复（含机密 super-secret-value-999）',
      timestamp: new Date(clock + 500).toISOString()
    });
    expect(textOutcome).toMatchObject({ action: 'synced_text', category: 'web', chatId: 'oc_same_chat' });
    expect(cardService.sendText).toHaveBeenCalledTimes(1);
    const sentText = (cardService.sendText.mock.calls[0]![0] as { text: string }).text;
    expect(sentText).toContain('【💻 网页同步】');
    expect(sentText).not.toContain('super-secret-value-999');
    expect(sentText).toContain('[REDACTED]');
  });

  it('streams Trace card in real time when quietReply is false, and cleanly finalizes without duplicating if group send occurs mid-turn', async () => {
    vi.useFakeTimers();
    try {
      const repos = createTestRepos();
      await seedBot(repos, { quietReply: false, pushIntervalMs: 500 });
      await bindHandover(repos, { sessionId: 'ses_stream', chatId: 'oc_stream_chat' });

      const runtime = new FakeSyncRuntime();
      runtime.addSession({ id: 'ses_stream' });
      const cardService = fakeCardService();
      const tracker = new LarkTurnTracker();
      const service = new LarkTurnSyncService({
        runtime,
        configRepository: repos.config,
        cardMappings: repos.channelMappings,
        turnTracker: tracker,
        resolveService: async () => cardService,
        nowMs: () => Date.now(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      });
      service.start();
      cleanups.push(() => service.close());

      await service.handleTurnStart({
        sessionId: 'ses_stream',
        taskId: 'task_stream_1',
        prompt: '📋 督办 · 验收任务',
        agentId: 'claude',
        taskOrigin: 'injected',
        timestamp: new Date().toISOString()
      });

      runtime.pushSessionEvent('ses_stream', {
        id: 'ev_1',
        sessionId: 'ses_stream',
        sequence: 1,
        type: 'tool_call',
        timestamp: new Date().toISOString(),
        data: { id: 'tc1', name: 'run_command', input: { command: 'vitest run' }, status: 'running' }
      });

      // 心跳到达 -> 建立 running 流式卡片
      await vi.advanceTimersByTimeAsync(550);
      await service.flushPending();
      expect(cardService.send).toHaveBeenCalledTimes(1);
      expect(cardService.send.mock.calls[0]![0]).toMatchObject({
        chatId: 'oc_stream_chat',
        state: 'running',
        sourceBadge: { label: '🐾 小猫督办', color: 'purple' }
      });

      // 中途 Agent 主动调了 group send 发往同群
      tracker.recordGroupSend({
        sessionId: 'ses_stream',
        appId: 'cli_bot',
        chatId: 'oc_stream_chat',
        messageId: 'om_mid_send',
        timestamp: Date.now()
      });

      // 终态收口：原地更新卡片为精简去重态（不重复正文，不发第二张卡）
      const outcome = await service.handleTurnEvent({
        id: 'tevt_stream_1',
        kind: 'completed',
        sessionId: 'ses_stream',
        taskId: 'task_stream_1',
        agentId: 'claude',
        taskOrigin: 'injected',
        summary: '超长完整正文不应再重复出现在卡片里',
        timestamp: new Date().toISOString()
      });
      expect(outcome).toMatchObject({ action: 'finalized_deduped_card', messageId: 'om_card_1' });
      expect(cardService.send).toHaveBeenCalledTimes(1);
      expect(cardService.update).toHaveBeenCalledTimes(1);
      const updateInput = cardService.update.mock.calls[0]![0] as { state: string; elements: Array<{ content?: string }> };
      expect(updateInput.state).toBe('completed');
      expect(JSON.stringify(updateInput.elements)).toContain('已通过群消息主动发送');
      expect(JSON.stringify(updateInput.elements)).not.toContain('超长完整正文不应再重复出现在卡片里');
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors per-handover-group turnSync override over bot defaults', async () => {
    const repos = createTestRepos();
    await seedBot(repos, {
      turnSync: { enabled: true, sources: { supervision: true, web: true, schedule: true, maintenance: false } }
    });
    // 单群覆盖：关闭 web、开启 maintenance
    await bindHandover(repos, {
      sessionId: 'ses_custom',
      chatId: 'oc_custom_group',
      turnSync: { enabled: true, sources: { web: false, maintenance: true } }
    });

    const runtime = new FakeSyncRuntime();
    runtime.addSession({ id: 'ses_custom' });
    const cardService = fakeCardService();
    const service = new LarkTurnSyncService({
      runtime,
      configRepository: repos.config,
      cardMappings: repos.channelMappings,
      turnTracker: new LarkTurnTracker(),
      resolveService: async () => cardService,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    service.start();
    cleanups.push(() => service.close());

    const webRes = await service.handleTurnEvent({
      id: 'tevt_c1',
      kind: 'completed',
      sessionId: 'ses_custom',
      taskId: 'task_c1',
      agentId: 'claude',
      summary: '网页消息不应同步',
      timestamp: new Date().toISOString()
    });
    expect(webRes).toEqual({ action: 'skipped', reason: 'category_disabled:web' });

    const maintRes = await service.handleTurnEvent({
      id: 'tevt_c2',
      kind: 'completed',
      sessionId: 'ses_custom',
      taskId: 'task_c2',
      agentId: 'claude',
      taskOrigin: 'maintenance',
      summary: '整理完成，折叠 3 张便签。',
      timestamp: new Date().toISOString()
    });
    expect(maintRes).toMatchObject({ action: 'synced_card', category: 'maintenance', chatId: 'oc_custom_group' });
  });

  it('never double-syncs Lark-owned turns even under concurrent dispatch, and blocks self-loop echoes in LarkMessageCoordinator', async () => {
    const repos = createTestRepos();
    const botConfig = await seedBot(repos);
    await bindHandover(repos, { sessionId: 'ses_lark_bound', chatId: 'oc_bound_chat' });

    const runtime = new FakeSyncRuntime();
    runtime.addSession({ id: 'ses_lark_bound' });
    const cardService = fakeCardService();
    const tracker = new LarkTurnTracker();
    const service = new LarkTurnSyncService({
      runtime,
      configRepository: repos.config,
      cardMappings: repos.channelMappings,
      turnTracker: tracker,
      resolveService: async () => cardService,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    service.start();
    cleanups.push(() => service.close());

    // 模拟竞态：Lark 正在 dispatch（尚未返回 taskId），此时 runtime 已经同步发出 onTurnStart！
    const release = tracker.beginLarkDispatch('ses_lark_bound');
    const startPromise = service.handleTurnStart({
      sessionId: 'ses_lark_bound',
      taskId: 'task_from_lark',
      prompt: '群里 @ 机器人的问题',
      agentId: 'claude',
      timestamp: new Date().toISOString()
    });
    // dispatch 返回后立刻记为 Lark 拥有并释放等待
    tracker.markLarkOwnedTask('task_from_lark');
    release();

    await expect(startPromise).resolves.toEqual({ tracked: false, reason: 'lark_owned' });
    await expect(service.handleTurnEvent({
      id: 'tevt_lark_1',
      kind: 'completed',
      sessionId: 'ses_lark_bound',
      taskId: 'task_from_lark',
      agentId: 'claude',
      summary: '飞书原轮次回复',
      timestamp: new Date().toISOString()
    })).resolves.toEqual({ action: 'skipped', reason: 'lark_owned' });
    expect(cardService.send).not.toHaveBeenCalled();

    // 验证防自激循环：同步发出的 outbound messageId 与机器人自身 senderOpenId 均不可触发新轮次
    const mockRuntime = {
      start: vi.fn(),
      getSession: vi.fn(async () => ({ id: 'ses_lark_bound', agentId: 'claude', state: 'idle', cwd: '/tmp', permissionMode: 'full-trust' as const, createdAt: '', updatedAt: '' })),
      send: vi.fn(),
      dispatch: vi.fn(),
      interrupt: vi.fn(),
      subscribe: vi.fn(() => () => {})
    };
    const coordinator = new LarkMessageCoordinator(
      mockRuntime,
      { ...cardService, addReaction: vi.fn(), deleteReaction: vi.fn() } as any,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      Math.random,
      'ou_self_bot',
      undefined,
      repos.channelMappings,
      repos.config,
      undefined,
      undefined,
      undefined,
      tracker
    );
    tracker.markOutboundMessage('om_synced_echo');
    await coordinator.handle({
      messageId: 'om_synced_echo',
      chatId: 'oc_bound_chat',
      chatType: 'group',
      messageType: 'interactive',
      content: '{}',
      senderOpenId: 'ou_someone',
      senderType: 'app',
      mentions: [{ key: '@bot', name: '小猫', openId: 'ou_self_bot' }]
    }, botConfig);
    await coordinator.handle({
      messageId: 'om_self_sender',
      chatId: 'oc_bound_chat',
      chatType: 'group',
      messageType: 'text',
      content: JSON.stringify({ text: '@bot 自己发的消息' }),
      senderOpenId: 'ou_self_bot',
      senderType: 'app',
      mentions: [{ key: '@bot', name: '小猫', openId: 'ou_self_bot' }]
    }, botConfig);
    expect(mockRuntime.dispatch).not.toHaveBeenCalled();
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });

  it('supports POST / GET / PATCH /api/sessions/:id/handover with per-group turnSync config and lineage inheritance', async () => {
    const repos = createTestRepos();
    await seedBot(repos, {
      turnSync: { enabled: true, sources: { supervision: true, web: true, schedule: true, maintenance: false }, filterSilentSchedule: true }
    });
    const runtime = new FakeSyncRuntime();
    runtime.addSession({ id: 'ses_gen1', title: '小猫主会话', source: 'assistant-main' });
    runtime.addSession({ id: 'ses_gen2', title: '二代小猫', source: 'assistant-main' });

    const lineage: HandoverCatLike[] = [
      { id: 'acat_1', familyId: 'fam_k', generation: 1, sessionId: 'ses_gen1', name: '大橘', state: 'retired' },
      { id: 'acat_2', familyId: 'fam_k', generation: 2, sessionId: 'ses_gen2', name: '小橘', state: 'active' }
    ];

    const app = Fastify();
    cleanups.push(() => app.close());
    await registerLarkRoutes(app, {
      config: repos.config,
      cardMappings: repos.channelMappings,
      runtime: runtime as any,
      assistant: { lifecycle: { lineage: () => lineage } } as any,
      listeningDisabled: true,
      fetcher: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/v3/tenant_access_token/internal')) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }));
        }
        if (url.includes('/im/v1/chats')) {
          return new Response(JSON.stringify({ code: 0, data: { chat_id: 'oc_created_group' } }));
        }
        return new Response(JSON.stringify({ code: 0, data: {} }));
      }) as typeof globalThis.fetch
    });

    // POST 托管时直接写入群级 turnSync
    const postRes = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_gen1/handover',
      payload: {
        appId: 'cli_bot',
        name: '大橘的托管群',
        syncBotProfile: false,
        turnSync: { enabled: true, sources: { maintenance: true, web: false }, filterSilentSchedule: false }
      }
    });
    expect(postRes.statusCode).toBe(200);
    expect(postRes.json()).toMatchObject({
      chatId: 'oc_created_group',
      effectiveTurnSync: {
        enabled: true,
        sources: { supervision: true, web: false, schedule: true, maintenance: true },
        filterSilentSchedule: false
      }
    });

    // 第 2 代在岗小猫通过 GET 自动继承同家族托管群绑定与配置
    const getGen2 = await app.inject({ method: 'GET', url: '/api/sessions/ses_gen2/handover' });
    expect(getGen2.statusCode).toBe(200);
    expect(getGen2.json().handover).toMatchObject({
      chatId: 'oc_created_group',
      effectiveTurnSync: {
        enabled: true,
        sources: { supervision: true, web: false, schedule: true, maintenance: true },
        filterSilentSchedule: false
      }
    });

    // PATCH 修改单群配置
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/ses_gen2/handover',
      payload: { turnSync: { sources: { web: true, maintenance: false } } }
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().handover.effectiveTurnSync).toEqual({
      enabled: true,
      sources: { supervision: true, web: true, schedule: true, maintenance: false },
      filterSilentSchedule: false
    });

    // PATCH turnSync: null 恢复继承机器人默认
    const resetRes = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/ses_gen2/handover',
      payload: { turnSync: null }
    });
    expect(resetRes.statusCode).toBe(200);
    expect(resetRes.json().handover.turnSync).toBeUndefined();
    expect(resetRes.json().handover.effectiveTurnSync).toEqual({
      enabled: true,
      sources: { supervision: true, web: true, schedule: true, maintenance: false },
      filterSilentSchedule: true
    });
  });

  it('wires LarkAgentToolsService.send -> onGroupSent -> LarkTurnTracker -> LarkTurnSyncService end-to-end dedup and native Lark group sync', async () => {
    const repos = createTestRepos();
    await seedBot(repos, { groupToolsEnabled: true, groupToolsAllowSend: true, quietReply: false });
    await repos.sessions.save({
      id: 'ses_e2e',
      agentId: 'claude',
      state: 'idle',
      cwd: '/tmp/ws',
      permissionMode: 'full-trust',
      runId: 'run_e2e',
      source: 'lark',
      sourceId: 'cli_bot:oc_native_grp:group:chat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const tracker = new LarkTurnTracker();
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310', 'test-secret');
    capabilities.useHandoverLookup(createHandoverLookup(repos.config, repos.channelMappings));
    const groupClient = {
      getBotInfo: vi.fn(async () => ({ appName: '小猫', openId: 'ou_bot' })),
      listChatMembers: vi.fn(async () => ({ items: [], hasMore: false, securityLimited: false })),
      listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
      getMessage: vi.fn(),
      getMessageItems: vi.fn(async () => []),
      sendText: vi.fn(async () => ({ messageId: 'om_tool_sent_1', chatId: 'oc_native_grp' })),
      replyText: vi.fn(),
      sendPost: vi.fn(),
      replyPost: vi.fn(),
      uploadImage: vi.fn(),
      sendImage: vi.fn(),
      replyImage: vi.fn()
    };
    const agentTools = new LarkAgentToolsService(capabilities, repos.config, {
      clientFactory: () => groupClient as any,
      onGroupSent: record => tracker.recordGroupSend(record)
    });

    const runtime = new FakeSyncRuntime();
    runtime.addSession({ id: 'ses_e2e', source: 'lark', sourceId: 'cli_bot:oc_native_grp:group:chat' });
    const cardService = fakeCardService();
    const syncService = new LarkTurnSyncService({
      runtime,
      configRepository: repos.config,
      cardMappings: repos.channelMappings,
      turnTracker: tracker,
      resolveService: async () => cardService,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    syncService.start();
    cleanups.push(() => { syncService.close(); capabilities.close(); });

    // Web 端对原生飞书群会话发消息，且中途 Agent 主动调了 group send -> 同步跳过（零重复）
    const issued = await agentTools.issueCapability('ses_e2e');
    await syncService.handleTurnStart({
      sessionId: 'ses_e2e',
      taskId: 'task_e2e_dedup',
      prompt: '在网页端触发并手动发群',
      agentId: 'claude',
      sessionSource: 'lark',
      sessionSourceId: 'cli_bot:oc_native_grp:group:chat',
      timestamp: new Date().toISOString()
    });
    await agentTools.send(issued.agentdock_group_tools_token, { content: '我已主动汇报到群里' });
    expect(tracker.isOutboundMessage('om_tool_sent_1')).toBe(true);

    const dedupRes = await syncService.handleTurnEvent({
      id: 'tevt_e2e_1',
      kind: 'completed',
      sessionId: 'ses_e2e',
      taskId: 'task_e2e_dedup',
      agentId: 'claude',
      sessionSource: 'lark',
      sessionSourceId: 'cli_bot:oc_native_grp:group:chat',
      summary: '我已主动汇报到群里',
      timestamp: new Date().toISOString()
    });
    expect(dedupRes).toEqual({ action: 'skipped', reason: 'group_send_deduped' });
    expect(cardService.send).not.toHaveBeenCalled();

    // 下一轮 Web 对话没有调 group send -> 自动同步到原飞书群主线程
    const syncRes = await syncService.handleTurnEvent({
      id: 'tevt_e2e_2',
      kind: 'completed',
      sessionId: 'ses_e2e',
      taskId: 'task_e2e_sync',
      agentId: 'claude',
      sessionSource: 'lark',
      sessionSourceId: 'cli_bot:oc_native_grp:group:chat',
      summary: '网页端的新进展同步到原飞书群。',
      timestamp: new Date().toISOString()
    });
    expect(syncRes).toMatchObject({ action: 'synced_card', category: 'web', chatId: 'oc_native_grp' });
    expect(cardService.send).toHaveBeenCalledTimes(1);
  });

  it('integrates seamlessly with LarkOutputPluginAdapterRegistry when a synced non-Lark turn ends with XML plugin output', async () => {
    const repos = createTestRepos();
    await seedBot(repos, { quietReply: false });
    await bindHandover(repos, { sessionId: 'ses_xml', chatId: 'oc_xml_group' });

    const runtime = new FakeSyncRuntime();
    runtime.addSession({ id: 'ses_xml' });
    const cardService = fakeCardService();
    const tracker = new LarkTurnTracker();
    const syncService = new LarkTurnSyncService({
      runtime,
      configRepository: repos.config,
      cardMappings: repos.channelMappings,
      turnTracker: tracker,
      resolveService: async () => cardService,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    syncService.start();
    cleanups.push(() => syncService.close());

    const xmlReply = [
      '我整理了两个实施方案，请确认采用哪一个：',
      '<agentdock-ask-user-question id="q_sync_1" title="方案选择">',
      '  <question id="plan">',
      '    <prompt>选择发布方案</prompt>',
      '    <option value="canary" recommended="true">灰度发布</option>',
      '    <option value="full">全量发布</option>',
      '  </question>',
      '</agentdock-ask-user-question>'
    ].join('\n');

    const res = await syncService.handleTurnEvent({
      id: 'tevt_xml_1',
      kind: 'completed',
      sessionId: 'ses_xml',
      taskId: 'task_xml_1',
      agentId: 'claude',
      taskOrigin: 'injected',
      summary: xmlReply,
      timestamp: new Date().toISOString()
    });
    expect(res).toMatchObject({ action: 'synced_card', category: 'supervision', chatId: 'oc_xml_group' });
    // 主卡片不泄漏裸 XML，并自动通过 LarkOutputPluginAdapterRegistry 推送 Schema 2.0 交互卡片
    expect(cardService.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(cardService.send.mock.calls[0]![0])).not.toContain('<agentdock-ask-user-question');
    expect(cardService.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(cardService.sendInteractiveCard.mock.calls[0]![0]).toMatchObject({
      chatId: 'oc_xml_group'
    });
    expect(tracker.isOutboundMessage('om_plugin_2')).toBe(true);
    // 持久化落库保证兜底桥接不会重复发送第二张交互卡
    const askMappings = await repos.channelMappings.list(LARK_ASK_CARD_CHANNEL);
    expect(askMappings).toHaveLength(1);
  });

  it('parses all ordinary Lark session sourceId variants (group, oc_ p2p, legacy 2-part p2p, ou_ p2p)', () => {
    expect(parseLarkSessionSourceBinding('lark', 'cli_bot:oc_grp_1:group:chat')).toEqual({
      appId: 'cli_bot',
      chatId: 'oc_grp_1',
      receiveIdType: 'chat_id',
      chatType: 'group',
      scope: 'chat'
    });
    expect(parseLarkSessionSourceBinding('lark', 'cli_bot:oc_grp_1:group:thread:omt_99')).toEqual({
      appId: 'cli_bot',
      chatId: 'oc_grp_1',
      receiveIdType: 'chat_id',
      chatType: 'group',
      scope: 'thread:omt_99'
    });
    expect(parseLarkSessionSourceBinding('lark', 'cli_bot:oc_dm_1:p2p')).toEqual({
      appId: 'cli_bot',
      chatId: 'oc_dm_1',
      receiveIdType: 'chat_id',
      chatType: 'p2p',
      scope: ''
    });
    expect(parseLarkSessionSourceBinding('lark', 'cli_bot:oc_dm_legacy')).toEqual({
      appId: 'cli_bot',
      chatId: 'oc_dm_legacy',
      receiveIdType: 'chat_id',
      chatType: 'p2p',
      scope: ''
    });
    expect(parseLarkSessionSourceBinding('lark', 'cli_bot:ou_user_42:p2p')).toEqual({
      appId: 'cli_bot',
      chatId: 'ou_user_42',
      receiveIdType: 'open_id',
      chatType: 'p2p',
      scope: ''
    });
    expect(parseLarkSessionSourceBinding('web', 'cli_bot:oc_dm_1:p2p')).toBeUndefined();
    expect(parseLarkSessionSourceBinding('lark', 'cli_bot:bad_id:group:chat')).toBeUndefined();
  });

  it('syncs ordinary Feishu DM (p2p oc_ & ou_) sessions with source badge, quietReply, redaction, XML plugin card, self-loop guard, and per-session override', async () => {
    const repos = createTestRepos();
    await seedBot(repos, { appSecret: 'sec_dm_secret_value', quietReply: false });

    const runtime = new FakeSyncRuntime();
    runtime.addSession({ id: 'ses_dm_oc', source: 'lark', sourceId: 'cli_bot:oc_dm_room:p2p', title: '和暮雪私聊' });
    runtime.addSession({ id: 'ses_dm_legacy', source: 'lark', sourceId: 'cli_bot:oc_dm_legacy', title: '老私聊会话' });
    runtime.addSession({ id: 'ses_dm_ou', source: 'lark', sourceId: 'cli_bot:ou_user_dm:p2p', title: 'openId 私聊' });

    const cardService = fakeCardService();
    const tracker = new LarkTurnTracker();
    const syncService = new LarkTurnSyncService({
      runtime,
      configRepository: repos.config,
      cardMappings: repos.channelMappings,
      turnTracker: tracker,
      resolveService: async () => cardService,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    syncService.start();
    cleanups.push(() => syncService.close());

    // 1) 标准 oc_ 私聊：Web 对话 + 凭据脱敏 + XML 交互插件卡片（chatType === 'p2p'）
    runtime.addTask({
      id: 'task_dm_1',
      sessionId: 'ses_dm_oc',
      prompt: '帮我看下发布状态',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const dmXmlReply = [
      '发布准备完成（绝不泄漏 sec_dm_secret_value）。',
      '<agentdock-ask-user-question id="q_dm_1" title="确认发布">',
      '  <question id="go">',
      '    <prompt>是否立刻发布？</prompt>',
      '    <option value="yes" recommended="true">立即发布</option>',
      '  </question>',
      '</agentdock-ask-user-question>'
    ].join('\n');
    const dmRes = await syncService.handleTurnEvent({
      id: 'tevt_dm_1',
      kind: 'completed',
      sessionId: 'ses_dm_oc',
      taskId: 'task_dm_1',
      agentId: 'claude',
      sessionSource: 'lark',
      sessionSourceId: 'cli_bot:oc_dm_room:p2p',
      summary: dmXmlReply,
      timestamp: new Date().toISOString()
    });
    expect(dmRes).toMatchObject({
      action: 'synced_card',
      category: 'web',
      chatId: 'oc_dm_room',
      chatType: 'p2p',
      bindingKind: 'lark-p2p'
    });
    expect(cardService.send).toHaveBeenCalledTimes(1);
    const firstSend = cardService.send.mock.calls[0]![0];
    expect(firstSend).toMatchObject({
      chatId: 'oc_dm_room',
      taskName: '问：帮我看下发布状态',
      sourceBadge: { label: '💻 网页同步', color: 'blue' }
    });
    expect(JSON.stringify(firstSend)).not.toContain('sec_dm_secret_value');
    expect(JSON.stringify(firstSend)).toContain('[REDACTED]');
    expect(cardService.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(cardService.sendInteractiveCard.mock.calls[0]![0]).toMatchObject({ chatId: 'oc_dm_room' });
    expect(tracker.isOutboundMessage('om_card_1')).toBe(true);
    expect(tracker.isOutboundMessage('om_plugin_2')).toBe(true);
    const askMappings = await repos.channelMappings.list(LARK_ASK_CARD_CHANNEL);
    expect(askMappings).toHaveLength(1);
    expect(JSON.parse(askMappings[0]!.extra!)).toMatchObject({ chatId: 'oc_dm_room', chatType: 'p2p' });

    // 2) 历史 2 段私聊格式：定时任务同步到私聊
    const legacyRes = await syncService.handleTurnEvent({
      id: 'tevt_dm_2',
      kind: 'completed',
      sessionId: 'ses_dm_legacy',
      taskId: 'task_dm_2',
      agentId: 'claude',
      taskOrigin: 'schedule',
      sessionSource: 'lark',
      sessionSourceId: 'cli_bot:oc_dm_legacy',
      summary: '早报巡检发现 1 条待处理工单。',
      timestamp: new Date().toISOString()
    });
    expect(legacyRes).toMatchObject({ action: 'synced_card', category: 'schedule', chatId: 'oc_dm_legacy', chatType: 'p2p' });

    // 3) open_id 变体私聊 + quietReply 纯文本模式：应走 receiveId + receiveIdType: 'open_id'
    await seedBot(repos, { originalAppId: 'cli_bot', appSecret: 'sec_dm_secret_value', quietReply: true });
    const ouRes = await syncService.handleTurnEvent({
      id: 'tevt_dm_3',
      kind: 'completed',
      sessionId: 'ses_dm_ou',
      taskId: 'task_dm_3',
      agentId: 'claude',
      sessionSource: 'lark',
      sessionSourceId: 'cli_bot:ou_user_dm:p2p',
      summary: '私聊纯文本同步成功。',
      timestamp: new Date().toISOString()
    });
    expect(ouRes).toMatchObject({ action: 'synced_text', category: 'web', chatId: 'ou_user_dm', chatType: 'p2p' });
    expect(cardService.sendText).toHaveBeenCalledWith(expect.objectContaining({
      receiveId: 'ou_user_dm',
      receiveIdType: 'open_id',
      text: expect.stringContaining('【💻 网页同步】')
    }));

    // 4) 单会话覆写关闭该私聊的 Web 同步 -> 跳过，但定时任务仍同步
    await saveSessionTurnSyncOverride(repos.channelMappings, 'ses_dm_oc', {
      enabled: true,
      sources: { web: false, schedule: true }
    });
    const skippedWeb = await syncService.handleTurnEvent({
      id: 'tevt_dm_4',
      kind: 'completed',
      sessionId: 'ses_dm_oc',
      taskId: 'task_dm_4',
      agentId: 'claude',
      sessionSource: 'lark',
      sessionSourceId: 'cli_bot:oc_dm_room:p2p',
      summary: '被单会话覆写关闭的网页消息',
      timestamp: new Date().toISOString()
    });
    expect(skippedWeb).toEqual({ action: 'skipped', reason: 'category_disabled:web' });
  });

  it('syncs ordinary Feishu group chat sessions (including thread-scoped) directly to group main thread and honors per-session overrides', async () => {
    const repos = createTestRepos();
    await seedBot(repos, { quietReply: false });

    const runtime = new FakeSyncRuntime();
    runtime.addSession({
      id: 'ses_grp_thread',
      source: 'lark',
      sourceId: 'cli_bot:oc_normal_grp:group:thread:omt_topic_1',
      title: '项目群话题会话'
    });

    const cardService = fakeCardService();
    const syncService = new LarkTurnSyncService({
      runtime,
      configRepository: repos.config,
      cardMappings: repos.channelMappings,
      turnTracker: new LarkTurnTracker(),
      resolveService: async () => cardService,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    syncService.start();
    cleanups.push(() => syncService.close());

    runtime.addTask({
      id: 'task_grp_1',
      sessionId: 'ses_grp_thread',
      prompt: '汇总一下今天改动',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const res = await syncService.handleTurnEvent({
      id: 'tevt_grp_1',
      kind: 'completed',
      sessionId: 'ses_grp_thread',
      taskId: 'task_grp_1',
      agentId: 'claude',
      sessionSource: 'lark',
      sessionSourceId: 'cli_bot:oc_normal_grp:group:thread:omt_topic_1',
      summary: '已完成三项核心改动。',
      timestamp: new Date().toISOString()
    });
    expect(res).toMatchObject({
      action: 'synced_card',
      category: 'web',
      chatId: 'oc_normal_grp',
      chatType: 'group',
      bindingKind: 'lark-group'
    });
    // 始终直发群主线程，不带 replyTo / replyInThread
    const sendArg = cardService.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(sendArg.chatId).toBe('oc_normal_grp');
    expect(sendArg.replyTo).toBeUndefined();
    expect(sendArg.replyInThread).toBeUndefined();

    // 单会话覆写关闭该普通飞书群会话的总开关
    await saveSessionTurnSyncOverride(repos.channelMappings, 'ses_grp_thread', { enabled: false });
    const skipped = await syncService.handleTurnEvent({
      id: 'tevt_grp_2',
      kind: 'completed',
      sessionId: 'ses_grp_thread',
      taskId: 'task_grp_2',
      agentId: 'claude',
      sessionSource: 'lark',
      sessionSourceId: 'cli_bot:oc_normal_grp:group:thread:omt_topic_1',
      summary: '关闭后不应再推送',
      timestamp: new Date().toISOString()
    });
    expect(skipped).toEqual({ action: 'skipped', reason: 'category_disabled:web' });
  });

  it('exposes unified GET/PATCH binding & turnSync override APIs for all three ordinary session types (ordinary handover, Feishu group, Feishu DM)', async () => {
    const repos = createTestRepos();
    await seedBot(repos, {
      name: '普通工作助手',
      turnSync: { enabled: true, sources: { supervision: true, web: true, schedule: true, maintenance: false } }
    });
    await bindHandover(repos, {
      sessionId: 'ses_ord_handover',
      chatId: 'oc_ord_handover',
      name: '普通需求托管群'
    });

    const sessions: Record<string, Session> = {
      ses_ord_handover: {
        id: 'ses_ord_handover',
        agentId: 'claude',
        cwd: '/tmp',
        state: 'idle',
        title: '普通需求会话',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      ses_ord_lark_group: {
        id: 'ses_ord_lark_group',
        agentId: 'claude',
        cwd: '/tmp',
        state: 'idle',
        source: 'lark',
        sourceId: 'cli_bot:oc_ord_group:group:chat',
        title: '前端联调群',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      ses_ord_lark_dm: {
        id: 'ses_ord_lark_dm',
        agentId: 'claude',
        cwd: '/tmp',
        state: 'idle',
        source: 'lark',
        sourceId: 'cli_bot:oc_ord_dm:p2p',
        title: '暮雪私聊',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      ses_unbound_web: {
        id: 'ses_unbound_web',
        agentId: 'claude',
        cwd: '/tmp',
        state: 'idle',
        title: '未托管普通会话',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    };

    const app = Fastify();
    await registerLarkRoutes(app, {
      config: repos.config,
      cardMappings: repos.channelMappings,
      runtime: { getSession: async id => sessions[id] } as any,
      listeningDisabled: true
    });
    cleanups.push(() => app.close());

    // 1) 普通托管群：handover 与 larkBinding 均返回，PATCH 更新并可传 null 恢复默认
    const getHandover = await app.inject({ method: 'GET', url: '/api/sessions/ses_ord_handover/handover' });
    expect(getHandover.statusCode).toBe(200);
    expect(getHandover.json()).toMatchObject({
      handover: { appId: 'cli_bot', chatId: 'oc_ord_handover', name: '普通需求托管群' },
      larkBinding: { kind: 'handover', chatType: 'group', chatId: 'oc_ord_handover', botName: '普通工作助手' },
      kitten: null
    });
    const patchHandover = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/ses_ord_handover/handover',
      payload: { turnSync: { enabled: true, sources: { web: false } } }
    });
    expect(patchHandover.statusCode).toBe(200);
    expect(patchHandover.json().larkBinding.effectiveTurnSync.sources.web).toBe(false);

    // 2) 普通飞书群聊：handover 为 null，larkBinding.kind === 'lark-group'，支持独立覆写与恢复默认
    const getGroup = await app.inject({ method: 'GET', url: '/api/sessions/ses_ord_lark_group/handover' });
    expect(getGroup.statusCode).toBe(200);
    expect(getGroup.json()).toMatchObject({
      handover: null,
      larkBinding: {
        kind: 'lark-group',
        chatType: 'group',
        chatId: 'oc_ord_group',
        name: '前端联调群',
        url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_ord_group',
        effectiveTurnSync: { enabled: true, sources: { web: true, schedule: true } }
      }
    });
    const patchGroup = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/ses_ord_lark_group/lark-binding',
      payload: { turnSync: { enabled: false } }
    });
    expect(patchGroup.statusCode).toBe(200);
    expect(patchGroup.json().larkBinding.turnSync.enabled).toBe(false);
    expect(patchGroup.json().larkBinding.effectiveTurnSync.enabled).toBe(false);
    const resetGroup = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/ses_ord_lark_group/handover',
      payload: { turnSync: null }
    });
    expect(resetGroup.statusCode).toBe(200);
    expect(resetGroup.json().larkBinding.turnSync).toBeUndefined();
    expect(resetGroup.json().larkBinding.effectiveTurnSync.enabled).toBe(true);

    // 3) 普通飞书私聊：handover 为 null，larkBinding.kind === 'lark-p2p'，支持独立覆写与恢复默认
    const getDm = await app.inject({ method: 'GET', url: '/api/sessions/ses_ord_lark_dm/lark-binding' });
    expect(getDm.statusCode).toBe(200);
    expect(getDm.json()).toMatchObject({
      handover: null,
      larkBinding: {
        kind: 'lark-p2p',
        chatType: 'p2p',
        chatId: 'oc_ord_dm',
        name: '暮雪私聊',
        url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_ord_dm'
      }
    });
    const patchDm = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/ses_ord_lark_dm/handover',
      payload: { turnSync: { enabled: true, sources: { schedule: false } } }
    });
    expect(patchDm.statusCode).toBe(200);
    expect(patchDm.json().larkBinding.effectiveTurnSync.sources.schedule).toBe(false);
    expect(patchDm.json().larkBinding.effectiveTurnSync.sources.web).toBe(true);

    // 4) 未绑定的普通 Web 会话：GET 返回 null，PATCH 返回 404
    const getUnbound = await app.inject({ method: 'GET', url: '/api/sessions/ses_unbound_web/handover' });
    expect(getUnbound.statusCode).toBe(200);
    expect(getUnbound.json()).toEqual({ handover: null, larkBinding: null, kitten: null });
    const patchUnbound = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/ses_unbound_web/handover',
      payload: { turnSync: { enabled: false } }
    });
    expect(patchUnbound.statusCode).toBe(404);
  });

  it('syncs task recovery turns with 🔄 断点续跑 badge across handover, lark-group, and lark-p2p bindings even when web source toggle is off', async () => {
    const repos = createTestRepos();
    const { appId } = await seedBot(repos, {
      turnSync: { enabled: true, sources: { supervision: true, web: false, schedule: true, maintenance: false } }
    });

    // Classify source + clean title stripping redundant prefix
    const source = classifyTurnSource({ taskOrigin: 'recovery', prompt: '🔄 断点续跑：补齐支付模块回归测试' });
    expect(source).toMatchObject({ badge: '🔄 断点续跑', label: '断点续跑', tagColor: 'wathet' });
    expect(formatSyncedTaskName('🔄 断点续跑：补齐支付模块回归测试', source, undefined, 'recovery')).toBe('补齐支付模块回归测试');

    const fakeRuntime = new FakeSyncRuntime();
    fakeRuntime.addSession({ id: 'ses_rec_handover', runId: 'run_1' });
    fakeRuntime.addSession({ id: 'ses_rec_group', source: 'lark', sourceId: `${appId}:oc_rec_grp:group`, runId: 'run_2' });
    fakeRuntime.addSession({ id: 'ses_rec_p2p', source: 'lark', sourceId: `${appId}:oc_rec_dm:p2p`, runId: 'run_3' });
    await bindHandover(repos, { appId, chatId: 'oc_rec_handover', sessionId: 'ses_rec_handover', name: '普通托管群' });

    const sentCards: Array<{ chatId?: string; sourceBadge?: { label: string; color?: string }; taskName?: string }> = [];
    const cardPort: LarkTurnSyncCardPort = {
      send: vi.fn(async input => {
        sentCards.push({ chatId: input.chatId, sourceBadge: input.sourceBadge, taskName: input.taskName });
        return { messageId: `om_rec_${sentCards.length}`, chatId: input.chatId };
      }),
      update: vi.fn(async input => ({ messageId: input.messageId })),
      sendText: vi.fn(async input => ({ messageId: 'om_txt', chatId: input.chatId }))
    };

    const stamp = new Date().toISOString();
    fakeRuntime.addTask({ id: 'task_rec_1', sessionId: 'ses_rec_handover', prompt: '🔄 断点续跑：继续构建文档', origin: 'recovery', status: 'completed', finalText: '文档构建已完成。', createdAt: stamp, updatedAt: stamp });
    fakeRuntime.addTask({ id: 'task_rec_2', sessionId: 'ses_rec_group', prompt: '🔄 断点续跑：巡检服务状态', origin: 'recovery', status: 'completed', finalText: '巡检正常。', createdAt: stamp, updatedAt: stamp });
    fakeRuntime.addTask({ id: 'task_rec_3', sessionId: 'ses_rec_p2p', prompt: '🔄 断点续跑：整理周报', origin: 'recovery', status: 'completed', finalText: '周报已整理完毕。', createdAt: stamp, updatedAt: stamp });

    const sync = new LarkTurnSyncService({
      runtime: fakeRuntime,
      configRepository: repos.config,
      cardMappings: repos.channelMappings,
      turnTracker: new LarkTurnTracker(),
      resolveService: async () => cardPort,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined }
    });

    for (const [sessionId, taskId, expectedChatId] of [
      ['ses_rec_handover', 'task_rec_1', 'oc_rec_handover'],
      ['ses_rec_group', 'task_rec_2', 'oc_rec_grp'],
      ['ses_rec_p2p', 'task_rec_3', 'oc_rec_dm']
    ] as const) {
      const outcome = await sync.handleTurnEvent({
        id: `te_${taskId}`,
        kind: 'completed',
        sessionId,
        taskId,
        agentId: 'claude',
        taskOrigin: 'recovery',
        summary: '已完成断点续跑',
        timestamp: stamp
      });
      expect(outcome).toMatchObject({ action: 'synced_card', chatId: expectedChatId });
    }

    expect(sentCards).toEqual([
      { chatId: 'oc_rec_handover', sourceBadge: { label: '🔄 断点续跑', color: 'wathet' }, taskName: '继续构建文档' },
      { chatId: 'oc_rec_grp', sourceBadge: { label: '🔄 断点续跑', color: 'wathet' }, taskName: '巡检服务状态' },
      { chatId: 'oc_rec_dm', sourceBadge: { label: '🔄 断点续跑', color: 'wathet' }, taskName: '整理周报' }
    ]);
  });

  it('attaches Lark turquoise source badge with Lark logo icon when syncing emoji reaction turns', async () => {
    const repos = createTestRepos();
    const appId = 'cli_emoji_sync';
    await seedBot(repos, { appId });
    await bindHandover(repos, { appId, chatId: 'oc_handover_emoji', sessionId: 'ses_main_emoji', name: '小猫督办群' });

    const fakeRuntime = new FakeSyncRuntime();
    fakeRuntime.addSession({ id: 'ses_main_emoji', source: 'assistant-main' });
    const cardService = fakeCardService();
    const sync = new LarkTurnSyncService({
      runtime: fakeRuntime,
      configRepository: repos.config,
      cardMappings: repos.channelMappings,
      turnTracker: new LarkTurnTracker(),
      resolveService: async () => cardService,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    cleanups.push(() => sync.close());

    const stamp = new Date().toISOString();
    fakeRuntime.addTask({
      id: 'task_emoji_1',
      sessionId: 'ses_main_emoji',
      prompt: '飞书表情触发（OK）：请帮我看下这条消息',
      origin: 'emoji',
      status: 'completed',
      finalText: '已处理该消息。',
      createdAt: stamp,
      updatedAt: stamp
    });

    const outcome = await sync.handleTurnEvent({
      id: 'te_emoji_1',
      kind: 'completed',
      sessionId: 'ses_main_emoji',
      taskId: 'task_emoji_1',
      agentId: 'claude',
      taskOrigin: 'emoji',
      summary: '已处理该消息。',
      timestamp: stamp
    });

    expect(outcome).toMatchObject({ action: 'synced_card', category: 'web', chatId: 'oc_handover_emoji' });
    expect(cardService.send).toHaveBeenCalledTimes(1);
    expect(cardService.send.mock.calls[0]![0]).toMatchObject({
      chatId: 'oc_handover_emoji',
      state: 'completed',
      readOnly: true,
      sourceBadge: { label: '🕊️ 飞书表情', color: 'turquoise' }
    });
  });
});
