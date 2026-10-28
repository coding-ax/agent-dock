import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { RuntimeError, type AgentConfig, type Session } from '@agent-dock/agent-dock-shared';
import type { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import { registerLarkRoutes, type LarkRoutesOptions } from './lark/routes.js';
import { discoverAgentModels } from './agent-models.js';
import { describeAcpError, listExternalSessions, loadExternalSessionTranscript } from '@agent-dock/agent-dock-acp-client';
import { collectAgentDockOwnedSessionIds } from './agent-owned-sessions.js';
import { getCodexUsage } from './codex-usage.js';
import { getClaudeUsage } from './claude-usage.js';
import { getCursorUsage } from './cursor-usage.js';
import { registerSystemRoutes, type SystemRoutesOptions } from './system-routes.js';
import { registerSelfUpdateRoutes, type SelfUpdateService } from './self-update.js';
import { registerScheduleRoutes } from './schedules/routes.js';
import type { ScheduleService } from './schedules/service.js';
import { registerTerminalWebSockets } from './terminal-ws.js';
import { registerFsRoutes } from './fs-routes.js';
import { registerLlmRoutes, type LlmRoutesOptions } from './llm/service.js';
import { LoginRateLimiter, readWebPasswordHash, verifyWebPassword, webPasswordPath } from './web-password.js';
import { isLocalOwnerRequest, issueMasterToken, parseCookieHeader, sessionTokenAllows, verifyWebToken, webAccessCookieName, webAccessCookieNameFor, webAccessSessionCookieName, type VerifiedWebToken } from './web-access.js';

const contentTypes: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.avi': 'video/x-msvideo',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.zip': 'application/zip'
};

export interface BuildAppOptions {
  webRoot?: string;
  lark?: LarkRoutesOptions;
  system?: SystemRoutesOptions;
  /** 模型端点（平台拿模型能力的唯一来源）；不传表示这套路由不挂。 */
  llm?: LlmRoutesOptions;
  /** 本地 Web 访问凭证防护；不传（或 enabled=false）时不挂防护中间件。 */
  webAuth?: { enabled?: boolean; secret?: string; /** 访问密码哈希文件；默认 ~/.agentdock/web-password，文件不存在即未启用密码。 */ passwordFile?: string };
  /** 界面上的检查更新 / 一键升级；不传表示不挂。 */
  selfUpdate?: SelfUpdateService;
  /** 定时任务；不传表示这套路由不挂。 */
  schedules?: ScheduleService;
}

// 上传路由接受任意 content-type（浏览器会为 .md/.heic/.zip 等发出五花八门的类型），
// 因此 body parser 不做类型白名单——白名单会以一个无法读懂的 415
// FST_ERR_CTP_INVALID_MEDIA_TYPE 拒绝合法文件。类型校验放在路由内部，见 uploads 路由。
const isUploadRequest = (request: { method: string; url: string }) =>
  request.method === 'POST' && /^\/api\/sessions\/[^/]+\/uploads\/?(?:\?|$)/.test(request.url);

/** `/record` 最多回多少条事件。它要的是「看这一次请求发了什么」，不需要整个会话的历史。 */
export const RECORD_EVENT_LIMIT = 200;

/**
 * 单轮事件最多回多少**原始行**与多少**原始字节**。事件是分片推的，几万行合并后可能只剩几百段，
 * 所以行数上限要比「想看到几段」大得多。字节上限才是真正管住响应大小的那一个：一轮若塞满
 * 整页 HTML 的 tool_result，光是几百段就能有 9.5 MB（实测），行数限不住。
 * 被截到时一定告诉调用方还有更多（`truncated` + `nextAfter`），不用猜。
 */
export const TURN_EVENT_ROW_LIMIT = 20_000;
export const TURN_EVENT_BYTE_LIMIT = 1_048_576;

/** 回放分页大小：一次同步读这么多行并立刻 finalize 迭代器。 */
export const REPLAY_PAGE_SIZE = 1_000;

/**
 * 把「全量回放」拆成有界分页。每页同步读完（statement 立刻 finalize），只在页与页之间 await。
 *
 * 不能改成 `events.iterate` 那样让 statement 挂着跨 await：daemon 只有一条 SQLite 连接，
 * 只要还有一个未结束的迭代器，同连接上任何 events.append / saveState 都会抛
 * "This database connection is busy executing a query"，能把正在跑的轮次判失败。
 * 分页读的内存占用同样与历史长度解耦，代价只是多几次查询。
 */
async function* pagedEvents(
  fetchPage: (after: number, limit: number) => Promise<Array<{ sequence: number }>>,
  after: number,
  /** 快照上界（含）。不传表示「一直追到没有为止」——只适合无限流（SSE）。 */
  through = Number.POSITIVE_INFINITY
): AsyncGenerator<{ sequence: number }> {
  let cursor = after;
  while (true) {
    const page = await fetchPage(cursor, REPLAY_PAGE_SIZE);
    if (!page.length) return;
    for (const event of page) {
      // 分页查询每次都是新的，会看到查询期间新写入的行；超上界的直接收尾，
      // 保证「有界回放」是固定快照（改动前 .all() / iterate() 的语义）。
      if (event.sequence > through) return;
      yield event;
    }
    cursor = page.at(-1)!.sequence;
    if (page.length < REPLAY_PAGE_SIZE || cursor >= through) return;
  }
}

/**
 * 把事件流写成 JSON 数组响应体。响应字节与 `reply.send(events)` 完全一致（同一个数组、
 * 同一批字段），只是服务端不再先把整段历史物化——145 万行 / 235 MB 的会话实测能把 daemon 拖到 OOM。
 * 交给 Fastify pipe 流：背压、断开、错误处理都由它管，这里不抢 socket。
 * 不带 content-length（流式无法预知），所以浏览器按 chunked 收。
 */
function jsonArrayStream(events: AsyncIterable<unknown>): Readable {
  return Readable.from((async function* () {
    yield '[';
    let first = true;
    for await (const event of events) {
      yield `${first ? '' : ','}${JSON.stringify(event)}`;
      first = false;
    }
    yield ']';
  }()));
}

export async function buildApp(runtime: AgentDockRuntime, options: BuildAppOptions = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 52 * 1024 * 1024 });
  const streams = new Set<import('node:http').ServerResponse>();
  await app.register(cors, { origin: true });
  // 可交互终端走 WebSocket（upgrade 不经 Fastify onRequest，鉴权在 registerTerminalWebSockets 内手工完成）。
  const terminalManager = registerTerminalWebSockets(app.server, runtime, { webAuth: options.webAuth });
  // 兜底 parser：任何未显式注册的类型都按原始 Buffer 交给路由。
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  // application/json 仍需为其余路由解析成对象，但上传路由要拿到原始 Buffer——
  // 否则上传 .json 文件时 writeFile 会收到已解析对象并抛 ERR_INVALID_ARG_TYPE。
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const buffer = body as Buffer;
    if (isUploadRequest(request)) return done(null, buffer);
    if (!buffer.length) return done(null, undefined);
    try { done(null, JSON.parse(buffer.toString('utf8'))); }
    catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      (failure as Error & { statusCode?: number }).statusCode = 400;
      done(failure);
    }
  });
  app.addHook('preClose', async () => { for (const stream of streams) stream.end(); streams.clear(); terminalManager.closeAll(); });

  const webAuthEnabled = options.webAuth?.enabled === true && Boolean(options.webAuth.secret);
  if (webAuthEnabled) {
    const secret = options.webAuth!.secret!;
    // 全局访问门：
    // - 卡片链接 /sessions/:id?t=<token> 首访（GET 非 /api）：验通过后种 cookie 并 302 去掉 query
    // - /api/* 全部需要有效凭证；会话 token 只能碰本会话资源，管理面仅 master token 可访问
    // - SPA 壳与静态资源公开（不含数据，数据全走 /api）
    app.addHook('onRequest', async (request, reply) => {
      (request as unknown as { webClaim?: VerifiedWebToken | null }).webClaim = null;
      const url = new URL(request.url, 'http://agent-dock.local');
      const queryToken = url.searchParams.get('t') ?? undefined;
      // cookie 必须带 Max-Age：否则它是浏览器会话 cookie，关浏览器/重启就被清，
      // 即便 token 本身 30 天（session）/365 天（master）有效也白搭。过期时间
      // 与 token 的 exp 对齐，不引入第二套寿命。master/session 各写各的 cookie 名，
      // 打开一张卡片链接不会把控制台的全权凭证覆盖掉。
      const setCredentialCookie = (token: string, value: VerifiedWebToken) => {
        const maxAge = Math.max(0, Math.floor((value.expiresAt - Date.now()) / 1000));
        reply.header('set-cookie', `${webAccessCookieNameFor(value.kind)}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
      };
      let claim: VerifiedWebToken | null = null;
      // 显式点开的带凭证链接优先级最高：用户点链接的意图就是「用这个凭证」，其作用域
      // （会话链接只见本会话）也按链接自己算，本机直连的补发不覆盖它。
      let explicitCredential = false;
      if (queryToken) {
        claim = verifyWebToken(queryToken, secret);
        if (claim) {
          explicitCredential = true;
          setCredentialCookie(queryToken, claim);
          if ((request.method === 'GET' || request.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
            url.searchParams.delete('t');
            return reply.redirect(`${url.pathname}${url.search}`, 302);
          }
        }
      }
      if (!url.pathname.startsWith('/api/')) return;
      // 密码登录本身就是拿凭证的入口，不能被访问门拦住；两个接口都不返回任何业务数据。
      if (url.pathname === '/api/auth/status' || url.pathname === '/api/auth/login') return;
      // 群协作工具是给会话内 agent 调的机器接口，走独立的每会话 HMAC Bearer
      // 鉴权（agent-tools 内部 fail-closed 401），agent 进程没有浏览器 cookie，
      // 不能被 Web 访问门拦掉。
      if (url.pathname.startsWith('/api/lark/agent-tools/')) return;
      claim ??= verifyWebToken(parseCookieHeader(request.headers.cookie, webAccessCookieName), secret)
        ?? verifyWebToken(parseCookieHeader(request.headers.cookie, webAccessSessionCookieName), secret);
      // 本机直连（回环源地址 + 回环 Host 头 + 非跨站发起，见 isLocalOwnerRequest）视为机器
      // 所有者，直接补发全权凭证并种下 cookie。凭证是 cookie、cookie 按源隔离，而启动时只
      // 打印其中一个主机名的带凭证链接——用户换 localhost / 127.0.0.1 / [::1] 里的任意一个
      // 打开、或那个链接已过期，就永远 401，观感正是「cookie 有效期非常短」。
      // 显式携带且验签通过的链接不在此列（见 explicitCredential），作用域按链接自己算；
      // 局域网来源的源地址不是回环，转发出去的卡片链接照旧收窄到本会话。
      if (!explicitCredential && claim?.kind !== 'master' && isLocalOwnerRequest({ address: request.ip, host: request.headers.host, fetchSite: request.headers['sec-fetch-site'] as string | undefined })) {
        const token = issueMasterToken(secret);
        const localClaim = verifyWebToken(token, secret);
        if (localClaim) {
          claim = localClaim;
          setCredentialCookie(token, localClaim);
        }
      }
      if (!claim) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: '访问凭证缺失或已过期，请从飞书卡片链接或 agent-dock 启动输出的带凭证地址重新打开。' } });
      }
      (request as unknown as { webClaim?: VerifiedWebToken | null }).webClaim = claim;
      if (claim.kind === 'session' && !sessionTokenAllows(request.method, url.pathname, claim.sessionId!, url.searchParams)) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: '该链接仅可访问对应会话的资源。' } });
      }
    });
  }

  if (webAuthEnabled) {
    const secret = options.webAuth!.secret!;
    const passwordFile = options.webAuth!.passwordFile ?? webPasswordPath();
    const limiter = new LoginRateLimiter();
    // 登录页用它决定显不显示密码框；只暴露「有没有密码」这一位。
    app.get('/api/auth/status', async () => ({ passwordEnabled: Boolean(readWebPasswordHash(passwordFile)) }));
    // 密码正确即发 master 凭证，与启动输出的带凭证链接等价。哈希每次现读：CLI 改密码立即生效。
    app.post<{ Body: { password?: unknown } }>('/api/auth/login', async (request, reply) => {
      const stored = readWebPasswordHash(passwordFile);
      if (!stored) return reply.code(404).send({ error: { code: 'PASSWORD_NOT_SET', message: '尚未设置访问密码。可在本机终端运行 agent-dock password set 设置。' } });
      const key = request.ip || 'unknown';
      if (limiter.blocked(key)) return reply.code(429).send({ error: { code: 'TOO_MANY_ATTEMPTS', message: '密码错误次数过多，请 10 分钟后再试。' } });
      const password = typeof request.body?.password === 'string' ? request.body.password : '';
      if (!password || !verifyWebPassword(password, stored)) {
        limiter.recordFailure(key);
        return reply.code(400).send({ error: { code: 'INVALID_PASSWORD', message: '密码不正确。' } });
      }
      limiter.reset(key);
      const token = issueMasterToken(secret);
      const claim = verifyWebToken(token, secret)!;
      const maxAge = Math.max(0, Math.floor((claim.expiresAt - Date.now()) / 1000));
      reply.header('set-cookie', `${webAccessCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
      return { ok: true };
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RuntimeError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  });

  app.get('/health', async () => ({ ok: true }));
  await registerSystemRoutes(app, options.system);
  if (options.selfUpdate) registerSelfUpdateRoutes(app, options.selfUpdate);
  if (options.schedules) registerScheduleRoutes(app, options.schedules);
  await registerLarkRoutes(app, { ...options.lark, runtime: options.lark?.runtime ?? runtime });
  app.get('/api/agents', async request => {
    // 停用的内置 agent 只在配置面板展示，面板入口仅 master token 可用（会话令牌拿到的列表不含停用项）。
    const url = new URL(request.url, 'http://agent-dock.local');
    const includeDisabled = url.searchParams.get('includeDisabled') === '1' && (!webAuthEnabled || (request as unknown as { webClaim?: VerifiedWebToken | null }).webClaim?.kind === 'master');
    return runtime.listAgents(includeDisabled);
  });
  // 账号额度属于本机控制台所有者，不放在 /api/agents 下（会话分享令牌可读该前缀）。
  app.get<{ Querystring: { refresh?: string } }>('/api/codex/usage', async request => getCodexUsage(request.query.refresh === '1'));
  app.get<{ Querystring: { refresh?: string } }>('/api/claude/usage', async request => getClaudeUsage(request.query.refresh === '1'));
  app.get<{ Querystring: { refresh?: string } }>('/api/cursor/usage', async request => getCursorUsage(request.query.refresh === '1'));
  app.post('/api/agents', async request => runtime.createAgent((request as { body: unknown }).body));
  app.put<{ Params: { id: string } }>('/api/agents/:id', async request => runtime.updateAgent(request.params.id, request.body));
  app.delete<{ Params: { id: string } }>('/api/agents/:id', async request => runtime.deleteAgent(request.params.id));
  // 单独一个启用/停用入口：PUT /api/agents/:id 是「表单全量更新」，它有意忽略提交体里的
  // disabled（防止表单把人锁在外面），所以停用后没法靠它启回来。
  app.post<{ Params: { id: string }; Body: { disabled?: boolean } }>('/api/agents/:id/disabled', async request => {
    if (typeof request.body?.disabled !== 'boolean') throw new RuntimeError('INVALID_DISABLED', 'disabled 必须是布尔值', 400);
    return runtime.setAgentDisabled(request.params.id, request.body.disabled);
  });
  app.get<{ Params: { id: string }; Querystring: { model?: string; refresh?: string } }>('/api/agents/:id/models', async request => {
    const agent = (await runtime.listAgents()).find(item => item.id === request.params.id);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${request.params.id}`, 404);
    return discoverAgentModels(agent, request.query.model?.trim() || undefined, request.query.refresh === '1' || request.query.refresh === 'true');
  });
  // 只读列举某个 Agent 自己记录的会话（ACP session/list），供导入面板选择；不落库、不建会话。
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; cwd?: string } }>('/api/agents/:id/external-sessions', async request => {
    const agent = (await runtime.listAgents()).find(item => item.id === request.params.id);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${request.params.id}`, 404);
    const result = await listExternalSessions(agent, {
      ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      ...(request.query.cwd ? { filterCwd: request.query.cwd } : {}),
      excludeSessionIds: await collectAgentDockOwnedSessionIds(runtime),
      timeoutMs: 30_000
    });
    return { agentId: agent.id, agentName: agent.name, ...result };
  });
  app.get('/api/sessions', async () => runtime.listSessions());
  // 只透传白名单字段：resumeSessionId / importTurns 只能由 /api/sessions/import 生成，
  // import、lark 来源由各自入口建会话，不能被普通建会话请求冒充。
  app.post<{ Body: { agentId: string; cwd?: string; model?: string; reasoningEffort?: string; systemPrompt?: string; source?: string; sourceId?: string } }>('/api/sessions', async request => {
    const { agentId, cwd, model, reasoningEffort, systemPrompt, source, sourceId } = request.body ?? {};
    if (source === 'import' || source === 'lark') throw new RuntimeError('INVALID_SOURCE', `source=${source} 只能由对应入口创建`, 400);
    return runtime.start({ agentId, cwd, model, reasoningEffort, systemPrompt, source, sourceId });
  });
  // 导入一个外部 ACP 会话：接管上下文 +（可选）把外部历史回填成 AgentDock 轮次。
  // 与 /api/sessions 分开，是因为 full 模式要先读一次外部转录再建会话，失败要做成明确的导入错误。
  app.post<{ Body: { agentId: string; externalSessionId: string; cwd?: string; mode?: 'full' | 'session'; model?: string; reasoningEffort?: string } }>('/api/sessions/import', async request => {
    try {
      const agentId = request.body?.agentId?.trim();
      const externalSessionId = request.body?.externalSessionId?.trim();
      if (!agentId || !externalSessionId) throw new RuntimeError('INVALID_IMPORT', 'agentId 与 externalSessionId 必填', 400);
      const agent = (await runtime.listAgents()).find(item => item.id === agentId);
      if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${agentId}`, 404);
      const cwd = request.body.cwd?.trim() || agent.cwd;
      if (!cwd || !cwd.startsWith('/')) throw new RuntimeError('INVALID_IMPORT', '导入需要绝对路径的工作目录', 400);
      const mode = request.body.mode === 'session' ? 'session' : 'full';
      let importTurns: Awaited<ReturnType<typeof loadExternalSessionTranscript>>['turns'] | undefined;
      if (mode === 'full') {
        const transcript = await loadExternalSessionTranscript(agent, externalSessionId, cwd, { timeoutMs: 60_000 });
        if (!transcript.replayed) throw new RuntimeError('IMPORT_UNSUPPORTED', `Agent ${agent.name} 不支持读取历史（ACP session/load），无法完整导入`, 422);
        importTurns = transcript.turns;
      }
      const startInput = {
        agentId,
        cwd,
        ...(request.body.model?.trim() ? { model: request.body.model.trim() } : {}),
        ...(request.body.reasoningEffort?.trim() ? { reasoningEffort: request.body.reasoningEffort.trim() } : {}),
        resumeSessionId: externalSessionId,
        source: 'import',
        sourceId: externalSessionId,
        ...(importTurns?.length ? { importTurns } : {})
      };
      // 读历史的临时连接释放 writer 锁可能有延迟（尤其 Codex）：只要报 active writer，
      // 短暂退避重试几次，避免把「几秒后就能成功」的情况直接判成失败。
      for (let attempt = 1; ; attempt++) {
        try {
          return await runtime.start(startInput);
        } catch (error) {
          const detail = describeAcpError(error);
          if (attempt < 3 && /active writer/i.test(detail)) { await new Promise(resolve => setTimeout(resolve, 1_200)); continue; }
          throw error;
        }
      }
    } catch (error) {
      // 4xx 的显式错误（缺参、Agent 不存在、不支持）原样抛出；其余（ACP/JSON-RPC 报错）翻成人话，
      // 否则前端只能看到 JSON-RPC 顶层的 "Internal error"，真正的原因在 error.data.details 里。
      if (error instanceof RuntimeError && error.statusCode < 500) throw error;
      const detail = describeAcpError(error);
      const friendly = /already has an active writer/i.test(detail)
        ? '该会话正在被其他客户端或进程使用（active writer），请先关闭占用它的 Codex/Agent 窗口或进程，再重试导入。'
        : detail;
      throw new RuntimeError('IMPORT_FAILED', friendly, 422);
    }
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => (await runtime.getSessionWithTitle(request.params.id)) ?? reply.code(404).send({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } }));
  app.get<{ Params: { id: string } }>('/api/sessions/:id/record', async (request, reply) => {
    const session = await runtime.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } });
    // events 必须有界：这里是「完整记录」档，但历史会话事件可达百万行、几百 MB，全量读会
    // 把 daemon 拖进 OOM（.all() 物化 + 逐行 JSON.parse）。只回最近一页，并用 eventTotal
    // 明说总数——静默截断会让用户拿这份记录去对账时得出错误结论。
    const [tasks, events, eventTotal] = await Promise.all([
      runtime.getTasks(session.id),
      runtime.getRecentEvents(session.id, RECORD_EVENT_LIMIT),
      runtime.countEvents(session.id)
    ]);
    return { session, tasks, events, eventTotal, eventsTruncated: eventTotal > events.length };
  });
  app.post<{ Params: { id: string }; Body: { prompt: string; mode?: 'queue' | 'interrupt' } }>('/api/sessions/:id/send', async (request, reply) => {
    const prompt = request.body?.prompt?.trim();
    const mode = request.body?.mode ?? 'queue';
    if (!prompt) throw new RuntimeError('INVALID_PROMPT', 'Prompt must not be empty', 400);
    if (mode !== 'queue' && mode !== 'interrupt') throw new RuntimeError('INVALID_SEND_MODE', `Unknown send mode: ${String(mode)}`, 400);
    const task = await runtime.dispatch(request.params.id, prompt, mode);
    return reply.code(202).send({ accepted: true, task });
  });
  // 会话名单独一条路由，不并进 /config：那个的语义是「真的去调 agent 切运行时配置」，
  // 改名字是纯本地元数据，混在一起会让「切模型失败」和「改名失败」共用同一套错误路径。
  // 空串/null = 恢复自动命名（回落到 Agent 名 / 首条 prompt 摘要），不是存一个空标题。
  app.patch<{ Params: { id: string }; Body: { title?: string | null } }>('/api/sessions/:id/title', async request => runtime.setSessionTitle(request.params.id, request.body?.title ?? null));
  app.patch<{ Params: { id: string }; Body: { model?: string; reasoningEffort?: string } }>('/api/sessions/:id/config', async request => {
    const model = request.body?.model?.trim();
    if (model) return runtime.setModel(request.params.id, model);
    const reasoningEffort = request.body?.reasoningEffort?.trim();
    if (reasoningEffort) return runtime.setReasoningEffort(request.params.id, reasoningEffort);
    throw new RuntimeError('INVALID_SESSION_CONFIG', 'Model or reasoning effort is required', 400);
  });
  app.delete<{ Params: { id: string; taskId: string } }>('/api/sessions/:id/queue/:taskId', async request => runtime.cancelQueued(request.params.id, request.params.taskId));
  app.patch<{ Params: { id: string; taskId: string }; Body: { prompt: string } }>('/api/sessions/:id/queue/:taskId', async request => {
    const prompt = request.body?.prompt?.trim();
    if (!prompt) throw new RuntimeError('INVALID_PROMPT', 'Prompt must not be empty', 400);
    return runtime.updateQueued(request.params.id, request.params.taskId, prompt);
  });
  app.post<{ Params: { id: string; taskId: string } }>('/api/sessions/:id/queue/:taskId/steer', async request => runtime.steerQueued(request.params.id, request.params.taskId));
  for (const action of ['interrupt', 'pause', 'resume', 'stop', 'restart'] as const) {
    app.post<{ Params: { id: string } }>(`/api/sessions/:id/${action}`, async request => { const result = await runtime[action](request.params.id); return result ?? { ok: true }; });
  }
  app.post<{ Params: { id: string } }>('/api/sessions/:id/archive', async request => runtime.archive(request.params.id));
  app.post<{ Params: { id: string; permissionId: string }; Body: { approved: boolean } }>('/api/sessions/:id/permissions/:permissionId', async request => runtime.resolvePermission(request.params.id, request.params.permissionId, request.body.approved));
  app.get<{ Params: { id: string }; Querystring: { after?: string; before?: string; compact?: string; limit?: string } }>('/api/sessions/:id/events', async (request, reply) => {
    if (request.query.limit !== undefined) {
      const limit = Number(request.query.limit);
      const before = request.query.before === undefined ? undefined : Number(request.query.before);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (before !== undefined && (!Number.isInteger(before) || before < 1))) {
        throw new RuntimeError('INVALID_EVENT_PAGE', 'Invalid event page', 400);
      }
      return runtime.getRecentEvents(request.params.id, limit, before);
    }
    if (request.query.compact === 'thinking') return runtime.getCompactedEvents(request.params.id, Number(request.query.after ?? 0));
    // 原始事件回放不给 limit：调用方要的就是完整历史，截断即功能回归，所以改成流式写出
    // （响应体与原来逐字节相同，服务端不再持有整份）。合并分支仍走内存——合并结果小一个量级
    // （实测最重会话 235 MB → 29.8 MB），且它的体积由主时间线首屏决定，属于另一件事。
    reply.type('application/json');
    const after = Number(request.query.after ?? 0);
    // 有界返回：先钉住快照上界。这是有限 JSON 响应，不能像 SSE 那样一直追新事件，
    // 否则活跃会话上新行不断，响应永远写不完。
    const through = await runtime.maxEventSequence(request.params.id);
    return jsonArrayStream(pagedEvents((cursor, limit) => runtime.getEventPage(request.params.id, cursor, limit), after, through));
  });
  // 导入会话从外部 Agent 同步新轮次。Codex 桌面端等仍开着该线程时会报 active writer，翻成可操作的提示。
  app.post<{ Params: { id: string } }>('/api/sessions/:id/sync-external', async request => {
    try {
      // 上一次读历史的临时连接释放 writer 锁约需 1 秒：连点两次时短暂退避重试，而不是报「外部占用」。
      const load = async (agent: AgentConfig, session: Session) => {
        for (let attempt = 1; ; attempt++) {
          try { return await loadExternalSessionTranscript(agent, session.sourceId!, session.cwd, { timeoutMs: 60_000 }); }
          catch (error) {
            if (attempt < 3 && /active writer/i.test(describeAcpError(error))) { await new Promise(resolve => setTimeout(resolve, 1_200)); continue; }
            throw error;
          }
        }
      };
      return await runtime.syncImportedSession(request.params.id, load);
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      const detail = describeAcpError(error);
      if (/active writer/i.test(detail)) throw new RuntimeError('EXTERNAL_SESSION_LOCKED', '外部 Agent 正占用该会话（如 Codex 桌面端还开着这个线程），关掉后再同步', 409);
      throw new RuntimeError('SYNC_FAILED', `同步外部会话失败：${detail}`, 502);
    }
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/tasks', async request => runtime.getTasks(request.params.id));
  // 轮次锚点图：只回每轮的边界与过程条数，不回事件体。轨迹面板整个生命周期只请求一次——
  // 锚点扫描要读该会话的全部 text 事件，重会话实测 184 ms，不能按轮算。
  app.get<{ Params: { id: string } }>('/api/sessions/:id/turns', async (request, reply) => {
    const session = await runtime.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } });
    return { turns: await runtime.getTurns(session.id) };
  });
  // 单轮事件体：有界 + 已合并分片（含正文），给面板「按需拉思考与工具调用」用。
  // 客户端已经握着 /turns 的边界时会带上 after/before，从而跳过一次锚点扫描；
  // 不带也能用，服务端自己算边界。
  app.get<{ Params: { id: string; taskId: string }; Querystring: { after?: string; before?: string; limit?: string } }>('/api/sessions/:id/turns/:taskId/events', async (request, reply) => {
    const session = await runtime.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } });
    const limit = request.query.limit === undefined ? TURN_EVENT_ROW_LIMIT : Number(request.query.limit);
    const givenAfter = request.query.after === undefined ? undefined : Number(request.query.after);
    const givenBefore = request.query.before === undefined ? undefined : Number(request.query.before);
    const badNumber = (value: number | undefined) => value !== undefined && (!Number.isInteger(value) || value < 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > TURN_EVENT_ROW_LIMIT || badNumber(givenAfter) || badNumber(givenBefore)) {
      throw new RuntimeError('INVALID_TURN_EVENT_PAGE', 'Invalid turn event page', 400);
    }
    let after = givenAfter;
    let before = givenBefore;
    if (after === undefined || before === undefined || before <= after) {
      const turn = (await runtime.getTurns(session.id)).find(item => item.taskId === request.params.taskId);
      if (!turn) return reply.code(404).send({ error: { code: 'TURN_NOT_FOUND', message: 'Turn not found' } });
      after = turn.startSequence;
      before = turn.endSequence;
    }
    const events = await runtime.getTurnEvents(session.id, { after, before, limit, maxBytes: TURN_EVENT_BYTE_LIMIT });
    // 序号在窗口内唯一，所以「最后一条的序号 < before - 1」就说明后面还有行没取。
    // 事件是分片推的，LIMIT 截在原始行上，这里必须把「只给了这一段」说出来。
    const lastSequence = events.at(-1)?.sequence;
    return { taskId: request.params.taskId, after, before, events, nextAfter: lastSequence ?? after, truncated: lastSequence !== undefined && lastSequence < before - 1 };
  });
  await registerFsRoutes(app, runtime);
  await registerLlmRoutes(app, options.llm);

  const mimeToExt: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'image/bmp': '.bmp', 'image/svg+xml': '.svg',
    'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv',
    'application/msword': '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-powerpoint': '.ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/zip': '.zip', 'application/x-tar': '.tar', 'application/gzip': '.gz',
    'application/json': '.json', 'application/javascript': '.js', 'text/html': '.html', 'text/css': '.css',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-msvideo': '.avi',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/flac': '.flac',
    'application/octet-stream': ''
  };
  const globalUploadRoot = join(homedir(), '.agentdock', 'uploads');
  // 上传文件此前只写不删，随使用无上限增长（尤其是粘贴截图、拖入视频）。
  // Agent 只在收到消息的那一轮需要读它，因此按 mtime 做 TTL 回收即可；
  // 保留 7 天足以覆盖「回看历史会话里的图片」，同时避免磁盘被无声占满。
  const uploadTtlMs = 7 * 24 * 60 * 60_000;
  const collectExpiredUploads = async (now = Date.now()) => {
    let removedFiles = 0;
    let sessionDirs: string[];
    try { sessionDirs = await readdir(globalUploadRoot); }
    catch { return { removedFiles }; }
    for (const sessionDir of sessionDirs) {
      const directory = join(globalUploadRoot, sessionDir);
      let names: string[];
      try { names = await readdir(directory); }
      catch { continue; }
      for (const name of names) {
        const filePath = join(directory, name);
        try {
          const info = await stat(filePath);
          if (!info.isFile() || now - info.mtimeMs <= uploadTtlMs) continue;
          await rm(filePath, { force: true });
          removedFiles++;
        } catch { /* 文件可能已被并发删除或不可读，跳过即可。 */ }
      }
      // 目录空了顺手删掉，避免留下大量空会话目录。
      try { if (!(await readdir(directory)).length) await rm(directory, { recursive: true, force: true }); }
      catch { /* best-effort */ }
    }
    return { removedFiles };
  };
  // 启动时清一次 + 每天一次；unref 避免拖住进程退出。
  void collectExpiredUploads().catch(() => undefined);
  const uploadGcTimer = setInterval(() => void collectExpiredUploads().catch(() => undefined), 24 * 60 * 60_000);
  uploadGcTimer.unref();
  app.addHook('onClose', async () => clearInterval(uploadGcTimer));
  // 未知 content-type 时按扩展名兜底：浏览器对 .md/.heic/.zip 等的类型上报很不一致
  // （Chrome 发 text/markdown、Windows 发 application/x-zip-compressed），
  // 这些都应正常落盘，而不是被拒绝。
  const extFromContentType = (contentType: string, fallbackName?: string) => {
    const known = mimeToExt[contentType];
    if (known !== undefined) return known;
    const suffix = fallbackName ? extname(fallbackName).toLowerCase() : '';
    return /^\.[a-z0-9]{1,8}$/.test(suffix) ? suffix : '';
  };

  app.post<{ Params: { id: string } }>('/api/sessions/:id/uploads', async (request, reply) => {
    const session = await runtime.getSession(request.params.id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
    const contentType = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!contentType) throw new RuntimeError('INVALID_UPLOAD', '缺少 Content-Type，无法识别上传文件类型', 400);
    const buffer = request.body;
    // parser 已放开为任意类型，因此这里必须自己确认拿到的是原始字节。
    if (!Buffer.isBuffer(buffer)) {
      throw new RuntimeError('INVALID_UPLOAD', `无法读取 ${contentType} 的原始内容，请以二进制方式上传`, 415);
    }
    if (buffer.length === 0) throw new RuntimeError('INVALID_UPLOAD', '上传内容为空', 400);
    if (buffer.length > 50 * 1024 * 1024) throw new RuntimeError('INVALID_UPLOAD', '文件过大（最大 50MB）', 400);
    const headerName = request.headers['x-upload-filename'];
    const rawName = Array.isArray(headerName) ? headerName[0] : headerName;
    // 客户端以 encodeURIComponent 发送（头部不能携带非 ASCII）；解码失败时忽略该提示。
    let originalName: string | undefined;
    try { originalName = rawName ? decodeURIComponent(rawName) : undefined; } catch { originalName = rawName; }
    const ext = extFromContentType(contentType, originalName);
    const uploadDir = join(globalUploadRoot, session.id);
    await mkdir(uploadDir, { recursive: true });
    const filename = `${Date.now()}-${randomBytes(6).toString('hex')}${ext}`;
    const filePath = join(uploadDir, filename);
    await writeFile(filePath, buffer);
    return reply.code(201).send({ path: filePath, url: `/api/sessions/${session.id}/uploads/${filename}`, filename });
  });
  app.get<{ Params: { id: string; filename: string } }>('/api/sessions/:id/uploads/:filename', async (request, reply) => {
    const session = await runtime.getSession(request.params.id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
    const filename = request.params.filename;
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new RuntimeError('INVALID_UPLOAD', 'Invalid filename', 400);
    }
    const filePath = join(globalUploadRoot, session.id, filename);
    const ext = extname(filename).toLowerCase();
    const data = await readFile(filePath);
    reply.header('Content-Type', contentTypes[ext] ?? 'application/octet-stream');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    // 上传内容来自外部（用户粘贴/拖拽的任意文件），不能让浏览器直接执行：
    // attachment 让直接导航变成下载；nosniff 阻止 MIME 嗅探。<img> 等子资源预览不受影响。
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(data);
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/sessions/:id/stream', async (request, reply) => {
    const fromHeader = request.headers['last-event-id'];
    const queryAfter = Number(request.query.after ?? 0);
    const headerAfter = Number((Array.isArray(fromHeader) ? fromHeader[0] : fromHeader) ?? 0);
    const after = Math.max(queryAfter, headerAfter);
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write(': connected\n\n');
    const write = (event: any) => reply.raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    // 回放历史：逐行迭代 + 尊重背压。以前是 getEvents 先把整段历史物化成对象再逐条 write，
    // 实测 145 万行 / 235 MB 的会话能直接把 daemon 拖到 OOM；写不动 socket 还继续全速生产，
    // 内存只是从「解析后的对象」挪到「待发送的字符串」，一样会炸。
    const drain = () => new Promise<void>(resolve => {
      const finish = () => { reply.raw.off('drain', finish); reply.raw.off('close', finish); resolve(); };
      reply.raw.once('drain', finish);
      reply.raw.once('close', finish);
    });
    // SSE 是无限流，故意不钉快照上界：回放期间新产生的事件直接顺带发出去，
    // 比「钉死上界 → 订阅」少一个丢事件的窗口。
    for await (const event of pagedEvents((cursor, limit) => runtime.getEventPage(request.params.id, cursor, limit), after)) {
      if (request.raw.destroyed) break;
      if (!write(event)) await drain();
    }
    const unsubscribe = runtime.subscribe(request.params.id, write);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    request.raw.once('close', () => { clearInterval(heartbeat); unsubscribe(); streams.delete(reply.raw); });
  });

  if (options.webRoot) {
    const webRoot = resolve(options.webRoot);
    const indexFile = resolve(webRoot, 'index.html');
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
      const pathname = new URL(request.url, 'http://agent-dock.local').pathname;
      if (pathname.startsWith('/api/') || pathname === '/api') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'API route not found' } });

      let requestedFile: string;
      try { requestedFile = resolve(webRoot, decodeURIComponent(pathname).replace(/^\/+/, '')); }
      catch { return reply.code(400).send({ error: { code: 'INVALID_PATH', message: 'Invalid URL path' } }); }
      if (requestedFile !== webRoot && !requestedFile.startsWith(`${webRoot}${sep}`)) return reply.code(404).send();

      let file = requestedFile;
      let body: Buffer;
      try { body = await readFile(file); }
      catch {
        if (extname(pathname)) return reply.code(404).send();
        file = indexFile;
        try { body = await readFile(file); }
        catch { return reply.code(404).send({ error: { code: 'WEB_UI_NOT_FOUND', message: 'Web UI is not installed' } }); }
      }
      const type = contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream';
      if (pathname.startsWith('/assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      else if (file === indexFile) reply.header('Cache-Control', 'no-cache, must-revalidate');
      return reply.type(type).send(request.method === 'HEAD' ? undefined : body);
    });
  }
  return app;
}
