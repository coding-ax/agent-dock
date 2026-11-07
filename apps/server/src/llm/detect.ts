/**
 * 从本机已有的 Agent 配置里猜一个可用的模型端点。
 *
 * 只做「发现」，不自动启用：候选端点会带着来源显示在模型端点面板里，用户点一下才写入。
 * 探测到的密钥全程留在服务端——GET 只回 keySet，应用候选时才由服务端自己读出来保存。
 *
 * 支持：
 * - Claude Code：~/.claude/settings.json 的 env 块，以及进程环境变量里的 ANTHROPIC_*；
 * - Codex：~/.codex/config.toml 的 model_provider 及其 model_providers.* 配置；
 * - OpenAI：进程环境变量里的 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeBaseUrl, type LlmAuthType, type LlmFormat } from './types.js';

export interface DetectedLlmEndpoint {
  /** 稳定 id：重新检测后同一条候选仍然可被应用。 */
  id: string;
  source: 'claude-code' | 'codex' | 'openai';
  label: string;
  format: LlmFormat;
  baseUrl: string;
  model: string;
  auth?: LlmAuthType;
  /** 只在服务端内存里流转，绝不进入 HTTP 响应。 */
  apiKey: string;
}

export type PublicDetectedLlmEndpoint = Omit<DetectedLlmEndpoint, 'apiKey'> & { keySet: true };

export interface DetectLlmOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const stringValue = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

async function readText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch { return undefined; }
}

/**
 * Claude Code 的模型可能只出现在这几个变量里。顺序按「用户显式选的」到「默认档位」，
 * 避免猜到一个更小/更快的模型。settings.json 顶层的 model 可能是 sonnet 这类别名，
 * 放在最后兜底。
 */
function anthropicCandidate(env: Record<string, unknown>, fallbackModel: unknown, id: string, label: string): DetectedLlmEndpoint | undefined {
  const authToken = stringValue(env.ANTHROPIC_AUTH_TOKEN);
  const apiKey = stringValue(env.ANTHROPIC_API_KEY);
  const key = authToken ?? apiKey;
  if (!key) return undefined;
  const model = stringValue(env.ANTHROPIC_MODEL)
    ?? stringValue(env.ANTHROPIC_DEFAULT_SONNET_MODEL)
    ?? stringValue(env.ANTHROPIC_DEFAULT_OPUS_MODEL)
    ?? stringValue(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
    ?? stringValue(env.ANTHROPIC_SMALL_FAST_MODEL)
    ?? stringValue(fallbackModel);
  if (!model) return undefined;
  const baseUrl = normalizeBaseUrl(stringValue(env.ANTHROPIC_BASE_URL) ?? 'https://api.anthropic.com');
  if (!baseUrl) return undefined;
  return {
    id, source: 'claude-code', label, format: 'anthropic-messages', baseUrl, model,
    // ANTHROPIC_AUTH_TOKEN 是 Claude Code 走代理时的 Bearer 凭证；API_KEY 才是原生 x-api-key。
    ...(authToken ? { auth: 'bearer' as const } : {}),
    apiKey: key
  };
}

function openAiCandidate(env: NodeJS.ProcessEnv): DetectedLlmEndpoint | undefined {
  const key = stringValue(env.OPENAI_API_KEY);
  const model = stringValue(env.OPENAI_MODEL) ?? stringValue(env.OPENAI_DEFAULT_MODEL);
  if (!key || !model) return undefined;
  const baseUrl = normalizeBaseUrl(stringValue(env.OPENAI_BASE_URL) ?? stringValue(env.OPENAI_API_BASE) ?? 'https://api.openai.com');
  if (!baseUrl) return undefined;
  return { id: 'openai:env', source: 'openai', label: 'OpenAI（环境变量）', format: 'openai-chat', baseUrl, model, apiKey: key };
}

/** 只认最小的 TOML 子集：表头 + 字符串/布尔/数字键值。Codex 配置就长这样。 */
function stripTomlComment(line: string) {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\' && quote === '"') { index += 1; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === '\'') { quote = char; continue; }
    if (char === '#') return line.slice(0, index);
  }
  return line;
}

function tomlValue(raw: string): string | undefined {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try { const parsed: unknown = JSON.parse(value); return typeof parsed === 'string' ? parsed : undefined; } catch { return undefined; }
  }
  if (value.startsWith('\'') && value.endsWith('\'')) return value.slice(1, -1);
  if (/^(true|false|\d+(?:\.\d+)?)$/.test(value)) return value;
  return undefined;
}

function parseToml(text: string) {
  const root: Record<string, string> = {};
  const providers: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | undefined = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      const name = section[1]!.trim();
      const provider = name.match(/^model_providers\.(.+)$/);
      if (provider) {
        const providerId = provider[1]!.trim();
        current = providers[providerId] ??= {};
      } else {
        current = undefined;
      }
      continue;
    }
    const entry = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!entry || !current) continue;
    const value = tomlValue(entry[2]!);
    if (value !== undefined) current[entry[1]!] = value;
  }
  return { root, providers };
}

function codexCandidate(configText: string, env: NodeJS.ProcessEnv): DetectedLlmEndpoint | undefined {
  const { root, providers } = parseToml(configText);
  const providerId = root.model_provider ?? Object.keys(providers)[0];
  if (!providerId) return undefined;
  const provider = providers[providerId];
  if (!provider) return undefined;
  const baseUrl = normalizeBaseUrl(provider.base_url ?? '');
  const model = root.model ?? provider.model;
  if (!baseUrl || !model) return undefined;
  const envKey = provider.env_key;
  const key = (envKey ? stringValue(env[envKey]) : undefined) ?? stringValue(provider.experimental_bearer_token) ?? stringValue(env.OPENAI_API_KEY);
  if (!key) return undefined;
  return {
    id: 'codex:config',
    source: 'codex',
    label: `Codex（${provider.name ?? providerId}）`,
    format: provider.wire_api === 'chat' ? 'openai-chat' : 'openai-responses',
    baseUrl,
    model,
    apiKey: key
  };
}

export async function detectLlmEndpoints(options: DetectLlmOptions = {}): Promise<DetectedLlmEndpoint[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const candidates: DetectedLlmEndpoint[] = [];

  const settings = await readJson(join(home, '.claude', 'settings.json'));
  const settingsEnv = settings?.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
    ? settings.env as Record<string, unknown>
    : {};
  const fromSettings = anthropicCandidate(settingsEnv, settings?.model, 'claude-code:settings', 'Claude Code（settings.json）');
  if (fromSettings) candidates.push(fromSettings);
  const fromEnv = anthropicCandidate(env as Record<string, unknown>, undefined, 'claude-code:env', 'Claude Code（环境变量）');
  if (fromEnv) candidates.push(fromEnv);

  const openai = openAiCandidate(env);
  if (openai) candidates.push(openai);

  const codexConfig = await readText(join(home, '.codex', 'config.toml'));
  if (codexConfig) {
    const codex = codexCandidate(codexConfig, env);
    if (codex) candidates.push(codex);
  }

  // 同一个网关经常同时被 settings.json 和环境变量指向；保留先发现的（更具体的来源）。
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const identity = `${candidate.format}\0${candidate.baseUrl}\0${candidate.model}\0${candidate.apiKey}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/** 响应投影：逐字段列出，密钥永远不出现。 */
export const publicDetectedLlmEndpoint = (endpoint: DetectedLlmEndpoint): PublicDetectedLlmEndpoint => ({
  id: endpoint.id,
  source: endpoint.source,
  label: endpoint.label,
  format: endpoint.format,
  baseUrl: endpoint.baseUrl,
  model: endpoint.model,
  ...(endpoint.auth ? { auth: endpoint.auth } : {}),
  keySet: true
});
