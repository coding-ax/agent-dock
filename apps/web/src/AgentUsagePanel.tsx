import { useState } from 'react';
import { Activity, AlertCircle, AlertTriangle, ArrowLeftRight, ChevronDown, Clock, RefreshCw, Users, Wallet } from 'lucide-react';
import { WebAccessDeniedError, type AgentUsageWindow, type UsageAccountSummary, type UsageGatewayStats } from './api';
import { formatTokens } from './composer-utils';
import { HoverTooltip, HoverTooltipText } from './HoverTooltip';
import { UsageSourceBadge } from './UsageSourceBadge';
import { useElapsedNow } from './useElapsedNow';
import {
  AGENT_USAGE_CACHE_TTL_MS,
  clampPercent,
  formatQuotaResetClock,
  formatQuotaResetCountdown,
  formatQuotaRunsOutCountdown,
  formatUpdatedAt,
  quotaAgentDisplayName,
  quotaUsageTone,
  useAgentUsage,
  type AgentQuotaData,
  type QuotaAgentId,
  type QuotaTone,
  type UsageSourcePreference
} from './agent-usage-cache';

const barToneClass: Record<QuotaTone, string> = {
  normal: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500'
};

const remainingToneClass: Record<QuotaTone, string> = {
  normal: 'text-emerald-600',
  warning: 'text-amber-600',
  danger: 'text-red-600'
};

function defaultQuotaSourceLabel(agentId: string): string {
  switch (agentId.trim().toLowerCase()) {
    case 'codex': return '本机 Codex CLI';
    case 'claude': return 'Claude statusline';
    case 'cursor': return 'cursor.com';
    case 'antigravity': return 'Antigravity CLI';
    case 'omp': return 'OMP';
    case 'opencode': return 'OpenCode';
    default: return agentId;
  }
}

function quotaErrorMessage(error: unknown): string {
  if (error instanceof WebAccessDeniedError && error.status === 403) {
    return '当前会话链接无权查看账号额度，请使用控制台地址。';
  }
  return '额度读取失败，请点击刷新重试。';
}

function formatUsd(costUsd?: number): string | undefined {
  if (!costUsd || !Number.isFinite(costUsd) || costUsd <= 0) return undefined;
  return `$${costUsd.toFixed(costUsd >= 1 ? 2 : 4)}`;
}

function cacheHintText(cacheTtlMs?: number): string {
  const ttl = cacheTtlMs && cacheTtlMs > 0 ? cacheTtlMs : AGENT_USAGE_CACHE_TTL_MS;
  if (ttl < 60_000) return `${Math.round(ttl / 1000)} 秒后可自动重试`;
  return `自动缓存 ${Math.round(ttl / 60_000)} 分钟`;
}

function GatewayStatsBlock({ stats }: { stats: UsageGatewayStats }) {
  const costText = formatUsd(stats.costUsd);
  return (
    <div
      data-magpie-gateway-stats=""
      className="mt-2 rounded-lg border border-zinc-200/75 bg-white/80 px-2.5 py-2"
    >
      <div className="flex items-center gap-1 text-[11px] font-medium text-zinc-600">
        <Activity size={11} className="shrink-0 text-sky-600"/>
        <span>Magpie 今日网关统计</span>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] tabular-nums">
        <div className="flex items-center justify-between gap-1 text-zinc-500">
          <span>请求</span>
          <span className="font-medium text-zinc-800">{stats.calls} 次</span>
        </div>
        <div className="flex items-center justify-between gap-1 text-zinc-500">
          <span>Token</span>
          <span className="font-medium text-zinc-800">{formatTokens(stats.totalTokens)}</span>
        </div>
        {costText && (
          <div className="flex items-center justify-between gap-1 text-zinc-500">
            <span>费用</span>
            <span className="font-medium text-zinc-800">{costText}</span>
          </div>
        )}
        {stats.credits !== undefined && stats.credits > 0 && (
          <div className="flex items-center justify-between gap-1 text-zinc-500">
            <span>积分</span>
            <span className="font-medium text-zinc-800">{stats.credits.toFixed(1)}</span>
          </div>
        )}
        <div className="flex items-center justify-between gap-1 text-zinc-500">
          <span>异常</span>
          <span className={`font-medium ${stats.errors > 0 ? 'text-amber-600' : 'text-zinc-700'}`}>
            {stats.errors} 次
          </span>
        </div>
      </div>
    </div>
  );
}

function AccountDetailRow({ account, now }: { account: UsageAccountSummary; now: number }) {
  const primaryWindows = account.windows.length
    ? (account.windows.some(w => /^total\s+credits$/i.test(w.label))
      ? account.windows.filter(w => !/^(credits|extra\s+credits)$/i.test(w.label))
      : account.windows)
    : [];

  return (
    <div
      data-magpie-account-row=""
      className="rounded-lg border border-zinc-200/75 bg-white px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate text-[11.5px] font-medium text-zinc-800">{account.label}</span>
        {account.active && (
          <span className="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-px text-[10px] font-medium leading-3.5 text-sky-700">
            当前活跃
          </span>
        )}
        {account.plan && (
          <span className="ml-auto shrink-0 text-[10.5px] text-zinc-400">{account.plan}</span>
        )}
      </div>

      {account.balance && (
        <div className="mt-1 flex items-baseline justify-between text-[11px] tabular-nums">
          <span className="text-zinc-500">余额</span>
          <span className="font-semibold text-zinc-800">{account.balance.display}</span>
        </div>
      )}

      {primaryWindows.length > 0 && (
        <div className="mt-1.5 space-y-1.5">
          {primaryWindows.map(win => {
            const used = clampPercent(win.usedPercent);
            const remaining = Math.round(100 - used);
            const tone = quotaUsageTone(used);
            const width = used > 0 ? Math.max(2, used) : 0;
            const runsOut = formatQuotaRunsOutCountdown(win.runsOutAt, now);
            return (
              <div key={win.label}>
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="min-w-0 truncate text-zinc-600">{win.label}</span>
                  <span className={`shrink-0 font-medium tabular-nums ${remainingToneClass[tone]}`}>
                    剩余 {remaining}%
                  </span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-200">
                  <div
                    className={`h-full rounded-full ${barToneClass[tone]}`}
                    style={{ width: `${width}%` }}
                  />
                </div>
                {(win.display || runsOut) && (
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-[10.5px] tabular-nums text-zinc-400">
                    <span className="min-w-0 truncate">{win.display ?? `已用 ${Math.round(used)}%`}</span>
                    {runsOut && <span className="shrink-0 text-amber-600">{runsOut}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface AgentQuotaViewProps {
  agentId: string;
  variant?: 'card' | 'embedded';
  data?: AgentQuotaData;
  updatedAt?: number;
  now?: number;
  isLoading?: boolean;
  isRefreshing?: boolean;
  error?: unknown;
  sourcePreference?: UsageSourcePreference;
  onSourceChange?(next: UsageSourcePreference): void;
  onRefresh(): void;
}

/**
 * 账号额度纯展示层：会话顶栏聚合面板（embedded）与设置菜单（card）共用同一套
 * 来源显式徽标（Provenance UI）+ 卡片 + 柔和细进度条 + 重置倒计时 + 多账号明细 + 余额/无额度四态展示。
 */
export function AgentQuotaView({
  agentId,
  variant = 'card',
  data,
  updatedAt,
  now = Date.now(),
  isLoading = false,
  isRefreshing = false,
  error,
  sourcePreference = 'auto',
  onSourceChange,
  onRefresh
}: AgentQuotaViewProps) {
  const [accountsExpanded, setAccountsExpanded] = useState(false);

  const embedded = variant === 'embedded';
  const displayName = quotaAgentDisplayName(agentId);
  const title = embedded ? '账号额度' : `${displayName} 账号额度`;
  const stale = Boolean(data && 'stale' in data && data.stale);
  const source = (data && 'source' in data && data.source) || defaultQuotaSourceLabel(agentId);
  const sourceMeta = data?.sourceMeta;
  const isMagpie = sourceMeta?.service === 'magpie';
  const isMagpieIssue = isMagpie && (data?.unavailableCode === 'magpie_unreachable' || data?.unavailableCode === 'magpie_auth_required');
  const isProviderNoQuota = isMagpie && data?.unavailableCode === 'provider_no_quota';
  const updatedText = formatUpdatedAt(updatedAt ?? data?.checkedAt, now);
  const cardSurface = embedded ? 'bg-zinc-50/75' : 'bg-white';
  const cardPad = embedded ? 'px-2.5 py-2' : 'px-3 py-2.5';
  const windows: AgentUsageWindow[] = data?.windows ?? [];
  const accounts = data?.accounts ?? [];
  const hasMultipleAccounts = accounts.length > 1;
  const gridClass = !embedded && windows.length > 1
    ? 'grid grid-cols-1 gap-2 sm:grid-cols-2'
    : embedded
      ? 'space-y-1.5'
      : 'space-y-2';

  const alternate = data?.alternateSources?.[0];
  const canSwitchSource = Boolean(onSourceChange && (alternate || sourcePreference !== 'auto'));
  const nextSourceTarget: UsageSourcePreference = alternate
    ? (alternate.kind === 'magpie' && sourcePreference === 'official' ? 'auto' : alternate.kind)
    : 'auto';
  const switchLabel = alternate
    ? (alternate.kind === 'official' ? '查看官方' : '切回 Magpie')
    : '恢复自动识别';

  const content = <>
    <div className="flex items-center gap-1.5">
      <div className="min-w-0 flex items-center gap-1.5">
        <span className="text-[12px] font-semibold text-zinc-800">{title}</span>
        {data?.plan && (
          <span className="shrink-0 rounded-full border border-zinc-200 bg-white px-1.5 py-px text-[10.5px] font-medium leading-4 text-zinc-600">
            {data.plan}
          </span>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {updatedText && (
          <span className="text-[11px] tabular-nums text-zinc-400">{updatedText}</span>
        )}
        <HoverTooltip content={isRefreshing ? '正在刷新账号额度…' : '手动刷新账号额度'}>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label={`刷新 ${displayName} 额度`}
            className="grid h-6 w-6 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-wait disabled:opacity-50"
          >
            <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''}/>
          </button>
        </HoverTooltip>
      </div>
    </div>

    {/* 来源显式提示条（Provenance Bar）：一眼区分 Magpie 供应商 vs 官方直连，并支持轻量源切换 */}
    {data && (sourceMeta || canSwitchSource) && (
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1.5">
        <UsageSourceBadge
          agentDisplayName={displayName}
          sourceMeta={sourceMeta}
          unavailableCode={data.unavailableCode}
          fallbackSourceLabel={source}
        />
        {canSwitchSource && (
          <HoverTooltip content={alternate?.label ?? '恢复按当前代理配置自动识别来源'}>
            <button
              type="button"
              onClick={() => onSourceChange?.(nextSourceTarget)}
              data-usage-source-switch={nextSourceTarget}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            >
              <ArrowLeftRight size={10} className="shrink-0"/>
              <span>{switchLabel}</span>
            </button>
          </HoverTooltip>
        )}
      </div>
    )}

    {Boolean(error) && Boolean(data) && (
      <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50/80 px-2.5 py-1.5 text-[11px] text-amber-700">
        <AlertCircle size={12} className="shrink-0"/>
        <span>刷新失败，当前展示最近一次缓存</span>
      </div>
    )}

    {isLoading ? (
      <div className="mt-2.5 space-y-2" aria-label="正在读取账号额度">
        <div className={`rounded-xl border border-zinc-200/80 ${cardSurface} px-3 py-2.5`}>
          <div className="flex items-center justify-between">
            <div className="ui-skeleton h-3 w-16 rounded bg-zinc-200/80"/>
            <div className="ui-skeleton h-3 w-12 rounded bg-zinc-200/80"/>
          </div>
          <div className="ui-skeleton mt-2 h-1.5 w-full rounded-full bg-zinc-200/80"/>
        </div>
        <div className={`rounded-xl border border-zinc-200/80 ${cardSurface} px-3 py-2.5`}>
          <div className="flex items-center justify-between">
            <div className="ui-skeleton h-3 w-20 rounded bg-zinc-200/80"/>
            <div className="ui-skeleton h-3 w-12 rounded bg-zinc-200/80"/>
          </div>
          <div className="ui-skeleton mt-2 h-1.5 w-full rounded-full bg-zinc-200/80"/>
        </div>
      </div>
    ) : Boolean(error) && !data ? (
      <div className={`mt-2.5 flex items-start gap-2 rounded-xl border border-dashed border-zinc-200 ${cardSurface} px-3 py-2.5 text-[12px] leading-5 text-zinc-500`}>
        <AlertCircle size={13} className="mt-0.5 shrink-0 text-zinc-400"/>
        <span>{quotaErrorMessage(error)}</span>
      </div>
    ) : !data ? (
      <div className={`mt-2.5 rounded-xl border border-dashed border-zinc-200 ${cardSurface} px-3 py-2.5 text-[12px] leading-5 text-zinc-500`}>
        点击右上角刷新按钮读取 {displayName} 账号额度。
      </div>
    ) : isMagpieIssue ? (
      <div
        data-magpie-issue={data.unavailableCode}
        className="mt-2.5 flex items-start gap-2 rounded-xl border border-dashed border-amber-200 bg-amber-50/70 px-3 py-2.5 text-[12px] leading-5 text-amber-800"
      >
        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600"/>
        <div className="min-w-0 flex-1">
          <div>{data.reason || 'Magpie 网关暂不可用。'}</div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-amber-200 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-50 disabled:opacity-50"
          >
            <RefreshCw size={10} className={isRefreshing ? 'animate-spin' : ''}/>
            <span>重新检测</span>
          </button>
        </div>
      </div>
    ) : isProviderNoQuota ? (
      <div
        data-magpie-no-quota=""
        className={`mt-2.5 rounded-xl border border-zinc-200/80 ${cardSurface} px-3 py-2.5 text-[12px] leading-5 text-zinc-600`}
      >
        <div>{data.reason || '该供应商未提供上游额度/余额查询。'}</div>
        {data.gatewayStats && <GatewayStatsBlock stats={data.gatewayStats}/>}
      </div>
    ) : data.status === 'unavailable' ? (
      <div className={`mt-2.5 rounded-xl border border-dashed border-zinc-200 ${cardSurface} px-3 py-2.5 text-[12px] leading-5 text-zinc-500`}>
        {data.reason || '当前暂无法获取账号额度。'}
      </div>
    ) : (
      <div className={`${embedded ? 'mt-2' : 'mt-2.5'} space-y-2`}>
        {/* B 类 API Key 余额卡片（如 DeepSeek ¥256.16） */}
        {data.balance && (
          <div
            data-quota-balance=""
            className={`flex items-center justify-between gap-2 rounded-xl border border-zinc-200/80 ${cardSurface} ${cardPad}`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-700">
                <Wallet size={12} className="shrink-0 text-sky-600"/>
                <span>账户余额</span>
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-400">
                {sourceMeta?.providerName ? `${sourceMeta.providerName} API 余额` : 'API Key 余额'}
              </div>
            </div>
            <div className="shrink-0 text-[16px] font-semibold tabular-nums text-zinc-900">
              {data.balance.display}
            </div>
          </div>
        )}

        {/* A 类订阅/积分窗口卡片 */}
        {windows.length > 0 && (
          <div className={gridClass}>
            {windows.map(window => {
              const used = clampPercent(window.usedPercent);
              const remaining = Math.round(100 - used);
              const tone = window.status === 'cooldown' ? 'warning' : quotaUsageTone(used);
              const width = used > 0 ? Math.max(2, used) : 0;
              const countdown = formatQuotaResetCountdown(window.resetsAt, now);
              const exactClock = formatQuotaResetClock(window.resetsAt);
              const runsOut = formatQuotaRunsOutCountdown(window.runsOutAt, now);
              const runsOutClock = formatQuotaResetClock(window.runsOutAt);
              return (
                <div
                  key={window.label}
                  data-quota-window={window.label}
                  className={`rounded-xl border border-zinc-200/80 ${cardSurface} ${cardPad}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 truncate text-[12px] font-medium text-zinc-800">{window.label}</span>
                      {window.aggregated && sourceMeta?.accountCount && sourceMeta.accountCount > 1 && (
                        <span className="shrink-0 rounded bg-zinc-200/70 px-1 py-px text-[10px] font-medium text-zinc-600">
                          {sourceMeta.accountCount} 账号汇总
                        </span>
                      )}
                      {window.status === 'cooldown' && (
                        <span className="shrink-0 rounded bg-amber-100 px-1 py-px text-[10px] font-medium text-amber-700">
                          冷却中
                        </span>
                      )}
                    </div>
                    <span className={`shrink-0 text-[12px] font-semibold tabular-nums ${remainingToneClass[tone]}`}>
                      剩余 {remaining}%
                    </span>
                  </div>
                  <div className={`${embedded ? 'mt-1.5' : 'mt-2'} h-1.5 w-full overflow-hidden rounded-full bg-zinc-200`}>
                    <div
                      className={`h-full rounded-full transition-[width] duration-300 ease-out ${barToneClass[tone]}`}
                      style={{ width: `${width}%` }}
                    />
                  </div>
                  <div className={`${embedded ? 'mt-1' : 'mt-1.5'} flex items-center justify-between gap-2 text-[11px] tabular-nums text-zinc-500`}>
                    <span className="min-w-0 truncate">
                      已用 {Math.round(used)}%{window.display ? ` · ${window.display}` : ''}
                    </span>
                    {countdown && (
                      <HoverTooltipText
                        content={exactClock ? `将于 ${exactClock} 重置` : undefined}
                        className="inline-flex shrink-0 items-center gap-1 text-zinc-400"
                      >
                        <Clock size={10} className="shrink-0"/>
                        <span>{countdown}</span>
                      </HoverTooltipText>
                    )}
                  </div>
                  {runsOut && (
                    <div className="mt-1 flex items-center gap-1 text-[10.5px] tabular-nums text-amber-600">
                      <AlertTriangle size={10} className="shrink-0"/>
                      <HoverTooltipText
                        content={runsOutClock ? `按当前速率预计 ${runsOutClock} 耗尽` : undefined}
                        className="truncate"
                      >
                        {runsOut}
                      </HoverTooltipText>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 多账号池可展开明细（脱敏短名 / alias + 活跃标记） */}
        {hasMultipleAccounts && (
          <div>
            <button
              type="button"
              aria-expanded={accountsExpanded}
              data-magpie-accounts-toggle=""
              onClick={() => setAccountsExpanded(v => !v)}
              className="flex w-full items-center justify-between rounded-lg border border-zinc-200/75 bg-white/80 px-2.5 py-1.5 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-white hover:text-zinc-900"
            >
              <span className="inline-flex items-center gap-1.5">
                <Users size={11} className="shrink-0 text-zinc-400"/>
                <span>{accountsExpanded ? `收起 ${accounts.length} 个账号明细` : `查看 ${accounts.length} 个账号明细`}</span>
              </span>
              <ChevronDown
                size={12}
                className={`shrink-0 text-zinc-400 transition-transform duration-150 ${accountsExpanded ? 'rotate-180' : ''}`}
              />
            </button>
            {accountsExpanded && (
              <div className="mt-1.5 space-y-1.5" data-magpie-accounts-list="">
                {accounts.map((acc, idx) => (
                  <AccountDetailRow key={`${acc.label}-${idx}`} account={acc} now={now}/>
                ))}
              </div>
            )}
          </div>
        )}

        {data.notices && data.notices.length > 0 && (
          <div className="rounded-lg border border-zinc-200/60 bg-zinc-50/60 px-2.5 py-1.5 text-[11px] leading-4 text-zinc-500">
            {data.notices[0]}
          </div>
        )}
      </div>
    )}

    <div className={`${embedded ? 'mt-2' : 'mt-2.5'} flex items-center justify-between gap-2 text-[11px] leading-4 text-zinc-400`}>
      <span className="min-w-0 truncate">
        {stale
          ? '快照超过 5 分钟，数据可能较旧'
          : isMagpie
            ? (sourceMeta?.providerName ? `由 Magpie 同步 · ${sourceMeta.providerName}` : '由本机 Magpie 同步')
            : `来源：${source}`}
      </span>
      <span className="shrink-0">{cacheHintText(data?.cacheTtlMs)}</span>
    </div>
  </>;

  if (embedded) {
    return <section aria-label={`${displayName} 账号额度`}>{content}</section>;
  }

  return (
    <section
      className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-3.5"
      aria-label={`${displayName} 账号额度`}
    >
      {content}
    </section>
  );
}

/** 供会话顶栏与设置页共用的账号额度区块，统一接入 5 分钟前端缓存、Magpie 识别与手动刷新。 */
export function AgentQuotaSection({
  agentId,
  model,
  sessionId,
  variant = 'card',
  active = true
}: {
  agentId: string;
  model?: string;
  sessionId?: string;
  variant?: 'card' | 'embedded';
  active?: boolean;
}) {
  const [sourcePreference, setSourcePreference] = useState<UsageSourcePreference>('auto');
  const usage = useAgentUsage(agentId, { enabled: active, model, sessionId, source: sourcePreference });
  const now = useElapsedNow(active, 30_000);
  return (
    <AgentQuotaView
      agentId={agentId}
      variant={variant}
      data={usage.data}
      updatedAt={usage.updatedAt}
      now={now}
      isLoading={usage.isLoading}
      isRefreshing={usage.isRefreshing}
      error={usage.error}
      sourcePreference={sourcePreference}
      onSourceChange={setSourcePreference}
      onRefresh={usage.refresh}
    />
  );
}

/** 设置菜单（Agent 设置）中复用的账号额度面板。 */
export function AgentUsagePanel({ agentId }: { agentId: QuotaAgentId | string }) {
  return <AgentQuotaSection agentId={agentId} variant="card" active/>;
}
