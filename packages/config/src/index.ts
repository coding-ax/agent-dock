import { agentConfigSchema, type AgentConfig } from '@agent-dock/agent-dock-shared';
import { listAcpxBuiltinAgents } from '@agent-dock/agent-dock-acp-client';
import { commandExists } from '@agent-dock/agent-dock-transports';
import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const ACXP_VERSION = '0.20.0';

export const appConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().positive().default(4310),
  databaseUrl: z.string().default('./.agentdock/agentdock.db'),
  acpxCommand: z.string().default('acpx'),
  driverIdleTimeoutMs: z.number().nonnegative().default(6 * 60 * 60_000),
  cleanupIntervalMs: z.number().positive().default(5 * 60_000),
  /** agentdock 自身的根目录。内置 Agent 的默认 cwd、数据库路径、平台借 Agent 跑任务时的默认工作目录都落在这里。 */
  defaultCwd: z.string().default(process.cwd()),
  agents: z.array(agentConfigSchema).default([])
});
export type AppConfig = z.infer<typeof appConfigSchema>;

const agentDetails: Record<string, { name: string; cli: string }> = {
  pi: { name: 'Pi', cli: 'pi' }, openclaw: { name: 'OpenClaw', cli: 'openclaw' }, codex: { name: 'Codex', cli: 'codex' }, claude: { name: 'Claude Code', cli: 'claude' },
  gemini: { name: 'Gemini', cli: 'gemini' }, cursor: { name: 'Cursor Agent', cli: 'cursor-agent' }, copilot: { name: 'GitHub Copilot', cli: 'copilot' }, droid: { name: 'Factory Droid', cli: 'droid' },
  'fast-agent': { name: 'fast-agent', cli: 'fast-agent-mcp' }, 'grok-build': { name: 'Grok Build', cli: 'grok' }, iflow: { name: 'iFlow', cli: 'iflow' }, kilocode: { name: 'Kilocode', cli: 'kilocode' },
  kimi: { name: 'Kimi', cli: 'kimi' }, kiro: { name: 'Kiro', cli: 'kiro-cli-chat' }, mcode: { name: 'MiniMax Code', cli: 'mcode' }, mux: { name: 'Mux', cli: 'mux' }, opencode: { name: 'OpenCode', cli: 'opencode' },
  pool: { name: 'Poolside', cli: 'pool' }, qoder: { name: 'Qoder', cli: 'qodercli' }, qwen: { name: 'Qwen Code', cli: 'qwen' }, trae: { name: 'Trae', cli: 'traecli' }, zeroclaw: { name: 'ZeroClaw', cli: 'zeroclaw' }
};

export function cliVersion(command: string, prefixArgs: string[] = []): string | undefined {
  for (const args of [['--version'], ['-V'], ['version']]) {
    const result = spawnSync(command, [...prefixArgs, ...args], { encoding: 'utf8', timeout: 1500, env: { ...process.env, NO_COLOR: '1' } });
    const line = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split(/\r?\n/).map(value => value.trim()).find(Boolean);
    if (result.status === 0 && line) return line.slice(0, 100);
  }
  return undefined;
}

let scannedBuiltinAgents: Array<Omit<AgentConfig, 'cwd'>> | undefined;
const scanBuiltinAgents = () => scannedBuiltinAgents ??= listAcpxBuiltinAgents().flatMap(({ id, argv }) => {
  const detail = agentDetails[id];
  if (!detail || !commandExists(detail.cli)) return [];
  return [{ id, name: detail.name, command: argv[0]!, args: argv.slice(1), protocol: 'acp' as const, env: {}, permissionMode: 'full-trust' as const, timeout: 600, capabilities: { pause: false, resume: true }, builtin: true, version: id === 'codex' ? cliVersion(argv[0]!, argv.slice(1)) : cliVersion(detail.cli) }];
});
export const builtinAgents = (cwd = process.cwd()): AgentConfig[] => scanBuiltinAgents().map(agent => ({ ...agent, cwd }));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const extra = env.AGENTDOCK_AGENTS_JSON ? JSON.parse(env.AGENTDOCK_AGENTS_JSON) : [];
  // 相对路径在这里就解析成绝对路径：这个值现在会通过 /api/platform-ai 回到前端当「工作目录」展示，
  // 也会被直接塞给 spawn 出来的 agent 进程，留一个相对的 cwd 只会让两边都对不上。
  const defaultCwd = resolve(env.AGENTDOCK_DEFAULT_CWD ?? process.cwd());
  const agents = new Map(builtinAgents(defaultCwd).map(agent => [agent.id, agent]));
  for (const agent of extra) {
    const configured = agentConfigSchema.parse(agent);
    if (commandExists(configured.command)) agents.set(configured.id, { ...configured, cwd: configured.cwd ?? defaultCwd, version: configured.version ?? cliVersion(configured.command) });
  }
  return appConfigSchema.parse({
    host: env.AGENTDOCK_LOCAL_ONLY === 'true' ? '127.0.0.1' : env.AGENTDOCK_HOST,
    port: env.AGENTDOCK_PORT ? Number(env.AGENTDOCK_PORT) : undefined,
    databaseUrl: resolve(defaultCwd, env.AGENTDOCK_DATABASE_URL ?? './.agentdock/agentdock.db'),
    acpxCommand: env.AGENTDOCK_ACPX_COMMAND,
    driverIdleTimeoutMs: env.AGENTDOCK_DRIVER_IDLE_TIMEOUT_MS ? Number(env.AGENTDOCK_DRIVER_IDLE_TIMEOUT_MS) : undefined,
    cleanupIntervalMs: env.AGENTDOCK_CLEANUP_INTERVAL_MS ? Number(env.AGENTDOCK_CLEANUP_INTERVAL_MS) : undefined,
    defaultCwd,
    agents: [...agents.values()]
  });
}
