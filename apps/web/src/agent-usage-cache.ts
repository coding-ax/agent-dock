import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AgentUsage, type CodexUsage, type UsageSourceKind } from './api';

export type QuotaAgentId = 'codex' | 'claude' | 'cursor' | 'antigravity';
export type UsageSourcePreference = 'auto' | UsageSourceKind;
export type AgentQuotaData = AgentUsage | CodexUsage;
export type UsageCacheStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface UsageQueryContext {
  model?: string;
  sessionId?: string;
  source?: UsageSourcePreference;
}

export interface CachedAgentUsageEntry {
  savedAt: number;
  data: AgentQuotaData;
}

export interface AgentUsageSnapshot {
  data: AgentQuotaData;
  updatedAt: number;
  fromCache: boolean;
}

export type QuotaTone = 'normal' | 'warning' | 'danger';

/** 账号额度前端缓存有效期：5 分钟。 */
export const AGENT_USAGE_CACHE_TTL_MS = 5 * 60_000;

const CACHE_PREFIX = 'agentdock.agent_usage.v1';

const QUOTA_AGENT_IDS: ReadonlySet<string> = new Set<QuotaAgentId>(['codex', 'claude', 'cursor', 'antigravity']);
const EXTRA_MAGPIE_AGENT_IDS: ReadonlySet<string> = new Set(['omp', 'opencode']);

export const QUOTA_AGENT_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  omp: 'OMP',
  opencode: 'OpenCode'
};

export function resolveQuotaAgentId(agentId?: string): QuotaAgentId | undefined {
  if (!agentId) return undefined;
  const normalized = agentId.trim().toLowerCase();
  return QUOTA_AGENT_IDS.has(normalized) ? (normalized as QuotaAgentId) : undefined;
}

/**
 * 解析支持通过统一额度端点 `/api/usage/quota` 查询的 Agent 目标：
 * 除 4 个内置官方 Agent 外，也覆盖 OMP / OpenCode 以及会话模型显式带 `magpie/` 前缀的 Agent。
 */
export function resolveQuotaTarget(agentId?: string, currentModel?: string): string | undefined {
  if (!agentId) return undefined;
  const normalized = agentId.trim().toLowerCase();
  if (QUOTA_AGENT_IDS.has(normalized) || EXTRA_MAGPIE_AGENT_IDS.has(normalized)) return normalized;
  if (currentModel && /^magpie\//i.test(currentModel.trim())) return normalized;
  return undefined;
}

export function quotaAgentDisplayName(agentId: string): string {
  const normalized = agentId.trim().toLowerCase();
  return QUOTA_AGENT_LABELS[normalized] ?? agentId;
}

function normalizeModelCachePart(model?: string): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\[[^\]]+\]\s*$/, '').trim().toLowerCase() || undefined;
}

function normalizedSource(source?: UsageSourcePreference): UsageSourcePreference {
  return source === 'magpie' || source === 'official' ? source : 'auto';
}

export const agentUsageQueryKey = (agentId: string, context?: UsageQueryContext) => {
  const modelPart = normalizeModelCachePart(context?.model);
  const src = normalizedSource(context?.source);
  const isGroup = Boolean(modelPart && /^(?:magpie\/)?group\//i.test(modelPart));
  if (!modelPart && src === 'auto') return ['agent-usage', agentId] as const;
  return ['agent-usage', agentId, modelPart ?? '', src, ...(isGroup && context?.sessionId ? [context.sessionId] : [])] as const;
};

const browserStorage = (): UsageCacheStorage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

const cacheKey = (agentId: string, context?: UsageQueryContext) => {
  const modelPart = normalizeModelCachePart(context?.model);
  const src = normalizedSource(context?.source);
  if (!modelPart && src === 'auto') return `${CACHE_PREFIX}:${agentId}`;
  const isGroup = Boolean(modelPart && /^(?:magpie\/)?group\//i.test(modelPart));
  const sessionSuffix = isGroup && context?.sessionId ? `::${context.sessionId}` : '';
  return `${CACHE_PREFIX}:${agentId}::${modelPart ?? ''}::${src}${sessionSuffix}`;
};

const validWindow = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.label === 'string'
    && typeof item.usedPercent === 'number'
    && Number.isFinite(item.usedPercent)
    && (item.resetsAt === undefined || (typeof item.resetsAt === 'number' && Number.isFinite(item.resetsAt)));
};

const validQuotaData = (value: unknown): value is AgentQuotaData => {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return (data.status === 'available' || data.status === 'unavailable')
    && Array.isArray(data.windows)
    && data.windows.every(validWindow)
    && typeof data.checkedAt === 'number'
    && Number.isFinite(data.checkedAt);
};

export function isUsageCacheFresh(entry: Pick<CachedAgentUsageEntry, 'savedAt'> & { data?: AgentQuotaData } | undefined, now = Date.now()): boolean {
  if (!entry || !Number.isFinite(entry.savedAt)) return false;
  const ttl = entry.data && 'cacheTtlMs' in entry.data && typeof entry.data.cacheTtlMs === 'number' && entry.data.cacheTtlMs > 0
    ? Math.min(entry.data.cacheTtlMs, AGENT_USAGE_CACHE_TTL_MS)
    : AGENT_USAGE_CACHE_TTL_MS;
  const age = now - entry.savedAt;
  return age >= 0 && age < ttl;
}

export function readCachedAgentUsage(
  agentId: string,
  storage: UsageCacheStorage | undefined = browserStorage(),
  context?: UsageQueryContext
): CachedAgentUsageEntry | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(cacheKey(agentId, context));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<CachedAgentUsageEntry>;
    if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt) || !validQuotaData(parsed.data)) {
      return undefined;
    }
    return { savedAt: parsed.savedAt, data: parsed.data };
  } catch {
    return undefined;
  }
}

export function readFreshCachedAgentUsage(
  agentId: string,
  storage: UsageCacheStorage | undefined = browserStorage(),
  now = Date.now(),
  context?: UsageQueryContext
): AgentUsageSnapshot | undefined {
  const entry = readCachedAgentUsage(agentId, storage, context);
  if (!entry || !isUsageCacheFresh(entry, now)) return undefined;
  return { data: entry.data, updatedAt: entry.savedAt, fromCache: true };
}

export function writeCachedAgentUsage(
  agentId: string,
  data: AgentQuotaData,
  storage: UsageCacheStorage | undefined = browserStorage(),
  now = Date.now(),
  context?: UsageQueryContext
): void {
  if (!storage || !validQuotaData(data)) return;
  try {
    storage.setItem(cacheKey(agentId, context), JSON.stringify({ savedAt: now, data } satisfies CachedAgentUsageEntry));
  } catch {
    /* localStorage 不可用或已满时忽略，继续使用内存态。 */
  }
}

export function fetchAgentUsageFromApi(
  agentId: string,
  refresh = false,
  context?: UsageQueryContext
): Promise<AgentQuotaData> {
  return api.agentQuota({
    agentId,
    ...(context?.model ? { model: context.model } : {}),
    ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context?.source && context.source !== 'auto' ? { source: context.source } : {}),
    refresh
  });
}

export async function loadAgentUsage(
  agentId: string,
  options: {
    refresh?: boolean;
    storage?: UsageCacheStorage | undefined;
    now?: () => number;
    model?: string;
    sessionId?: string;
    source?: UsageSourcePreference;
    fetcher?: (agentId: string, refresh: boolean, context?: UsageQueryContext) => Promise<AgentQuotaData>;
  } = {}
): Promise<AgentUsageSnapshot> {
  const refresh = Boolean(options.refresh);
  const storage = 'storage' in options ? options.storage : browserStorage();
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? fetchAgentUsageFromApi;
  const context: UsageQueryContext = {
    ...(options.model ? { model: options.model } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.source ? { source: options.source } : {})
  };

  if (!refresh) {
    const fresh = readFreshCachedAgentUsage(agentId, storage, now(), context);
    if (fresh) return fresh;
  }

  const hasContext = Boolean(context.model || context.sessionId || (context.source && context.source !== 'auto'));
  const data = hasContext ? await fetcher(agentId, refresh, context) : await fetcher(agentId, refresh);
  const savedAt = now();
  writeCachedAgentUsage(agentId, data, storage, savedAt, context);
  return { data, updatedAt: savedAt, fromCache: false };
}

export function useAgentUsage(
  agentId: string | undefined,
  options: { enabled?: boolean; model?: string; sessionId?: string; source?: UsageSourcePreference } = {}
) {
  const client = useQueryClient();
  const enabled = Boolean(agentId) && (options.enabled ?? true);
  const context = useMemo<UsageQueryContext>(() => ({
    ...(options.model ? { model: options.model } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.source ? { source: options.source } : {})
  }), [options.model, options.sessionId, options.source]);

  const key = agentId ? agentUsageQueryKey(agentId, context) : (['agent-usage', '__none__'] as const);

  const freshCache = useMemo(
    () => (agentId ? readFreshCachedAgentUsage(agentId, undefined, Date.now(), context) : undefined),
    [agentId, context]
  );

  const query = useQuery<AgentUsageSnapshot>({
    queryKey: key,
    queryFn: () => loadAgentUsage(agentId!, { refresh: false, ...context }),
    enabled,
    initialData: freshCache,
    initialDataUpdatedAt: freshCache?.updatedAt,
    staleTime: AGENT_USAGE_CACHE_TTL_MS,
    gcTime: 30 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  });

  const refreshMutation = useMutation({
    mutationFn: () => loadAgentUsage(agentId!, { refresh: true, ...context }),
    onSuccess: snapshot => {
      if (agentId) client.setQueryData(agentUsageQueryKey(agentId, context), snapshot);
    }
  });

  const snapshot = query.data;
  const error = refreshMutation.error ?? query.error;

  return {
    data: snapshot?.data,
    updatedAt: snapshot?.updatedAt,
    fromCache: snapshot?.fromCache ?? false,
    isLoading: enabled && query.isLoading && !snapshot,
    isRefreshing: refreshMutation.isPending || (query.isFetching && Boolean(snapshot)),
    error,
    refresh: () => {
      if (!agentId || refreshMutation.isPending) return;
      refreshMutation.mutate();
    }
  };
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function quotaUsageTone(usedPercent: number): QuotaTone {
  const clamped = clampPercent(usedPercent);
  if (clamped >= 90) return 'danger';
  if (clamped >= 70) return 'warning';
  return 'normal';
}

export function formatQuotaResetCountdown(resetsAtSeconds?: number, nowMs = Date.now()): string | undefined {
  if (resetsAtSeconds === undefined || !Number.isFinite(resetsAtSeconds) || resetsAtSeconds <= 0) return undefined;
  const diffMs = resetsAtSeconds * 1000 - nowMs;
  if (diffMs <= 0) return '即将重置';
  const totalMinutes = Math.ceil(diffMs / 60_000);
  if (totalMinutes <= 1) return '1 分钟内重置';
  if (totalMinutes < 60) return `${totalMinutes} 分钟后重置`;
  const totalHours = Math.floor(totalMinutes / 60);
  const restMinutes = totalMinutes % 60;
  if (totalHours < 24) {
    return restMinutes > 0 ? `${totalHours} 小时 ${restMinutes} 分后重置` : `${totalHours} 小时后重置`;
  }
  const days = Math.floor(totalHours / 24);
  const restHours = totalHours % 24;
  return restHours > 0 ? `${days} 天 ${restHours} 小时后重置` : `${days} 天后重置`;
}

export function formatQuotaResetClock(resetsAtSeconds?: number): string | undefined {
  if (resetsAtSeconds === undefined || !Number.isFinite(resetsAtSeconds) || resetsAtSeconds <= 0) return undefined;
  const date = new Date(resetsAtSeconds * 1000);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hour}:${minute}`;
}

export function formatClockTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${hour}:${minute}`;
}

export function formatUpdatedAt(timestampMs?: number, nowMs = Date.now()): string | undefined {
  if (timestampMs === undefined || !Number.isFinite(timestampMs)) return undefined;
  const diffMs = Math.max(0, nowMs - timestampMs);
  const clock = formatClockTime(timestampMs);
  if (diffMs < 60_000) return `刚刚更新 · ${clock}`;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins} 分钟前 · ${clock}`;
  const date = new Date(timestampMs);
  return `${date.getMonth() + 1}/${date.getDate()} ${clock} 更新`;
}

/** 格式化预计耗尽倒计时（来自 Magpie runsOutAt）。 */
export function formatQuotaRunsOutCountdown(runsOutAtSeconds?: number, nowMs = Date.now()): string | undefined {
  if (runsOutAtSeconds === undefined || !Number.isFinite(runsOutAtSeconds) || runsOutAtSeconds <= 0) return undefined;
  const diffMs = runsOutAtSeconds * 1000 - nowMs;
  if (diffMs <= 0) return '即将耗尽';
  const totalMinutes = Math.ceil(diffMs / 60_000);
  if (totalMinutes < 60) return `预计 ${totalMinutes} 分钟后耗尽`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `预计 ${totalHours} 小时后耗尽`;
  const days = Math.floor(totalHours / 24);
  return `预计 ${days} 天后耗尽`;
}

/** 取最紧迫窗口的剩余百分比或余额，用于外层 HoverTooltip 一句话摘要（含 Magpie 来源标记）。 */
export function summarizeQuotaTooltip(data?: AgentQuotaData): string | undefined {
  if (!data) return undefined;
  const meta = data.sourceMeta;
  const isMagpie = meta?.service === 'magpie';
  const providerTag = meta?.providerName ? `Magpie · ${meta.providerName}` : 'Magpie';

  if (data.status !== 'available') {
    if (!isMagpie) return undefined;
    if (data.unavailableCode === 'provider_no_quota') return `${providerTag}（无上游额度）`;
    if (data.unavailableCode === 'magpie_auth_required') return 'Magpie 需授权';
    if (data.unavailableCode === 'magpie_unreachable') return 'Magpie 未连接';
    return undefined;
  }

  if (data.windows.length) {
    const tightest = data.windows.reduce((max, item) => (item.usedPercent > max.usedPercent ? item : max), data.windows[0]!);
    const remaining = Math.round(100 - clampPercent(tightest.usedPercent));
    if (isMagpie) return `${providerTag} · 剩余 ${remaining}%`;
    return `${tightest.label} 剩余 ${remaining}%`;
  }

  if (data.balance?.display) {
    return isMagpie ? `${providerTag} · 余额 ${data.balance.display}` : `余额 ${data.balance.display}`;
  }
  return undefined;
}
