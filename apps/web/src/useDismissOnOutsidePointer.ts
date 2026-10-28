import { useEventListener } from 'ahooks';
import type { RefObject } from 'react';

/**
 * 点击浮层之外时关闭浮层。
 *
 * InlineSelect 与 CompactSelect 此前各写了一份完全相同的 useEffect（挂载 pointerdown、
 * 判断 contains、卸载时移除），这里收成一处：`enable` 交给 ahooks 判断，避免手写
 * 「if (!open) return」这类隐式的订阅开关。
 *
 * 用 pointerdown 而不是 click：click 要等抬起才触发，拖拽选中浮层内文本后在外部松手
 * 会误判为「点了外面」。
 */
export function useDismissOnOutsidePointer(root: RefObject<HTMLElement | null>, open: boolean, onDismiss: () => void) {
  useEventListener('pointerdown', event => {
    if (!root.current?.contains(event.target as Node)) onDismiss();
  }, { target: () => document, enable: open });
}
