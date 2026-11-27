import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { RuntimeTurnEvent } from '@agent-dock/agent-dock-shared';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import { buildApp } from '../app.js';
import {
  DEFAULT_NOTIFICATION_CONFIG,
  MASKED_SECRET_SENTINEL,
  parseAndMergeNotificationConfig,
  toPublicNotificationConfig
} from './config.js';
import {
  buildWebhookRequest,
  deliverCommandHook,
  deliverLarkNotification,
  deliverWebhookNotification,
  type NotificationPayload
} from './delivery.js';
import {
  coalescePayloads,
  evaluateNotificationRule,
  NotificationService
} from './service.js';

function makeTurnEvent(overrides: Partial<RuntimeTurnEvent> = {}): RuntimeTurnEvent {
  return {
    id: 'tevt_1',
    kind: 'completed',
    sessionId: 'ses_1',
    taskId: 'task_1',
    agentId: 'claude',
    sessionTitle: '重构通知系统',
    durationMs: 15_000,
    summary: '已完成后端与前端改造。',
    timestamp: '2026-11-27T00:00:00.000Z',
    ...overrides
  };
}

function makePayload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    id: 'ntf_1',
    kind: 'completed',
    sessionId: 'ses_1',
    taskId: 'task_1',
    agentId: 'claude',
    sessionTitle: '重构通知系统',
    durationMs: 18_000,
    summary: '已完成全部单测与构建验证。',
    timestamp: '2026-11-27T00:00:00.000Z',
    ...overrides
  };
}

describe('notifications: 规则与防刷屏引擎', () => {
  it('用户主动停止（user_stopped）与 agent_cancelled 硬抑制，不触发通知', () => {
    const userStop = evaluateNotificationRule(
      makeTurnEvent({ kind: 'interrupted', interruptIntent: 'user' }),
      DEFAULT_NOTIFICATION_CONFIG,
      { isAssistantSubtask: false, isScheduledSession: false }
    );
    expect(userStop).toEqual({ notify: false, reason: 'user_stopped' });

    const agentCancel = evaluateNotificationRule(
      makeTurnEvent({ kind: 'interrupted', interruptIntent: 'agent_cancelled' }),
      DEFAULT_NOTIFICATION_CONFIG,
      { isAssistantSubtask: false, isScheduledSession: false }
    );
    expect(agentCancel).toEqual({ notify: false, reason: 'agent_cancelled' });

    const restartInterrupt = evaluateNotificationRule(
      makeTurnEvent({ kind: 'interrupted', interruptIntent: 'daemon_restart' }),
      DEFAULT_NOTIFICATION_CONFIG,
      { isAssistantSubtask: false, isScheduledSession: false }
    );
    expect(restartInterrupt).toEqual({ notify: true, kind: 'failed' });
  });

  it('最短运行时长阈值仅过滤正常完成，不抑制失败与等待审批', () => {
    const shortCompleted = evaluateNotificationRule(
      makeTurnEvent({ kind: 'completed', durationMs: 3_000 }),
      DEFAULT_NOTIFICATION_CONFIG,
      { isAssistantSubtask: false, isScheduledSession: false }
    );
    expect(shortCompleted).toEqual({ notify: false, reason: 'below_min_duration' });

    const longCompleted = evaluateNotificationRule(
      makeTurnEvent({ kind: 'completed', durationMs: 10_000 }),
      DEFAULT_NOTIFICATION_CONFIG,
      { isAssistantSubtask: false, isScheduledSession: false }
    );
    expect(longCompleted).toEqual({ notify: true, kind: 'completed' });

    const shortFailed = evaluateNotificationRule(
      makeTurnEvent({ kind: 'failed', durationMs: 500, error: 'boom' }),
      DEFAULT_NOTIFICATION_CONFIG,
      { isAssistantSubtask: false, isScheduledSession: false }
    );
    expect(shortFailed).toEqual({ notify: true, kind: 'failed' });

    const shortApproval = evaluateNotificationRule(
      makeTurnEvent({ kind: 'waiting_approval', durationMs: 200 }),
      DEFAULT_NOTIFICATION_CONFIG,
      { isAssistantSubtask: false, isScheduledSession: false }
    );
    expect(shortApproval).toEqual({ notify: true, kind: 'waiting_approval' });
  });

  it('便签子会话默认静音、定时任务默认仅失败通知、系统内部轮次静默', () => {
    const subtaskMuted = evaluateNotificationRule(
      makeTurnEvent({ kind: 'completed', durationMs: 30_000 }),
      DEFAULT_NOTIFICATION_CONFIG,
      { isAssistantSubtask: true, isScheduledSession: false }
    );
    expect(subtaskMuted).toEqual({ notify: false, reason: 'assistant_subtask_muted' });

    const subtaskEnabled = evaluateNotificationRule(
      makeTurnEvent({ kind: 'completed', durationMs: 30_000 }),
      { ...DEFAULT_NOTIFICATION_CONFIG, scopes: { ...DEFAULT_NOTIFICATION_CONFIG.scopes, assistantSubtasks: true } },
      { isAssistantSubtask: true, isScheduledSession: false }
    );
    expect(subtaskEnabled).toEqual({ notify: true, kind: 'completed' });

    const scheduledDone = evaluateNotificationRule(
      makeTurnEvent({ kind: 'completed', durationMs: 30_000 }),
      DEFAULT_NOTIFICATION_CONFIG,
      { isAssistantSubtask: false, isScheduledSession: true }
    );
    expect(scheduledDone).toEqual({ notify: false, reason: 'scheduled_failed_only' });

    const scheduledFail = evaluateNotificationRule(
      makeTurnEvent({ kind: 'failed', durationMs: 1_000, error: 'cron failed' }),
      DEFAULT_NOTIFICATION_CONFIG,
      { isAssistantSubtask: false, isScheduledSession: true }
    );
    expect(scheduledFail).toEqual({ notify: true, kind: 'failed' });

    const maintenanceTurn = evaluateNotificationRule(
      makeTurnEvent({ kind: 'completed', taskOrigin: 'maintenance', durationMs: 25_000 }),
      DEFAULT_NOTIFICATION_CONFIG,
      { isAssistantSubtask: false, isScheduledSession: false }
    );
    expect(maintenanceTurn).toEqual({ notify: false, reason: 'system_turn' });

    const larkAvatarInternal = evaluateNotificationRule(
      makeTurnEvent({ kind: 'completed', sessionSource: 'lark-avatar', durationMs: 25_000 }),
      DEFAULT_NOTIFICATION_CONFIG,
      { isAssistantSubtask: false, isScheduledSession: false }
    );
    expect(larkAvatarInternal).toEqual({ notify: false, reason: 'internal_session' });
  });

  it('短窗合并将多条同类事件压缩成单条批量摘要', () => {
    const merged = coalescePayloads([
      makePayload({ id: 'n1', sessionId: 's1', sessionTitle: '修复登录' }),
      makePayload({ id: 'n2', sessionId: 's2', sessionTitle: '优化首页' }),
      makePayload({ id: 'n3', kind: 'failed', sessionId: 's3', sessionTitle: '构建脚本', error: 'exit 1' })
    ]);
    expect(merged).toHaveLength(2);
    const completedBatch = merged.find(item => item.kind === 'completed')!;
    expect(completedBatch.batchCount).toBe(2);
    expect(completedBatch.summary).toContain('修复登录');
    expect(completedBatch.summary).toContain('优化首页');
  });
});

describe('notifications: 配置校验与密文脱敏', () => {
  it('敏感 Header 与 Webhook secret 严格脱敏，保存时支持哨兵保留与显式清空', () => {
    const saved = parseAndMergeNotificationConfig({
      ...DEFAULT_NOTIFICATION_CONFIG,
      webhooks: [{
        id: 'wh_1',
        name: '我的通知',
        enabled: true,
        preset: 'generic',
        url: 'https://hooks.example.com/notify',
        secret: 'super-secret-key-999',
        headers: [
          { key: 'Authorization', value: 'Bearer abcdef123456' },
          { key: 'X-Custom', value: 'hello' }
        ],
        timeoutSec: 8
      }]
    });

    const pub = toPublicNotificationConfig(saved);
    expect(pub.webhooks[0]!.hasSecret).toBe(true);
    expect('secret' in pub.webhooks[0]!).toBe(false);
    expect(pub.webhooks[0]!.headers[0]!.masked).toBe(true);
    expect(pub.webhooks[0]!.headers[0]!.value).not.toContain('abcdef123456');
    expect(pub.webhooks[0]!.headers[1]).toEqual({ key: 'X-Custom', value: 'hello', masked: false });

    // 前端回传脱敏对象 + 哨兵时保留原有密文
    const merged = parseAndMergeNotificationConfig({
      ...pub,
      webhooks: [{
        ...pub.webhooks[0]!,
        name: '改名后的通知',
        secret: MASKED_SECRET_SENTINEL
      }]
    }, saved);
    expect(merged.webhooks[0]!.name).toBe('改名后的通知');
    expect(merged.webhooks[0]!.secret).toBe('super-secret-key-999');
    expect(merged.webhooks[0]!.headers[0]!.value).toBe('Bearer abcdef123456');

    // 显式传空串清除 secret
    const cleared = parseAndMergeNotificationConfig({
      ...pub,
      webhooks: [{ ...pub.webhooks[0]!, secret: '' }]
    }, merged);
    expect(cleared.webhooks[0]!.secret).toBeUndefined();
  });

  it('拒绝非法 URL 与未确认安全提示的本地命令 Hook', () => {
    expect(() => parseAndMergeNotificationConfig({
      ...DEFAULT_NOTIFICATION_CONFIG,
      webhooks: [{
        id: 'wh_bad', name: 'Bad', enabled: true, preset: 'generic',
        url: 'javascript:alert(1)', headers: [], timeoutSec: 5
      }]
    })).toThrow(/http:\/\/ 或 https:\/\//);

    expect(() => parseAndMergeNotificationConfig({
      ...DEFAULT_NOTIFICATION_CONFIG,
      commandHook: { enabled: true, command: 'echo hi', timeoutSec: 5, trustConfirmed: false }
    })).toThrow(/安全风险/);
  });
});

describe('notifications: Webhook 模板、签名、飞书与本地 Shell Hook', () => {
  it('覆盖 8 种 Webhook 预设格式并正确对中文 ntfy 标题做 RFC2047 编码', () => {
    const payload = makePayload({ sessionUrl: 'https://dock.example.com/sessions/ses_1' });
    const presets = ['generic', 'lark_webhook', 'dingtalk', 'wecom', 'bark', 'ntfy', 'slack', 'discord'] as const;
    for (const preset of presets) {
      const req = buildWebhookRequest(preset, payload);
      expect(req.body.length).toBeGreaterThan(10);
      if (preset === 'ntfy') {
        expect(req.extraHeaders?.Title).toMatch(/^=\?UTF-8\?B\?/);
        expect(req.extraHeaders?.Click).toBe('https://dock.example.com/sessions/ses_1');
      } else {
        expect(() => JSON.parse(req.body)).not.toThrow();
      }
    }
  });

  it('Webhook 发送携带 HMAC-SHA256 签名并正确返回耗时与错误', async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = '';
    const okFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      capturedBody = String(init?.body ?? '');
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof globalThis.fetch;

    const hook = {
      id: 'wh_sig', name: 'Signed', enabled: true, preset: 'generic' as const,
      url: 'https://hooks.example.com/test', headers: [{ key: 'X-Tenant', value: 'demo' }],
      secret: 'topsecret', timeoutSec: 5
    };
    const res = await deliverWebhookNotification(hook, makePayload(), { fetcher: okFetch, retries: 0 });
    expect(res.ok).toBe(true);
    expect(res.statusCode).toBe(200);
    const expectedSig = `sha256=${createHmac('sha256', 'topsecret').update(capturedBody).digest('hex')}`;
    expect(capturedHeaders['x-agentdock-signature']).toBe(expectedSig);
    expect(capturedHeaders['X-Tenant']).toBe('demo');

    const failFetch = (async () => new Response('bad token', { status: 401 })) as typeof globalThis.fetch;
    const failRes = await deliverWebhookNotification(hook, makePayload(), { fetcher: failFetch, retries: 0 });
    expect(failRes.ok).toBe(false);
    expect(failRes.statusCode).toBe(401);
    expect(failRes.error).toContain('401');
  });

  it('本地 Shell Hook 通过环境变量与 stdin JSON 安全传参，且超时会强杀不阻塞', async () => {
    const payload = makePayload({
      sessionTitle: '测试 $(echo SHOULD_NOT_RUN) "引号"',
      summary: '安全摘要'
    });
    const okRes = await deliverCommandHook(
      {
        enabled: true,
        command: 'node -e "const fs=require(\'fs\');const d=JSON.parse(fs.readFileSync(0,\'utf8\'));console.log(process.env.AGENTDOCK_NOTIFY_EVENT+\'|\'+process.env.AGENTDOCK_SESSION_TITLE+\'|\'+d.sessionId)"',
        timeoutSec: 5,
        trustConfirmed: true
      },
      payload
    );
    expect(okRes.ok).toBe(true);
    expect(okRes.detail).toContain('completed|测试 $(echo SHOULD_NOT_RUN) "引号"|ses_1');

    const timeoutRes = await deliverCommandHook(
      {
        enabled: true,
        command: 'node -e "setTimeout(() => {}, 10000)"',
        timeoutSec: 1,
        trustConfirmed: true
      },
      payload
    );
    expect(timeoutRes.ok).toBe(false);
    expect(timeoutRes.error).toContain('超时');
  });

  it('飞书机器人通道可发送卡片，且对原飞书群自动去重跳过', async () => {
    const repos = createRepositories(':memory:');
    try {
      await repos.config.set('lark.bots', JSON.stringify([{
        appId: 'cli_test_bot',
        appSecret: 'sec_test',
        name: '通知小助手',
        webBaseUrl: 'https://dock.example.com'
      }]));
      const sentUrls: string[] = [];
      const mockFetch = (async (input: string | URL | Request) => {
        const url = String(input);
        sentUrls.push(url);
        if (url.includes('tenant_access_token')) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok_1', expire: 7200 }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_notify_123', chat_id: 'oc_group_1' } }), { status: 200 });
      }) as typeof globalThis.fetch;

      const sent = await deliverLarkNotification(
        {
          enabled: true,
          appId: 'cli_test_bot',
          mode: 'chat',
          fallbackReceiveId: 'oc_group_1',
          fallbackReceiveIdType: 'chat_id',
          skipOriginalLarkChat: true,
          includeSummary: true
        },
        makePayload(),
        { configRepo: repos.config, channelMappings: repos.channelMappings, fetcher: mockFetch }
      );
      expect(sent.ok).toBe(true);
      expect(sentUrls.some(url => url.includes('receive_id_type=chat_id'))).toBe(true);

      // 同一飞书群发起的会话自动跳过防重复
      const skipped = await deliverLarkNotification(
        {
          enabled: true,
          appId: 'cli_test_bot',
          mode: 'chat',
          fallbackReceiveId: 'oc_group_1',
          fallbackReceiveIdType: 'chat_id',
          skipOriginalLarkChat: true,
          includeSummary: true
        },
        makePayload({ sessionSource: 'lark', sessionSourceId: 'cli_test_bot:oc_group_1:group:u1' }),
        { configRepo: repos.config, channelMappings: repos.channelMappings, fetcher: mockFetch }
      );
      expect(skipped.ok).toBe(true);
      expect(skipped.detail).toContain('跳过');
    } finally {
      repos.close();
    }
  });
});

describe('notifications: REST API、离机判定与测试推送', () => {
  it('支持 GET/PUT 持久化、POST /api/notifications/test 与 presence 离机联动', async () => {
    const repos = createRepositories(':memory:');
    const runtime = new AgentDockRuntime(repos, { cleanupIntervalMs: 0 });
    let clock = 1_000_000;
    const deliveredBodies: string[] = [];
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      deliveredBodies.push(String(init?.body ?? ''));
      return new Response('ok', { status: 200 });
    }) as typeof globalThis.fetch;

    const notifications = new NotificationService({
      runtime,
      repos,
      fetcher: mockFetch,
      nowMs: () => clock
    });
    notifications.start();
    const app = await buildApp(runtime, { notifications });

    try {
      const initial = await app.inject({ method: 'GET', url: '/api/notifications/config' });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().configured).toBe(false);
      expect(initial.json().config.antiSpam.minDurationSec).toBe(10);

      const put = await app.inject({
        method: 'PUT',
        url: '/api/notifications/config',
        payload: {
          ...DEFAULT_NOTIFICATION_CONFIG,
          antiSpam: { minDurationSec: 5, coalesceWindowMs: 0, remoteOnlyWhenAway: true, awayAfterSec: 30 },
          webhooks: [{
            id: 'wh_api',
            name: 'API 测试',
            enabled: true,
            preset: 'generic',
            url: 'https://example.com/hook',
            headers: [{ key: 'Authorization', value: 'Bearer secret_xyz_987' }],
            secret: 'my-secret',
            timeoutSec: 5
          }]
        }
      });
      expect(put.statusCode).toBe(200);
      const savedBody = put.json();
      expect(savedBody.configured).toBe(true);
      expect(savedBody.config.webhooks[0].hasSecret).toBe(true);
      expect(savedBody.config.webhooks[0].secret).toBeUndefined();
      expect(savedBody.config.webhooks[0].headers[0].value).not.toContain('secret_xyz_987');

      // 测试推送接口
      const testRes = await app.inject({
        method: 'POST',
        url: '/api/notifications/test',
        payload: { channel: 'webhook', webhookId: 'wh_api' }
      });
      expect(testRes.statusCode).toBe(200);
      expect(testRes.json().ok).toBe(true);
      expect(deliveredBodies).toHaveLength(1);

      // 客户端活跃聚焦时：remoteOnlyWhenAway 抑制远程推送，但 SSE 仍广播
      await app.inject({
        method: 'POST',
        url: '/api/notifications/presence',
        payload: { clientId: 'tab_1', focused: true, activeSessionId: 'ses_1' }
      });
      const sseReceived: NotificationPayload[] = [];
      const unsub = notifications.subscribe(p => sseReceived.push(p));

      await notifications.handleTurnEvent(makeTurnEvent({ id: 'tevt_active', taskId: 'task_a', durationMs: 12_000 }));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(sseReceived).toHaveLength(1);
      expect(deliveredBodies).toHaveLength(1); // 仍为 1，未多发远程

      // 超过 30s 离开电脑后：自动推送远程 Webhook
      clock += 45_000;
      await notifications.handleTurnEvent(makeTurnEvent({ id: 'tevt_away', taskId: 'task_b', durationMs: 12_000 }));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(sseReceived).toHaveLength(2);
      expect(deliveredBodies).toHaveLength(2);
      unsub();
    } finally {
      await notifications.close();
      await app.close();
      await runtime.shutdown();
      repos.close();
    }
  });
});
