import type { FastifyInstance } from 'fastify';
import type { ScheduleDelivery, ScheduleSessionTemplate } from '@agent-dock/agent-dock-shared';
import type { ScheduleService } from './service.js';

interface CreateBody { name?: string; sessionId?: string; template?: ScheduleSessionTemplate; delivery?: ScheduleDelivery; cron?: string; runAt?: string; intervalMinutes?: number; timezone?: string; prompt?: string; createdBySessionId?: string }

/**
 * 定时任务的 HTTP 入口。鉴权跟其他 /api 路由一样走全局中间件；
 * 「Agent 只能给自己和关联会话注册」的限制放在 CLI 侧，与 session send 一致。
 */
export function registerScheduleRoutes(app: FastifyInstance, schedules: ScheduleService) {
  app.get<{ Querystring: { sessionId?: string } }>('/api/schedules', async request => {
    const all = await schedules.list();
    const sessionId = request.query?.sessionId?.trim();
    return sessionId ? all.filter(item => item.sessionId === sessionId) : all;
  });
  app.post<{ Body: CreateBody }>('/api/schedules', async (request, reply) => {
    const body = request.body ?? {};
    const created = await schedules.create({
      prompt: body.prompt ?? '',
      ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
      ...(body.template !== undefined ? { template: body.template } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.delivery !== undefined ? { delivery: body.delivery } : {}),
      ...(body.cron !== undefined ? { cron: body.cron } : {}),
      ...(body.intervalMinutes !== undefined ? { intervalMinutes: Number(body.intervalMinutes) } : {}),
      ...(body.runAt !== undefined ? { runAt: body.runAt } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.createdBySessionId !== undefined ? { createdBySessionId: body.createdBySessionId } : {})
    });
    return reply.code(201).send(created);
  });
  app.get<{ Querystring: { limit?: string; sessionId?: string } }>('/api/schedule-runs', async request => {
    const limit = Number(request.query?.limit);
    return schedules.recentRuns(Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : undefined, request.query?.sessionId?.trim() || undefined);
  });
  app.get<{ Params: { id: string } }>('/api/schedules/:id', async request => schedules.get(request.params.id));
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/schedules/:id/runs', async request => {
    const limit = Number(request.query?.limit);
    return schedules.runs(request.params.id, Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : undefined);
  });
  app.post<{ Params: { id: string } }>('/api/schedules/:id/pause', async request => schedules.pause(request.params.id));
  app.post<{ Params: { id: string } }>('/api/schedules/:id/resume', async request => schedules.resume(request.params.id));
  app.post<{ Params: { id: string } }>('/api/schedules/:id/run', async request => schedules.runNow(request.params.id));
  app.delete<{ Params: { id: string } }>('/api/schedules/:id', async request => schedules.remove(request.params.id));
}
