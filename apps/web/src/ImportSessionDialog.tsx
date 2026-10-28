import { useMemo, useRef, useState } from 'react';
import { useUpdateEffect } from 'ahooks';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Download, FolderOpen, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { api, type Agent, type ExternalSession, type Session } from './api';
import { AgentIcon } from './AgentIcon';
import { useModalFocusTrap } from './useModalFocusTrap';
import { useToast } from './Toast';
import { matchesExternalSession } from './external-session-search';

/** 集成方式：full=把外部历史回填成 AgentDock 轮次；session=只接管上下文，不回填历史。 */
type ImportMode = 'full' | 'session';

function formatUpdatedAt(value?: string): string {
  if (!value) return '';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

function SessionRow({ session, selected, onSelect }: { session: ExternalSession; selected: boolean; onSelect(): void }) {
  return <button type="button" onClick={onSelect} aria-pressed={selected} className={`flex w-full items-center gap-3 border-b border-zinc-100 px-4 py-2.5 text-left transition-colors last:border-b-0 ${selected ? 'bg-blue-50/70' : 'hover:bg-zinc-50'}`}>
    <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${selected ? 'border-blue-500 bg-blue-500 text-white' : 'border-zinc-300 text-transparent'}`}><Check size={11}/></span>
    <div className="min-w-0 flex-1">
      <div className="truncate text-[13px] text-zinc-800" title={session.title ?? session.sessionId}>{session.title?.trim() || '（无标题）'}</div>
      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-zinc-400">
        <span className="truncate font-mono" title={session.cwd}>{session.cwd}</span>
        {session.updatedAt && <span className="shrink-0 tabular-nums">{formatUpdatedAt(session.updatedAt)}</span>}
      </div>
    </div>
    <span className="hidden shrink-0 font-mono text-[10px] text-zinc-300 sm:inline" title={session.sessionId}>{session.sessionId.slice(0, 8)}</span>
  </button>;
}

const modeHint: Record<ImportMode, string> = {
  full: '完整导入：把外部历史写进 AgentDock 时间线，并接管后续对话。',
  session: '仅接管会话：不回填历史，但 Agent 记得之前的上下文，下一条消息即可继续。'
};

/**
 * 外部会话导入面板。
 *
 * 列表来自各 Agent 自己的 ACP `session/list`（只读、不落库）；选中后走 `/api/sessions/import`：
 * 接管上下文（`resumeSessionId`），并可选地把外部历史回填成 AgentDock 轮次。
 */
export function ImportSessionDialog({ agents, onClose, onImported }: { agents: Agent[]; onClose(): void; onImported(session: Session): void }) {
  const qc = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: panelRef, dismissible: true, onDismiss: onClose });
  const candidates = useMemo(() => agents.filter(agent => !agent.disabled && (agent.protocol === 'auto' || agent.protocol === 'acp')), [agents]);
  const [selectedId, setSelectedId] = useState<string | undefined>(candidates[0]?.id);
  const [keyword, setKeyword] = useState('');
  const [mode, setMode] = useState<ImportMode>('full');
  const [picked, setPicked] = useState<ExternalSession | undefined>();
  const selected = candidates.find(agent => agent.id === selectedId);

  const query = useInfiniteQuery({
    queryKey: ['external-sessions', selectedId],
    enabled: Boolean(selectedId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.externalSessions(selectedId!, pageParam ? { cursor: pageParam } : {}),
    getNextPageParam: last => last.nextCursor || undefined,
    refetchOnWindowFocus: false,
    staleTime: 30_000
  });

  const sessions = useMemo(() => query.data?.pages.flatMap(page => page.sessions) ?? [], [query.data]);
  const filtered = useMemo(() => sessions.filter(session => matchesExternalSession(session, keyword)), [sessions, keyword]);

  const importSession = useMutation({
    mutationFn: () => api.importSession({ agentId: selectedId!, externalSessionId: picked!.sessionId, cwd: picked!.cwd, mode }),
    onSuccess: session => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      onImported(session);
      onClose();
    }
  });

  const importError = importSession.error instanceof Error ? importSession.error.message : undefined;
  const toast = useToast();
  // 每次导入失败都换成一条 toast（同一时刻只有一条，不堆叠）。
  useUpdateEffect(() => {
    if (importError) toast.show(`导入失败：${importError}`);
  }, [importError]);
  const canImport = Boolean(selectedId && picked) && !importSession.isPending;

  return <div className="ui-overlay fixed inset-0 z-[60] grid place-items-center bg-zinc-950/30 p-2 backdrop-blur-[2px] sm:p-4">
    <div ref={panelRef} className="ui-dialog flex h-[86dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-100 px-4">
        <div className="flex items-center gap-2 text-[14px] font-semibold text-zinc-900"><FolderOpen size={16}/>导入外部会话</div>
        <span className="hidden truncate text-[11px] text-zinc-400 sm:inline">浏览各 Agent 自己记录的会话，选中后导入到 AgentDock</span>
        <button type="button" onClick={onClose} aria-label="关闭" className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={16}/></button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[200px_1fr]">
        <div className="hidden min-h-0 overflow-y-auto border-r border-zinc-100 bg-zinc-50/60 p-2 md:block">
          {candidates.map(agent => {
            const active = agent.id === selectedId;
            return <button key={agent.id} type="button" onClick={() => { setSelectedId(agent.id); setKeyword(''); setPicked(undefined); }} className={`flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12px] font-medium transition-colors ${active ? 'bg-white text-zinc-900 shadow-[0_1px_2px_rgba(24,24,27,.06)]' : 'text-zinc-600 hover:bg-white/70'}`}>
              <AgentIcon agentId={agent.id} agentName={agent.name} size={14}/>
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
            </button>;
          })}
          {candidates.length === 0 && <div className="px-2 py-2 text-[11px] text-zinc-400">没有支持 ACP 的 Agent</div>}
        </div>

        <div className="flex min-h-0 min-w-0 flex-col">
          {/* 窄屏没有左侧栏，用一排可横滑的 Agent 胶囊替代。 */}
          <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-zinc-100 bg-zinc-50/60 px-3 py-2 md:hidden">
            {candidates.map(agent => {
              const active = agent.id === selectedId;
              return <button key={agent.id} type="button" onClick={() => { setSelectedId(agent.id); setKeyword(''); setPicked(undefined); }} className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors ${active ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 bg-white text-zinc-600'}`}>
                <AgentIcon agentId={agent.id} agentName={agent.name} size={13}/>
                {agent.name}
              </button>;
            })}
            {candidates.length === 0 && <span className="px-1 text-[11px] text-zinc-400">没有支持 ACP 的 Agent</span>}
          </div>
          <div className="flex shrink-0 items-center gap-2 border-b border-zinc-100 px-4 py-2.5">
            <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-zinc-200 px-2.5 ui-field-within">
              <Search size={13} className="shrink-0 text-zinc-400"/>
              <input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="按标题、工作目录或会话 ID 过滤（支持 codex://threads/…）" className="min-w-0 flex-1 bg-transparent text-[12px] text-zinc-800 placeholder:text-zinc-400 outline-none"/>
            </div>
            <button type="button" disabled={!selectedId || query.isFetching} onClick={() => query.refetch()} className="flex h-8 items-center gap-1 rounded-md border border-zinc-200 px-2.5 text-[11px] text-zinc-600 hover:bg-zinc-50 disabled:opacity-40"><RefreshCw size={12} className={query.isFetching ? 'animate-spin' : ''}/>刷新</button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {query.isLoading && <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-zinc-400"><LoaderCircle size={13} className="animate-spin"/>正在读取会话列表…</div>}
            {query.isError && <div className="m-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-5 text-red-700">{query.error instanceof Error ? query.error.message : '读取失败'}</div>}
            {!query.isLoading && !query.isError && query.data?.pages[0]?.supported === false && <div className="m-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">该 Agent 未实现会话列表能力（ACP session/list），暂时无法浏览它的历史会话。</div>}
            {!query.isLoading && !query.isError && query.data?.pages[0]?.supported !== false && filtered.length === 0 && <div className="px-4 py-3 text-[12px] text-zinc-400">{keyword ? '没有匹配的会话' : '这个 Agent 没有历史会话'}</div>}
            {filtered.map(session => <SessionRow key={`${session.cwd}:${session.sessionId}`} session={session} selected={picked?.sessionId === session.sessionId && picked?.cwd === session.cwd} onSelect={() => setPicked(session)}/>)}
            {query.hasNextPage && !keyword && <div className="p-3"><button type="button" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-zinc-200 text-[11px] text-zinc-600 hover:bg-zinc-50 disabled:opacity-40">{query.isFetchingNextPage ? <LoaderCircle size={12} className="animate-spin"/> : null}加载更多</button></div>}
          </div>

          <div className="shrink-0 border-t border-zinc-100 px-4 py-2.5">
            <div className="flex flex-col gap-2 text-[11px] text-zinc-400 sm:flex-row sm:items-center sm:gap-3">
              <span className="min-w-0 flex-1 truncate">已列出 {filtered.length} 条{query.hasNextPage ? '（还有更多）' : ''}{picked ? ` · 已选 ${picked.sessionId.slice(0, 8)}` : ''}</span>
              <div className="flex w-full shrink-0 items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5 sm:w-auto">
                {(['full', 'session'] as const).map(value => <button key={value} type="button" onClick={() => setMode(value)} className={`flex-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors sm:flex-none ${mode === value ? 'bg-white text-zinc-900 shadow-[0_1px_2px_rgba(24,24,27,.08)]' : 'text-zinc-500 hover:text-zinc-800'}`}>{value === 'full' ? '完整导入' : '仅接管会话'}</button>)}
              </div>
              <button type="button" disabled={!canImport} onClick={() => importSession.mutate()} className="flex h-8 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-[11px] font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400 sm:w-auto">{importSession.isPending ? <LoaderCircle size={12} className="animate-spin"/> : <Download size={12}/>}导入</button>
            </div>
            <p className="mt-1.5 text-[10px] leading-4 text-zinc-400">{modeHint[mode]}</p>
          </div>
        </div>
      </div>
    </div>
    {toast.toast}
  </div>;
}
