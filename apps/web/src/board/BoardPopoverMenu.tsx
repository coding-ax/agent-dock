import { useLayoutEffect, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ExitGate } from '../ExitGate';

export interface BoardPopoverPosition {
  top: number;
  left: number;
  flipped: boolean;
}

/**
 * 计算浮层菜单的视口安全坐标：
 * - 右缘与触发器对齐，并钳制在 [8, viewportWidth - width - 8] 内（桌面与 390px 移动端均不裁切）；
 * - 下方空间不足时自动向上翻转。
 */
export function computeBoardPopoverPosition(
  anchorRect: Pick<DOMRect, 'top' | 'bottom' | 'right'>,
  menuSize: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 6,
  margin = 8
): BoardPopoverPosition {
  const maxLeft = Math.max(margin, viewport.width - menuSize.width - margin);
  const left = Math.min(maxLeft, Math.max(margin, anchorRect.right - menuSize.width));
  const fitsBelow = anchorRect.bottom + gap + menuSize.height <= viewport.height - margin;
  if (fitsBelow || anchorRect.top < menuSize.height + gap + margin) {
    const top = Math.min(
      Math.max(margin, viewport.height - menuSize.height - margin),
      Math.max(margin, anchorRect.bottom + gap)
    );
    return { top, left, flipped: false };
  }
  return {
    top: Math.max(margin, anchorRect.top - gap - menuSize.height),
    left,
    flipped: true
  };
}

interface BoardPopoverMenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose(): void;
  ariaLabel?: string;
  width?: number;
  testId?: string;
  children: ReactNode;
}

/**
 * 看板浮层菜单（Portal 至 document.body + ExitGate 150ms 进退场）：
 * 彻底隔离顶栏 backdrop-blur 层叠上下文与列/卡片滚动容器的 overflow 裁切，
 * 保证看板「更多」、列设置、卡片操作菜单在亮/暗主题与桌面/移动端永远完整悬浮于最前层。
 */
export function BoardPopoverMenu({
  open,
  anchorRef,
  onClose,
  ariaLabel,
  width = 208,
  testId,
  children
}: BoardPopoverMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [pos, setPos] = useState<BoardPopoverPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const measuredHeight = menuRef.current?.offsetHeight || 196;
      setPos(computeBoardPopoverPosition(
        rect,
        { width, height: measuredHeight },
        { width: window.innerWidth, height: window.innerHeight }
      ));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open, anchorRef, width]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      const anchor = anchorRef.current;
      if (!anchor) { onCloseRef.current(); return; }
      const rect = anchor.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
        onCloseRef.current();
        return;
      }
      const measuredHeight = menuRef.current?.offsetHeight || 196;
      setPos(computeBoardPopoverPosition(
        rect,
        { width, height: measuredHeight },
        { width: window.innerWidth, height: window.innerHeight }
      ));
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, anchorRef, width]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <ExitGate open={open} ms={150}>
      <div
        ref={menuRef}
        role="menu"
        aria-label={ariaLabel}
        data-testid={testId}
        data-placement={pos?.flipped ? 'bottom-end' : 'top-end'}
        onPointerDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
        style={{
          top: pos?.top ?? -9999,
          left: pos?.left ?? -9999,
          width
        }}
        className={`ui-popover fixed z-[60] rounded-xl border border-zinc-200 bg-white p-1.5 shadow-[0_16px_38px_rgba(24,24,27,.16)] ${
          pos?.flipped ? 'ui-popover-up' : ''
        }`}
      >
        {children}
      </div>
    </ExitGate>,
    document.body
  );
}
