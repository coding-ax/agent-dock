import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Bot, Cpu, Folder, MessageSquare, RefreshCw, X, Zap } from 'lucide-react';
import { api, type Agent, type UsageBreakdownGroup, type UsageQueryParams } from './api';
import { formatTokens } from './composer-utils';
import { bi, useBi } from './i18n';

type RangePreset = 'today' | '7d' | '30d' | 'all' | 'custom';

function localDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function presetDates(preset: Exclude<RangePreset, 'custom'>): { from?: string; to?: string } {
  if (preset === 'all') return {};
  const now = new Date();
  const to = localDateInputValue(now);
  if (preset === 'today') return { from: to, to };
  const days = preset === '7d' ? 7 : 30;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return { from: localDateInputValue(start), to };
}

function formatTps(tps: number | null | undefined): string {
  return tps !== null && tps !== undefined ? `${tps.toFixed(1)} t/s` : '—';
}

function formatCost(costUsd: number | null | undefined): string {
  if (!costUsd || costUsd <= 0) return '—';
  return `$${costUsd.toFixed(costUsd >= 1 ? 2 : 4)}`;
}

const groupTabs: Array<{ id: UsageBreakdownGroup; label: string; icon: typeof Folder }> = [
  { id: 'project', get label() { return bi("按项目", "By Project"); }, icon: Folder },
  { id: 'agent', get label() { return bi("按 Agent", "By Agent"); }, icon: Bot },
  { id: 'session', get label() { return bi("按会话", "By Session"); }, icon: MessageSquare },
  { id: 'model', get label() { return bi("按模型", "By Model"); }, icon: Cpu }
];

export function UsageDashboardDialog({
  agents,
  onClose,
  onOpenSession
}: {
  agents: Agent[];
  onClose(): void;
  onOpenSession(sessionId: string): void;
}) {
  const L = useBi();
  const [preset, setPreset] = useState<RangePreset>('7d');
  const initial7d = useMemo(() => presetDates('7d'), []);
  const [from, setFrom] = useState(initial7d.from ?? '');
  const [to, setTo] = useState(initial7d.to ?? '');
  const [agentFilter, setAgentFilter] = useState('');
  const [groupBy, setGroupBy] = useState<UsageBreakdownGroup>('project');

  const applyPreset = (next: Exclude<RangePreset, 'custom'>) => {
    setPreset(next);
    const bounds = presetDates(next);
    setFrom(bounds.from ?? '');
    setTo(bounds.to ?? '');
  };

  const queryParams = useMemo<UsageQueryParams>(() => ({
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(agentFilter ? { agentId: agentFilter } : {})
  }), [from, to, agentFilter]);

  const summary = useQuery({
    queryKey: ['usage-summary', queryParams],
    queryFn: () => api.usageSummary(queryParams),
    staleTime: 15_000
  });

  const breakdown = useQuery({
    queryKey: ['usage-breakdown', groupBy, queryParams],
    queryFn: () => api.usageBreakdown(groupBy, { ...queryParams, limit: 100 }),
    staleTime: 15_000
  });

  const refreshing = summary.isFetching || breakdown.isFetching;
  const refreshAll = () => {
    void summary.refetch();
    void breakdown.refetch();
  };

  const totals = summary.data?.totals;
  const daily = summary.data?.daily ?? [];
  const maxDailyTokens = useMemo(() => Math.max(1, ...daily.map(d => d.totalTokens)), [daily]);
  const items = breakdown.data?.items ?? [];
  const maxItemTokens = useMemo(() => Math.max(1, ...items.map(i => i.totals.totalTokens)), [items]);

  return (
    <div
      className="ui-overlay ui-overlay-sheet fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-0 sm:p-6"
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={L("消耗看板", "Usage Dashboard")}
        className="ui-dialog flex h-[100dvh] max-h-[100dvh] w-full max-w-5xl flex-col overflow-hidden rounded-none border-0 bg-white text-zinc-900 shadow-[0_24px_80px_rgba(12,13,16,.24)] sm:h-auto sm:max-h-[90dvh] sm:rounded-2xl sm:border sm:border-zinc-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-3.5 py-3 sm:px-5 sm:py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <BarChart3 size={18} className="shrink-0 text-zinc-700"/>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-zinc-900">{L("消耗看板", "Usage Dashboard")}</h2>
              <p className="truncate text-[11px] text-zinc-500">{L("基于各 Agent 通过 ACP 真实上报的 Token 与耗时统计（不含估算）", "Actual token and duration telemetry reported by Agents via ACP (no estimates)")}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={refreshAll}
              disabled={refreshing}
              aria-label={L("刷新消耗看板", "Refresh usage dashboard")}
              className="grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-50"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''}/>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={L("关闭", "Close")}
              className="grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
            >
              <X size={16}/>
            </button>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200/80 bg-zinc-50/70 px-3.5 py-2.5 text-[12px] sm:px-5">
          <div className="grid w-full grid-cols-4 items-center rounded-lg border border-zinc-200 bg-white p-0.5 sm:flex sm:w-auto">
            {([
              ['today', L("今天", "Today")],
              ['7d', L("近 7 天", "7 Days")],
              ['30d', L("近 30 天", "30 Days")],
              ['all', L("全部", "All Time")]
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => applyPreset(key)}
                className={`rounded-md px-2 py-1 text-center text-[12px] font-medium transition-colors sm:px-2.5 ${
                  preset === key ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex w-full items-center gap-1.5 sm:w-auto">
            <input
              type="date"
              aria-label={L("开始日期", "Start date")}
              value={from}
              onChange={e => { setPreset('custom'); setFrom(e.target.value); }}
              className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2 text-[12px] text-zinc-700 outline-none focus:border-zinc-400 sm:h-7 sm:flex-none"
            />
            <span className="shrink-0 text-zinc-400">{L("至", "to")}</span>
            <input
              type="date"
              aria-label={L("结束日期", "End date")}
              value={to}
              onChange={e => { setPreset('custom'); setTo(e.target.value); }}
              className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2 text-[12px] text-zinc-700 outline-none focus:border-zinc-400 sm:h-7 sm:flex-none"
            />
          </div>

          <select
            aria-label={L("按 Agent 筛选", "Filter by Agent")}
            value={agentFilter}
            onChange={e => setAgentFilter(e.target.value)}
            className="h-8 w-full rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] text-zinc-700 outline-none focus:border-zinc-400 sm:ml-auto sm:h-7 sm:w-auto"
          >
            <option value="">{L("全部 Agent", "All Agents")}</option>
            {agents.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-3.5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-5">
          {/* KPI Cards */}
          <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-3 sm:p-3.5">
              <div className="text-[11px] font-medium text-zinc-500">{L("总消耗 Token", "Total Tokens")}</div>
              <div className="mt-1 text-[19px] font-semibold tabular-nums text-zinc-900 sm:text-[22px]">
                {totals ? formatTokens(totals.totalTokens) : '—'}
              </div>
              {totals && (
                <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-zinc-500">
                  <span>{L("输入", "Input")} {formatTokens(totals.inputTokens)}</span>
                  <span>{L("缓存", "Cache")} {formatTokens(totals.cacheReadTokens)}</span>
                  <span>{L("输出", "Output")} {formatTokens(totals.outputTokens)}</span>
                  {totals.thoughtTokens > 0 && <span>{L("思考", "Thinking")} {formatTokens(totals.thoughtTokens)}</span>}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-3 sm:p-3.5">
              <div className="flex items-center gap-1 text-[11px] font-medium text-zinc-500">
                <Zap size={12}/><span>{L("平均生成速度 (TPS)", "Avg Speed (TPS)")}</span>
              </div>
              <div className="mt-1 text-[19px] font-semibold tabular-nums text-zinc-900 sm:text-[22px]">
                {formatTps(totals?.avgTps)}
              </div>
              <div className="mt-1.5 text-[11px] text-zinc-500">
                
                {L("扣除工具与审批等待后的有效输出速率", "Effective output speed excluding tool and approval waits")}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-3 sm:p-3.5">
              <div className="text-[11px] font-medium text-zinc-500">{L("费用（Agent 上报）", "Cost (Reported)")}</div>
              <div className="mt-1 text-[19px] font-semibold tabular-nums text-zinc-900 sm:text-[22px]">
                {formatCost(totals?.costUsd)}
              </div>
              <div className="mt-1.5 text-[11px] text-zinc-500">
                
                {L("仅汇总 Agent 主动回报的 USD 费用", "Aggregates USD costs explicitly reported by Agents")}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-3 sm:p-3.5">
              <div className="text-[11px] font-medium text-zinc-500">{L("活跃规模", "Activity")}</div>
              <div className="mt-1 text-[19px] font-semibold tabular-nums text-zinc-900 sm:text-[22px]">
                {totals ? L(`${totals.sessionCount} 会话`, `${totals.sessionCount} sessions`) : '—'}
              </div>
              <div className="mt-1.5 text-[11px] tabular-nums text-zinc-500">
                
                {L("共", "")} {totals?.turnCount ?? 0}  {L("轮真实统计记录", " verified turns")}
              </div>
            </div>
          </div>

          {/* Daily Trend */}
          {daily.length > 0 && (
            <div className="rounded-xl border border-zinc-200 bg-white p-3.5">
              <div className="mb-3 flex items-center justify-between text-[12px]">
                <span className="font-medium text-zinc-800">{L("每日消耗趋势", "Daily Token Trend")}</span>
                <span className="text-[11px] text-zinc-400">{L("悬停柱条查看当日明细", "Hover bars for daily breakdown")}</span>
              </div>
              <div className="flex h-28 items-end gap-1.5 overflow-x-auto pb-1">
                {daily.map(point => {
                  const pct = Math.max(6, Math.round((point.totalTokens / maxDailyTokens) * 100));
                  return (
                    <div
                      key={point.date}
                      title={L(`${point.date}：${formatTokens(point.totalTokens)} tokens（${point.turnCount} 轮 · ${formatTps(point.avgTps)}）`, `${point.date}: ${formatTokens(point.totalTokens)} tokens (${point.turnCount} turns · ${formatTps(point.avgTps)})`)}
                      className="group flex min-w-[26px] flex-1 flex-col items-center gap-1"
                    >
                      <div className="flex h-20 w-full items-end justify-center">
                        <div
                          style={{ height: `${pct}%` }}
                          className="w-full max-w-[34px] rounded-t-md bg-zinc-800/80 transition-colors group-hover:bg-blue-600"
                        />
                      </div>
                      <span className="text-[10px] tabular-nums text-zinc-400">{point.date.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Breakdown Tabs & Table */}
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-3.5 py-2.5">
              <div className="flex flex-wrap items-center gap-1">
                {groupTabs.map(tab => {
                  const Icon = tab.icon;
                  const active = groupBy === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setGroupBy(tab.id)}
                      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                        active ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                      }`}
                    >
                      <Icon size={13}/><span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>
              <span className="text-[11px] tabular-nums text-zinc-400">{L("按总 Token 降序 · 共", "Sorted by tokens · ")} {items.length}  {L("项", " items")}</span>
            </div>

            {breakdown.isLoading ? (
              <div className="px-4 py-10 text-center text-[13px] text-zinc-400">{L("正在加载消耗统计…", "Loading usage statistics…")}</div>
            ) : !items.length ? (
              <div className="px-4 py-10 text-center text-[13px] text-zinc-400">{L("当前筛选条件下暂无真实 Token 消耗记录。", "No token usage records match the current filter.")}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-zinc-200/80 bg-zinc-50 text-[11px] font-medium text-zinc-500">
                      <th className="sticky left-0 z-10 min-w-[160px] whitespace-nowrap bg-zinc-50 px-3.5 py-2.5 font-medium">{L("名称", "Name")}</th>
                      <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">{L("总 Token", "Total Tokens")}</th>
                      <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">{L("输入", "Input")}</th>
                      <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">{L("缓存读", "Cache Read")}</th>
                      <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">{L("输出", "Output")}</th>
                      <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">{L("思考", "Thinking")}</th>
                      <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">{L("平均 TPS", "Avg TPS")}</th>
                      <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">{L("轮次", "Turns")}</th>
                      <th className="whitespace-nowrap px-3.5 py-2.5 text-right font-medium">{L("费用", "Cost")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {items.map(item => {
                      const ratio = Math.max(2, Math.round((item.totals.totalTokens / maxItemTokens) * 100));
                      const clickable = groupBy === 'session' && Boolean(item.sessionId);
                      return (
                        <tr
                          key={item.key}
                          onClick={clickable ? () => { onClose(); onOpenSession(item.sessionId!); } : undefined}
                          className={`group transition-colors hover:bg-zinc-50 ${clickable ? 'cursor-pointer' : ''}`}
                        >
                          <td className="sticky left-0 max-w-[260px] bg-white px-3.5 py-2.5 align-middle transition-colors group-hover:bg-zinc-50">
                            <div className="truncate font-medium text-zinc-900">{item.label}</div>
                            {item.sublabel && item.sublabel !== item.label && (
                              <div className="truncate font-mono text-[11px] text-zinc-400">{item.sublabel}</div>
                            )}
                            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-100">
                              <div className="h-full rounded-full bg-zinc-800/75" style={{ width: `${ratio}%` }}/>
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right align-middle font-semibold tabular-nums text-zinc-900">{formatTokens(item.totals.totalTokens)}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right align-middle tabular-nums text-zinc-600">{formatTokens(item.totals.inputTokens)}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right align-middle tabular-nums text-zinc-500">{formatTokens(item.totals.cacheReadTokens)}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right align-middle tabular-nums text-zinc-600">{formatTokens(item.totals.outputTokens)}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right align-middle tabular-nums text-zinc-500">{item.totals.thoughtTokens > 0 ? formatTokens(item.totals.thoughtTokens) : '—'}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right align-middle tabular-nums text-zinc-700">{formatTps(item.totals.avgTps)}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right align-middle tabular-nums text-zinc-600">{item.totals.turnCount}</td>
                          <td className="whitespace-nowrap px-3.5 py-2.5 text-right align-middle tabular-nums text-zinc-600">{formatCost(item.totals.costUsd)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
