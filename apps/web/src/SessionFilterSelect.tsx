import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEventListener } from 'ahooks';
import { Bot, Check, ChevronDown, Folder, Laptop, Layers3 } from 'lucide-react';
import type { Agent, LarkBotConfig } from './api';
import { HoverTooltipText } from './HoverTooltip';
import { AgentIcon, BotAvatar } from './AgentIcon';

type FilterOption = { value: string; label: string; kind: 'all' | 'local' | 'bot'; detail: string; workspace?: string; model?: string; agent?: string; agentId?: string; avatarUrl?: string; configured?: boolean };

function optionsFor(bots: LarkBotConfig[], agents: Agent[]): FilterOption[] {
  return [
    { value: 'all', label: '全部会话', kind: 'all', detail: '显示所有来源的会话' },
    { value: 'local', label: '本地', kind: 'local', detail: '仅显示本机创建的会话' },
    ...bots.map(bot => ({
      value: bot.appId,
      label: bot.tabLabel,
      kind: 'bot' as const,
      detail: bot.name,
      workspace: bot.workspace?.trim() || undefined,
      model: bot.defaultModel?.trim() || undefined,
      agent: agents.find(agent => agent.id === bot.defaultAgentId)?.name ?? bot.defaultAgentId,
      agentId: bot.defaultAgentId,
      avatarUrl: bot.avatarUrl?.trim() || undefined,
      configured: bot.setupComplete
    }))
  ];
}

/** 机器人取到过飞书头像就用真图，否则维持通用图标。 */
function optionIcon(option: FilterOption, size: number) {
  if (option.kind === 'bot' && option.avatarUrl) return <BotAvatar url={option.avatarUrl} size={size}/>;
  return option.kind === 'all' ? <Layers3 size={size}/> : option.kind === 'local' ? <Laptop size={size}/> : <Bot size={size}/>;
}

export function SessionFilterSelect({ value, bots, agents, onChange }: { value: string; bots: LarkBotConfig[]; agents: Agent[]; onChange(value: string): void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; maxHeight: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const options = optionsFor(bots, agents);
  const selected = options.find(option => option.value === value) ?? options[0]!;

  const place = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(336, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const flip = below < 220 && above > below;
    setPosition({ top: flip ? Math.max(8, rect.top - Math.min(420, above) - 6) : rect.bottom + 6, left, width, maxHeight: Math.min(420, flip ? above : below) });
  };

  const toggle = () => { if (open) setOpen(false); else { place(); setOpen(true); } };
  useEventListener('pointerdown', event => {
    if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
  }, { target: () => document, enable: open });
  useEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    if (!rows.length) return;
    event.preventDefault();
    const index = rows.findIndex(row => row === document.activeElement);
    rows[index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : (index + rows.length + (event.key === 'ArrowDown' ? 1 : -1)) % rows.length]?.focus();
  }, { target: () => document, enable: open });
  useEventListener('resize', () => { if (open) place(); }, { target: () => window, enable: open });
  useEventListener('scroll', () => { if (open) place(); }, { target: () => window, capture: true, enable: open });

  return <>
    <button ref={trigger} type="button" aria-label="筛选会话来源" aria-haspopup="listbox" aria-expanded={open} onClick={toggle} onKeyDown={event => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); place(); setOpen(true); } }} className="flex min-h-10 w-full items-center gap-2.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-left shadow-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50">
      <span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-md bg-zinc-100 text-zinc-600">{optionIcon(selected, 15)}</span>
      <span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-semibold text-zinc-800">{selected.label}</span>{selected.kind === 'bot' ? <span className="flex min-w-0 items-center gap-1 text-[10px] text-zinc-400"><AgentIcon agentId={selected.agentId} agentName={selected.agent} size={12}/><span className="truncate">{selected.agent || '未设置 Agent'} · {selected.model || 'Agent 默认模型'}</span></span> : <span className="block truncate text-[10px] text-zinc-400">{selected.detail}</span>}</span>
      <ChevronDown size={13} className={`shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}/>
    </button>
    {open && position && createPortal(<div ref={menu} role="listbox" aria-label="会话来源" className="ui-popover fixed z-50 overflow-y-auto overscroll-contain rounded-xl border border-zinc-200 bg-white p-1.5 shadow-[0_18px_48px_rgba(24,24,27,.18)]" style={position}>
      {options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); trigger.current?.focus(); }} className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-zinc-100 focus-visible:bg-zinc-100 ${option.value === value ? 'bg-zinc-50' : ''}`}>
        <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-md ${option.value === value ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-500'}`}>{optionIcon(option, 15)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5"><span className="min-w-0 truncate text-[12px] font-semibold text-zinc-800">{option.label}</span>{option.kind === 'bot' && !option.configured && <span className="shrink-0 text-[10px] text-amber-700">待配置</span>}</span>
          {option.kind === 'bot' ? <><span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-zinc-500"><Folder size={10} className="shrink-0"/><HoverTooltipText content={option.workspace || '未设置工作区'} className="min-w-0 truncate">{option.workspace || '未设置工作区'}</HoverTooltipText></span><span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-zinc-500"><AgentIcon agentId={option.agentId} agentName={option.agent} size={12}/><span className="truncate">{option.agent || '未设置 Agent'} · {option.model || 'Agent 默认模型'}</span></span></> : <span className="mt-0.5 block text-[10px] text-zinc-500">{option.detail}</span>}
        </span>
        {option.value === value && <Check size={13} className="mt-1 shrink-0 text-zinc-700"/>}
      </button>)}
    </div>, document.body)}
  </>;
}
