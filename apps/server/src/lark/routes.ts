import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { registerApp as larkRegisterApp } from './sdk.js';
import { cleanChatName, validateHighRiskPattern, type AgentRepository, type ChannelMappingRepository, type ConfigRepository } from '@agent-dock/agent-dock-shared';
import type { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import { createLarkCardService, LarkServiceError, larkConfigurationStatus, type LarkBotConfigInput, type LarkCardService, type LarkSendInput, type LarkUpdateInput } from './service.js';
import { defaultHighRiskPattern, deleteLarkConfig, publicLarkConfigs, readLarkConfig, readLarkConfigs, saveLarkConfig, type SaveLarkConfigInput } from './config.js';
import { LarkLongConnectionListenerPool, larkHandoverChannel, type LarkListenerPool } from './listener.js';
import { installLarkHook, larkHookStatus } from './security-hooks.js';
import { registerLarkAgentToolRoutes } from './agent-tools-routes.js';
import type { LarkAgentToolsService } from './agent-tools.js';
import { abortable } from '../abortable.js';

// 飞书一键创建应用的预设权限、事件和回调。
// 权限列表来自 AgentDock 文档「导入权限」，覆盖消息、卡片、通讯录、云文档、云盘等能力。
const LARK_ONECLICK_PRESET = {
  appPreset: {
    name: '{user} 的 AgentDock 智能助手',
    desc: '由 {user} 创建的 AgentDock 智能体，支持多 Agent 协作、飞书卡片交互和本地工具调用。'
  },
  addons: {
    preset: true,
    scopes: {
      tenant: [
        'application:app_slash_command:read',
        'application:app_slash_command:write',
        'application:application:self_manage',
        'application:bot.basic_info:read',
        'application:bot.menu:write',
        'cardkit:card:read',
        'cardkit:card:write',
        'contact:contact.base:readonly',
        'contact:user.base:readonly',
        'contact:user.email:readonly',
        'docs:document.comment:create',
        'docs:document.comment:delete',
        'docs:document.comment:read',
        'docs:document.comment:update',
        'docs:document.comment:write_only',
        'docx:document.block:convert',
        'docx:document:readonly',
        'docx:document:write_only',
        'drive:drive.metadata:readonly',
        'drive:file:download',
        'drive:file:upload',
        'im:chat.members:bot_access',
        'im:chat.members:read',
        'im:chat:create',
        'im:chat:read',
        'im:chat:update',
        'im:message.group_at_msg.include_bot:readonly',
        'im:message.group_at_msg:readonly',
        'im:message.group_msg',
        'im:message.p2p_msg:readonly',
        'im:message.pins:read',
        'im:message.pins:write_only',
        'im:message.reactions:read',
        'im:message.reactions:write_only',
        'im:message:readonly',
        'im:message:send_as_bot',
        'im:message:send_multi_users',
        'im:message:send_sys_msg',
        'im:message:update',
        'im:resource',
        'wiki:node:read'
      ],
      user: ['offline_access']
    },
    events: {
      items: {
        tenant: ['im.message.receive_v1']
      }
    },
    callbacks: {
      items: ['card.action.trigger']
    }
  }
};

type LarkSendRequest = LarkSendInput & { bot?: LarkBotConfigInput; botAppId?: string };
type LarkUpdateRequest = LarkUpdateInput & { bot?: LarkBotConfigInput; botAppId?: string };
type SaveLarkConfigRequest = SaveLarkConfigInput;

export interface LarkRoutesOptions {
  env?: NodeJS.ProcessEnv;
  service?: LarkCardService;
  config?: ConfigRepository;
  agents?: AgentRepository;
  cardMappings?: ChannelMappingRepository;
  fetcher?: typeof globalThis.fetch;
  listener?: LarkListenerPool;
  runtime?: AgentDockRuntime;
  listeningDisabled?: boolean;
  agentTools?: LarkAgentToolsService;
  registerApp?: typeof larkRegisterApp;
  registrationTimeoutMs?: number;
}

export async function registerLarkRoutes(app: FastifyInstance, options: LarkRoutesOptions = {}) {
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? globalThis.fetch;
  let service = options.service;
  const listeningDisabled = options.listeningDisabled === true;
  const listener = options.listener ?? new LarkLongConnectionListenerPool(app.log, {
    runtime: options.runtime,
    cardMappings: options.cardMappings,
    configRepository: options.config,
    env,
    fetcher,
    peerBotAuthorized: (appId, chatId, senderOpenId) => options.agentTools?.isConfiguredPeer(appId, chatId, senderOpenId) ?? Promise.resolve(false)
  });
  const syncListeners = async (configs: Awaited<ReturnType<typeof readLarkConfigs>>) => {
    try { await listener.sync(configs); }
    catch (firstError) {
      app.log.warn({ error: firstError }, '飞书消息监听首次连接失败，正在自动重试');
      try { await listener.sync(configs); }
      catch (error) { app.log.error({ error }, '飞书消息监听连接失败，已保留监听配置'); }
    }
  };
  const storedBot = async (appId?: string) => {
    const stored = await readLarkConfig(options.config, appId);
    return stored ? { appId: stored.appId, appSecret: stored.appSecret } : undefined;
  };
  const resolveService = async (bot?: LarkBotConfigInput, appId?: string) => {
    if (bot) return createLarkCardService(env, fetcher, bot);
    if (appId) {
      const stored = await storedBot(appId);
      if (!stored) throw new LarkServiceError('LARK_BOT_NOT_FOUND', `Unknown Lark bot: ${appId}`, 404);
      return createLarkCardService(env, fetcher, stored);
    }
    if (service) return service;
    service = createLarkCardService(env, fetcher, await storedBot(appId));
    return service;
  };

  const initialConfigs = await readLarkConfigs(options.config);
  if (!listeningDisabled) await syncListeners(initialConfigs);
  app.addHook('onClose', async () => listener.stop());
  // 下面这组托管/选人路由统一把 LarkServiceError 翻成对应状态码；全局 errorHandler 只认 RuntimeError，
  // 不包一层的话缺参、已托管、飞书会话不可托管都会变成 500。
  const larkErrors = <Req extends FastifyRequest>(handler: (request: Req) => Promise<unknown>) => async (request: Req, reply: FastifyReply) => {
    try { return await handler(request); }
    catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  };

  // 「托管给机器人」：建一个飞书群（机器人做群主），并把群与某个 AgentDock 会话绑定。
  // 之后该群的消息由 listener 路由到这个会话，实现「用群聊继续这个会话」。
  app.post<{ Params: { id: string }; Body: { appId?: string; name?: string; memberOpenIds?: string[] } }>('/api/sessions/:id/handover', larkErrors(async request => {
    const sessionId = request.params.id;
    const session = await options.runtime?.getSession(sessionId);
    if (!session) throw new LarkServiceError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`, 404);
    // 飞书发起的会话已有原群作为入口：再建托管群会让两个群同时驱动同一会话，
    // 且原群的配置变更会 stop 掉它、托管群随之静默换会话。直接拒绝，引导回原群继续。
    if (session.source === 'lark') throw new LarkServiceError('LARK_SESSION_NOT_HANDOVERABLE', '该会话由飞书群发起，请直接在原群继续，无需托管', 409);
    if (!options.cardMappings) throw new LarkServiceError('LARK_HANDOVER_UNAVAILABLE', 'channel mapping storage unavailable', 503);
    const appId = request.body?.appId?.trim();
    if (!appId) throw new LarkServiceError('INVALID_HANDOVER', 'appId is required', 400);
    const channel = larkHandoverChannel(appId);
    // 一个会话只托管到一个群：重复提交（双击、换个机器人再点）不能再建第二个群去驱动同一会话。
    const appIds = new Set([appId, ...(await readLarkConfigs(options.config)).map(config => config.appId)]);
    for (const id of appIds) {
      const existing = (await options.cardMappings.list(larkHandoverChannel(id))).find(item => item.sessionId === sessionId);
      if (existing) throw new LarkServiceError('SESSION_ALREADY_HANDED_OVER', '该会话已托管到飞书群，请直接打开已有的托管群', 409);
    }
    // 群名兜底也必须清洗：会话标题对附件首发的会话等于一条路径，直接拿来当群名会建出
    // 一个叫 `/Users/xxx/a.png` 的飞书群。用户显式传的 name 不动，那是他的选择。
    const name = request.body?.name?.trim() || `${cleanChatName(session.title) || session.agentId} · AgentDock`;
    const bot = await resolveService(undefined, appId);
    const chat = await bot.createChat({ name, memberOpenIds: request.body?.memberOpenIds ?? [] });
    await options.cardMappings.save({
      id: `${channel}:${chat.chatId}`,
      channel,
      externalId: chat.chatId,
      sessionId,
      extra: JSON.stringify({ appId, chatId: chat.chatId, sessionId, name }),
      createdAt: new Date().toISOString()
    });
    return { sessionId, appId, chatId: chat.chatId, name, url: `https://applink.feishu.cn/client/chat/open?openChatId=${chat.chatId}` };
  }));

  // 查这个会话是否已经托管给某个机器人（返回绑定群，供前端显示「已托管」而不是再建一个）。
  app.get<{ Params: { id: string } }>('/api/sessions/:id/handover', larkErrors(async request => {
    const sessionId = request.params.id;
    if (!options.cardMappings || !options.config) return { handover: null };
    const configs = await readLarkConfigs(options.config);
    for (const config of configs) {
      const mapping = (await options.cardMappings.list(larkHandoverChannel(config.appId))).find(item => item.sessionId === sessionId);
      if (!mapping) continue;
      const extra = (() => { try { return JSON.parse(mapping.extra ?? '{}') as { name?: string; appId?: string }; } catch { return {}; } })();
      return { handover: { appId: config.appId, botName: config.name ?? config.appId, chatId: mapping.externalId, name: extra.name ?? '托管群', url: `https://applink.feishu.cn/client/chat/open?openChatId=${mapping.externalId}` } };
    }
    return { handover: null };
  }));

  // 批量取用户头像+姓名，给「托管」弹窗的成员胶囊做头像展示。
  app.get<{ Querystring: { appId?: string; openIds?: string } }>('/api/lark/user-profiles', larkErrors(async request => {
    const appId = request.query.appId?.trim();
    if (!appId) throw new LarkServiceError('INVALID_PROFILES_QUERY', 'appId is required', 400);
    const ids = [...new Set((request.query.openIds ?? '').split(',').map(value => value.trim()).filter(value => value.startsWith('ou_')))].slice(0, 20);
    const bot = await resolveService(undefined, appId);
    const users = await Promise.all(ids.map(async openId => {
      const profile = await bot.getUserProfile(openId).catch((): { name: string; avatarUrl?: string } => ({ name: openId }));
      return { openId, name: profile.name, ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}) };
    }));
    return { users };
  }));

  // 机器人创建者（自建应用 owner）：托管默认邀请「机器人 + 创建者自己」用。
  app.get<{ Querystring: { appId?: string } }>('/api/lark/app-owner', larkErrors(async request => {
    const appId = request.query.appId?.trim();
    if (!appId) throw new LarkServiceError('INVALID_APP_OWNER_QUERY', 'appId is required', 400);
    const bot = await resolveService(undefined, appId);
    const owner = await bot.getAppOwner();
    if (!owner.openId) return { owner: null };
    const profile = await bot.getUserProfile(owner.openId).catch((): { name: string; avatarUrl?: string } => ({ name: owner.openId! }));
    return { owner: { openId: owner.openId, name: profile.name, ownerType: owner.ownerType, ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}) } };
  }));

  // 按姓名搜人（机器人可见范围）：复用白名单解析那套「扫机器人所在群找同名成员」，
  // 建新群时不必让用户自己提供 open_id。找不到/同名多人时按普通结果返回，不抛 5xx。
  app.get<{ Querystring: { appId?: string; q?: string } }>('/api/lark/member-search', larkErrors(async request => {
    const appId = request.query.appId?.trim();
    const query = request.query.q?.trim();
    if (!appId) throw new LarkServiceError('INVALID_MEMBER_SEARCH', 'appId is required', 400);
    if (!query) return { users: [] };
    const bot = await resolveService(undefined, appId);
    try {
      const users = await bot.resolveChatUsersByNames([query]);
      return { users: users.map(user => ({ openId: user.openId, name: user.name })) };
    } catch (error) {
      if (error instanceof LarkServiceError && ['LARK_USER_NAME_NOT_FOUND', 'LARK_USER_NAME_AMBIGUOUS', 'LARK_NAME_RESOLUTION_LIMIT'].includes(error.code)) {
        return { users: [], error: error.message };
      }
      throw error;
    }
  }));

  // 「托管」弹窗的选人来源：列出某个飞书群里机器人可见的成员（带姓名 + open_id），
  // 用户按名字勾选即可，不需要自己去翻自己的 open_id。
  app.get<{ Querystring: { appId?: string; chatId?: string } }>('/api/lark/chat-members', larkErrors(async request => {
    const appId = request.query.appId?.trim();
    const chatId = request.query.chatId?.trim();
    if (!appId) throw new LarkServiceError('INVALID_MEMBERS_QUERY', 'appId is required', 400);
    if (!chatId?.startsWith('oc_')) throw new LarkServiceError('INVALID_MEMBERS_QUERY', 'chatId must start with oc_', 400);
    const bot = await resolveService(undefined, appId);
    const result = await bot.listChatMembers({ chatId, memberTypes: ['user'], pageSize: 100 });
    const users = result.items.filter(item => item.memberType === 'user' && item.openId).map(item => ({ openId: item.openId!, name: item.name }));
    return { users };
  }));

  await registerLarkAgentToolRoutes(app, options.agentTools);

  app.get('/api/lark/status', async () => ({ ...larkConfigurationStatus(env, await storedBot()), configuredBots: (await readLarkConfigs(options.config)).length, listening: listener.listening, activeAppIds: listener.activeAppIds, listeningDisabled }));
  app.get('/api/lark/config', async () => publicLarkConfigs(await readLarkConfigs(options.config), { activeAppIds: listener.activeAppIds, listeningDisabled }));
  app.post<{ Body: { appId?: string; appSecret?: string } }>('/api/lark/bot/inspect', async (request, reply) => {
    try {
      const bot = createLarkCardService(env, fetcher, { appId: request.body?.appId, appSecret: request.body?.appSecret });
      return await bot.getBotInfo();
    } catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });

  // 一个本地服务进程只保留一个扫码流程，避免多标签页重复创建。
  let registration: AbortController | undefined;
  app.addHook('preClose', async () => registration?.abort());
  app.post('/api/lark/bot/oneclick', async (_request, reply) => {
    if (!options.config) return reply.code(503).send({ error: { message: '当前服务未配置持久化存储，无法保存机器人。' } });
    if (registration) return reply.code(409).send({ error: { message: '已有扫码创建流程进行中，请先完成或取消。' } });
    const controller = new AbortController();
    registration = controller;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const send = (event: string, data: unknown) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const disconnect = () => controller.abort();
    // IncomingMessage.close 也会在请求体读完时触发；响应关闭才代表客户端离开。
    reply.raw.once('close', disconnect);
    const heartbeat = setInterval(() => send('heartbeat', {}), 15_000);
    const deadline = setTimeout(() => controller.abort(new Error('REGISTRATION_TIMEOUT')), options.registrationTimeoutMs ?? 12 * 60_000);
    send('connected', { message: '正在生成二维码' });
    try {
      const result = await abortable((options.registerApp ?? larkRegisterApp)({
        ...LARK_ONECLICK_PRESET,
        createOnly: true,
        signal: controller.signal,
        onQRCodeReady: ({ url, expireIn }) => send('qrcode', { url, expireIn }),
        onStatusChange: ({ status }) => send('status', { status })
      }), controller.signal);
      clearTimeout(deadline);
      controller.signal.throwIfAborted();
      const appId = result.client_id;
      const appSecret = result.client_secret;
      if (!appId || !appSecret) throw new Error('INVALID_CREDENTIALS');
      if (await readLarkConfig(options.config, appId)) throw new Error('BOT_ALREADY_EXISTS');
      send('status', { status: 'saving' });
      // 凭证一旦收到就先持久化；名称查询失败、页面断开均不能丢失已创建的应用。
      let saved = await saveLarkConfig(options.config, options.agents, {
        stage: 'lark', appId, appSecret, name: appId, listening: !listeningDisabled
      });
      let appName = appId;
      let warning: string | undefined;
      try {
        const bot = createLarkCardService(env, fetcher, { appId, appSecret });
        const info = await abortable(bot.getBotInfo(), AbortSignal.timeout(3000));
        appName = info.appName;
        // 头像是这个接口的顺带产物，之前被丢掉了；undefined 时 saveLarkConfig 会保留已存的值。
        saved = await saveLarkConfig(options.config, options.agents, { stage: 'lark', originalAppId: appId, name: appName, avatarUrl: info.avatarUrl });
      } catch {
        warning = '机器人凭证已保存，名称暂时无法读取。可稍后在设置中继续配置。';
      }
      if (!listeningDisabled) await syncListeners(saved);
      send('success', { appId, appName, warning, config: publicLarkConfigs(saved, { activeAppIds: listener.activeAppIds, listeningDisabled }) });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const expired = code === 'expired_token' || (controller.signal.reason as Error)?.message === 'REGISTRATION_TIMEOUT';
      if (!controller.signal.aborted || expired) send('error', {
        code: expired ? 'expired' : 'failed',
        message: expired ? '二维码已过期，请重新生成。' : code === 'access_denied' ? '已取消授权，可重新生成二维码。' : '创建未完成，请先刷新机器人列表确认是否已保存，再重试；也可使用手动配置。'
      });
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      reply.raw.off('close', disconnect);
      controller.abort();
      if (registration === controller) registration = undefined;
      reply.raw.end();
    }
  });
  app.get<{ Params: { appId: string }; Querystring: { pageToken?: string } }>('/api/lark/bots/:appId/chats', async (request, reply) => {
    try {
      return await (await resolveService(undefined, request.params.appId)).listChats(request.query.pageToken);
    } catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.get<{ Params: { appId: string; chatId: string }; Querystring: { pageToken?: string } }>('/api/lark/bots/:appId/chats/:chatId/members', async (request, reply) => {
    try {
      return await (await resolveService(undefined, request.params.appId)).listChatMembers({
        chatId: request.params.chatId,
        memberTypes: ['user'],
        pageSize: 100,
        ...(request.query.pageToken ? { pageToken: request.query.pageToken } : {})
      });
    } catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.get<{ Querystring: { appId?: string } }>('/api/lark/hooks/status', async (request, reply) => {
    const config = await readLarkConfig(options.config, request.query.appId);
    if (!config) return reply.code(404).send({ error: { code: 'LARK_BOT_NOT_FOUND', message: 'Unknown Lark bot' } });
    return larkHookStatus(config.defaultAgentId, config.workspace);
  });
  app.post<{ Body: { appId?: string; highRiskPattern?: string } }>('/api/lark/hooks/install', async (request, reply) => {
    try {
      const config = await readLarkConfig(options.config, request.body?.appId);
      if (!config) throw new LarkServiceError('LARK_BOT_NOT_FOUND', 'Unknown Lark bot', 404);
      const pattern = request.body?.highRiskPattern === undefined ? config.highRiskPattern : request.body.highRiskPattern.trim() || defaultHighRiskPattern;
      const patternValidation = validateHighRiskPattern(pattern);
      if (!patternValidation.valid) throw new LarkServiceError('INVALID_HIGH_RISK_PATTERN', patternValidation.error, 400);
      const hook = await installLarkHook(config.defaultAgentId, config.workspace);
      const saved = await saveLarkConfig(options.config, options.agents, {
        stage: 'agent',
        originalAppId: config.appId,
        ...(request.body?.highRiskPattern !== undefined ? { highRiskPattern: request.body.highRiskPattern } : {}),
        gateEnabled: true,
        hardGateEnabled: false,
        hookTrustConfirmed: true
      });
      if (!listeningDisabled) await syncListeners(saved);
      return hook;
    } catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.put<{ Body: SaveLarkConfigRequest }>('/api/lark/config', async (request, reply) => {
    try {
      let input = request.body ?? {};
      if (input.stage === 'lark') {
        const existing = input.originalAppId ? await readLarkConfig(options.config, input.originalAppId) : undefined;
        const appId = input.appId?.trim() || existing?.appId;
        const appSecret = input.appSecret?.trim() || existing?.appSecret;
        const bot = createLarkCardService(env, fetcher, { appId, appSecret });
        const info = await bot.getBotInfo();
        const allowedUsers = input.allowedUsers ?? existing?.allowedUsers ?? [];
        const allowedEmails = input.allowedEmails ?? existing?.allowedEmails ?? [];
        if (input.allowedUserNames === undefined && !allowedUsers.length && allowedEmails.length) await bot.checkIdentityResolution();
        input = {
          ...input,
          ...(input.allowedUserNames !== undefined ? { allowedEmails: [] } : {}),
          name: info.appName,
          // 放在展开之后：头像以服务端取到的为准，客户端传什么都不作数。
          avatarUrl: info.avatarUrl,
          listening: input.listening ?? existing?.listening ?? false
        };
      }
      if (input.stage === 'agent') {
        const existing = input.originalAppId ? await readLarkConfig(options.config, input.originalAppId) : undefined;
        const highRiskAllowedUsers = input.highRiskAllowedUsers ?? existing?.highRiskAllowedUsers ?? [];
        const highRiskAllowedEmails = input.highRiskAllowedEmails ?? existing?.highRiskAllowedEmails ?? [];
        const gateEnabled = input.gateEnabled ?? existing?.gateEnabled ?? false;
        if (input.highRiskAllowedUserNames === undefined && gateEnabled && !highRiskAllowedUsers.length && highRiskAllowedEmails.length && existing) {
          await createLarkCardService(env, fetcher, { appId: existing.appId, appSecret: existing.appSecret }).checkIdentityResolution();
        }
        if (input.highRiskAllowedUserNames !== undefined) input = { ...input, highRiskAllowedEmails: [] };
      }
      if (input.hardGateEnabled === true) {
        const existing = input.originalAppId ? await readLarkConfig(options.config, input.originalAppId) : undefined;
        const hook = await larkHookStatus(input.defaultAgentId ?? existing?.defaultAgentId, input.workspace ?? existing?.workspace);
        if (!hook.supported || !hook.installed || !hook.writable) throw new LarkServiceError('HARD_GATE_NOT_READY', hook.reason ?? 'Install the selected Agent hook before enabling the hard gate', 409);
      }
      const saved = await saveLarkConfig(options.config, options.agents, listeningDisabled ? { ...input, listening: undefined } : input);
      if (!listeningDisabled) await syncListeners(saved);
      if (!options.service) service = undefined;
      return publicLarkConfigs(saved, { activeAppIds: listener.activeAppIds, listeningDisabled });
    } catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.delete<{ Params: { appId: string } }>('/api/lark/config/:appId', async (request, reply) => {
    try {
      const saved = await deleteLarkConfig(options.config, request.params.appId);
      if (!listeningDisabled) await syncListeners(saved);
      if (!options.service) service = undefined;
      return publicLarkConfigs(saved, { activeAppIds: listener.activeAppIds, listeningDisabled });
    } catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.post<{ Body: LarkSendRequest }>('/api/lark/send', async (request, reply) => {
    const { bot, botAppId, ...input } = request.body ?? {};
    try { return await (await resolveService(bot, botAppId)).send(input); }
    catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
  app.post<{ Body: LarkUpdateRequest }>('/api/lark/update', async (request, reply) => {
    const { bot, botAppId, ...input } = request.body ?? ({} as LarkUpdateRequest);
    try { return await (await resolveService(bot, botAppId)).update(input as LarkUpdateInput); }
    catch (error) {
      if (error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
}
