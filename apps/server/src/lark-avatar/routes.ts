import type { FastifyInstance } from 'fastify';
import { RuntimeError } from '@agent-dock/agent-dock-shared';
import { LarkAvatarService } from './service.js';
import type { LarkRegionName } from './types.js';

export function registerLarkAvatarRoutes(app: FastifyInstance, service: LarkAvatarService) {
  const handleError = (reply: { code(code: number): { send(value: unknown): unknown } }, error: unknown) => {
    if (error instanceof RuntimeError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message } });
  };

  app.get('/api/lark-avatar/status', async () => service.status());
  app.get('/api/lark-avatar/config', async () => service.publicState() ?? null);
  app.get('/api/lark-avatar/chats', async () => service.availableChats());
  app.put<{ Body: { region?: LarkRegionName; triggerPrefix?: string; contextMessages?: number; contextScope?: 'anchor' | 'chat'; replyInTopic?: boolean; replyMode?: 'direct' | 'quote' | 'thread'; emojiReactions?: boolean; replySignature?: string; agentTimeoutSeconds?: number; listening?: boolean; listenChats?: string[]; allowedSenders?: string[]; agentId?: string; model?: string; reasoningEffort?: string; workspace?: string } }>('/api/lark-avatar/config', async (request, reply) => {
    try { return await service.saveConfig(request.body ?? {}); }
    catch (error) { return handleError(reply, error); }
  });
  app.post<{ Body: { region?: LarkRegionName } }>('/api/lark-avatar/login/qr', async request =>
    service.startQrLogin(request.body?.region)
  );
  app.get('/api/lark-avatar/login/status', async () => service.loginStatus());
  app.post('/api/lark-avatar/login/poll', async (request, reply) => {
    try { return await service.pollQrLogin(); }
    catch (error) { return handleError(reply, error); }
  });
  app.delete('/api/lark-avatar/login', async () => service.cancelQrLogin());
  app.post<{ Body: { cookie?: string; region?: LarkRegionName } }>('/api/lark-avatar/login/cookie', async (request, reply) => {
    try { return await service.connectWithCookie(request.body?.cookie ?? '', request.body?.region); }
    catch (error) { return handleError(reply, error); }
  });
  app.post('/api/lark-avatar/disconnect', async () => {
    service.disconnect();
    return { ok: true };
  });
  app.post('/api/lark-avatar/poll', async (request, reply) => {
    try { return await service.pollNow(); }
    catch (error) { return handleError(reply, error); }
  });
  app.put<{ Body: { enabled?: unknown } }>('/api/lark-avatar/listening', async (request, reply) => {
    const enabled = request.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: { code: 'INVALID_LISTENING_STATE', message: 'enabled 必须是布尔值' } });
    }
    try { return service.setListening(enabled); }
    catch (error) { return handleError(reply, error); }
  });
  app.get<{ Querystring: { state?: string; tier?: string } }>('/api/lark-avatar/inbox', async request =>
    service.inbox(request.query.state?.split(',').filter(Boolean), request.query.tier));
  app.post<{ Params: { id: string }; Body: { regenerate?: boolean } }>('/api/lark-avatar/inbox/:id/draft', async (request, reply) => {
    try { return await service.draftForItem(request.params.id, request.body?.regenerate === true); }
    catch (error) { return handleError(reply, error); }
  });
  app.get<{ Querystring: { state?: string } }>('/api/lark-avatar/drafts', async request => service.drafts(request.query.state));
  app.post<{ Body: { itemId?: string; target?: string; body?: string; threadKey?: string; replyRootId?: string } }>('/api/lark-avatar/drafts', async (request, reply) => {
    try {
      return await service.createDraft({
        itemId: request.body?.itemId, target: request.body?.target ?? '', body: request.body?.body ?? '',
        threadKey: request.body?.threadKey, replyRootId: request.body?.replyRootId
      });
    } catch (error) { return handleError(reply, error); }
  });
  app.patch<{ Params: { id: string }; Body: { body?: string } }>('/api/lark-avatar/drafts/:id', async (request, reply) => {
    try {
      if (typeof request.body?.body !== 'string') throw new RuntimeError('INVALID_DRAFT', '草稿正文必须是字符串', 400);
      return service.updateDraft(request.params.id, request.body.body);
    } catch (error) { return handleError(reply, error); }
  });
  app.post<{ Params: { id: string }; Body: { body?: string } }>('/api/lark-avatar/drafts/:id/send', async (request, reply) => {
    try { return await service.sendDraft(request.params.id, request.body?.body); }
    catch (error) { return handleError(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/api/lark-avatar/drafts/:id/discard', async (request, reply) => {
    try { return service.discardDraft(request.params.id); }
    catch (error) { return handleError(reply, error); }
  });
}
