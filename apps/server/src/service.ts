import { AutostartService } from './daemon/autostart.js';
import { acquireDatabaseServerLock } from './daemon/db-lock.js';
import { KeepAwakeService } from './daemon/keep-awake.js';
import { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import { loadConfig, type AppConfig } from '@agent-dock/agent-dock-config';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SelfUpdateService } from './self-update.js';
import { buildApp } from './app.js';
import { createHandoverLookup } from './lark/handover-binding.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService, loadOrCreateGroupToolsSigningSecret } from './lark/agent-tools.js';
import { LarkTurnTracker } from './lark/turn-tracker.js';
import { readLarkConfigs } from './lark/config.js';
import { createLarkCardService } from './lark/service.js';
import { LlmEndpointService } from './llm/service.js';
import { SideChatConfigService } from './side-chat-config.js';
import { AskUserQuestionService } from './ask-user-question.js';
import { OutputPluginService } from './output-plugins/index.js';
import { NotificationService } from './notifications/service.js';
import { BoardService } from './boards/service.js';
import { ThemeService } from './themes/service.js';
import { LarkAvatarService } from './lark-avatar/service.js';
import { buildInitialSystemPrompt } from './initial-system-prompt.js';
import { ScheduleService } from './schedules/service.js';
import { AssistantService } from './assistant/service.js';
import { createLarkNotifier } from './assistant/notify.js';
import { defaultSessionTokenTtlMs, initWebAccess, issueMasterToken, loadOrCreateWebAccessSecret } from './web-access.js';
import { ShareLinkService } from './share-link.js';

export interface StartLocalServerOptions { env?: NodeJS.ProcessEnv; webRoot?: string; groupToolsCommand?: string; /** 当前 CLI 入口，给界面一键升级跑 `agent-dock update`；不传则不挂升级路由。 */ cliEntrypoint?: string }
export interface LocalServer {
  config: AppConfig;
  runtime: AgentDockRuntime;
  /** 本机管理入口（master token，全权，一年有效）；防护关闭时 enabled=false。 */
  webAccess: { enabled: boolean; adminToken?: string };
  close(): Promise<void>;
}

export function listenOptions(config: Pick<AppConfig, 'host' | 'port'>) {
  if (config.host === '0.0.0.0') {
    return { host: '::', port: config.port, ipv6Only: false } as const;
  }
  return { host: config.host, port: config.port };
}

function localApiBaseUrl(config: Pick<AppConfig, 'host' | 'port'>) {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
}

export async function startLocalServer(options: StartLocalServerOptions = {}): Promise<LocalServer> {
  const config = loadConfig(options.env ?? process.env);
  const env = options.env ?? process.env;
  // 先独占数据库服务锁，再打开库与运行 runtime.initialize()：杜绝重复起服在 listen 失败前破坏在线会话。
  const dbLock = acquireDatabaseServerLock(config.databaseUrl, { home: env.HOME });
  let repos: ReturnType<typeof createRepositories>;
  try { repos = createRepositories(config.databaseUrl); }
  catch (error) { dbLock.release(); throw error; }
  let groupToolsSigningSecret: string;
  try { groupToolsSigningSecret = await loadOrCreateGroupToolsSigningSecret(repos.config); }
  catch (error) { repos.close(); dbLock.release(); throw error; }
  const larkTurnTracker = new LarkTurnTracker();
  let assistant: AssistantService | undefined;
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, localApiBaseUrl(config), groupToolsSigningSecret);
  capabilities.useHandoverLookup(createHandoverLookup(repos.config, repos.channelMappings, () => assistant?.lifecycle.lineage() ?? []));
  const agentTools = new LarkAgentToolsService(capabilities, repos.config, {
    env,
    groupToolsCommand: options.groupToolsCommand,
    onGroupSent: record => larkTurnTracker.recordGroupSend(record)
  });
  let outputPlugins: OutputPluginService | undefined;
  let askUserQuestion: AskUserQuestionService | undefined;
  const runtime = new AgentDockRuntime(repos, {
    acpxCommand: config.acpxCommand,
    driverIdleTimeoutMs: config.driverIdleTimeoutMs,
    cleanupIntervalMs: config.cleanupIntervalMs,
    // agentdock_database：告诉 Agent 自己跑在哪个 daemon 上，CLI 的自杀保护靠它区分「重启自己」和「操作沙箱」。
    sessionEnvironment: session => ({ agentdock_database: config.databaseUrl, ...capabilities.environmentFor(session) }),
    createSystemPrompt: buildInitialSystemPrompt,
    // 先串飞书工具提示，再串主会话快照，最后按开关注入所有启用的纯 XML 交互插件协议；均只影响实际发给 Agent 的文本，不改变时间线用户原话。
    sessionPrompt: async (session, prompt, origin) => {
      const withTools = await agentTools.promptForSession(session, prompt);
      const withAssistant = assistant ? await assistant.composePrompt(session, withTools, origin) : withTools;
      return outputPlugins ? outputPlugins.promptForSession(session, withAssistant, origin) : withAssistant;
    }
  });
  outputPlugins = new OutputPluginService({ config: repos.config, channelMappings: repos.channelMappings, runtime, env });
  askUserQuestion = new AskUserQuestionService({ config: repos.config, channelMappings: repos.channelMappings, runtime, outputPlugins });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let schedules: ScheduleService | undefined;
  let notifications: NotificationService | undefined;
  let boards: BoardService | undefined;
  let themes: ThemeService | undefined;
  let larkAvatar: LarkAvatarService | undefined;
  let keepAwake: KeepAwakeService | undefined;
  let closed = false;
  let webAuth: { enabled: boolean; secret?: string; sessionTokenTtlMs?: number } = { enabled: false };
  try {
    await runtime.initialize(config.agents);
    // 本地 Web 访问防护默认开启（AGENTDOCK_WEB_AUTH=off 可关）：secret 持久化，重启不换。
    const webAuthEnabled = !['off', '0', 'false'].includes((env.AGENTDOCK_WEB_AUTH ?? '').trim().toLowerCase());
    if (webAuthEnabled) {
      const secret = await loadOrCreateWebAccessSecret(repos.config);
      const ttlDays = Number(env.AGENTDOCK_WEB_TOKEN_TTL_DAYS);
      const sessionTokenTtlMs = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 24 * 60 * 60_000 : defaultSessionTokenTtlMs;
      initWebAccess(secret, sessionTokenTtlMs);
      webAuth = { enabled: true, secret, sessionTokenTtlMs };
    }
    const webRoot = options.webRoot ?? fileURLToPath(new URL('../public', import.meta.url));
    const llm = new LlmEndpointService({ config: repos.config });
    themes = new ThemeService({ config: repos.config, llm });
    const sideChatConfig = new SideChatConfigService({ config: repos.config, listAgents: () => runtime.listAgents() });
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
    const selfUpdate = options.cliEntrypoint ? new SelfUpdateService({ currentVersion: packageJson.version, packageName: packageJson.name, cliEntrypoint: options.cliEntrypoint, env }) : undefined;
    schedules = new ScheduleService(repos.schedules, repos.sessions, runtime, {
      resolveMainSessionId: () => assistant?.mainSessionId
    });
    const legacyLarkNotify = createLarkNotifier(repos, env);
    notifications = new NotificationService({
      runtime,
      repos,
      env,
      cwd: config.defaultCwd,
      isAssistantSubtask: sessionId => assistant?.isTaskSession(sessionId) ?? false
    });
    // 主会话/事项/watch/督办。旧 sources-router 从 M0 起不再构造，代码留到 M2 删除。
    assistant = new AssistantService({
      databaseUrl: config.databaseUrl,
      runtime,
      repos,
      log: { info: () => undefined, warn: message => console.warn(String(message)) },
      notify: async input => {
        if (!notifications) return legacyLarkNotify(input);
        const state = await notifications.getPublicState();
        const dispatched = await notifications.emitManualNotify(input);
        if (!state.config.lark.enabled) {
          const legacySent = await legacyLarkNotify(input).catch(() => false);
          return dispatched || legacySent;
        }
        return dispatched;
      },
      // larkAvatar 在下面才构造；回调在真正发草稿时才解析到实例。
      sendLarkReply: input => {
        if (!larkAvatar) throw new Error('飞书替身尚未初始化');
        return larkAvatar.sendMessage(input);
      },
      onMainSessionHandoff: async fromSessionId => {
        await schedules?.migrateSessionAppendSchedulesToMain(fromSessionId);
      },
      boardSnapshot: () => boards ? boards.snapshotForMainSession() : Promise.resolve(''),
      onTaskMutated: task => {
        boards?.hub.broadcast({
          event: 'task.updated',
          data: { taskId: task.id, sessionId: task.sessionId, state: task.state, timestamp: task.updatedAt }
        });
      }
    });
    await assistant.initialize();
    boards = new BoardService({ repos, runtime, assistant });
    let openChatService: ReturnType<typeof createLarkCardService> | undefined;
    const openChatLookup = async (openChatId: string) => {
      try {
        if (!openChatService) {
          const stored = (await readLarkConfigs(repos.config))[0];
          const appId = stored?.appId?.trim() || env.LARK_APP_ID?.trim();
          const appSecret = stored?.appSecret?.trim() || env.LARK_APP_SECRET?.trim();
          if (!appId || !appSecret) return undefined;
          openChatService = createLarkCardService(env, globalThis.fetch, { appId, appSecret });
        }
        return await openChatService.getChat(openChatId);
      } catch (error) {
        console.warn(`飞书替身 OpenAPI 反查群 ${openChatId} 失败：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    };
    larkAvatar = new LarkAvatarService({
      databaseUrl: config.databaseUrl, runtime, llm,
      workspace: config.defaultCwd,
      log: { info: message => console.info(String(message)), warn: message => console.warn(String(message)) },
      openChatLookup,
      mainSession: {
        id: () => assistant?.mainSessionId,
        dispatch: async input => {
          const sessionId = assistant?.mainSessionId;
          if (!sessionId) throw new Error('还没有指定主会话');
          return runtime.dispatch(sessionId, input.prompt, 'queue', input.agentPrompt, undefined, input.origin, input.clientMessageId);
        }
      }
    });
    const autostart = options.cliEntrypoint ? new AutostartService({ entrypoint: options.cliEntrypoint, env }) : undefined;
    // 偏好存库：daemon 重启后按上次的选择恢复；caffeinate 用 -w 绑定本进程，异常退出时不会留孤儿。
    keepAwake = new KeepAwakeService({ config: repos.config });
    await keepAwake.restore();
    // 分享链接接口始终挂载：访问防护关闭时 build() 会返回可操作的 409，
    // 界面据此提示用户开启局域网访问，而不是显示一个 404「接口不存在」。
    const shareLinks = new ShareLinkService({ host: config.host, port: config.port, secret: webAuth.secret ?? '', config: repos.config, env });
    app = await buildApp(runtime, { webRoot, webAuth, shareLinks, schedules, ...(assistant ? { assistant } : {}), ...(selfUpdate ? { selfUpdate } : {}), system: { keepAwake, ...(autostart ? { autostart } : {}) }, llm: { service: llm }, sideChatConfig, outputPlugins, askUserQuestion, notifications, boards, themes, lark: { env, config: repos.config, agents: repos.agents, cardMappings: repos.channelMappings, runtime, agentTools, turnTracker: larkTurnTracker, listeningDisabled: env.AGENTDOCK_DISABLE_LARK_LISTENER === 'true' }, larkAvatar });
    await app.listen(listenOptions(config));
    // 听到端口后再开始扫描：启动失败时不会先投递出去一半。
    notifications.start();
    boards.start();
    schedules.start();
    assistant?.start();
    larkAvatar.start();
  } catch (error) {
    keepAwake?.close();
    boards?.close();
    themes?.close();
    const results = await Promise.allSettled([
      notifications?.close() ?? Promise.resolve(),
      schedules?.stop() ?? Promise.resolve(),
      app?.close() ?? Promise.resolve(),
      assistant?.close() ?? Promise.resolve(),
      larkAvatar?.close() ?? Promise.resolve(),
      runtime.shutdown()
    ]);
    capabilities.close();
    repos.close();
    dbLock.release();
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    throw new AggregateError([error, ...failures], 'AgentDock 启动失败');
  }
  return {
    config,
    runtime,
    webAccess: webAuth.enabled && webAuth.secret ? { enabled: true, adminToken: issueMasterToken(webAuth.secret) } : { enabled: false },
    async close() {
      if (closed) return;
      closed = true;
      // 先停调度（等当前一轮扫完），再关 runtime：避免关到一半时还在往里投递。
      keepAwake?.close();
      boards?.close();
      themes?.close();
      await notifications?.close();
      await larkAvatar?.close();
      await schedules?.stop();
      await assistant?.close();
      const results = await Promise.allSettled([app?.close() ?? Promise.resolve(), runtime.shutdown()]);
      capabilities.close();
      repos.close();
      dbLock.release();
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'AgentDock did not shut down cleanly');
    }
  };
}
