import { useQuery } from '@tanstack/react-query';
import { CornerDownRight, PanelRightOpen, PawPrint } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { api, type AssistantState } from './api';
import {
  silentTriggerKey,
  silentTriggerTargets,
  wasSilentTriggered,
  type SilentTriggerTarget
} from './silent-trigger';
import type { TimelineEvent } from './timeline';

const selectSilentEmoji = (state: AssistantState) => state.silentEmoji ?? '';

/** 只订阅静默表情这一个字段；assistant-state 轮询变化时不会把整条时间线拖着重渲染。 */
export function useSilentEmoji(): string {
  return useQuery({
    queryKey: ['assistant-state'],
    queryFn: api.assistantState,
    retry: false,
    staleTime: 5_000,
    select: selectSilentEmoji
  }).data ?? '';
}

const targetMeta: Record<SilentTriggerTarget, { label: string; description: string; icon: typeof PawPrint }> = {
  main: { label: '发送主会话', description: '交给小猫处理', icon: PawPrint },
  tab: { label: '在新标签打开', description: '带着上下文开一个新会话', icon: PanelRightOpen },
  here: { label: '直接新开一轮', description: '在当前会话继续', icon: CornerDownRight }
};

/**
 * 消息旁的反应入口。
 *
 * 没有小猫时不弹选择器，直接在当前会话开一轮；有小猫时由调用方决定是否展示三个去处。
 * 触发权由 `onTarget` 同步领取（账本见 silent-trigger.ts），组件本地再兜一层，
 * 所以重渲染、轮询和同一帧的连点都不会重复开轮次。
 */
export function SilentTrigger({ sessionId, event, emoji, hasMainSession, onTarget }: {
  sessionId: string;
  event: TimelineEvent;
  emoji: string;
  hasMainSession: boolean;
  onTarget(target: SilentTriggerTarget): boolean | Promise<boolean>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const triggerKey = silentTriggerKey({ sessionId, event, emoji });
  // key 随消息/emoji 变化。切到新表情时必须按新 key 重新读账本，不能沿用旧 emoji 的 triggered。
  const storedTriggered = useMemo(() => wasSilentTriggered({ sessionId, event, emoji }), [triggerKey, sessionId, event, emoji]);
  const [triggerState, setTriggerState] = useState({ key: triggerKey, triggered: storedTriggered });
  const triggered = triggerState.key === triggerKey ? triggerState.triggered : storedTriggered;
  const [duplicate, setDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTriggerState(current => current.key === triggerKey ? current : { key: triggerKey, triggered: storedTriggered });
    setDuplicate(false);
    setOpen(false);
  }, [triggerKey, storedTriggered]);

  // 菜单在 portal 里，不能只判断 root.contains；同时监听滚动/缩放，避免 fixed 浮层和消息脱节。
  useEffect(() => {
    if (!open) return;
    const dismiss = (pointerEvent: PointerEvent) => {
      const target = pointerEvent.target as Node;
      if (root.current?.contains(target) || menu.current?.contains(target)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault();
        setOpen(false);
        trigger.current?.focus();
        return;
      }
      if (keyboardEvent.key !== 'ArrowDown' && keyboardEvent.key !== 'ArrowUp') return;
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
      if (!items.length) return;
      keyboardEvent.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = index < 0
        ? (keyboardEvent.key === 'ArrowDown' ? 0 : items.length - 1)
        : (index + (keyboardEvent.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const choose = async (target: SilentTriggerTarget) => {
    if (triggered || busy) { setDuplicate(true); setOpen(false); return; }
    setBusy(true);
    setOpen(false);
    try {
      const accepted = await onTarget(target);
      setTriggerState({ key: triggerKey, triggered: accepted });
      setDuplicate(!accepted);
    } catch {
      // 调用方负责回滚账本；这里只恢复可点击状态，错误由会话内联横幅展示。
      setTriggerState({ key: triggerKey, triggered: false });
      setDuplicate(false);
    } finally {
      setBusy(false);
    }
    requestAnimationFrame(() => trigger.current?.focus());
  };

  const activate = () => {
    if (triggered) { setDuplicate(true); return; }
    if (!hasMainSession) { void choose('here'); return; }
    setDuplicate(false);
    if (open) { setOpen(false); return; }
    // 顶部消息向下弹、底部消息向上弹：时间线滚动容器会裁掉视口外的浮层，
    // 固定一个方向在首条消息上会把「发送主会话」藏在视口上方。
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(224, window.innerWidth - 16);
      const openUp = window.innerHeight - rect.bottom < 200 && rect.top > 200;
      const space = openUp ? rect.top - 12 : window.innerHeight - rect.bottom - 12;
      setMenuStyle({
        width,
        right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - width - 8)),
        maxHeight: Math.max(140, Math.min(320, space)),
        overflowY: 'auto',
        ...(openUp ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 })
      });
    }
    setOpen(true);
  };

  const visible = open || triggered || duplicate;
  return <div ref={root} className={`relative inline-flex transition-opacity duration-150 ${visible ? 'opacity-100' : 'opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 max-sm:opacity-100'}`}>
    <button
      ref={trigger}
      type="button"
      data-silent-trigger="true"
      aria-label={triggered ? '静默轮次已触发，不会重复发送' : `用 ${emoji} 静默开一轮`}
      aria-haspopup={hasMainSession ? 'menu' : undefined}
      aria-expanded={hasMainSession ? open : undefined}
      aria-pressed={triggered}
      aria-busy={busy}
      disabled={busy}
      title={triggered ? '已触发过，不会重复发送' : `用 ${emoji} 静默开一轮`}
      onClick={activate}
      className={`grid h-6 min-w-6 place-items-center rounded-full border px-1 text-[13px] leading-none shadow-[0_1px_4px_rgba(24,24,27,.08)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 ${triggered ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50'}`}
    >
      <span aria-hidden="true">{emoji}</span>
    </button>
    {open && createPortal(<div ref={menu} role="menu" aria-label="静默轮次发送到哪里" style={menuStyle} className="ui-popover fixed z-[80] rounded-xl border border-zinc-200 bg-white p-1.5 shadow-[0_16px_48px_rgba(0,0,0,.16)]">
      <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium tracking-[.08em] text-zinc-400">这一轮交给谁</div>
      {silentTriggerTargets(hasMainSession).map(target => {
        const meta = targetMeta[target];
        const Icon = meta.icon;
        return <button key={target} type="button" role="menuitem" data-silent-trigger-target={target} onClick={() => void choose(target)} className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:bg-zinc-100 focus-visible:outline-none">
          <span className="mt-0.5 shrink-0 text-zinc-500"><Icon size={14}/></span>
          <span className="min-w-0">
            <span className="block text-[13px] font-medium leading-5">{meta.label}</span>
            <span className="block text-[11px] leading-4 text-zinc-400">{meta.description}</span>
          </span>
        </button>;
      })}
    </div>, document.body)}
  </div>;
}
