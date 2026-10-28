import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { api, WebAccessDeniedError, type AgentUsage, type CodexUsage } from './api';

type UsageAgent = 'codex' | 'claude' | 'cursor';
const names: Record<UsageAgent, string> = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor' };
const percent = (value: number) => `${Math.round(value)}%`;

export function AgentUsagePanel({ agentId }: { agentId: UsageAgent }) {
  const client = useQueryClient();
  const fetchUsage = (refresh = false): Promise<AgentUsage | CodexUsage> => agentId === 'codex' ? api.codexUsage(refresh) : agentId === 'claude' ? api.claudeUsage(refresh) : api.cursorUsage(refresh);
  const key = ['agent-usage', agentId];
  const usage = useQuery({ queryKey: key, queryFn: () => fetchUsage(), staleTime: 60_000, refetchOnWindowFocus: false });
  const refresh = useMutation({ mutationFn: () => fetchUsage(true), onSuccess: data => client.setQueryData(key, data) });
  const data = refresh.data ?? usage.data;
  const error = refresh.error ?? usage.error;
  const stale = data && 'stale' in data && data.stale;
  const source = data && 'source' in data && data.source;
  return <section className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-3" aria-label={`${names[agentId]} 额度`}>
    <div className="flex items-center gap-2">
      <div className="text-[12px] font-semibold text-zinc-800">{names[agentId]} 额度</div>
      {data?.plan && <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-zinc-500">{data.plan}</span>}
      <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending} aria-label={`刷新 ${names[agentId]} 额度`} title="刷新额度" className="ml-auto grid h-7 w-7 place-items-center rounded-md text-zinc-500 hover:bg-white hover:text-zinc-800 disabled:opacity-50">{refresh.isPending ? <LoaderCircle size={13} className="animate-spin"/> : <RefreshCw size={13}/>}</button>
    </div>
    {usage.isLoading ? <div className="mt-2 text-[11px] text-zinc-500">正在读取额度…</div>
      : error && !data ? <div className="mt-2 text-[11px] text-zinc-500">{error instanceof WebAccessDeniedError && error.status === 403 ? '当前会话链接无权查看账号额度，请使用控制台地址。' : '额度读取失败，请稍后重试。'}</div>
      : data?.status === 'unavailable' ? <div className="mt-2 text-[11px] leading-5 text-zinc-500">{data.reason}</div>
      : <div className="mt-2 space-y-3">{data?.windows.map(window => <div key={window.label}>
        <div className="flex items-baseline justify-between text-[11px]"><span className="font-medium text-zinc-700">{window.label}</span><span className="tabular-nums text-zinc-600">已用 {percent(window.usedPercent)} · 剩余 {percent(100 - window.usedPercent)}</span></div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-200"><div className={`h-full rounded-full ${window.usedPercent >= 90 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${window.usedPercent}%` }}/></div>
        {window.resetsAt && <div className="mt-1 text-right text-[10px] text-zinc-400">{new Date(window.resetsAt * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置</div>}
      </div>)}</div>}
    <div className="mt-3 border-t border-zinc-200 pt-2 text-[10px] leading-4 text-zinc-400">{stale ? '快照超过 5 分钟，数据可能过期。' : source ? `来源：${source}。` : '本机 Codex CLI 账号。'} 自动缓存 1 分钟。</div>
  </section>;
}
