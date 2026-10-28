import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  AgentGroupToolError,
  agentGroupToolBearerToken,
  type LarkAgentToolsService
} from './agent-tools.js';

interface GroupToolQuery {
  after?: string;
  limit?: string;
  timeoutMs?: string;
}

interface GroupSendBody {
  content?: string;
  to?: string;
  replyTo?: string;
  inThread?: boolean;
  idempotencyKey?: string;
}

interface GroupReplyModeBody {
  mode?: string;
}

const tokenFrom = (authorization?: string) => agentGroupToolBearerToken(authorization);
const numberFrom = (value?: string) => value === undefined ? undefined : Number(value);

function handleToolError(error: unknown, reply: FastifyReply) {
  if (error instanceof AgentGroupToolError) return reply.code(error.statusCode).send(error.response());
  throw error;
}

export async function registerLarkAgentToolRoutes(app: FastifyInstance, service?: LarkAgentToolsService) {
  if (!service) return;

  // 会话中途才托管到群时，Agent 进程环境变量里没有凭证，CLI 用 agentdock_session_id 来换。
  // 路径不在 /api/lark/agent-tools/ 下：必须走常规 Web 访问鉴权（CLI 用 daemon 状态里的本机凭证）。
  app.post<{ Params: { id: string } }>('/api/sessions/:id/group-tools-capability', async (request, reply) => {
    try { return await service.issueCapability(request.params.id); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.get('/api/lark/agent-tools/self', async (request, reply) => {
    try { return await service.self(tokenFrom(request.headers.authorization)); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.get('/api/lark/agent-tools/peers', async (request, reply) => {
    try { return await service.peers(tokenFrom(request.headers.authorization)); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.get('/api/lark/agent-tools/members', async (request, reply) => {
    try { return await service.members(tokenFrom(request.headers.authorization)); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.get('/api/lark/agent-tools/bots', async (request, reply) => {
    try { return await service.bots(tokenFrom(request.headers.authorization)); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.get<{ Querystring: GroupToolQuery }>('/api/lark/agent-tools/messages', async (request, reply) => {
    try {
      return await service.messages(tokenFrom(request.headers.authorization), {
        after: request.query.after,
        limit: numberFrom(request.query.limit)
      });
    } catch (error) { return handleToolError(error, reply); }
  });

  app.get<{ Querystring: { messageId?: string } }>('/api/lark/agent-tools/message', async (request, reply) => {
    try {
      return await service.message(tokenFrom(request.headers.authorization), {
        messageId: request.query.messageId ?? ''
      });
    } catch (error) { return handleToolError(error, reply); }
  });

  app.get<{ Querystring: GroupToolQuery }>('/api/lark/agent-tools/wait', async (request, reply) => {
    try {
      return await service.wait(tokenFrom(request.headers.authorization), {
        after: request.query.after,
        limit: numberFrom(request.query.limit),
        timeoutMs: numberFrom(request.query.timeoutMs)
      });
    } catch (error) { return handleToolError(error, reply); }
  });

  app.post<{ Body: GroupSendBody }>('/api/lark/agent-tools/send', async (request, reply) => {
    try { return await service.send(tokenFrom(request.headers.authorization), request.body ?? {}); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.post<{ Body: GroupReplyModeBody }>('/api/lark/agent-tools/reply-mode', async (request, reply) => {
    try {
      return await service.replyMode(tokenFrom(request.headers.authorization), {
        mode: request.body?.mode as 'thread' | 'direct' | undefined
      });
    } catch (error) { return handleToolError(error, reply); }
  });
}
