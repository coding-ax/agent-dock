import { useMemo, useState, type CSSProperties } from 'react';
import { Bot, ChevronDown, ClipboardList } from 'lucide-react';
import { noteTilt, noteTone, parseSupervisionDetail, supervisionChipTone, supervisionKindLabel, supervisionKindTone, supervisionNoticeMode } from './companion-model';
import { supervisionSystemRoundCopy } from './supervision-notice-copy';
import { useCompanion } from './useCompanion';
import { useCompanionStore } from './companion-store';
import { Disclosure } from '../Disclosure';
import { useBi } from '../i18n';

/**
 * daemon 注入主会话的督办信号。以前是一行灰色 details，现在把每条信号画成一张迷你便签：
 * 带事项 id 的点一下就打开抽屉并定位到那张便签；全文仍可展开查看。
 */
export function SupervisionNotice({ text, detail, timestamp }: { text?: string; detail: string; timestamp?: string }) {
  const L = useBi();
  const items = useMemo(() => parseSupervisionDetail(detail), [detail]);
  const noticeMode = supervisionNoticeMode(items.map(item => item.kind));
  const system = noticeMode === 'notice'
    ? { title: L("系统通知 · 用户停止", "System Notice · User Stopped"), badge: L("系统通知", "System Notice"), description: L("用户主动停止了侧边会话；这不是失败，也不是待验收", "Side session was manually stopped by the user (not failed or ready for review)") }
    : supervisionSystemRoundCopy();
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
      <span className="font-semibold text-zinc-700">{noticeMode === 'notice' ? L("通知", "Notice") : L("督办", "Supervision")}</span>
      <span className="min-w-0 truncate">{items.length ? (noticeMode === 'notice' ? L("用户已停止，等用户明确说「继续」", "Stopped by user — waiting for explicit \"continue\"") : L(`${items.length} 条新动静，小猫正在处理`, `${items.length} update(s) being reviewed by companion`)) : (text ?? '').replace(/^(📋|⏸)\s*/, '')}</span>
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
      {open ? L("收起全文", "Collapse") : L("查看全文", "Expand")}<ChevronDown size={11} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}/>
    </button>}
    {detail && <Disclosure open={open}>
      <pre className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-5 text-zinc-500">{detail}</pre>
    </Disclosure>}
  </div>;
}
