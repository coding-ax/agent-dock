import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, RotateCcw, Search, X } from 'lucide-react';
import { api, type Agent, type Session } from './api';
import { AgentIcon } from './AgentIcon';
import { useModalFocusTrap } from './useModalFocusTrap';
import { DeferredMount, DeferredSkeleton } from './DeferredMount';
import { formatScheduleTime } from './schedule-view';

/**
 * 归档会话列表。早先是侧边栏里的展开区，挂在整棵会话树底部：会话一多，点了按钮
 * 也要滚到底才看得见，看上去就是「点不开」。改成弹窗，并支持按标题/目录过滤。
 */
export function ArchivedSessionsDialog({ sessions, agents, mainSessionId, onClose, onOpenSession }: { sessions: Session[]; agents: Agent[]; mainSessionId?: string; onClose(): void; onOpenSession(id: string): void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  useModalFocusTrap({ panel: panelRef, initial: inputRef, dismissible: true, onDismiss: onClose });
  const [keyword, setKeyword] = useState('');
  const [restoreError, setRestoreError] = useState<string>();
  const restore = useMutation({
    mutationFn: (sessionId: string) => api.assistantRestoreMain(sessionId),
    onSuccess: result => {
      setRestoreError(undefined);
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === result.session.id ? result.session : item));
      void qc.invalidateQueries({ queryKey: ['assistant-state'] });
      void qc.invalidateQueries({ queryKey: ['assistant-lifecycle'] });
      onOpenSession(result.session.id);
    },
    onError: error => setRestoreError(error.message)
  });
  const names = useMemo(() => new Map(agents.map(agent => [agent.id, agent.name])), [agents]);
  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    const sorted = [...sessions].sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));
    return needle ? sorted.filter(session => [session.title, session.cwd, session.id].some(value => value?.toLowerCase().includes(needle))) : sorted;
  }, [sessions, keyword]);

  return <div className="ui-overlay fixed inset-0 z-[60] grid place-items-center bg-zinc-950/30 p-2 sm:p-4" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label="归档会话" className="ui-dialog flex h-[min(720px,86dvh)] w-full max-w-2xl flex-col overflow-hidden rounded-[14px] border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-100 px-4">
        <div className="flex items-center gap-2 text-[16px] font-semibold text-zinc-900"><Archive size={16}/>归档会话</div>
        <span className="text-[12px] tabular-nums text-zinc-400">{sessions.length} 个，只读</span>
        <button type="button" onClick={onClose} aria-label="关闭" className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={16}/></button>
      </div>
      <div className="shrink-0 border-b border-zinc-100 px-4 py-2.5">
        <div className="flex h-8 items-center gap-2 rounded-md border border-zinc-200 px-2.5 ui-field-within">
          <Search size={13} className="shrink-0 text-zinc-400"/>
          <input ref={inputRef} value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="按标题、工作目录或会话 ID 过滤" className="min-w-0 flex-1 bg-transparent text-[12px] text-zinc-800 outline-none placeholder:text-zinc-400"/>
        </div>
      </div>
      <DeferredMount placeholder={<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3"><DeferredSkeleton/></div>}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!filtered.length && <div className="px-4 py-8 text-center text-[12px] text-zinc-400">{keyword ? '没有匹配的归档会话' : '还没有归档会话'}</div>}
        {filtered.map(session => {
          const isMain = session.id === mainSessionId;
          return <div key={session.id} className="flex items-center gap-3 border-b border-zinc-100 px-4 py-2.5 transition-colors last:border-b-0 hover:bg-zinc-50">
            <AgentIcon agentId={session.agentId} agentName={names.get(session.agentId)} size={14}/>
            <button type="button" onClick={() => onOpenSession(session.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[13px] text-zinc-800" title={session.title}>{session.title || names.get(session.agentId) || session.agentId}</span>
                  {isMain && <span className="shrink-0 rounded-full bg-amber-100 px-1.5 text-[10.5px] font-medium leading-[18px] text-amber-800">当前主会话 · 可恢复</span>}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[12px] text-zinc-400" title={session.cwd}>{session.cwd}</span>
              </span>
            </button>
            {isMain
              ? <button type="button" disabled={restore.isPending} onClick={() => restore.mutate(session.id)} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 text-[11.5px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50">
                <RotateCcw size={11} className={restore.isPending && restore.variables === session.id ? 'animate-spin' : ''}/>{restore.isPending && restore.variables === session.id ? '恢复中…' : '恢复主会话'}
              </button>
              : <span className="shrink-0 text-[12px] tabular-nums text-zinc-400">归档于 {formatScheduleTime(session.archivedAt)}</span>}
          </div>;
        })}
      </div>
      </DeferredMount>
      {restoreError && <div className="shrink-0 border-t border-red-100 bg-red-50 px-4 py-2 text-[12px] text-red-700">{restoreError}</div>}
    </div>
  </div>;
}
