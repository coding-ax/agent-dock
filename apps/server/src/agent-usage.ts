export type UsageSourceKind = 'official' | 'magpie';

export type UsageMatchedBy =
  | 'session_model'
  | 'magpie_route'
  | 'agent_config'
  | 'magpie_applied'
  | 'official_direct';

export type UsageUnavailableCode =
  | 'magpie_unreachable'
  | 'magpie_auth_required'
  | 'provider_no_quota'
  | 'official_unavailable';

export type UsageWindowStatus = 'normal' | 'warning' | 'exhausted' | 'cooldown';

export type UsageSourceMeta = {
  service: UsageSourceKind;
  providerId?: string;
  providerName?: string;
  /** 仅 origin（如 http://127.0.0.1:3425），绝不含 query、路径或密钥。 */
  endpoint?: string;
  gatewayVersion?: string;
  matchedBy: UsageMatchedBy;
  matchedModel?: string;
  /** 优先 alias 或脱敏短名，绝不含个人邮箱明文或密钥。 */
  activeAccount?: string;
  accountCount?: number;
};

export type UsageBalance = {
  display: string;
  currency?: string;
  amount?: number;
};

export type AgentUsageWindow = {
  label: string;
  usedPercent: number;
  resetsAt?: number;
  display?: string;
  amount?: number;
  limit?: number;
  unit?: string;
  runsOutAt?: number;
  pool?: string;
  status?: UsageWindowStatus;
  aggregated?: boolean;
};

export type UsageAccountSummary = {
  /** 优先 alias，否则脱敏短名；绝不暴露明文邮箱或密钥。 */
  label: string;
  plan?: string;
  active?: boolean;
  windows: AgentUsageWindow[];
  balance?: UsageBalance;
  readAt?: number;
};

export type UsageGatewayStats = {
  period: 'today';
  calls: number;
  errors: number;
  totalTokens: number;
  costUsd?: number;
  credits?: number;
};

export type UsageAlternateSource = {
  kind: UsageSourceKind;
  label: string;
};

export type AgentUsage = {
  status: 'available' | 'unavailable';
  plan?: string;
  windows: AgentUsageWindow[];
  balance?: UsageBalance;
  accounts?: UsageAccountSummary[];
  gatewayStats?: UsageGatewayStats;
  notices?: string[];
  reason?: string;
  unavailableCode?: UsageUnavailableCode;
  source?: string;
  sourceMeta?: UsageSourceMeta;
  alternateSources?: UsageAlternateSource[];
  stale?: boolean;
  checkedAt: number;
  cacheTtlMs?: number;
};

export const unavailableUsage = (
  reason: string,
  source?: string,
  extra?: Partial<Omit<AgentUsage, 'status' | 'reason' | 'source' | 'windows' | 'checkedAt'>>
): AgentUsage => ({
  status: 'unavailable',
  reason,
  ...(source !== undefined ? { source } : {}),
  ...extra,
  windows: [],
  checkedAt: Date.now()
});

export function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, 100) : undefined;
}

export function resetSeconds(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n > 1e11 ? n / 1000 : n) : undefined;
}
