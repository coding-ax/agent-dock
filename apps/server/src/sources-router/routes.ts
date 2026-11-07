import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { RuntimeError, type AgentEvent } from '@agent-dock/agent-dock-shared';
import { defaultBodyLimitBytes } from './ingress.js';
import { IngressError } from './ingress.js';
import { SourceRouterService } from './service.js';
import type { CaseStatus, SourceKind } from './types.js';

const createSourceSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['webhook', 'poll', 'stream', 'worker']).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  secretRefs: z.array(z.string()).optional(),
  secrets: z.record(z.string()).optional()
}).strict();

const updateSourceSchema = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
  secretRefs: z.array(z.string()).optional(),
  secrets: z.record(z.string()).optional()
}).strict();

function asHeaders(request: FastifyRequest): Record<string, string | string[] | undefined> {
  return request.headers as Record<string, string | string[] | undefined>;
}

const sourceRawBodies = new WeakMap<FastifyRequest, string>();

function asBody(request: FastifyRequest): string {
  const raw = sourceRawBodies.get(request);
  if (raw !== undefined) return raw;
  if (typeof request.body === 'string') return request.body;
  if (Buffer.isBuffer(request.body)) return request.body.toString('utf8');
  return JSON.stringify(request.body ?? {});
}

async function captureIngressBody(request: FastifyRequest, _reply: unknown, payload: AsyncIterable<Buffer>): Promise<Readable> {
  const chunks: Buffer[] = [];
  for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  sourceRawBodies.set(request, raw.toString('utf8'));
  return Readable.from([raw]);
}

const ingressBodyOptions = { preParsing: captureIngressBody, bodyLimit: defaultBodyLimitBytes };

function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof RuntimeError || error instanceof IngressError) {
    reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message } });
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RuntimeError('INVALID_REQUEST', `请求格式不正确：${result.error.issues[0]?.message ?? '校验失败'}`, 400);
  return result.data;
}

export function registerSourceRouterRoutes(app: FastifyInstance, service: SourceRouterService) {
  app.get('/api/health/sources-router', async () => ({ ok: true, module: 'sources-router' }));

  app.get<{ Querystring: { sourceId?: string; status?: string } }>('/api/source-router/cases', async request => {
    const status = request.query.status;
    if (status && !['open', 'waiting', 'closed'].includes(status)) throw new RuntimeError('INVALID_CASE_STATUS', `未知 Case 状态：${status}`, 400);
    return service.listCases({ ...(request.query.sourceId ? { sourceId: request.query.sourceId } : {}), ...(status ? { status: status as CaseStatus } : {}) });
  });
  app.get<{ Params: { id: string } }>('/api/source-router/cases/:id', async request => service.caseDetail(request.params.id));
  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/source-router/cases/:id/close', async request => service.closeCase(request.params.id, request.body?.reason));

  app.get('/api/source-router/events', async request => service.listEventSummaries((request.query as { sourceId?: string }).sourceId));

  app.get('/api/sources', async () => service.listSources());
  app.post<{ Body: unknown }>('/api/sources', async (request, reply) => {
    try {
      const body = parseOrThrow(createSourceSchema, request.body ?? {});
      const created = service.createSource({
        name: body.name, ...(body.kind ? { kind: body.kind as SourceKind } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.config ? { config: body.config } : {}),
        ...(body.secretRefs ? { secretRefs: body.secretRefs } : {}),
        ...(body.secrets ? { secrets: body.secrets } : {})
      });
      return reply.code(201).send(created);
    } catch (error) { return sendError(reply, error); }
  });
  app.get<{ Params: { id: string } }>('/api/sources/:id', async (request, reply) => {
    try { return service.getSource(request.params.id); } catch (error) { return sendError(reply, error); }
  });
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/sources/:id', async (request, reply) => {
    try {
      const body = parseOrThrow(updateSourceSchema, request.body ?? {});
      return service.updateSource(request.params.id, body);
    } catch (error) { return sendError(reply, error); }
  });
  for (const [action, enabled] of [['enable', true], ['disable', false]] as const) {
    app.post<{ Params: { id: string } }>(`/api/sources/:id/${action}`, async (request, reply) => {
      try { return service.setSourceEnabled(request.params.id, enabled); } catch (error) { return sendError(reply, error); }
    });
  }
  app.get<{ Params: { id: string } }>('/api/sources/:id/checkpoint', async (request, reply) => {
    try { return service.checkpoint(request.params.id); } catch (error) { return sendError(reply, error); }
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/sources/:id/heartbeat', async (request, reply) => {
    try { return service.heartbeat(request.params.id, (request.body ?? {}) as Record<string, unknown>); } catch (error) { return sendError(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/api/sources/:id/events', ingressBodyOptions, async (request, reply) => {
    try {
      const result = await service.ingest({ sourceId: request.params.id, body: asBody(request), headers: asHeaders(request) });
      return reply.code(result.duplicate ? 200 : 202).send({
        accepted: result.accepted, duplicate: result.duplicate, ...(result.eventId ? { eventId: result.eventId } : {}),
        ...(result.caseId ? { caseId: result.caseId } : {}), ...(result.decision ? { decision: result.decision } : {}),
        ...(result.reason ? { reason: result.reason } : {})
      });
    } catch (error) { return sendError(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/api/sources/:id/events/test', ingressBodyOptions, async (request, reply) => {
    try { return await service.dryRun({ sourceId: request.params.id, body: asBody(request), headers: asHeaders(request) }); }
    catch (error) { return sendError(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/api/sources/:id/github/webhook', ingressBodyOptions, async (request, reply) => {
    try {
      const result = await service.ingest({ sourceId: request.params.id, body: asBody(request), headers: asHeaders(request), github: true });
      return reply.code(result.duplicate ? 200 : 202).send({
        accepted: result.accepted, duplicate: result.duplicate, ...(result.eventId ? { eventId: result.eventId } : {}),
        ...(result.caseId ? { caseId: result.caseId } : {}), ...(result.reason ? { reason: result.reason } : {})
      });
    } catch (error) { return sendError(reply, error); }
  });

  app.get('/api/router/status', async () => service.routerStatus());
  app.get('/api/router/audits', async request => service.audits(Number((request.query as { limit?: string }).limit) || 200));
  app.get('/api/router/inbox', async request => service.inbox((request.query as { sessionId?: string }).sessionId));
  app.post<{ Body: { limit?: number } }>('/api/router/inbox/dispatch', async (request, reply) => {
    try {
      const limit = request.body?.limit;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new RuntimeError('INVALID_REQUEST', 'limit 必须是 1 到 100 的整数', 400);
      return await service.dispatchInbox(limit ?? 20);
    } catch (error) { return sendError(reply, error); }
  });
  app.post('/api/router/open', async (request, reply) => {
    try { return await service.routerOpen(); } catch (error) { return sendError(reply, error); }
  });
  app.post<{ Body: { paused?: boolean } }>('/api/router/pause', async (request, reply) => {
    try {
      if (typeof request.body?.paused !== 'boolean') throw new RuntimeError('INVALID_REQUEST', 'paused 必须是布尔值', 400);
      return service.setRouterPaused(request.body.paused);
    } catch (error) { return sendError(reply, error); }
  });
  app.post<{ Body: unknown }>('/api/router/dry-run', async (request, reply) => {
    try {
      const body = request.body as { sourceId?: string; event?: unknown } | undefined;
      if (!body?.sourceId) throw new RuntimeError('INVALID_REQUEST', '缺少 sourceId', 400);
      return await service.testFixture(body.sourceId, JSON.stringify(body.event ?? {}));
    } catch (error) { return sendError(reply, error); }
  });

  app.addHook('onClose', async () => { await service.close(); });
}
