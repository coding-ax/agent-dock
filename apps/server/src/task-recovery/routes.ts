import type { FastifyInstance } from 'fastify';
import {
  taskRecoveryModes,
  taskRecoveryStatuses,
  type TaskRecoveryConfigInput,
  type TaskRecoveryMode,
  type TaskRecoveryStatus
} from '@agent-dock/agent-dock-shared';
import type { TaskRecoveryService } from './service.js';

export function registerTaskRecoveryRoutes(app: FastifyInstance, service: TaskRecoveryService): void {
  app.get('/api/task-recovery/config', async () => ({
    config: await service.getConfig()
  }));

  app.put<{ Body?: Record<string, unknown> }>('/api/task-recovery/config', async (request, reply) => {
    const body = request.body ?? {};
    const patch: TaskRecoveryConfigInput = {};
    if (body.mode !== undefined) {
      if (typeof body.mode !== 'string' || !(taskRecoveryModes as readonly string[]).includes(body.mode)) {
        return reply.code(400).send({ error: { code: 'INVALID_RECOVERY_MODE', message: 'mode 必须是 auto、confirm 或 off' } });
      }
      patch.mode = body.mode as TaskRecoveryMode;
    }
    if (body.windowMinutes !== undefined) {
      if (typeof body.windowMinutes !== 'number' || !Number.isFinite(body.windowMinutes)) {
        return reply.code(400).send({ error: { code: 'INVALID_WINDOW_MINUTES', message: 'windowMinutes 必须是有效数字' } });
      }
      patch.windowMinutes = body.windowMinutes;
    }
    if (body.maxAutoAttempts !== undefined) {
      if (typeof body.maxAutoAttempts !== 'number' || !Number.isFinite(body.maxAutoAttempts)) {
        return reply.code(400).send({ error: { code: 'INVALID_MAX_ATTEMPTS', message: 'maxAutoAttempts 必须是有效数字' } });
      }
      patch.maxAutoAttempts = body.maxAutoAttempts;
    }
    if (body.staggerSeconds !== undefined) {
      if (typeof body.staggerSeconds !== 'number' || !Number.isFinite(body.staggerSeconds)) {
        return reply.code(400).send({ error: { code: 'INVALID_STAGGER_SECONDS', message: 'staggerSeconds 必须是有效数字' } });
      }
      patch.staggerSeconds = body.staggerSeconds;
    }
    return { config: await service.updateConfig(patch) };
  });

  app.get<{ Querystring: { sessionId?: string; status?: string; limit?: string } }>('/api/task-recovery/records', async request => {
    const rawStatus = request.query.status?.trim();
    const status = rawStatus && (taskRecoveryStatuses as readonly string[]).includes(rawStatus)
      ? (rawStatus as TaskRecoveryStatus)
      : undefined;
    const rawLimit = Number(request.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(200, Math.round(rawLimit)) : 50;
    const items = await service.listRecords({
      ...(request.query.sessionId?.trim() ? { sessionId: request.query.sessionId.trim() } : {}),
      ...(status ? { status } : {}),
      limit
    });
    return { items };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/recoveries', async request => ({
    items: await service.listSessionRecords(request.params.id)
  }));

  app.post<{ Params: { id: string; recoveryId: string }; Body?: { decision?: unknown } }>(
    '/api/sessions/:id/recoveries/:recoveryId/decide',
    async (request, reply) => {
      const decision = request.body?.decision;
      if (decision !== 'resume' && decision !== 'dismiss') {
        return reply.code(400).send({ error: { code: 'INVALID_DECISION', message: 'decision 必须是 resume 或 dismiss' } });
      }
      return service.decide({
        recoveryId: request.params.recoveryId,
        sessionId: request.params.id,
        decision,
        source: 'web'
      });
    }
  );
}
