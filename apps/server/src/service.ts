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
import { buildInitialSystemPrompt } from './initial-system-prompt.js';
import { ScheduleService } from './schedules/service.js';
import { defaultSessionTokenTtlMs, initWebAccess, issueMasterToken, loadOrCreateWebAccessSecret } from './web-access.js';

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
  const runtime = new AgentDockRuntime(repos, {
    acpxCommand: config.acpxCommand,
    driverIdleTimeoutMs: config.driverIdleTimeoutMs,
    cleanupIntervalMs: config.cleanupIntervalMs,
    // agentdock_database：告诉 Agent 自己跑在哪个 daemon 上，CLI 的自杀保护靠它区分「重启自己」和「操作沙箱」。
    sessionEnvironment: session => ({ agentdock_database: config.databaseUrl, ...capabilities.environmentFor(session) }),
    createSystemPrompt: buildInitialSystemPrompt,
    sessionPrompt: (session, prompt) => agentTools.promptForSession(session, prompt)
  });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let schedules: ScheduleService | undefined;
  let closed = false;
  let webAuth: { enabled: boolean; secret?: string } = { enabled: false };
  try {
    await runtime.initialize(config.agents);
    // 本地 Web 访问防护默认开启（AGENTDOCK_WEB_AUTH=off 可关）：secret 持久化，重启不换。
    const webAuthEnabled = !['off', '0', 'false'].includes((env.AGENTDOCK_WEB_AUTH ?? '').trim().toLowerCase());
    if (webAuthEnabled) {
      const secret = await loadOrCreateWebAccessSecret(repos.config);
      const ttlDays = Number(env.AGENTDOCK_WEB_TOKEN_TTL_DAYS);
      const sessionTokenTtlMs = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 24 * 60 * 60_000 : defaultSessionTokenTtlMs;
      initWebAccess(secret, sessionTokenTtlMs);
      webAuth = { enabled: true, secret };
    }
    const webRoot = options.webRoot ?? fileURLToPath(new URL('../public', import.meta.url));
    const llm = new LlmEndpointService({ config: repos.config });
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
    const selfUpdate = options.cliEntrypoint ? new SelfUpdateService({ currentVersion: packageJson.version, packageName: packageJson.name, cliEntrypoint: options.cliEntrypoint, env }) : undefined;
    schedules = new ScheduleService(repos.schedules, repos.sessions, runtime);
    app = await buildApp(runtime, { webRoot, webAuth, schedules, ...(selfUpdate ? { selfUpdate } : {}), llm: { service: llm }, lark: { env, config: repos.config, agents: repos.agents, cardMappings: repos.channelMappings, runtime, agentTools, listeningDisabled: env.AGENTDOCK_DISABLE_LARK_LISTENER === 'true' } });
    await app.listen(listenOptions(config));
    // 听到端口后再开始扫描：启动失败时不会先投递出去一半。
    schedules.start();
  } catch (error) {
    await schedules?.stop(); capabilities.close(); await runtime.shutdown(); repos.close(); throw error;
  }
  return {
    config,
    runtime,
    webAccess: webAuth.enabled && webAuth.secret ? { enabled: true, adminToken: issueMasterToken(webAuth.secret) } : { enabled: false },
    async close() {
      if (closed) return;
      closed = true;
      // 先停调度（等当前一轮扫完），再关 runtime：避免关到一半时还在往里投递。
      await schedules?.stop();
      const results = await Promise.allSettled([app?.close() ?? Promise.resolve(), runtime.shutdown()]);
      capabilities.close();
      repos.close();
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'AgentDock did not shut down cleanly');
    }
  };
}
