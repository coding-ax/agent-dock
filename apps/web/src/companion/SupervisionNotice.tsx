import { useMemo, useState, type CSSProperties } from 'react';
import { Bot, ChevronDown, ClipboardList } from 'lucide-react';
import { noteTilt, noteTone, parseSupervisionDetail, supervisionChipTone, supervisionKindLabel, supervisionKindTone } from './companion-model';
import { supervisionSystemRoundCopy } from './supervision-notice-copy';
import { useCompanion } from './useCompanion';
import { useCompanionStore } from './companion-store';

/**
 * daemon 注入主会话的督办信号。以前是一行灰色 details，现在把每条信号画成一张迷你便签：
 * 带事项 id 的点一下就打开抽屉并定位到那张便签；全文仍可展开查看。
 */
export function SupervisionNotice({ text, detail, timestamp }: { text?: string; detail: string; timestamp?: string }) {
  const items = useMemo(() => parseSupervisionDetail(detail), [detail]);
  const system = supervisionSystemRoundCopy();
  const { tasks } = useCompanion();
  const [open, setOpen] = useState(false);
  const time = timestamp ? new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  return <div className="ui-timeline-item ui-supervision">
    <div className="ui-supervision-system" role="note" aria-label={`${system.title}（${system.badge}）`}>
      <span className="ui-supervision-system-icon"><Bot size={15}/></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words text-[13px] font-semibold leading-5 text-zinc-800">{system.title}</span>
          <span className="ui-supervision-system-badge">{system.badge}</span>
        </div>
        <p className="mt-0.5 text-[11.5px] leading-4 text-zinc-500">{system.description}</p>
      </div>
    </div>
    <div className="mt-3 flex items-center gap-2 text-[12.5px] text-zinc-600">
      <ClipboardList size={14} className="shrink-0 text-zinc-500"/>
      <span className="font-semibold text-zinc-700">督办</span>
      <span className="min-w-0 truncate">{items.length ? `${items.length} 条新动静，小猫正在处理` : (text ?? '').replace(/^📋\s*/, '')}</span>
      {time && <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-400">{time}</span>}
    </div>
    {items.length > 0 && <div className="mt-2.5 flex flex-wrap gap-2">
      {items.map((item, index) => {
        const task = item.taskId ? tasks.find(candidate => candidate.id === item.taskId) : undefined;
        const tone = supervisionChipTone(item.kind, task ? noteTone(task) : supervisionKindTone[item.kind]);
        const style = { '--tilt': `${noteTilt(item.taskId ?? `${item.title}:${index}`)}deg` } as CSSProperties;
        const body = <>
          <span className="ui-note-dot ui-note-ink"/>
          <span className="min-w-0 truncate font-medium">{task?.title ?? item.title}</span>
          <span className="shrink-0 text-[11px] text-zinc-500">{supervisionKindLabel[item.kind] ?? item.kind}</span>
        </>;
        return task
          ? <button key={index} type="button" title={item.detail || task.title} onClick={() => useCompanionStore.getState().openDrawer({ highlight: task.id })} className={`ui-supervision-chip ui-note-paper-${tone}`} style={style}>{body}</button>
          : <span key={index} title={item.detail} className={`ui-supervision-chip ui-note-paper-${tone}`} style={style}>{body}</span>;
      })}
    </div>}
    {detail && <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-zinc-400 transition-colors hover:text-zinc-700">
      {open ? '收起全文' : '查看全文'}<ChevronDown size={11} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}/>
    </button>}
    {open && <pre className="ui-disclosure-body mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-5 text-zinc-500">{detail}</pre>}
  </div>;
}
