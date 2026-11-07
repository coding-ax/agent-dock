import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 弹窗的「延迟卸载」。
 *
 * 弹窗都是 `{open && <Dialog/>}` 条件渲染，关闭瞬间就从 DOM 里消失，没法播退出动画。
 * 这里在 open 变 false 后把最后一次的子树多留 ms 毫秒，并给外层标上 data-closing，
 * 由 index.css 里的 `[data-closing] .ui-dialog / .ui-overlay` 播淡出；期间 pointer-events 关闭，不会再被点到。
 * 外层用 display: contents，不改变弹窗自己的 fixed 定位和层叠。
 */
export function ExitGate({ open, children, ms = 180 }: { open: boolean; children: ReactNode; ms?: number }) {
  const last = useRef<ReactNode>(children);
  const [mounted, setMounted] = useState(open);
  if (open) last.current = children;
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const timer = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(timer);
  }, [open, ms]);
  if (!open && !mounted) return null;
  return <div style={{ display: 'contents' }} {...(open ? {} : { 'data-closing': '' })}>{open ? children : last.current}</div>;
}
