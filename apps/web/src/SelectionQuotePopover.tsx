import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownRight } from 'lucide-react';
import {
  computeSelectionPopoverPosition,
  resolveAssistantSelection,
  type SelectionPopoverPosition,
  type SelectionQuoteTarget
} from './selection-quote';

const ESTIMATED_POPOVER_SIZE = { width: 96, height: 34 };

/**
 * Agent 回复区域的划词浮层：
 * 仅当选区落在当前时间线容器的 `[data-assistant-output]` 内部且非空时显示。
 * 点击外部、选区清空、按 Esc 或容器滚动时立即收起，不干扰原生复制与右键菜单。
 */
export function SelectionQuotePopover({
  containerRef,
  enabled = true,
  onQuote
}: {
  containerRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  onQuote(text: string): void;
}) {
  const [target, setTarget] = useState<SelectionQuoteTarget | null>(null);
  const [position, setPosition] = useState<SelectionPopoverPosition | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const pointerDownRef = useRef(false);
  const rafRef = useRef<number | undefined>(undefined);

  const dismiss = useCallback(() => {
    setTarget(null);
    setPosition(null);
  }, []);

  const syncFromSelection = useCallback(() => {
    if (!enabled) {
      dismiss();
      return;
    }
    const next = resolveAssistantSelection(window.getSelection(), containerRef.current);
    if (!next) {
      dismiss();
      return;
    }
    setTarget(next);
  }, [containerRef, dismiss, enabled]);

  const scheduleSync = useCallback(() => {
    if (rafRef.current !== undefined) window.cancelAnimationFrame(rafRef.current);
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = undefined;
      syncFromSelection();
    });
  }, [syncFromSelection]);

  useEffect(() => {
    if (!enabled) dismiss();
  }, [dismiss, enabled]);

  useEffect(() => {
    if (!enabled) return;

    const onPointerDown = (event: PointerEvent) => {
      const node = event.target;
      if (node instanceof Node && popoverRef.current?.contains(node)) return;
      // 鼠标左键开始拖拽选词期间暂不闪烁弹出，等松手后统一计算。
      if (event.pointerType === 'mouse' && event.button === 0) {
        pointerDownRef.current = true;
      }
      dismiss();
    };

    const onPointerUp = (event: PointerEvent) => {
      const node = event.target;
      if (node instanceof Node && popoverRef.current?.contains(node)) return;
      pointerDownRef.current = false;
      // 右键松开交给原生上下文菜单，不弹划词浮层遮挡。
      if (event.pointerType === 'mouse' && event.button === 2) return;
      scheduleSync();
    };

    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        dismiss();
        return;
      }
      // 鼠标拖拽中不频繁重算；触摸屏调整选区手柄或键盘 Shift+方向键扩选时跟进。
      if (!pointerDownRef.current) scheduleSync();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.shiftKey || event.key === 'Shift') scheduleSync();
    };

    const onWindowResize = () => dismiss();

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', onWindowResize);

    return () => {
      if (rafRef.current !== undefined) window.cancelAnimationFrame(rafRef.current);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', onWindowResize);
    };
  }, [dismiss, enabled, scheduleSync]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;
    const onScroll = () => dismiss();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [containerRef, dismiss, enabled]);

  useLayoutEffect(() => {
    if (!target) {
      setPosition(null);
      return;
    }
    const popoverRect = popoverRef.current?.getBoundingClientRect();
    const popoverSize = popoverRect && popoverRect.width > 0 && popoverRect.height > 0
      ? { width: popoverRect.width, height: popoverRect.height }
      : ESTIMATED_POPOVER_SIZE;
    const containerRect = containerRef.current?.getBoundingClientRect();
    setPosition(
      computeSelectionPopoverPosition({
        selectionRect: target.rect,
        popoverSize,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        bounds: containerRect
          ? {
              top: containerRect.top,
              bottom: containerRect.bottom,
              left: containerRect.left,
              right: containerRect.right
            }
          : undefined
      })
    );
  }, [containerRef, target]);

  if (!target || typeof document === 'undefined') return null;

  const fallback = computeSelectionPopoverPosition({
    selectionRect: target.rect,
    popoverSize: ESTIMATED_POPOVER_SIZE,
    viewport: { width: window.innerWidth, height: window.innerHeight }
  });
  const coords = position ?? fallback;

  return createPortal(
    <div
      ref={popoverRef}
      role="toolbar"
      aria-label="选中文本操作"
      data-testid="selection-quote-popover"
      data-placement={coords.placement}
      style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
      className="ui-popover fixed z-50 flex items-center rounded-full border border-zinc-200/90 bg-white/95 p-1 shadow-[0_8px_24px_rgba(0,0,0,.14)] backdrop-blur-sm"
    >
      <button
        type="button"
        data-testid="selection-quote-button"
        onMouseDown={event => event.preventDefault()}
        onClick={() => {
          const quoted = target.text;
          dismiss();
          window.getSelection()?.removeAllRanges();
          onQuote(quoted);
        }}
        className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900 active:scale-[0.98]"
      >
        <CornerDownRight size={13} className="shrink-0 text-zinc-500" />
        <span>引用回复</span>
      </button>
    </div>,
    document.body
  );
}
