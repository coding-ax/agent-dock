import { useEventListener, useMemoizedFn, useMount, useUnmount } from 'ahooks';
import { useRef, type RefObject } from 'react';
import { antdPopupOpen } from './AntdScope';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 模态框焦点陷阱：进入时聚焦首个控件、Tab 在框内循环、Esc 关闭、卸载后把焦点还给来处。
 *
 * 组件只在 open 时挂载本 hook 的宿主，所以这里不再做「if (!open) return」的隐式开关，
 * 生命周期就是模态框的生命周期。
 *
 * 还原焦点必须在卸载时做：关闭后若不归还，焦点会落回 body，键盘用户要从头 Tab 一遍。
 */
export function useModalFocusTrap(options: {
  panel: RefObject<HTMLElement | null>;
  initial: RefObject<HTMLElement | null>;
  dismissible: boolean;
  onDismiss(): void;
}) {
  const { panel, initial, dismissible, onDismiss } = options;
  const restore = useRef<HTMLElement>(undefined);
  const dismiss = useMemoizedFn(onDismiss);

  useMount(() => {
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    // 让出一帧：打开动画期间元素尚未就位，立即 focus 会被浏览器忽略。
    requestAnimationFrame(() => initial.current?.focus());
  });
  useUnmount(() => restore.current?.focus());

  useEventListener('keydown', event => {
    // antd 下拉/日期浮层开着时，Esc 留给浮层自己关。
    if (event.key === 'Escape' && dismissible && !antdPopupOpen()) { event.preventDefault(); dismiss(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!focusable.length) return;
    const first = focusable[0]!; const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }, { target: () => document });
}
