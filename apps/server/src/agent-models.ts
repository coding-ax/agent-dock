import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAcpRuntime, createAgentRegistry, createRuntimeStore, type AcpRuntime, type AcpRuntimeEnsureInput, type AcpRuntimeHandle, type AcpRuntimeStatus } from 'acpx/runtime';
import type { AgentConfig } from '@agent-dock/agent-dock-shared';
import { buildAcpxSessionOptions } from '@agent-dock/agent-dock-acp-client';

const run = promisify(execFile);
const ACP_MODEL_PROBE_TIMEOUT_MS = 30_000;
export interface AgentModel { id: string; name: string }
export interface AgentModelsResult { models: AgentModel[]; defaultModel?: string; reasoningEfforts: AgentModel[]; defaultReasoningEffort?: string; source?: 'acp' | 'cli' | 'agent'; warning?: string }

export class AgentModelProbeTimeoutError extends Error {
  constructor(readonly phase: 'ensureSession' | 'getStatus' | 'close', readonly timeoutMs: number) {
    super(`Agent model probe ${phase} timed out after ${timeoutMs}ms`);
    this.name = 'AgentModelProbeTimeoutError';
  }
}

export function agentModelProbeWarning(error: unknown): string {
  if (error instanceof AgentModelProbeTimeoutError) return 'Agent 配置读取超时，暂时使用备用信息，可重新读取。';
  const detail = error && typeof error === 'object' && 'data' in error ? (error as { data: unknown }).data : undefined;
  if (typeof detail === 'string' && detail.includes('failed to load configuration')) {
    return 'Agent 配置加载失败，请检查配置格式与 CLI 版本是否兼容后重新读取。';
  }
  return '未能通过 ACP 读取 Agent 配置，暂时使用备用信息，可重新读取。';
}

export async function withAgentModelProbeTimeout<T>(phase: AgentModelProbeTimeoutError['phase'], timeoutMs: number, operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AgentModelProbeTimeoutError(phase, timeoutMs)), timeoutMs);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

const cliCommands: Record<string, { command: string; args: string[]; parse(output: string): AgentModel[] }> = {
  cursor: {
    command: 'cursor-agent', args: ['--list-models'],
    parse: output => output.split(/\r?\n/).flatMap(line => {
      const match = line.trim().match(/^(\S+)\s+-\s+(.+)$/);
      return match ? [{ id: match[1]!, name: match[2]!.replace(/\s+\(default\)$/, '') }] : [];
    })
  },
  trae: { command: 'traecli', args: ['models'], parse: parseModelIds },
  opencode: { command: 'opencode', args: ['models'], parse: parseModelIds },
  pi: {
    command: 'pi', args: ['--list-models'],
    parse: output => output.split(/\r?\n/).slice(1).flatMap(line => {
      const match = line.trim().match(/^(\S+)\s+(\S+)\s+/);
      return match ? [{ id: `${match[1]}/${match[2]}`, name: match[2]! }] : [];
    })
  }
};

function parseModelIds(output: string): AgentModel[] {
  return output.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/\s/.test(line) && !line.startsWith('[')).map(id => ({ id, name: id }));
}

export function modelsFromAcpStatus(status: AcpRuntimeStatus | undefined): AgentModelsResult | undefined {
  if (!status) return undefined;
  const configOptions = Array.isArray(status.details?.configOptions) ? status.details.configOptions as Array<Record<string, any>> : [];
  const modelOption = configOptions.find(option => option.id === 'model' || option.category === 'model');
  const reasoningOption = configOptions.find(option => option.category === 'thought_level' || option.id === 'reasoning_effort' || option.id === 'effort');
  const names = new Map<string, string>();
  for (const option of Array.isArray(modelOption?.options) ? modelOption.options : []) {
    // 同一 model id 可能带多个别名（如 "xxx[1M]" 与 "xxx"）。保留首个名称，
    // 后续同 id 项不得覆盖，否则列表里的名字会随探测顺序漂移。
    if (typeof option?.value === 'string' && !names.has(option.value)) {
      names.set(option.value, typeof option.name === 'string' ? option.name : option.value);
    }
  }
  const reasoningEfforts = (Array.isArray(reasoningOption?.options) ? reasoningOption.options : []).flatMap((option: any) => typeof option?.value === 'string' ? [{ id: option.value, name: typeof option.name === 'string' ? option.name : option.value }] : []);
  // availableModelIds 也可能重复上报同一 id；去重避免下拉出现两行完全同值的选项。
  const ids = [...new Set(status.models?.availableModelIds?.length ? status.models.availableModelIds : [...names.keys()])];
  if (!ids.length && !status.models?.currentModelId && !reasoningEfforts.length) return undefined;
  return {
    models: ids.map(id => ({ id, name: names.get(id) ?? id })),
    ...(status.models?.currentModelId ? { defaultModel: status.models.currentModelId } : {}),
    reasoningEfforts,
    ...(typeof reasoningOption?.currentValue === 'string' ? { defaultReasoningEffort: reasoningOption.currentValue } : {}),
    source: 'acp'
  };
}

export async function probeModelsThroughAcpRuntime(runtime: AcpRuntime, input: AcpRuntimeEnsureInput, timeoutMs = ACP_MODEL_PROBE_TIMEOUT_MS): Promise<AgentModelsResult | undefined> {
  let handle: AcpRuntimeHandle | undefined;
  let abandoned = false;
  const close = (target: AcpRuntimeHandle) => withAgentModelProbeTimeout('close', timeoutMs,
    runtime.close({ handle: target, reason: 'AgentDock model discovery', discardPersistentState: true })).catch(() => undefined);
  const pending = runtime.ensureSession(input);
  // A Promise timeout does not cancel its operation. A late successful ensure
  // must still close its child, even after the HTTP request has returned.
  void pending.then(result => { if (abandoned) return close(result); }, () => undefined);
  try {
    handle = await withAgentModelProbeTimeout('ensureSession', timeoutMs, pending);
    const status = runtime.getStatus
      ? await withAgentModelProbeTimeout('getStatus', timeoutMs, Promise.resolve(runtime.getStatus({ handle })))
      : undefined;
    return modelsFromAcpStatus(status);
  } finally {
    abandoned = true;
    if (handle) await close(handle);
  }
}

async function discoverThroughAcp(agent: AgentConfig, model?: string): Promise<AgentModelsResult | undefined> {
  const stateDir = await mkdtemp(join(tmpdir(), 'agentdock-models-'));
  const runtime = createAcpRuntime({
    cwd: agent.cwd ?? process.cwd(),
    sessionStore: createRuntimeStore({ stateDir }),
    agentRegistry: createAgentRegistry({ overrides: { [agent.id]: [agent.command, ...agent.args] } }),
    permissionMode: agent.permissionMode === 'full-trust' ? 'approve-all' : agent.permissionMode === 'deny-all' ? 'deny-all' : 'approve-reads',
    nonInteractivePermissions: 'fail',
    timeoutMs: Math.min(agent.timeout * 1000, ACP_MODEL_PROBE_TIMEOUT_MS)
  });
  try {
    return await probeModelsThroughAcpRuntime(runtime, { sessionKey: `agentdock-model-probe-${crypto.randomUUID()}`, agent: agent.id, mode: 'oneshot', cwd: agent.cwd ?? process.cwd(), sessionOptions: buildAcpxSessionOptions({ ...agent, model: model ?? agent.model }) });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function discoverThroughCli(agentId: string): Promise<AgentModel[]> {
  const definition = cliCommands[agentId];
  if (!definition) return [];
  const { stdout } = await run(definition.command, definition.args, { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  return definition.parse(stdout);
}

export function agentModelsCacheKey(agent: AgentConfig, model?: string): string {
  // Environment values may contain secrets; keep only their digest in cache keys.
  return createHash('sha256').update(JSON.stringify({
    id: agent.id, command: agent.command, args: agent.args, version: agent.version,
    cwd: agent.cwd ?? process.cwd(), env: Object.entries(agent.env).sort(([a], [b]) => a.localeCompare(b)),
    configuredModel: agent.model, extraModels: agent.extraModels ?? [], model, permissionMode: agent.permissionMode, timeout: agent.timeout
  })).digest('hex');
}

const cache = new Map<string, { expiresAt: number; value: AgentModelsResult }>();
export async function discoverAgentModels(agent: AgentConfig, model?: string, forceRefresh = false): Promise<AgentModelsResult> {
  const cacheKey = agentModelsCacheKey(agent, model);
  const cached = cache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value;

  let value: AgentModelsResult | undefined;
  let warning: string | undefined;
  try { value = await discoverThroughAcp(agent, model); }
  catch (error) {
    warning = agentModelProbeWarning(error);
  }
  if (!value?.models.length) {
    try {
      const models = await discoverThroughCli(agent.id);
      if (models.length) value = { models, ...(agent.model ? { defaultModel: agent.model } : {}), reasoningEfforts: value?.reasoningEfforts ?? [], ...(value?.defaultReasoningEffort ? { defaultReasoningEffort: value.defaultReasoningEffort } : {}), source: 'cli' };
    } catch { /* Fall through to the Agent's configured default. */ }
  }
  value ??= { models: [], ...(agent.model ? { defaultModel: agent.model } : {}), reasoningEfforts: [], source: 'agent' };
  // Merge user-supplied extra models (e.g. reverse-proxied models not advertised
  // by the provider's /models endpoint). Existing IDs take precedence to keep
  // their display names; extra models fall back to using the ID as the name.
  if (agent.extraModels?.length) {
    const seen = new Set(value.models.map(m => m.id));
    const extras = agent.extraModels
      .filter(id => id && !seen.has(id))
      .map(id => ({ id, name: id }));
    if (extras.length) value = { ...value, models: [...value.models, ...extras] };
  }
  if (warning) value = { ...value, warning };
  cache.set(cacheKey, { expiresAt: Date.now() + (value.source === 'acp' && !warning ? 5 * 60_000 : 15_000), value });
  return value;
}
