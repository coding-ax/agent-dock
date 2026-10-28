import { useMemo, useRef, useState } from 'react';
import { Archive, Search, X } from 'lucide-react';
import type { Agent, Session } from './api';
import { AgentIcon } from './AgentIcon';
import { useModalFocusTrap } from './useModalFocusTrap';
import { formatScheduleTime } from './schedule-view';

/**
 * 归档会话列表。早先是侧边栏里的展开区，挂在整棵会话树底部：会话一多，点了按钮
 * 也要滚到底才看得见，看上去就是「点不开」。改成弹窗，并支持按标题/目录过滤。
 */
export function ArchivedSessionsDialog({ sessions, agents, onClose, onOpenSession }: { sessions: Session[]; agents: Agent[]; onClose(): void; onOpenSession(id: string): void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: inputRef, dismissible: true, onDismiss: onClose });
  const [keyword, setKeyword] = useState('');
  const names = useMemo(() => new Map(agents.map(agent => [agent.id, agent.name])), [agents]);
  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    const sorted = [...sessions].sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));
    return needle ? sorted.filter(session => [session.title, session.cwd, session.id].some(value => value?.toLowerCase().includes(needle))) : sorted;
  }, [sessions, keyword]);

  return <div className="ui-overlay fixed inset-0 z-[60] grid place-items-center bg-zinc-950/30 p-2 backdrop-blur-[2px] sm:p-4" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label="归档会话" className="ui-dialog flex h-[min(720px,86dvh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-100 px-4">
        <div className="flex items-center gap-2 text-[14px] font-semibold text-zinc-900"><Archive size={16}/>归档会话</div>
        <span className="text-[11px] tabular-nums text-zinc-400">{sessions.length} 个，只读</span>
        <button type="button" onClick={onClose} aria-label="关闭" className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={16}/></button>
      </div>
      <div className="shrink-0 border-b border-zinc-100 px-4 py-2.5">
        <div className="flex h-8 items-center gap-2 rounded-md border border-zinc-200 px-2.5 ui-field-within">
          <Search size={13} className="shrink-0 text-zinc-400"/>
          <input ref={inputRef} value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="按标题、工作目录或会话 ID 过滤" className="min-w-0 flex-1 bg-transparent text-[12px] text-zinc-800 outline-none placeholder:text-zinc-400"/>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!filtered.length && <div className="px-4 py-8 text-center text-[12px] text-zinc-400">{keyword ? '没有匹配的归档会话' : '还没有归档会话'}</div>}
        {filtered.map(session => <button key={session.id} type="button" onClick={() => onOpenSession(session.id)} className="flex w-full items-center gap-3 border-b border-zinc-100 px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-zinc-50">
          <AgentIcon agentId={session.agentId} agentName={names.get(session.agentId)} size={14}/>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] text-zinc-800" title={session.title}>{session.title || names.get(session.agentId) || session.agentId}</div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-400" title={session.cwd}>{session.cwd}</div>
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">归档于 {formatScheduleTime(session.archivedAt)}</span>
        </button>)}
      </div>
    </div>
  </div>;
}
