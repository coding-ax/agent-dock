import type { FastifyInstance } from 'fastify';
import { RuntimeError } from '@agent-dock/agent-dock-shared';
import { LarkAvatarService, type LarkReactionPort } from './service.js';
import { LarkAvatarResolutionError, larkAvatarResolutionHttpStatus, type LarkChatMatchMode } from './id-resolution.js';
import type { LarkAvatarReplyForwardMode, LarkRegionName } from './types.js';
import type { LarkReactionRoute } from './reaction-trigger.js';

export interface LarkAvatarRouteOptions {
  /**
   * 仅隔离沙箱开启：通过 HTTP 注入 fake reaction 事件，验证「加表情 → 轮次」链路。
   * 正式实例必须保持关闭，避免本地脚本伪造触发。
   */
  allowReactionTest?: boolean;
}

export function registerLarkAvatarRoutes(app: FastifyInstance, service: LarkAvatarService, options: LarkAvatarRouteOptions = {}) {
  const handleError = (reply: { code(code: number): { send(value: unknown): unknown } }, error: unknown) => {
    if (error instanceof RuntimeError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error instanceof LarkAvatarResolutionError) {
      const body = error.toJSON();
      return reply.code(larkAvatarResolutionHttpStatus(error.code)).send({
        error: {
          ...body,
          message: error.hint && error.hint !== error.message ? `${error.message}（${error.hint}）` : error.message
        }
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message } });
  };

  app.get('/api/lark-avatar/status', async () => service.status());
  app.get('/api/lark-avatar/config', async () => service.publicState() ?? null);
  app.get('/api/lark-avatar/chats', async () => service.availableChats());
  app.put<{ Body: { region?: LarkRegionName; triggerPrefix?: string; contextMessages?: number; contextScope?: 'anchor' | 'chat'; replyInTopic?: boolean; replyMode?: 'direct' | 'quote' | 'thread'; replyForwardMode?: LarkAvatarReplyForwardMode; emojiReactions?: boolean; reactionTriggerEnabled?: boolean; reactionTriggerEmoji?: string; reactionTriggerRoute?: LarkReactionRoute; reactionTriggerIgnoreBots?: boolean; replySignature?: string; agentTimeoutSeconds?: number; listening?: boolean; listenChats?: string[]; inboxMaxItems?: number; inboxCleanupWarnThreshold?: number; allowedSenders?: string[]; agentId?: string; model?: string; reasoningEffort?: string; workspace?: string } }>('/api/lark-avatar/config', async (request, reply) => {
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
  app.post<{
    Body: {
      chat?: string;
      text?: string;
      replyTo?: string;
      inThread?: boolean;
      at?: string[];
      match?: LarkChatMatchMode;
    };
  }>('/api/lark-avatar/send', async (request, reply) => {
    try {
      const body = request.body ?? {};
      if (typeof body.chat !== 'string' || !body.chat.trim()) {
        throw new RuntimeError('INVALID_INPUT', 'chat 必填：群名、oc_* chat_id 或数字 chat_id', 400);
      }
      if (typeof body.text !== 'string' || !body.text.trim()) {
        throw new RuntimeError('INVALID_INPUT', 'text 必填且不能为空', 400);
      }
      if (body.replyTo !== undefined && typeof body.replyTo !== 'string') {
        throw new RuntimeError('INVALID_INPUT', 'replyTo 必须是字符串', 400);
      }
      if (body.inThread !== undefined && typeof body.inThread !== 'boolean') {
        throw new RuntimeError('INVALID_INPUT', 'inThread 必须是布尔值', 400);
      }
      if (body.at !== undefined && (!Array.isArray(body.at) || body.at.some(item => typeof item !== 'string'))) {
        throw new RuntimeError('INVALID_INPUT', 'at 必须是字符串数组', 400);
      }
      if (body.match !== undefined && body.match !== 'exact' && body.match !== 'fuzzy') {
        throw new RuntimeError('INVALID_INPUT', 'match 只能是 exact 或 fuzzy', 400);
      }
      const sent = await service.sendMessage({
        chat: body.chat,
        text: body.text,
        ...(body.replyTo ? { replyTo: body.replyTo } : {}),
        ...(body.inThread === true ? { inThread: true } : {}),
        ...(body.at?.length ? { at: body.at } : {}),
        ...(body.match ? { match: body.match } : {})
      });
      return { ok: true, ...sent };
    } catch (error) { return handleError(reply, error); }
  });
  app.put<{ Body: { enabled?: unknown } }>('/api/lark-avatar/listening', async (request, reply) => {
    const enabled = request.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: { code: 'INVALID_LISTENING_STATE', message: 'enabled 必须是布尔值' } });
    }
    try { return service.setListening(enabled); }
    catch (error) { return handleError(reply, error); }
  });
  app.get<{ Querystring: { state?: string; tier?: string; limit?: string } }>('/api/lark-avatar/inbox', async request => {
    const requested = request.query.limit !== undefined ? Number(request.query.limit) : undefined;
    const limit = requested !== undefined && Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : undefined;
    return service.inbox(request.query.state?.split(',').filter(Boolean), request.query.tier, limit);
  });
  app.post<{ Body: { keepLatest?: unknown } }>('/api/lark-avatar/inbox/cleanup', async (request, reply) => {
    try {
      const keepLatest = request.body?.keepLatest;
      return service.cleanupInbox(keepLatest === undefined ? {} : { keepLatest: keepLatest as number });
    } catch (error) { return handleError(reply, error); }
  });
  app.get<{ Querystring: { limit?: string } }>('/api/lark-avatar/reaction-triggers', async request => {
    const requested = Number(request.query.limit);
    const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.floor(requested))) : 20;
    return service.reactionTriggers(limit);
  });
  app.get<{ Querystring: { limit?: string } }>('/api/lark-avatar/reaction-diagnostics', async request => {
    const requested = Number(request.query.limit);
    const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.floor(requested))) : 10;
    await service.refreshReactionSourceStatus();
    return service.reactionDiagnostics(limit);
  });
  app.post<{ Body: {
    messageId?: string;
    emojiType?: string;
    operatorId?: string;
    operatorType?: string;
    actionTime?: string;
    chatId?: string;
    chatName?: string;
    senderId?: string;
    senderName?: string;
    content?: string;
  } }>('/api/lark-avatar/reaction-test', async (request, reply) => {
    if (!options.allowReactionTest) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'reaction-test 只在隔离沙箱开启' } });
    }
    const body = request.body ?? {};
    const messageId = body.messageId?.trim();
    const emojiType = body.emojiType?.trim();
    if (!messageId || !emojiType) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'messageId 和 emojiType 必填' } });
    }
    const message = {
      messageId,
      chatId: body.chatId?.trim() || 'oc_test_chat',
      chatName: body.chatName?.trim() || '测试群',
      chatType: 'group',
      senderId: body.senderId?.trim() || 'ou_test_sender',
      senderName: body.senderName?.trim() || '测试用户',
      content: body.content?.trim() || '表情触发测试消息',
      messageType: 'text',
      createTime: String(Date.now())
    };
    const port: LarkReactionPort = {
      async getMessage(id) { return id === message.messageId ? message : undefined; },
      async listContext() { return [message]; },
      async sendAskCard(input) {
        return { messageId: `om_test_card_${input.triggerId.replace(/[^A-Za-z0-9]/g, '').slice(-12)}` };
      },
      async updateAskCard() { /* fake 端口不更新真实卡片 */ }
    };
    const operatorType = body.operatorType === 'bot' || body.operatorType === 'app' || body.operatorType === 'user'
      ? body.operatorType
      : 'user';
    const result = await service.handleReaction({
      messageId,
      emojiType,
      ...(body.operatorId?.trim() ? { operatorId: body.operatorId.trim() } : { operatorId: 'ou_test_operator' }),
      operatorType,
      actionTime: body.actionTime?.trim() || String(Date.now())
    }, port);
    return { ...result, diagnostics: service.reactionDiagnostics(5) };
  });
  app.post<{ Body: { triggerId?: string; route?: string; operatorId?: string } }>('/api/lark-avatar/reaction-route-test', async (request, reply) => {
    if (!options.allowReactionTest) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'reaction-route-test 只在隔离沙箱开启' } });
    }
    const result = await service.resolveReactionRoute({
      value: {
        action: 'avatar_reaction_route',
        trigger_id: request.body?.triggerId ?? '',
        route: request.body?.route ?? ''
      },
      ...(request.body?.operatorId ? { operatorId: request.body.operatorId } : {}),
      authorize: () => true
    });
    if (!result) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'triggerId / route 不合法' } });
    return { ...result, diagnostics: service.reactionDiagnostics(5) };
  });
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
