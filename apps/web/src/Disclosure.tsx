import { useEffect, useState, type ReactNode, type TransitionEvent } from 'react';

/** 展开容器：grid-template-rows 0fr → 1fr 加透明度，避免高度跳变。
 *  - 默认（unmountOnClose=false）：首次展开前不渲染内容（历史长会话默认折叠时不必为每一步建 DOM）；
 *    展开过之后保留，才能播收起动画。
 *  - unmountOnClose=true（用于内容撑宽的 shrink-to-fit 气泡）：展开时先以 0fr 挂载子节点、经 rAF 切到 1fr
 *    播放展开动画；收起时先播完 200ms 过渡，待 transitionend（及超时兜底）后再卸载子节点，避免隐藏内容撑住气泡宽度。 */
export function Disclosure({ open, unmountOnClose = false, children }: { open: boolean; unmountOnClose?: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);

  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (!unmountOnClose) {
      setExpanded(open);
      return;
    }
    if (open) {
      let inner = 0;
      const outer = window.requestAnimationFrame(() => {
        inner = window.requestAnimationFrame(() => setExpanded(true));
      });
      return () => {
        window.cancelAnimationFrame(outer);
        if (inner) window.cancelAnimationFrame(inner);
      };
    }
    setExpanded(false);
    if (!mounted) return;
    const timer = window.setTimeout(() => setMounted(false), 280);
    return () => window.clearTimeout(timer);
  }, [open, unmountOnClose, mounted]);

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (!unmountOnClose || open) return;
    if (event.target !== event.currentTarget || event.propertyName !== 'grid-template-rows') return;
    setMounted(false);
  };

  const shown = unmountOnClose ? expanded : open;
  return <div
    aria-hidden={!open}
    inert={!open}
    data-open={shown ? 'true' : 'false'}
    onTransitionEnd={handleTransitionEnd}
    className={`ui-disclosure grid transition-[grid-template-rows,opacity] duration-[220ms] ease-[cubic-bezier(.16,1,.3,1)] ${shown ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
  >
    <div className="min-h-0 overflow-hidden"><div className="ui-disclosure-content">{mounted ? children : null}</div></div>
  </div>;
}
