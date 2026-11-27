/**
 * 通知设置 REST 接口与全局轻量通知 SSE。
 *
 * - GET  /api/notifications/config   读取脱敏配置与各通道最近投递健康状态
 * - PUT  /api/notifications/config   校验并持久化配置（密文自动保留）
 * - POST /api/notifications/test     测试指定后端通道（飞书 / Webhook / 本地命令）
 * - POST /api/notifications/presence 汇报客户端聚焦活跃态（支持「仅离机推远程」）
 * - GET  /api/notifications/stream   全局轻量通知 SSE（15s 心跳，仅推终态/审批/提醒）
 */
import type { FastifyInstance } from 'fastify';
import { RuntimeError } from '@agent-dock/agent-dock-shared';
import type { VerifiedWebToken } from '../web-access.js';
import type { NotificationService, TestNotificationInput } from './service.js';

export function registerNotificationRoutes(
  app: FastifyInstance,
  service: NotificationService,
  streams: Set<import('node:http').ServerResponse>
): void {
  app.get('/api/notifications/config', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return service.getPublicState();
  });

  app.put('/api/notifications/config', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return service.saveConfig(request.body);
  });

  app.post<{ Body: Partial<TestNotificationInput> }>('/api/notifications/test', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const channel = request.body?.channel;
    if (channel !== 'lark' && channel !== 'webhook' && channel !== 'command') {
      throw new RuntimeError('INVALID_NOTIFICATION_CHANNEL', 'channel 必须是 lark、webhook 或 command', 400);
    }
    return service.testChannel({
      channel,
      ...(typeof request.body?.webhookId === 'string' ? { webhookId: request.body.webhookId } : {}),
      ...(request.body?.draftConfig !== undefined ? { draftConfig: request.body.draftConfig } : {})
    });
  });

  app.post<{ Body: { clientId?: unknown; focused?: unknown; activeSessionId?: unknown } }>('/api/notifications/presence', async request => {
    const clientId = typeof request.body?.clientId === 'string' ? request.body.clientId.trim() : '';
    const focused = request.body?.focused === true;
    const activeSessionId = typeof request.body?.activeSessionId === 'string' ? request.body.activeSessionId.trim() : undefined;
    if (clientId) {
      service.reportPresence({ clientId, focused, ...(activeSessionId ? { activeSessionId } : {}) });
    }
    return { ok: true };
  });

  app.get('/api/notifications/stream', async (request, reply) => {
    const claim = (request as unknown as { webClaim?: VerifiedWebToken | null }).webClaim;
    const scopedSessionId = claim?.kind === 'session' ? claim.sessionId : undefined;
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    reply.raw.write(': connected\n\n');
    const unsubscribe = service.subscribe(payload => {
      if (request.raw.destroyed) return;
      if (scopedSessionId && payload.sessionId !== scopedSessionId) return;
      reply.raw.write(`id: ${payload.id}\nevent: notification\ndata: ${JSON.stringify(payload)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      if (!request.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 15_000);
    request.raw.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(reply.raw);
    });
  });
}
