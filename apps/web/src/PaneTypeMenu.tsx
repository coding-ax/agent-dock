import { useLayoutEffect, useRef, useState } from 'react';
import { Folder, MessagesSquare, ScrollText, Terminal as TerminalIcon } from 'lucide-react';
import { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer';
import type { Shortcut } from './useShortcuts';
import type { PaneTabKind } from './store';

const MENU_WIDTH = 232;
const MENU_HEIGHT = 210;
const GAP = 6;

export interface PaneTypeOption { kind: PaneTabKind; label: string; shortcut?: Shortcut }

export const paneTypeOptions = (shortcuts: Shortcut[]): PaneTypeOption[] => [
  { kind: 'terminal', label: '终端', shortcut: shortcuts.find(item => item.key === 't' && !item.shift) },
  { kind: 'side-chat', label: '侧边聊天', shortcut: shortcuts.find(item => item.key === 's' && item.shift) },
  { kind: 'files', label: '文件', shortcut: shortcuts.find(item => item.key === 'p') },
  { kind: 'raw', label: '原始日志', shortcut: undefined }
];

const icon = (kind: PaneTabKind) => kind === 'terminal' ? <TerminalIcon size={14}/> : kind === 'side-chat' ? <MessagesSquare size={14}/> : kind === 'raw' ? <ScrollText size={14}/> : <Folder size={14}/>;

/**
 * 「新建面板」的类型选择菜单。
 *
 * 定位比照 App.tsx 里那个 AgentPickerMenu 多做了两件事：超出视口下边缘时向上翻，
 * 以及滚动/缩放后跟随锚点。原实现是点击时算一次坐标就不管了，列表一滚菜单就飘在空处。
 */
export function PaneTypeMenu({ anchor, shortcuts, onPick, onClose }: { anchor?: HTMLElement; shortcuts: Shortcut[]; onPick(kind: PaneTabKind): void; onClose(): void }) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  useDismissOnOutsidePointer(root, true, onClose);

  // 用 layout effect 而不是普通 effect：先量再画，避免第一帧出现在错误位置后跳一下。
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(GAP, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - GAP));
      // 下方放不下就翻到锚点上方——菜单贴着屏幕底边时这是唯一能看全的做法。
      const below = rect.bottom + GAP;
      const top = below + MENU_HEIGHT + GAP > window.innerHeight ? Math.max(GAP, rect.top - MENU_HEIGHT - GAP) : below;
      setPosition({ top, left });
    };
    place();
    // 捕获阶段才收得到内层滚动容器的滚动事件。
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [anchor]);

  return <div ref={root} role="menu" className="ui-popover fixed z-50 rounded-xl border border-zinc-200 bg-white p-1 shadow-[0_12px_32px_rgba(24,24,27,.12)]" style={{ top: position?.top ?? -9999, left: position?.left ?? -9999, width: MENU_WIDTH }}>
    {paneTypeOptions(shortcuts).map(option => <button key={option.kind} type="button" role="menuitem" onClick={() => onPick(option.kind)} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] text-zinc-700 transition-colors hover:bg-zinc-100">
      <span className="text-zinc-500">{icon(option.kind)}</span>
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {option.shortcut && <span className="shrink-0 font-mono text-[10px] text-zinc-400">{option.shortcut.label}</span>}
    </button>)}
  </div>;
}
