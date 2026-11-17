import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { reactionEmojiRows, reactionEmojiSelection } from './lark-avatar-emoji';

/** 页面/面板滚动时收起菜单；菜单自己的滚动不能触发收起，否则列表一滚就消失。 */
export function shouldCloseEmojiMenuOnScroll(menu: Pick<HTMLElement, 'contains'> | null, target: EventTarget | null): boolean {
  return !(menu && target && menu.contains(target as Node));
}

/** 只读的选项列表；单独导出便于用 renderToStaticMarkup 做渲染测试。 */
export function ReactionEmojiOptionList({ value, onPick }: {
  value: string;
  onPick(code: string): void;
}) {
  const rows = reactionEmojiRows(value);
  const selected = reactionEmojiSelection(value);
  return <div role="listbox" aria-label="常用飞书 emoji" className="p-0.5">
    <button
      type="button"
      role="option"
      aria-selected={!selected}
      data-emoji-code=""
      onClick={() => onPick('')}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-zinc-600 transition-colors hover:bg-zinc-100 focus-visible:bg-zinc-100 focus-visible:outline-none"
    >
      <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-zinc-100 text-[13px] text-zinc-400">＋</span>
      <span className="min-w-0 flex-1 text-[12px] font-medium">未选择</span>
      <span className="font-mono text-[10px] text-zinc-400">--</span>
    </button>
    {rows.map(row => {
      const active = selected?.code === row.code;
      return <button
        key={row.code}
        type="button"
        role="option"
        aria-selected={active}
        data-emoji-code={row.code}
        onClick={() => onPick(row.code)}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none ${active ? 'bg-zinc-100' : 'hover:bg-zinc-50 focus-visible:bg-zinc-50'}`}
      >
        <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white text-[16px] shadow-[0_1px_3px_rgba(24,24,27,.08)]">{row.emoji}</span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[12px] font-medium ${row.custom ? 'text-amber-700' : 'text-zinc-800'}`}>{row.label}</span>
          {row.custom && <span className="block text-[10px] leading-4 text-amber-600">不在常用集合，仍会保留</span>}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-zinc-400">{row.code}</span>
        <span className={`grid h-4 w-4 shrink-0 place-items-center ${active ? 'text-zinc-700' : 'text-transparent'}`}><Check size={12}/></span>
      </button>;
    })}
    <p className="px-2.5 pb-1 pt-1.5 text-[10px] leading-4 text-zinc-400">只列出常用飞书 emoji 代码；已有配置不在列表时会置顶保留。</p>
  </div>;
}

/**
 * 表情触发的 emoji 选择器。
 * 用 portal + fixed 定位，避免被设置页的滚动容器裁掉；只有列表里的值可选，
 * 历史自定义值作为「当前配置」置顶显示，不会被静默清空。
 */
export function ReactionEmojiPicker({ value, onChange }: {
  value: string;
  onChange(value: string): void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const selected = reactionEmojiSelection(value);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || menu.current?.contains(target)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    const onScroll = (event: Event) => {
      if (shouldCloseEmojiMenuOnScroll(menu.current, event.target)) close();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activate = () => {
    if (open) { setOpen(false); return; }
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(380, Math.max(320, rect.width), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 12;
      const openUp = below < 240 && rect.top > 260;
      setStyle({
        position: 'fixed',
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        width,
        maxHeight: Math.max(160, Math.min(340, openUp ? rect.top - 12 : below)),
        ...(openUp ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 })
      });
    }
    setOpen(true);
  };

  return <div className="mt-1.5">
    <button
      ref={trigger}
      type="button"
      aria-label="选择触发 emoji"
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={activate}
      className="flex h-9 w-full max-w-[280px] items-center gap-2 rounded-lg border border-zinc-300 bg-white px-2.5 text-left outline-none transition-colors hover:border-zinc-400 focus-visible:border-zinc-500"
    >
      <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-zinc-100 text-[15px]">{selected?.emoji ?? '＋'}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-800">{selected ? selected.label : '选择 emoji'}</span>
      <span className="shrink-0 font-mono text-[10px] text-zinc-400">{selected?.code ?? '未选择'}</span>
      <ChevronDown size={14} className={`shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}/>
    </button>
    {open && createPortal(<div
      ref={menu}
      style={style}
      className="ui-popover overscroll-contain overflow-y-auto rounded-xl border border-zinc-200 bg-white shadow-[0_16px_48px_rgba(0,0,0,.16)]"
    >
      <ReactionEmojiOptionList value={value} onPick={code => { onChange(code); setOpen(false); }}/>
    </div>, document.body)}
  </div>;
}
