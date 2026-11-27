import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ClipboardList, Fingerprint, Link2, Pencil, Pin, Type } from 'lucide-react';
import type { Session } from './api';
import { copyText, placeContextMenu, sessionContextMenuEntries, CONTEXT_MENU_HEIGHT, CONTEXT_MENU_WIDTH, type ContextMenuPoint, type SessionContextMenuItem } from './session-context-menu';
import { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer';

const icons = {
  rename: Pencil,
  pin: Pin,
  'copy-link': Link2,
  'copy-id': Fingerprint,
  'copy-title': Type,
  'copy-info': ClipboardList,
  archive: Archive
} as const;

/**
 * 会话条目的右键 / 长按菜单。
 *
 * 菜单挂在 portal 里：侧栏本身是 overflow 容器，放在行内会被裁掉。定位先用固定
 * 尺寸算一次，layout effect 量到真实高度后再算一次，保证贴右/贴底时翻转且不闪。
 * 复制失败不关菜单，直接展开一个已选中的只读文本框让用户手动复制。
 */
export function SessionContextMenu({ session, agentName, point, origin, anchor, onClose, onRename, onArchive, onTogglePin, onNotice }: {
  session: Session;
  agentName?: string;
  point: ContextMenuPoint;
  origin: string;
  anchor?: HTMLElement;
  onClose(): void;
  onRename(): void;
  onArchive(): void;
  onTogglePin(): void;
  onNotice(text: string): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const manualRef = useRef<HTMLTextAreaElement>(null);
  const [manual, setManual] = useState<{ label: string; value: string }>();
  const [position, setPosition] = useState(() => placeContextMenu(point, { width: CONTEXT_MENU_WIDTH, height: CONTEXT_MENU_HEIGHT }, { width: window.innerWidth, height: window.innerHeight }));
  const entries = sessionContextMenuEntries(session, { agentName, origin });

  const close = (restoreFocus = false) => {
    onClose();
    if (restoreFocus) requestAnimationFrame(() => anchor?.focus());
  };

  useDismissOnOutsidePointer(root, true, () => close());

  useLayoutEffect(() => {
    const rect = root.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(placeContextMenu(point, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [point.x, point.y, manual]);

  useEffect(() => {
    if (manual) {
      manualRef.current?.focus();
      manualRef.current?.select();
      return;
    }
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [manual]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        close(true);
        return;
      }
      if (manual || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End')) return;
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
      if (!buttons.length) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : current < 0
            ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    const onViewportChange = () => close();
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    };
  }, [manual]);

  const runCopy = async (item: SessionContextMenuItem) => {
    if (!item.value) return;
    const result = await copyText(item.value);
    if (result.ok) {
      onNotice(`已复制${item.label.replace(/^复制/, '')}`);
      close();
      return;
    }
    setManual({ label: item.label, value: item.value });
  };

  const choose = (item: SessionContextMenuItem) => {
    if (item.action === 'rename') {
      close();
      onRename();
      return;
    }
    if (item.action === 'archive') {
      close();
      onArchive();
      return;
    }
    if (item.action === 'pin') {
      close();
      onTogglePin();
      return;
    }
    void runCopy(item);
  };

  const flippedUp = position.top < point.y - 10;
  const flippedLeft = position.left < point.x - 10;
  const placement = flippedUp
    ? (flippedLeft ? 'bottom-end' : 'top-start')
    : (flippedLeft ? 'top-end' : 'bottom-start');

  return createPortal(<div
    ref={root}
    role="menu"
    aria-label={`${session.title || session.id} 的会话操作`}
    data-placement={placement}
    style={{ top: position.top, left: position.left, width: CONTEXT_MENU_WIDTH }}
    onContextMenu={event => event.preventDefault()}
    className="ui-popover fixed z-[70] rounded-xl border border-zinc-200 bg-white p-1.5 shadow-[0_16px_48px_rgba(24,24,27,.18)]"
  >
    {entries.map((entry, index) => {
      if (entry.kind === 'separator') return <div key={`separator-${index}`} role="separator" className="my-1 border-t border-zinc-100"/>;
      const Icon = icons[entry.action];
      return <button
        key={entry.action}
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={() => choose(entry)}
        className={`ui-press flex h-[32px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors ${entry.danger ? 'text-red-600 hover:bg-red-50' : 'text-zinc-700 hover:bg-zinc-100'}`}
      >
        <Icon size={14} className={`shrink-0 ${entry.danger ? 'text-red-500' : 'text-zinc-500'}`}/>
        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
      </button>;
    })}
    {manual && <div className="mt-1 border-t border-zinc-100 px-1 pb-1 pt-2">
      <div className="mb-1.5 text-[12px] text-red-600">{manual.label}失败，请手动复制：</div>
      <textarea ref={manualRef} readOnly value={manual.value} rows={4} aria-label={`手动复制${manual.label.replace(/^复制/, '')}`} className="w-full resize-none rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 font-mono text-[12px] leading-4 text-zinc-700 outline-none"/>
    </div>}
  </div>, document.body);
}
