import { useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import type { Agent, Session } from './api';
import { searchSessions, sessionLabel } from './session-groups';
import { useModalFocusTrap } from './useModalFocusTrap';
import { AgentIcon } from './AgentIcon';

/**
 * ⌘K 搜索会话：只负责定位并打开已有会话，不再承担新建——新建统一走首页输入框（DraftComposer）。
 */
export function SessionSearchDialog({ agents, sessions, onClose, onOpen }: {
  agents: Agent[];
  sessions: Session[];
  onClose(): void;
  onOpen(session: Session): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const hits = useMemo(() => searchSessions(sessions, agents, query), [sessions, agents, query]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (hits.length) setCursor(value => (value + 1) % hits.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (hits.length) setCursor(value => (value - 1 + hits.length) % hits.length); }
    else if (event.key === 'Enter') { event.preventDefault(); const hit = hits[cursor]; if (hit) onOpen(hit.session); }
    else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
  };

  useModalFocusTrap({ panel: panelRef, initial: inputRef, dismissible: true, onDismiss: onClose });

  return <div className="ui-overlay fixed inset-0 z-[60] grid place-items-center bg-zinc-950/25 p-3 backdrop-blur-[2px] sm:p-4" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label="搜索会话" className="ui-dialog flex max-h-[calc(100dvh-1.5rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_28px_90px_rgba(24,24,27,.24)] sm:max-h-[calc(100dvh-2rem)]">
      <div className="ui-palette-field flex items-center gap-2.5 border-b border-zinc-100 px-4">
        <Search size={15} className="shrink-0 text-zinc-400"/>
        <input ref={inputRef} value={query} onChange={event => { setQuery(event.target.value); setCursor(0); }} onKeyDown={onKeyDown} placeholder="搜索会话标题、Agent 或工作目录…" className="h-12 min-w-0 flex-1 border-0 bg-transparent text-[13px] text-zinc-900 outline-none placeholder:text-zinc-400"/>
      </div>
      {/* pb-6 是给底部渐隐留的安全区（见 index.css 的 .ui-scroll-fade）。 */}
      <div role="listbox" className="ui-scroll-fade min-h-0 max-h-[46dvh] overflow-y-auto px-1.5 pt-1.5 pb-6">
        {!hits.length && <div className="px-3 py-6 text-center text-[12px] text-zinc-400">{query.trim() ? '没有匹配的会话' : '还没有会话'}</div>}
        {hits.map(({ session, agentName }, index) => {
          const selected = index === cursor;
          return <button key={session.id} type="button" role="option" aria-selected={selected} onMouseEnter={() => setCursor(index)} onClick={() => onOpen(session)} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${selected ? 'bg-zinc-100' : 'hover:bg-zinc-50'}`}>
            <AgentIcon agentId={session.agentId} agentName={agentName} size={16}/>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-zinc-800">{sessionLabel(session, agentName)}</span>
              <span className="mt-0.5 block truncate font-mono text-[10px] leading-4 text-zinc-400">{session.title ? `${agentName} · ` : ''}{session.cwd}</span>
            </span>
            <CornerDownLeft size={13} className={`shrink-0 ${selected ? 'text-zinc-400' : 'text-transparent'}`}/>
          </button>;
        })}
      </div>
      <div className="hidden items-center border-t border-zinc-100 bg-zinc-50/70 px-4 py-2 text-[10px] text-zinc-400 md:flex">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
    </div>
  </div>;
}
