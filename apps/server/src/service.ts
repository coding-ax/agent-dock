import { AutostartService } from './daemon/autostart.js';
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
import { LlmEndpointService } from './llm/service.js';
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
  const repos = createRepositories(config.databaseUrl);
  let groupToolsSigningSecret: string;
  try { groupToolsSigningSecret = await loadOrCreateGroupToolsSigningSecret(repos.config); }
  catch (error) { repos.close(); throw error; }
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, localApiBaseUrl(config), groupToolsSigningSecret);
  capabilities.useHandoverLookup(createHandoverLookup(repos.config, repos.channelMappings));
  const env = options.env ?? process.env;
  const agentTools = new LarkAgentToolsService(capabilities, repos.config, { env, groupToolsCommand: options.groupToolsCommand });
  let assistant: AssistantService | undefined;
  const runtime = new AgentDockRuntime(repos, {
    acpxCommand: config.acpxCommand,
    driverIdleTimeoutMs: config.driverIdleTimeoutMs,
    cleanupIntervalMs: config.cleanupIntervalMs,
    // agentdock_database：告诉 Agent 自己跑在哪个 daemon 上，CLI 的自杀保护靠它区分「重启自己」和「操作沙箱」。
    sessionEnvironment: session => ({ agentdock_database: config.databaseUrl, ...capabilities.environmentFor(session) }),
    createSystemPrompt: buildInitialSystemPrompt,
    // 先串飞书工具提示，再串主会话快照；两者都只影响实际发给 Agent 的文本，不改变时间线里的用户原话。
    sessionPrompt: async (session, prompt) => assistant
      ? assistant.composePrompt(session, await agentTools.promptForSession(session, prompt))
      : agentTools.promptForSession(session, prompt)
  });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let schedules: ScheduleService | undefined;
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
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
    const selfUpdate = options.cliEntrypoint ? new SelfUpdateService({ currentVersion: packageJson.version, packageName: packageJson.name, cliEntrypoint: options.cliEntrypoint, env }) : undefined;
    schedules = new ScheduleService(repos.schedules, repos.sessions, runtime);
    // 主会话/事项/watch/督办。旧 sources-router 从 M0 起不再构造，代码留到 M2 删除。
    assistant = new AssistantService({
      databaseUrl: config.databaseUrl,
      runtime,
      repos,
      log: { info: () => undefined, warn: message => console.warn(String(message)) },
      notify: createLarkNotifier(repos, env)
    });
    await assistant.initialize();
    larkAvatar = new LarkAvatarService({
      databaseUrl: config.databaseUrl, runtime, llm,
      workspace: config.defaultCwd,
      log: { info: () => undefined, warn: message => console.warn(String(message)) }
    });
    const autostart = options.cliEntrypoint ? new AutostartService({ entrypoint: options.cliEntrypoint, env }) : undefined;
    // 偏好存库：daemon 重启后按上次的选择恢复；caffeinate 用 -w 绑定本进程，异常退出时不会留孤儿。
    keepAwake = new KeepAwakeService({ config: repos.config });
    await keepAwake.restore();
    // 分享链接接口始终挂载：访问防护关闭时 build() 会返回可操作的 409，
    // 界面据此提示用户开启局域网访问，而不是显示一个 404「接口不存在」。
    const shareLinks = new ShareLinkService({ host: config.host, port: config.port, secret: webAuth.secret ?? '', config: repos.config, env });
    app = await buildApp(runtime, { webRoot, webAuth, shareLinks, schedules, ...(assistant ? { assistant } : {}), ...(selfUpdate ? { selfUpdate } : {}), system: { keepAwake, ...(autostart ? { autostart } : {}) }, llm: { service: llm }, lark: { env, config: repos.config, agents: repos.agents, cardMappings: repos.channelMappings, runtime, agentTools, listeningDisabled: env.AGENTDOCK_DISABLE_LARK_LISTENER === 'true' }, larkAvatar });
    await app.listen(listenOptions(config));
    // 听到端口后再开始扫描：启动失败时不会先投递出去一半。
    schedules.start();
    assistant?.start();
    larkAvatar.start();
  } catch (error) {
    keepAwake?.close();
    const results = await Promise.allSettled([
      schedules?.stop() ?? Promise.resolve(),
      app?.close() ?? Promise.resolve(),
      assistant?.close() ?? Promise.resolve(),
      larkAvatar?.close() ?? Promise.resolve(),
      runtime.shutdown()
    ]);
    capabilities.close();
    repos.close();
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
      await larkAvatar?.close();
      await schedules?.stop();
      await assistant?.close();
      const results = await Promise.allSettled([app?.close() ?? Promise.resolve(), runtime.shutdown()]);
      capabilities.close();
      repos.close();
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'AgentDock did not shut down cleanly');
    }
  };
}
