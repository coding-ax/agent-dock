import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  percent,
  resetSeconds,
  unavailableUsage,
  type AgentUsage,
  type AgentUsageWindow,
  type UsageAccountSummary,
  type UsageAlternateSource,
  type UsageBalance,
  type UsageGatewayStats,
  type UsageMatchedBy,
  type UsageSourceKind,
  type UsageSourceMeta,
  type UsageWindowStatus
} from './agent-usage.js';
import { parseCodexToml } from './llm/detect.js';
import { getCodexUsage } from './codex-usage.js';
import { getClaudeUsage } from './claude-usage.js';
import { getCursorUsage } from './cursor-usage.js';
import { getAntigravityUsage } from './antigravity-usage.js';

export const MAGPIE_CACHE_TTL_MS = 5 * 60_000;
export const MAGPIE_NEGATIVE_TTL_MS = 30_000;
export const MAGPIE_REFRESH_COOLDOWN_MS = 10_000;

const PROBE_TIMEOUT_MS = 1_500;
const QUOTAS_TIMEOUT_MS = 8_000;
const METADATA_TIMEOUT_MS = 4_000;
const ROUTE_TIMEOUT_MS = 1_500;

export type UsageSourcePreference = 'auto' | 'magpie' | 'official';
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AgentRoutingInfo {
  agentId: string;
  /** 指向网关的归一化 origin（仅 scheme://host[:port]，绝不含凭据）。 */
  origin?: string;
  /** 仅驻留服务端内存用于 401/403 自动鉴权重试，严禁落盘、打日志或下发前端。 */
  authToken?: string;
  /** 配置里是否显式出现 Magpie 线索（如 model_provider="magpie"、magpie/ 前缀或命中 gateway.json 地址）。 */
  explicitMagpie: boolean;
  /** 从 Agent 本地配置解析出的默认模型（含 Claude 别名映射）。 */
  configuredModel?: string;
  /** 本地 ~/.config/magpie/gateway.json 记录的监听 origin。 */
  knownGatewayOrigin?: string;
}

type MagpieRootResponse = {
  name?: unknown;
  version?: unknown;
  apis?: unknown;
};

type MagpieQuotaWindowRaw = {
  name?: unknown;
  used?: unknown;
  remaining?: unknown;
  resetsAt?: unknown;
  display?: unknown;
  amount?: unknown;
  limit?: unknown;
  unit?: unknown;
  runsOutAt?: unknown;
  runsOut?: unknown;
  pool?: unknown;
  text?: unknown;
  holds?: unknown;
  holdsWhy?: unknown;
};

type MagpieQuotaEntryRaw = {
  provider?: unknown;
  name?: unknown;
  kind?: unknown;
  plan?: unknown;
  user?: unknown;
  alias?: unknown;
  until?: unknown;
  balance?: unknown;
  readAt?: unknown;
  last?: unknown;
  lastServedAt?: unknown;
  windows?: unknown;
};

type MagpieAccountRaw = {
  provider?: unknown;
  providerName?: unknown;
  id?: unknown;
  pin?: unknown;
  kind?: unknown;
  label?: unknown;
  user?: unknown;
  plan?: unknown;
  on?: unknown;
};

type MagpieModelRaw = {
  id?: unknown;
  owned_by?: unknown;
  display_name?: unknown;
};

type MagpieUsageAccountRaw = {
  provider?: unknown;
  account?: unknown;
  name?: unknown;
  calls?: unknown;
  errors?: unknown;
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  cost?: unknown;
  credits?: unknown;
};

type MagpieUsageModelRaw = {
  provider?: unknown;
  model?: unknown;
  host?: unknown;
  calls?: unknown;
  errors?: unknown;
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  cost?: unknown;
  credits?: unknown;
};

type MagpieUsageTodayRaw = {
  period?: unknown;
  models?: unknown;
  accounts?: unknown;
};

type MagpieRouteTryRaw = {
  model?: unknown;
  status?: unknown;
  ms?: unknown;
};

type MagpieRouteResponseRaw = {
  route?: {
    asked?: unknown;
    model?: unknown;
    served?: unknown;
    status?: unknown;
    tries?: unknown;
  } | null;
};

type ProbeCacheEntry = {
  checkedAt: number;
  isMagpie: boolean;
  authRequired: boolean;
  unreachable: boolean;
  version?: string;
};

type SnapshotCacheEntry = {
  fetchedAt: number;
  ok: boolean;
  authRequired: boolean;
  unreachable: boolean;
  version?: string;
  quotas: MagpieQuotaEntryRaw[];
  accounts: MagpieAccountRaw[];
  models: MagpieModelRaw[];
  usageToday?: MagpieUsageTodayRaw;
};

const probeCache = new Map<string, ProbeCacheEntry>();
const snapshotCache = new Map<string, SnapshotCacheEntry>();
const snapshotInFlight = new Map<string, Promise<SnapshotCacheEntry>>();

/** 测试辅助：清空模块级 Magpie 指纹与快照缓存。 */
export function resetMagpieUsageCacheForTests(): void {
  probeCache.clear();
  snapshotCache.clear();
  snapshotInFlight.clear();
}

const OFFICIAL_PROVIDERS: Record<string, { label: string; fetch: (refresh: boolean) => Promise<AgentUsage> }> = {
  codex: { label: 'Codex CLI', fetch: getCodexUsage },
  claude: { label: 'Claude statusline', fetch: getClaudeUsage },
  cursor: { label: 'cursor.com', fetch: getCursorUsage },
  antigravity: { label: 'Antigravity CLI', fetch: getAntigravityUsage }
};

const SECRET_PREFIX_RE = /^(?:sk-|rk-|pk-|eyJ|Bearer\s|Basic\s|ghp_|gho_|xox[a-z]-|AKIA|AIza|magpie_|mp_)/i;
const EMAIL_RE = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SECRET_RE = /^[0-9a-f]{24,}$/i;

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 仅提取安全 origin（http/https），剥离用户凭证、路径与查询参数。 */
export function safeOrigin(rawUrl?: string): string | undefined {
  const trimmed = stringValue(rawUrl);
  if (!trimmed) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/**
 * 将账号名称或邮箱脱敏为可辨识短名；优先使用用户显式设置的非敏感 alias，
 * 严禁输出完整个人邮箱、API Key、Token 或长随机密钥。
 */
export function maskAccountLabel(rawUser?: string, rawAlias?: string): string {
  const cleanAlias = stringValue(rawAlias);
  if (cleanAlias && !EMAIL_RE.test(cleanAlias) && !SECRET_PREFIX_RE.test(cleanAlias) && !HEX_SECRET_RE.test(cleanAlias)) {
    return cleanAlias.slice(0, 32);
  }
  const raw = stringValue(rawUser);
  if (!raw) return '默认账号';
  if (SECRET_PREFIX_RE.test(raw) || HEX_SECRET_RE.test(raw)) return '密钥账号';
  const email = raw.match(EMAIL_RE);
  if (email) {
    const local = email[1]!;
    const domain = email[2]!;
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (UUID_RE.test(raw)) {
    return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
  }
  // 去掉诸如 "xxx · Chrome 登录" 的登录方式尾缀再脱敏
  const stripped = raw.split(/\s+·\s+/)[0]?.trim() || raw;
  const chars = [...stripped];
  if (chars.length <= 1) return `${chars[0] ?? '账'}*`;
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}***${chars[chars.length - 1]}`;
}

/** 归一化模型字符串：去掉尾部 `[1m]`/`[200k]` 等上下文标记以及 `magpie/` 前缀。 */
export function normalizeModelRef(model?: string): { raw?: string; normalized?: string; hasMagpiePrefix: boolean; providerId?: string; bareModel?: string } {
  const raw = stringValue(model);
  if (!raw) return { hasMagpiePrefix: false };
  const withoutBracket = raw.replace(/\[[^\]]+\]\s*$/, '').trim();
  const hasMagpiePrefix = /^magpie\//i.test(withoutBracket);
  const normalized = hasMagpiePrefix ? withoutBracket.replace(/^magpie\//i, '').trim() : withoutBracket;
  const slash = normalized.indexOf('/');
  if (slash > 0 && slash < normalized.length - 1) {
    return {
      raw,
      normalized,
      hasMagpiePrefix,
      providerId: normalized.slice(0, slash).trim().toLowerCase(),
      bareModel: normalized.slice(slash + 1).trim()
    };
  }
  return { raw, normalized, hasMagpiePrefix, bareModel: normalized };
}

function resolveCandidateHomes(explicitHome?: string): string[] {
  if (explicitHome) return [explicitHome];
  const homes = [homedir()];
  // 在隔离沙箱（HOME 被替换）下，允许只读回落到系统真实 HOME 查找本机 Agent / Magpie 配置，
  // 行为与 antigravity-usage.ts 保持一致；普通测试会显式传入 options.home，不受影响。
  if (process.env.AGENTDOCK_DEV_SANDBOX === 'true') {
    try {
      const real = userInfo().homedir?.trim();
      if (real && !homes.includes(real)) homes.push(real);
    } catch { /* ignore */ }
  }
  return homes;
}

async function readTextFromHomes(homes: string[], relativeParts: string[]): Promise<string | undefined> {
  for (const home of homes) {
    try {
      return await readFile(join(home, ...relativeParts), 'utf8');
    } catch {
      continue;
    }
  }
  return undefined;
}

async function readJsonFromHomes<T = Record<string, unknown>>(homes: string[], relativeParts: string[]): Promise<T | undefined> {
  const text = await readTextFromHomes(homes, relativeParts);
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as T : undefined;
  } catch {
    return undefined;
  }
}

async function readTextDirect(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function readJsonDirect<T = Record<string, unknown>>(filePath: string): Promise<T | undefined> {
  const text = await readTextDirect(filePath);
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as T : undefined;
  } catch {
    return undefined;
  }
}

function resolveClaudeSlotModel(
  envMap: Record<string, unknown>,
  fallbackModel: unknown,
  sessionModel?: string
): string | undefined {
  const norm = normalizeModelRef(sessionModel);
  const alias = (!norm.providerId ? norm.bareModel?.toLowerCase() : undefined);
  if (alias === 'sonnet') {
    return stringValue(envMap.ANTHROPIC_DEFAULT_SONNET_MODEL) ?? stringValue(envMap.ANTHROPIC_MODEL);
  }
  if (alias === 'opus') {
    return stringValue(envMap.ANTHROPIC_DEFAULT_OPUS_MODEL) ?? stringValue(envMap.ANTHROPIC_MODEL);
  }
  if (alias === 'haiku') {
    return stringValue(envMap.ANTHROPIC_DEFAULT_HAIKU_MODEL)
      ?? stringValue(envMap.ANTHROPIC_SMALL_FAST_MODEL)
      ?? stringValue(envMap.ANTHROPIC_MODEL);
  }
  return stringValue(envMap.ANTHROPIC_MODEL)
    ?? stringValue(envMap.ANTHROPIC_DEFAULT_SONNET_MODEL)
    ?? stringValue(envMap.ANTHROPIC_DEFAULT_OPUS_MODEL)
    ?? stringValue(envMap.ANTHROPIC_DEFAULT_HAIKU_MODEL)
    ?? stringValue(envMap.ANTHROPIC_SMALL_FAST_MODEL)
    ?? stringValue(fallbackModel);
}

/**
 * Layer 1：解析某个 Agent 的有效网关与模型配置。
 * 优先级：agent.env > 本机 Agent 配置文件 > 进程环境变量。
 * 严禁在未配置代理 URL 时误判直连官方的 Agent（如 Antigravity / Cursor）。
 */
export async function inspectAgentRouting(options: {
  agentId: string;
  agentEnv?: Record<string, string>;
  sessionModel?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AgentRoutingInfo> {
  const agentId = options.agentId.trim().toLowerCase();
  const agentEnv = options.agentEnv ?? {};
  const procEnv = options.env ?? process.env;
  const homes = resolveCandidateHomes(options.home);

  const gatewayJson = await readJsonFromHomes<{ addr?: unknown }>(homes, ['.config', 'magpie', 'gateway.json']);
  const knownGatewayOrigin = safeOrigin(stringValue(gatewayJson?.addr) ?? stringValue(procEnv.MAGPIE_ADDR));

  if (agentId === 'claude') {
    const customConfigDir = stringValue(agentEnv.CLAUDE_CONFIG_DIR) ?? stringValue(procEnv.CLAUDE_CONFIG_DIR);
    const settings = customConfigDir
      ? await readJsonDirect<Record<string, unknown>>(join(customConfigDir, 'settings.json'))
      : await readJsonFromHomes<Record<string, unknown>>(homes, ['.claude', 'settings.json']);
    const settingsEnv = settings?.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
      ? settings.env as Record<string, unknown>
      : {};
    const mergedEnv: Record<string, unknown> = { ...procEnv, ...settingsEnv, ...agentEnv };
    const origin = safeOrigin(stringValue(mergedEnv.ANTHROPIC_BASE_URL));
    const authToken = stringValue(mergedEnv.ANTHROPIC_AUTH_TOKEN) ?? stringValue(mergedEnv.ANTHROPIC_API_KEY);
    const configuredModel = resolveClaudeSlotModel(mergedEnv, settings?.model, options.sessionModel);
    const explicitMagpie = Boolean(
      (origin && knownGatewayOrigin && origin === knownGatewayOrigin)
      || normalizeModelRef(options.sessionModel).hasMagpiePrefix
      || normalizeModelRef(configuredModel).hasMagpiePrefix
    );
    return { agentId, origin, authToken, explicitMagpie, configuredModel, knownGatewayOrigin };
  }

  if (agentId === 'codex') {
    const customCodexHome = stringValue(agentEnv.CODEX_HOME) ?? stringValue(procEnv.CODEX_HOME);
    const tomlText = customCodexHome
      ? await readTextDirect(join(customCodexHome, 'config.toml'))
      : await readTextFromHomes(homes, ['.codex', 'config.toml']);
    const parsed = tomlText ? parseCodexToml(tomlText) : { root: {}, providers: {} };
    const providerId = stringValue(parsed.root.model_provider);
    const provider = providerId ? parsed.providers[providerId] : undefined;
    const rawBaseUrl = stringValue(agentEnv.OPENAI_BASE_URL)
      ?? stringValue(provider?.base_url)
      ?? stringValue(parsed.root.openai_base_url);
    const origin = safeOrigin(rawBaseUrl);
    const envKey = stringValue(provider?.env_key);
    const authToken = (envKey ? (stringValue(agentEnv[envKey]) ?? stringValue(procEnv[envKey])) : undefined)
      ?? stringValue(provider?.experimental_bearer_token)
      ?? stringValue(agentEnv.OPENAI_API_KEY)
      ?? stringValue(procEnv.OPENAI_API_KEY);
    const configuredModel = stringValue(parsed.root.model) ?? stringValue(provider?.model);
    const explicitMagpie = Boolean(
      providerId?.toLowerCase() === 'magpie'
      || stringValue(provider?.name)?.toLowerCase() === 'magpie'
      || stringValue(parsed.root.model_catalog_json)?.toLowerCase().includes('magpie')
      || stringValue(provider?.http_headers)?.toLowerCase().includes('magpie')
      || (origin && knownGatewayOrigin && origin === knownGatewayOrigin)
    );
    return { agentId, origin, authToken, explicitMagpie, configuredModel, knownGatewayOrigin };
  }

  if (agentId === 'omp') {
    const yml = await readTextFromHomes(homes, ['.omp', 'agent', 'config.yml']);
    const match = yml?.match(/^\s*default\s*:\s*["']?([^\s"'#]+)["']?/m);
    const configuredModel = stringValue(match?.[1]);
    const sessionRef = normalizeModelRef(options.sessionModel);
    const configRef = normalizeModelRef(configuredModel);
    const explicitMagpie = sessionRef.hasMagpiePrefix || configRef.hasMagpiePrefix;
    const origin = safeOrigin(stringValue(agentEnv.OPENAI_BASE_URL) ?? stringValue(agentEnv.ANTHROPIC_BASE_URL))
      ?? (explicitMagpie ? knownGatewayOrigin : undefined);
    return { agentId, origin, explicitMagpie, configuredModel, knownGatewayOrigin };
  }

  if (agentId === 'opencode') {
    const cfg = await readJsonFromHomes<Record<string, unknown>>(homes, ['.config', 'opencode', 'opencode.json'])
      ?? await readJsonFromHomes<Record<string, unknown>>(homes, ['.config', 'opencode', 'config.json']);
    const providers = cfg?.provider && typeof cfg.provider === 'object' && !Array.isArray(cfg.provider)
      ? cfg.provider as Record<string, Record<string, unknown>>
      : {};
    const magpieProv = providers.magpie;
    let origin = safeOrigin(
      stringValue((magpieProv?.options as Record<string, unknown> | undefined)?.baseURL)
      ?? stringValue(magpieProv?.baseURL)
      ?? stringValue(agentEnv.OPENAI_BASE_URL)
      ?? stringValue(agentEnv.ANTHROPIC_BASE_URL)
    );
    let authToken = stringValue((magpieProv?.options as Record<string, unknown> | undefined)?.apiKey)
      ?? stringValue(magpieProv?.apiKey);
    if (!origin) {
      for (const entry of Object.values(providers)) {
        const opts = entry?.options as Record<string, unknown> | undefined;
        const candidate = safeOrigin(stringValue(opts?.baseURL) ?? stringValue(entry?.baseURL));
        if (candidate && knownGatewayOrigin && candidate === knownGatewayOrigin) {
          origin = candidate;
          authToken = stringValue(opts?.apiKey) ?? stringValue(entry?.apiKey);
          break;
        }
      }
    }
    const configuredModel = stringValue(cfg?.model);
    const explicitMagpie = Boolean(
      magpieProv
      || normalizeModelRef(options.sessionModel).hasMagpiePrefix
      || normalizeModelRef(configuredModel).hasMagpiePrefix
      || (origin && knownGatewayOrigin && origin === knownGatewayOrigin)
    );
    return { agentId, origin, authToken, explicitMagpie, configuredModel, knownGatewayOrigin };
  }

  // 其他 Agent（含 Antigravity / Cursor / Gemini / 自定义）：仅当显式在 agentEnv 配了代理 URL
  // 或会话模型显式带 magpie/ 前缀时才进入探测，绝不对直连官方的 Agent 产生误判。
  const explicitOrigin = safeOrigin(
    stringValue(agentEnv.ANTHROPIC_BASE_URL)
    ?? stringValue(agentEnv.OPENAI_BASE_URL)
    ?? stringValue(agentEnv.GEMINI_API_BASE)
    ?? stringValue(agentEnv.MAGPIE_ADDR)
  );
  const sessionRef = normalizeModelRef(options.sessionModel);
  const explicitMagpie = Boolean(
    sessionRef.hasMagpiePrefix
    || stringValue(agentEnv.MAGPIE_ADDR)
    || (explicitOrigin && knownGatewayOrigin && explicitOrigin === knownGatewayOrigin)
  );
  const origin = explicitOrigin ?? (sessionRef.hasMagpiePrefix ? knownGatewayOrigin : undefined);
  const authToken = stringValue(agentEnv.ANTHROPIC_AUTH_TOKEN)
    ?? stringValue(agentEnv.ANTHROPIC_API_KEY)
    ?? stringValue(agentEnv.OPENAI_API_KEY);
  return { agentId, origin, authToken, explicitMagpie, knownGatewayOrigin };
}

async function fetchJsonWithOptionalAuth(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
  authToken?: string
): Promise<{ status: number; ok: boolean; json?: unknown; networkError?: boolean }> {
  const attempt = async (withAuth: boolean) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (withAuth && authToken) headers.Authorization = `Bearer ${authToken}`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, ok: res.ok, json };
  };

  try {
    const first = await attempt(false);
    if ((first.status === 401 || first.status === 403) && authToken) {
      return await attempt(true);
    }
    return first;
  } catch {
    return { status: 0, ok: false, networkError: true };
  }
}

/**
 * Layer 2：权威指纹探测 `GET <origin>/`，确认目标服务确实是 Magpie 且开放 `/v1/magpie/quotas`。
 * 正常结果缓存 5 分钟，失败/非 Magpie 负缓存 30 秒。
 */
export async function probeMagpieOrigin(
  origin: string,
  options: {
    authToken?: string;
    refresh?: boolean;
    fetchImpl?: FetchLike;
    now?: () => number;
  } = {}
): Promise<ProbeCacheEntry> {
  const now = options.now ?? Date.now;
  const cached = probeCache.get(origin);
  if (!options.refresh && cached) {
    const ttl = cached.isMagpie ? MAGPIE_CACHE_TTL_MS : MAGPIE_NEGATIVE_TTL_MS;
    if (now() - cached.checkedAt < ttl) return cached;
  }

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const res = await fetchJsonWithOptionalAuth(fetchImpl, `${origin}/`, PROBE_TIMEOUT_MS, options.authToken);
  const checkedAt = now();

  if (res.networkError) {
    const entry: ProbeCacheEntry = { checkedAt, isMagpie: false, authRequired: false, unreachable: true };
    probeCache.set(origin, entry);
    return entry;
  }

  if (res.status === 401 || res.status === 403) {
    const errText = JSON.stringify(res.json ?? '').toLowerCase();
    const looksMagpie = errText.includes('magpie');
    const entry: ProbeCacheEntry = { checkedAt, isMagpie: looksMagpie, authRequired: looksMagpie, unreachable: false };
    probeCache.set(origin, entry);
    return entry;
  }

  const body = (res.json && typeof res.json === 'object' ? res.json : {}) as MagpieRootResponse;
  const apis = Array.isArray(body.apis) ? body.apis.filter((item): item is string => typeof item === 'string') : [];
  const isMagpie = res.ok && body.name === 'magpie' && apis.includes('/v1/magpie/quotas');
  const entry: ProbeCacheEntry = {
    checkedAt,
    isMagpie,
    authRequired: false,
    unreachable: false,
    version: stringValue(body.version)
  };
  probeCache.set(origin, entry);
  return entry;
}

async function fetchMagpieSnapshotRaw(
  origin: string,
  version: string | undefined,
  options: { authToken?: string; fetchImpl?: FetchLike; now?: () => number }
): Promise<SnapshotCacheEntry> {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);

  const [quotasRes, accountsRes, modelsRes, usageTodayRes] = await Promise.all([
    fetchJsonWithOptionalAuth(fetchImpl, `${origin}/v1/magpie/quotas`, QUOTAS_TIMEOUT_MS, options.authToken),
    fetchJsonWithOptionalAuth(fetchImpl, `${origin}/v1/magpie/accounts`, METADATA_TIMEOUT_MS, options.authToken),
    fetchJsonWithOptionalAuth(fetchImpl, `${origin}/v1/models`, METADATA_TIMEOUT_MS, options.authToken),
    fetchJsonWithOptionalAuth(fetchImpl, `${origin}/v1/magpie/usage?period=today`, METADATA_TIMEOUT_MS, options.authToken)
  ]);

  const fetchedAt = now();

  if (quotasRes.status === 401 || quotasRes.status === 403) {
    return { fetchedAt, ok: false, authRequired: true, unreachable: false, version, quotas: [], accounts: [], models: [] };
  }
  if (quotasRes.networkError && accountsRes.networkError) {
    return { fetchedAt, ok: false, authRequired: false, unreachable: true, version, quotas: [], accounts: [], models: [] };
  }
  if (!quotasRes.ok && !accountsRes.ok) {
    return { fetchedAt, ok: false, authRequired: false, unreachable: true, version, quotas: [], accounts: [], models: [] };
  }

  const extractList = <T>(payload: unknown): T[] => {
    if (Array.isArray(payload)) return payload as T[];
    if (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
      return (payload as { data: T[] }).data;
    }
    return [];
  };

  return {
    fetchedAt,
    ok: true,
    authRequired: false,
    unreachable: false,
    version,
    quotas: quotasRes.ok ? extractList<MagpieQuotaEntryRaw>(quotasRes.json) : [],
    accounts: accountsRes.ok ? extractList<MagpieAccountRaw>(accountsRes.json) : [],
    models: modelsRes.ok ? extractList<MagpieModelRaw>(modelsRes.json) : [],
    usageToday: usageTodayRes.ok && usageTodayRes.json && typeof usageTodayRes.json === 'object'
      ? usageTodayRes.json as MagpieUsageTodayRaw
      : undefined
  };
}

/**
 * 按 Magpie origin 共享原始快照（5 分钟 TTL + 并发去重 + 手动刷新 10 秒冷却 + 失败 30 秒负缓存）。
 */
async function getMagpieSnapshot(
  origin: string,
  version: string | undefined,
  options: { authToken?: string; refresh?: boolean; fetchImpl?: FetchLike; now?: () => number }
): Promise<SnapshotCacheEntry> {
  const now = options.now ?? Date.now;
  const cached = snapshotCache.get(origin);
  if (cached) {
    const age = now() - cached.fetchedAt;
    if (options.refresh) {
      // 手动刷新加 10 秒防抖冷却，防止连点打爆上游供应商。
      if (cached.ok && age >= 0 && age < MAGPIE_REFRESH_COOLDOWN_MS) return cached;
    } else {
      const ttl = cached.ok ? MAGPIE_CACHE_TTL_MS : MAGPIE_NEGATIVE_TTL_MS;
      if (age >= 0 && age < ttl) return cached;
    }
  }

  const existing = snapshotInFlight.get(origin);
  if (existing) return existing;

  const task = fetchMagpieSnapshotRaw(origin, version, options)
    .then(result => {
      snapshotCache.set(origin, result);
      return result;
    })
    .finally(() => {
      snapshotInFlight.delete(origin);
    });
  snapshotInFlight.set(origin, task);
  return task;
}

/** 格式化数字便于展示（如 5885.66 -> "5,885.7", 15080 -> "15,080"）。 */
function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value - Math.round(value)) < 0.05) return Math.round(value).toLocaleString('en-US');
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function parseBalance(raw?: string): UsageBalance | undefined {
  const display = stringValue(raw);
  if (!display) return undefined;
  const match = display.match(/^([¥$€£]|CNY|USD|EUR)?\s*(-?[\d,]+(?:\.\d+)?)/i);
  const currency = match?.[1]?.toUpperCase();
  const numeric = match?.[2] ? Number(match[2].replace(/,/g, '')) : NaN;
  return {
    display,
    ...(currency ? { currency } : {}),
    ...(Number.isFinite(numeric) ? { amount: numeric } : {})
  };
}

function computeWindowStatus(usedPercent: number, raw: MagpieQuotaWindowRaw): UsageWindowStatus {
  const holdsWhy = stringValue(raw.holdsWhy)?.toLowerCase();
  if (raw.holds && holdsWhy === 'cooldown') return 'cooldown';
  if (usedPercent >= 99.9) return 'exhausted';
  if (usedPercent >= 85) return 'warning';
  return 'normal';
}

function normalizeQuotaWindow(raw: MagpieQuotaWindowRaw): { window?: AgentUsageWindow; notice?: string } {
  const label = stringValue(raw.name);
  if (!label) return {};
  if (raw.text === true) {
    const display = stringValue(raw.display);
    return { notice: display ? `${label}：${display}` : label };
  }
  const used = percent(raw.used);
  const rem = percent(raw.remaining);
  const usedPercent = used ?? (rem !== undefined ? Math.max(0, Math.min(100, 100 - rem)) : undefined);
  if (usedPercent === undefined) return {};

  const amount = finiteNumber(raw.amount);
  const limit = finiteNumber(raw.limit);
  const unit = stringValue(raw.unit);
  const display = stringValue(raw.display)
    ?? (amount !== undefined && limit !== undefined
      ? `${formatCompactNumber(amount)} / ${formatCompactNumber(limit)}${unit ? ` ${unit}` : ''}`
      : undefined);
  const resetsAt = resetSeconds(raw.resetsAt);
  const runsOutAt = resetSeconds(raw.runsOutAt);
  const pool = stringValue(raw.pool);
  const status = computeWindowStatus(usedPercent, raw);

  return {
    window: {
      label,
      usedPercent: Math.round(usedPercent * 100) / 100,
      ...(resetsAt ? { resetsAt } : {}),
      ...(display ? { display } : {}),
      ...(amount !== undefined ? { amount } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(unit ? { unit } : {}),
      ...(runsOutAt ? { runsOutAt } : {}),
      ...(pool ? { pool } : {}),
      status
    }
  };
}

function extractEntryWindows(entry: MagpieQuotaEntryRaw): { windows: AgentUsageWindow[]; notices: string[] } {
  const rawList = Array.isArray(entry.windows) ? entry.windows as MagpieQuotaWindowRaw[] : [];
  const windows: AgentUsageWindow[] = [];
  const notices: string[] = [];
  for (const raw of rawList) {
    const parsed = normalizeQuotaWindow(raw);
    if (parsed.window) windows.push(parsed.window);
    if (parsed.notice) notices.push(parsed.notice);
  }
  return { windows, notices };
}

/**
 * 若账号同时包含 Total credits 与子项 Credits / Extra credits，
 * 顶层摘要优先展示 Total credits + 独立模型窗，避免把总分项重复塞满小面板。
 */
function selectSummaryWindows(windows: AgentUsageWindow[]): AgentUsageWindow[] {
  const hasTotalCredits = windows.some(w => /^total\s+credits$/i.test(w.label));
  if (!hasTotalCredits) return windows;
  return windows.filter(w => !/^(credits|extra\s+credits)$/i.test(w.label));
}

function aggregatePoolWindows(accountWindowsList: AgentUsageWindow[][]): AgentUsageWindow[] {
  const grouped = new Map<string, AgentUsageWindow[]>();
  const order: string[] = [];

  for (const windows of accountWindowsList) {
    const selected = selectSummaryWindows(windows);
    for (const w of selected) {
      const key = w.label;
      if (!grouped.has(key)) {
        grouped.set(key, []);
        order.push(key);
      }
      grouped.get(key)!.push(w);
    }
  }

  const aggregated: AgentUsageWindow[] = [];
  for (const label of order) {
    const items = grouped.get(label)!;
    if (items.length === 1) {
      aggregated.push(items[0]!);
      continue;
    }
    const allHaveAmountLimit = items.every(i => i.limit !== undefined && i.limit > 0);
    const unit = items.find(i => i.unit)?.unit;
    let usedPercent: number;
    let amount: number | undefined;
    let limit: number | undefined;
    let display: string | undefined;

    if (allHaveAmountLimit) {
      limit = items.reduce((sum, i) => sum + (i.limit ?? 0), 0);
      amount = items.reduce((sum, i) => sum + (i.amount ?? ((i.usedPercent / 100) * (i.limit ?? 0))), 0);
      usedPercent = limit > 0 ? Math.min(100, Math.max(0, (amount / limit) * 100)) : 0;
      display = `${formatCompactNumber(amount)} / ${formatCompactNumber(limit)}${unit ? ` ${unit}` : ''}`;
    } else {
      usedPercent = items.reduce((sum, i) => sum + i.usedPercent, 0) / items.length;
    }

    const resetsCandidates = items.map(i => i.resetsAt).filter((v): v is number => v !== undefined);
    const runsOutCandidates = items.map(i => i.runsOutAt).filter((v): v is number => v !== undefined);
    const resetsAt = resetsCandidates.length ? Math.min(...resetsCandidates) : undefined;
    const runsOutAt = runsOutCandidates.length ? Math.min(...runsOutCandidates) : undefined;
    const pool = items.find(i => i.pool)?.pool;
    const status: UsageWindowStatus = usedPercent >= 99.9
      ? 'exhausted'
      : items.some(i => i.status === 'cooldown')
        ? 'cooldown'
        : usedPercent >= 85
          ? 'warning'
          : 'normal';

    aggregated.push({
      label,
      usedPercent: Math.round(usedPercent * 100) / 100,
      ...(resetsAt ? { resetsAt } : {}),
      ...(display ? { display } : {}),
      ...(amount !== undefined ? { amount } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(unit ? { unit } : {}),
      ...(runsOutAt ? { runsOutAt } : {}),
      ...(pool ? { pool } : {}),
      status,
      aggregated: true
    });
  }

  return aggregated;
}

function computeGatewayStatsForProvider(usageToday: MagpieUsageTodayRaw | undefined, providerId: string): UsageGatewayStats | undefined {
  if (!usageToday) return undefined;
  const models = Array.isArray(usageToday.models) ? usageToday.models as MagpieUsageModelRaw[] : [];
  const matchedModels = models.filter(m => stringValue(m.provider)?.toLowerCase() === providerId);
  const accounts = Array.isArray(usageToday.accounts) ? usageToday.accounts as MagpieUsageAccountRaw[] : [];
  const matchedAccounts = accounts.filter(a => stringValue(a.provider)?.toLowerCase() === providerId);
  const rows = matchedModels.length ? matchedModels : matchedAccounts;
  if (!rows.length) {
    return { period: 'today', calls: 0, errors: 0, totalTokens: 0 };
  }

  let calls = 0;
  let errors = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let credits = 0;
  for (const row of rows) {
    calls += finiteNumber(row.calls) ?? 0;
    errors += finiteNumber(row.errors) ?? 0;
    totalTokens += (finiteNumber(row.input) ?? 0)
      + (finiteNumber(row.output) ?? 0)
      + (finiteNumber(row.cache_read) ?? 0)
      + (finiteNumber(row.cache_write) ?? 0);
    costUsd += finiteNumber(row.cost) ?? 0;
    credits += finiteNumber(row.credits) ?? 0;
  }

  return {
    period: 'today',
    calls,
    errors,
    totalTokens,
    ...(costUsd > 0 ? { costUsd } : {}),
    ...(credits > 0 ? { credits } : {})
  };
}

function findActiveAccountRawKey(
  entries: MagpieQuotaEntryRaw[],
  usageToday: MagpieUsageTodayRaw | undefined,
  providerId: string
): string | undefined {
  // 1. 优先用 Magpie 自身的 last: true 或最新 lastServedAt
  const flagged = entries.find(e => e.last === true);
  if (flagged) return stringValue(flagged.user) ?? stringValue(flagged.alias);

  let latestServedKey: string | undefined;
  let latestServedMs = -1;
  for (const e of entries) {
    const ts = stringValue(e.lastServedAt);
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > latestServedMs) {
      latestServedMs = ms;
      latestServedKey = stringValue(e.user) ?? stringValue(e.alias);
    }
  }
  if (latestServedKey) return latestServedKey;

  // 2. 次选今日用量中调用最多的同 provider 账号
  const accounts = Array.isArray(usageToday?.accounts) ? usageToday!.accounts as MagpieUsageAccountRaw[] : [];
  let bestCalls = 0;
  let bestAccount: string | undefined;
  for (const acc of accounts) {
    if (stringValue(acc.provider)?.toLowerCase() !== providerId) continue;
    const calls = finiteNumber(acc.calls) ?? 0;
    if (calls > bestCalls) {
      bestCalls = calls;
      bestAccount = stringValue(acc.account) ?? stringValue(acc.name);
    }
  }
  return bestAccount;
}

/**
 * O(1) 读取 acpx 持久化的单会话记录，拿到 native acp_session_id，用于 Magpie `/v1/magpie/route?session=` 穿透。
 */
export async function resolveAcpSessionIdFromStore(
  sessionId: string,
  cwd?: string,
  home?: string
): Promise<string | undefined> {
  const safeId = stringValue(sessionId);
  if (!safeId || safeId.includes('/') || safeId.includes('\\') || safeId.includes('..')) return undefined;

  const candidateDirs: string[] = [];
  if (cwd) candidateDirs.push(join(cwd, '.agentdock', 'acpx', 'sessions'));
  for (const h of resolveCandidateHomes(home)) {
    const dir = join(h, '.agentdock', 'acpx', 'sessions');
    if (!candidateDirs.includes(dir)) candidateDirs.push(dir);
  }

  for (const dir of candidateDirs) {
    const record = await readJsonDirect<{
      acp_session_id?: unknown;
      backendSessionId?: unknown;
      agentSessionId?: unknown;
      acpx?: { backendSessionId?: unknown } | null;
    }>(join(dir, `${safeId}.json`));
    if (!record) continue;
    const id = stringValue(record.acp_session_id)
      ?? stringValue(record.acpx?.backendSessionId)
      ?? stringValue(record.backendSessionId)
      ?? stringValue(record.agentSessionId);
    if (id) return id;
  }
  return undefined;
}

async function queryMagpieDynamicRoute(
  origin: string,
  acpSessionId: string,
  options: { authToken?: string; fetchImpl?: FetchLike }
): Promise<{ providerId?: string; matchedModel?: string; rateLimited?: boolean } | undefined> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const res = await fetchJsonWithOptionalAuth(
    fetchImpl,
    `${origin}/v1/magpie/route?session=${encodeURIComponent(acpSessionId)}`,
    ROUTE_TIMEOUT_MS,
    options.authToken
  );
  if (!res.ok || !res.json || typeof res.json !== 'object') return undefined;
  const route = (res.json as MagpieRouteResponseRaw).route;
  if (!route) return undefined;
  const routedRef = normalizeModelRef(stringValue(route.model));
  const tries = Array.isArray(route.tries) ? route.tries as MagpieRouteTryRaw[] : [];
  const rateLimited = route.status === 429 || tries.some(t => t.status === 429);
  if (!routedRef.providerId || routedRef.providerId === 'group') return undefined;
  return {
    providerId: routedRef.providerId,
    matchedModel: routedRef.normalized,
    rateLimited
  };
}

/** Layer 3：把当前会话上下文解析到 Magpie 具体供应商 ID 与匹配依据。 */
async function resolveTargetProvider(options: {
  origin: string;
  routing: AgentRoutingInfo;
  snapshot: SnapshotCacheEntry;
  sessionModel?: string;
  acpSessionId?: string;
  home?: string;
  fetchImpl?: FetchLike;
}): Promise<{
  providerId?: string;
  matchedBy: UsageMatchedBy;
  matchedModel?: string;
  routeRateLimited?: boolean;
}> {
  const { origin, routing, snapshot, sessionModel, acpSessionId, fetchImpl } = options;
  const knownProviders = new Set<string>();
  for (const q of snapshot.quotas) {
    const p = stringValue(q.provider)?.toLowerCase();
    if (p) knownProviders.add(p);
  }
  for (const a of snapshot.accounts) {
    const p = stringValue(a.provider)?.toLowerCase();
    if (p) knownProviders.add(p);
  }
  for (const m of snapshot.models) {
    const p = stringValue(m.owned_by)?.toLowerCase() ?? normalizeModelRef(stringValue(m.id)).providerId;
    if (p) knownProviders.add(p);
  }

  const sessionRef = normalizeModelRef(sessionModel);

  // 1) 会话显式模型如果是 routing group（group/<id>），优先通过 /v1/magpie/route 动态穿透
  if (sessionRef.providerId === 'group') {
    if (acpSessionId) {
      const routed = await queryMagpieDynamicRoute(origin, acpSessionId, { authToken: routing.authToken, fetchImpl });
      if (routed?.providerId) {
        return {
          providerId: routed.providerId,
          matchedBy: 'magpie_route',
          matchedModel: routed.matchedModel ?? sessionRef.normalized,
          routeRateLimited: routed.rateLimited
        };
      }
    }
    // 路由组尚无动态记录时，尝试读 ~/.config/magpie/providers.json 的 groups 首个成员兜底
    const homes = resolveCandidateHomes(options.home);
    const providersFile = await readJsonFromHomes<{ groups?: Array<{ id?: unknown; members?: unknown }> }>(homes, ['.config', 'magpie', 'providers.json']);
    const groupId = sessionRef.bareModel?.toLowerCase();
    const matchedGroup = providersFile?.groups?.find(g => stringValue(g.id)?.toLowerCase() === groupId);
    const members = Array.isArray(matchedGroup?.members) ? matchedGroup!.members : [];
    for (const member of members) {
      const memberStr = typeof member === 'string' ? member : stringValue((member as { model?: unknown })?.model);
      const memberRef = normalizeModelRef(memberStr);
      if (memberRef.providerId && memberRef.providerId !== 'group') {
        return { providerId: memberRef.providerId, matchedBy: 'agent_config', matchedModel: sessionRef.normalized };
      }
    }
  }

  // 2) 会话显式模型带 `<provider>/<model>`（最常见场景，如 workbuddy/deepseek-v4.1-flash 或 cpa/claude-opus-5-5）
  if (sessionRef.providerId && sessionRef.providerId !== 'group') {
    if (!knownProviders.size || knownProviders.has(sessionRef.providerId)) {
      return { providerId: sessionRef.providerId, matchedBy: 'session_model', matchedModel: sessionRef.normalized };
    }
  }

  // 3) 会话模型为空 / 别名（sonnet[1m]） / 无前缀裸模型时，若有 acpSessionId，尝试动态路由查询
  if (acpSessionId) {
    const routed = await queryMagpieDynamicRoute(origin, acpSessionId, { authToken: routing.authToken, fetchImpl });
    if (routed?.providerId) {
      return {
        providerId: routed.providerId,
        matchedBy: 'magpie_route',
        matchedModel: routed.matchedModel,
        routeRateLimited: routed.rateLimited
      };
    }
  }

  // 4) 若会话传了裸模型名且在 Magpie /v1/models 中唯一归属某个供应商
  if (sessionRef.bareModel && !sessionRef.providerId) {
    const bareLower = sessionRef.bareModel.toLowerCase();
    const candidates = new Set<string>();
    for (const m of snapshot.models) {
      const mRef = normalizeModelRef(stringValue(m.id));
      if (mRef.bareModel?.toLowerCase() === bareLower) {
        const owner = stringValue(m.owned_by)?.toLowerCase() ?? mRef.providerId;
        if (owner) candidates.add(owner);
      }
    }
    if (candidates.size === 1) {
      const only = [...candidates][0]!;
      return { providerId: only, matchedBy: 'session_model', matchedModel: `${only}/${sessionRef.bareModel}` };
    }
  }

  // 5) 回退到 Agent 本机默认配置模型（~/.claude/settings.json 槽位 / ~/.codex/config.toml model / omp）
  const configRef = normalizeModelRef(routing.configuredModel);
  if (configRef.providerId && configRef.providerId !== 'group') {
    return { providerId: configRef.providerId, matchedBy: 'agent_config', matchedModel: configRef.normalized };
  }

  // 6) 最后兜底 ~/.config/magpie/applied.json
  const homes = resolveCandidateHomes(options.home);
  const applied = await readJsonFromHomes<Record<string, { fields?: { model?: unknown } }>>(homes, ['.config', 'magpie', 'applied.json']);
  const appliedModel = stringValue(applied?.[routing.agentId]?.fields?.model);
  const appliedRef = normalizeModelRef(appliedModel);
  if (appliedRef.providerId && appliedRef.providerId !== 'group') {
    return { providerId: appliedRef.providerId, matchedBy: 'magpie_applied', matchedModel: appliedRef.normalized };
  }

  return { matchedBy: 'agent_config', matchedModel: sessionRef.normalized ?? configRef.normalized };
}

function buildOfficialMeta(agentId: string, usage: AgentUsage): AgentUsage {
  const providerName = usage.source ?? OFFICIAL_PROVIDERS[agentId]?.label ?? agentId;
  return {
    ...usage,
    source: usage.source ?? providerName,
    sourceMeta: usage.sourceMeta ?? {
      service: 'official',
      providerName,
      matchedBy: 'official_direct'
    },
    ...(usage.status === 'unavailable' && !usage.unavailableCode ? { unavailableCode: 'official_unavailable' } : {}),
    cacheTtlMs: usage.cacheTtlMs ?? MAGPIE_CACHE_TTL_MS
  };
}

function projectMagpieUsage(options: {
  origin: string;
  snapshot: SnapshotCacheEntry;
  providerId?: string;
  matchedBy: UsageMatchedBy;
  matchedModel?: string;
  routeRateLimited?: boolean;
  alternateSources?: UsageAlternateSource[];
  checkedAt: number;
}): AgentUsage {
  const { origin, snapshot, providerId, matchedBy, matchedModel, routeRateLimited, alternateSources, checkedAt } = options;

  if (!providerId) {
    return {
      ...unavailableUsage('已识别本机 Magpie 网关，但未能从当前会话或 Agent 配置确定具体供应商。', 'Magpie', {
        unavailableCode: 'provider_no_quota',
        sourceMeta: {
          service: 'magpie',
          endpoint: origin,
          gatewayVersion: snapshot.version,
          matchedBy,
          ...(matchedModel ? { matchedModel } : {})
        },
        ...(alternateSources?.length ? { alternateSources } : {}),
        cacheTtlMs: MAGPIE_CACHE_TTL_MS
      }),
      checkedAt
    };
  }

  const allAccountsForProvider = snapshot.accounts.filter(a => stringValue(a.provider)?.toLowerCase() === providerId);
  const disabledUsers = new Set(
    allAccountsForProvider
      .filter(a => a.on === false)
      .map(a => stringValue(a.user)?.toLowerCase() ?? stringValue(a.label)?.toLowerCase())
      .filter((v): v is string => Boolean(v))
  );

  const rawQuotas = snapshot.quotas.filter(q => {
    if (stringValue(q.provider)?.toLowerCase() !== providerId) return false;
    const u = stringValue(q.user)?.toLowerCase();
    if (u && disabledUsers.has(u)) return false;
    return true;
  });

  const providerName = stringValue(rawQuotas[0]?.name)
    ?? stringValue(allAccountsForProvider[0]?.providerName)
    ?? providerId;
  const sourceLabel = `Magpie · ${providerName}`;
  const gatewayStats = computeGatewayStatsForProvider(snapshot.usageToday, providerId);

  // Class C：存在于 Magpie 账户/模型目录，但无上游额度接口（如 cpa / 纯转发代理）
  if (!rawQuotas.length) {
    const sourceMeta: UsageSourceMeta = {
      service: 'magpie',
      providerId,
      providerName,
      endpoint: origin,
      gatewayVersion: snapshot.version,
      matchedBy,
      ...(matchedModel ? { matchedModel } : {}),
      ...(allAccountsForProvider.length ? { accountCount: allAccountsForProvider.filter(a => a.on !== false).length || allAccountsForProvider.length } : {})
    };
    return {
      ...unavailableUsage(`已识别经由 Magpie 的 ${providerName} 供应商，该供应商未提供上游额度/余额查询。`, sourceLabel, {
        unavailableCode: 'provider_no_quota',
        sourceMeta,
        ...(gatewayStats ? { gatewayStats } : {}),
        ...(alternateSources?.length ? { alternateSources } : {}),
        cacheTtlMs: MAGPIE_CACHE_TTL_MS
      }),
      checkedAt
    };
  }

  const activeRawKey = findActiveAccountRawKey(rawQuotas, snapshot.usageToday, providerId)?.toLowerCase();
  const accounts: UsageAccountSummary[] = [];
  const allNotices = new Set<string>();
  const balances: UsageBalance[] = [];
  let activeAccountLabel: string | undefined;

  for (const entry of rawQuotas) {
    const rawUser = stringValue(entry.user);
    const rawAlias = stringValue(entry.alias);
    const maskedLabel = maskAccountLabel(rawUser, rawAlias);
    const isActive = Boolean(
      entry.last === true
      || (activeRawKey && (rawUser?.toLowerCase() === activeRawKey || rawAlias?.toLowerCase() === activeRawKey))
    );
    if (isActive && !activeAccountLabel) activeAccountLabel = maskedLabel;

    const { windows, notices } = extractEntryWindows(entry);
    for (const notice of notices) allNotices.add(notice);
    const balance = parseBalance(stringValue(entry.balance));
    if (balance) balances.push(balance);
    const readAt = resetSeconds(entry.readAt);

    accounts.push({
      label: maskedLabel,
      ...(stringValue(entry.plan) ? { plan: stringValue(entry.plan) } : {}),
      ...(isActive ? { active: true } : {}),
      windows,
      ...(balance ? { balance } : {}),
      ...(readAt ? { readAt } : {})
    });
  }

  if (routeRateLimited) {
    allNotices.add('最近一轮路由曾触发上游限流（429），Magpie 已自动重试/切换');
  }

  const plans = [...new Set(accounts.map(a => a.plan).filter((p): p is string => Boolean(p)))];
  const plan = plans.length === 1 ? plans[0] : plans.length > 1 ? `${plans[0]} 等` : undefined;

  // 汇总主窗口（单账号取精简主窗；多账号聚合池级主窗）
  const topWindows = accounts.length === 1
    ? selectSummaryWindows(accounts[0]!.windows)
    : aggregatePoolWindows(accounts.map(a => a.windows));

  // Class B：API Key 余额型（如 DeepSeek ¥256.16）
  let topBalance: UsageBalance | undefined;
  if (balances.length === 1) {
    topBalance = balances[0];
  } else if (balances.length > 1) {
    const sameCurrency = balances.every(b => b.currency && b.currency === balances[0]!.currency && b.amount !== undefined);
    if (sameCurrency) {
      const total = balances.reduce((sum, b) => sum + (b.amount ?? 0), 0);
      topBalance = {
        currency: balances[0]!.currency,
        amount: total,
        display: `${balances[0]!.currency}${total.toFixed(2)}`
      };
    } else {
      topBalance = balances[0];
    }
  }

  const sourceMeta: UsageSourceMeta = {
    service: 'magpie',
    providerId,
    providerName,
    endpoint: origin,
    gatewayVersion: snapshot.version,
    matchedBy,
    ...(matchedModel ? { matchedModel } : {}),
    ...(activeAccountLabel ? { activeAccount: activeAccountLabel } : {}),
    accountCount: accounts.length
  };

  if (!topWindows.length && !topBalance) {
    return {
      ...unavailableUsage(`已识别 Magpie · ${providerName}，但暂未返回可用额度窗口或余额。`, sourceLabel, {
        unavailableCode: 'provider_no_quota',
        plan,
        sourceMeta,
        ...(accounts.length > 1 ? { accounts } : {}),
        ...(gatewayStats ? { gatewayStats } : {}),
        ...(allNotices.size ? { notices: [...allNotices] } : {}),
        ...(alternateSources?.length ? { alternateSources } : {}),
        cacheTtlMs: MAGPIE_CACHE_TTL_MS
      }),
      checkedAt
    };
  }

  return {
    status: 'available',
    ...(plan ? { plan } : {}),
    windows: topWindows,
    ...(topBalance ? { balance: topBalance } : {}),
    ...(accounts.length > 1 ? { accounts } : {}),
    ...(gatewayStats && gatewayStats.calls > 0 ? { gatewayStats } : {}),
    ...(allNotices.size ? { notices: [...allNotices] } : {}),
    source: sourceLabel,
    sourceMeta,
    ...(alternateSources?.length ? { alternateSources } : {}),
    checkedAt,
    cacheTtlMs: MAGPIE_CACHE_TTL_MS
  };
}

export interface ResolveAgentUsageOptions {
  agentId: string;
  model?: string;
  sessionId?: string;
  sessionCwd?: string;
  source?: UsageSourcePreference;
  refresh?: boolean;
  agentEnv?: Record<string, string>;
  home?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => number;
  resolveAcpSessionId?: (sessionId: string) => Promise<string | undefined>;
  officialFetchers?: Partial<Record<string, (refresh: boolean) => Promise<AgentUsage>>>;
}

/**
 * 统一账号额度调度入口：
 * - `source="auto"`（默认）：按 Agent 实际流量路由自动决策（指向已验明指纹的 Magpie 时优先借力 Magpie，否则直连官方）；
 * - `source="official"`：强制查看官方直连额度；
 * - `source="magpie"`：强制查询 Magpie 额度。
 */
export async function resolveAgentUsage(options: ResolveAgentUsageOptions): Promise<AgentUsage> {
  const agentId = options.agentId.trim().toLowerCase();
  const sourcePref: UsageSourcePreference = options.source === 'magpie' || options.source === 'official' ? options.source : 'auto';
  const refresh = Boolean(options.refresh);
  const now = options.now ?? Date.now;
  const officialFetcher = options.officialFetchers?.[agentId] ?? OFFICIAL_PROVIDERS[agentId]?.fetch;

  const routing = await inspectAgentRouting({
    agentId,
    agentEnv: options.agentEnv,
    sessionModel: options.model,
    home: options.home,
    env: options.env
  });

  // 1) 用户显式切换查看官方直连额度
  if (sourcePref === 'official') {
    if (!officialFetcher) {
      return {
        ...unavailableUsage('当前 Agent 未提供官方直连额度查询。', undefined, {
          unavailableCode: 'official_unavailable',
          sourceMeta: { service: 'official', providerName: agentId, matchedBy: 'official_direct' },
          cacheTtlMs: MAGPIE_CACHE_TTL_MS
        }),
        checkedAt: now()
      };
    }
    const official = buildOfficialMeta(agentId, await officialFetcher(refresh));
    // 如果当前 Agent 实际走 Magpie，保留切回 Magpie 的入口
    if (routing.origin) {
      const probe = await probeMagpieOrigin(routing.origin, { authToken: routing.authToken, fetchImpl: options.fetchImpl, now });
      if (probe.isMagpie) {
        return {
          ...official,
          alternateSources: [{ kind: 'magpie', label: '切回 Magpie 供应商额度' }]
        };
      }
    }
    return official;
  }

  // 2) 确定 Magpie 目标 origin
  const targetOrigin = routing.origin ?? (sourcePref === 'magpie' ? routing.knownGatewayOrigin : undefined);
  const alternateOfficial: UsageAlternateSource[] | undefined = officialFetcher
    ? [{ kind: 'official', label: '查看官方直连额度' }]
    : undefined;

  if (targetOrigin) {
    const probe = await probeMagpieOrigin(targetOrigin, {
      authToken: routing.authToken,
      refresh,
      fetchImpl: options.fetchImpl,
      now
    });

    if (probe.authRequired) {
      return {
        ...unavailableUsage('已识别 Magpie 网关，但当前密钥无权读取额度（请在 Magpie 为该密钥开启 quotas 权限）。', 'Magpie', {
          unavailableCode: 'magpie_auth_required',
          sourceMeta: {
            service: 'magpie',
            endpoint: targetOrigin,
            matchedBy: 'agent_config',
            ...(routing.configuredModel ? { matchedModel: normalizeModelRef(routing.configuredModel).normalized } : {})
          },
          ...(alternateOfficial ? { alternateSources: alternateOfficial } : {}),
          cacheTtlMs: MAGPIE_NEGATIVE_TTL_MS
        }),
        checkedAt: now()
      };
    }

    if (probe.isMagpie) {
      const snapshot = await getMagpieSnapshot(targetOrigin, probe.version, {
        authToken: routing.authToken,
        refresh,
        fetchImpl: options.fetchImpl,
        now
      });

      if (snapshot.authRequired) {
        return {
          ...unavailableUsage('已识别 Magpie 网关，但当前密钥无权读取额度（请在 Magpie 为该密钥开启 quotas 权限）。', 'Magpie', {
            unavailableCode: 'magpie_auth_required',
            sourceMeta: {
              service: 'magpie',
              endpoint: targetOrigin,
              gatewayVersion: probe.version,
              matchedBy: 'agent_config',
              ...(routing.configuredModel ? { matchedModel: normalizeModelRef(routing.configuredModel).normalized } : {})
            },
            ...(alternateOfficial ? { alternateSources: alternateOfficial } : {}),
            cacheTtlMs: MAGPIE_NEGATIVE_TTL_MS
          }),
          checkedAt: now()
        };
      }

      if (!snapshot.ok) {
        return {
          ...unavailableUsage(`已识别 Magpie 网关（${targetOrigin}），但额度接口暂未响应，请稍后重试。`, 'Magpie', {
            unavailableCode: 'magpie_unreachable',
            sourceMeta: {
              service: 'magpie',
              endpoint: targetOrigin,
              gatewayVersion: probe.version,
              matchedBy: 'agent_config'
            },
            ...(alternateOfficial ? { alternateSources: alternateOfficial } : {}),
            cacheTtlMs: MAGPIE_NEGATIVE_TTL_MS
          }),
          checkedAt: now()
        };
      }

      const acpSessionId = options.sessionId
        ? await (options.resolveAcpSessionId
          ? options.resolveAcpSessionId(options.sessionId)
          : resolveAcpSessionIdFromStore(options.sessionId, options.sessionCwd, options.home))
        : undefined;

      const resolved = await resolveTargetProvider({
        origin: targetOrigin,
        routing,
        snapshot,
        sessionModel: options.model,
        acpSessionId,
        home: options.home,
        fetchImpl: options.fetchImpl
      });

      return projectMagpieUsage({
        origin: targetOrigin,
        snapshot,
        providerId: resolved.providerId,
        matchedBy: resolved.matchedBy,
        matchedModel: resolved.matchedModel,
        routeRateLimited: resolved.routeRateLimited,
        alternateSources: alternateOfficial,
        checkedAt: snapshot.fetchedAt
      });
    }

    // 探测失败但配置显式指向 Magpie（例如 Magpie 刚退出或未启动）→ 明确报 Magpie 未连接，绝不静默错挂官方额度
    if (probe.unreachable && (routing.explicitMagpie || sourcePref === 'magpie')) {
      return {
        ...unavailableUsage(`检测到当前 Agent 代理指向 Magpie（${targetOrigin}），但网关未启动或暂不可达。`, 'Magpie', {
          unavailableCode: 'magpie_unreachable',
          sourceMeta: {
            service: 'magpie',
            endpoint: targetOrigin,
            matchedBy: 'agent_config',
            ...(routing.configuredModel ? { matchedModel: normalizeModelRef(routing.configuredModel).normalized } : {})
          },
          ...(alternateOfficial ? { alternateSources: alternateOfficial } : {}),
          cacheTtlMs: MAGPIE_NEGATIVE_TTL_MS
        }),
        checkedAt: now()
      };
    }
    // 若目标端口实际是其他反代（如 8317）而非 Magpie，则继续自然回落到官方逻辑，杜绝误判。
  }

  if (sourcePref === 'magpie') {
    return {
      ...unavailableUsage('未检测到运行中的本机 Magpie 网关。', 'Magpie', {
        unavailableCode: 'magpie_unreachable',
        sourceMeta: { service: 'magpie', matchedBy: 'agent_config' },
        ...(alternateOfficial ? { alternateSources: alternateOfficial } : {}),
        cacheTtlMs: MAGPIE_NEGATIVE_TTL_MS
      }),
      checkedAt: now()
    };
  }

  // 3) 官方直连
  if (officialFetcher) {
    return buildOfficialMeta(agentId, await officialFetcher(refresh));
  }

  return {
    ...unavailableUsage('当前 Agent 暂不支持账号额度查询。', undefined, {
      unavailableCode: 'official_unavailable',
      sourceMeta: { service: 'official', providerName: agentId, matchedBy: 'official_direct' },
      cacheTtlMs: MAGPIE_CACHE_TTL_MS
    }),
    checkedAt: now()
  };
}
