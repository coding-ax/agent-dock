import { useEffect, useState } from 'react';
import { useIsFetching } from '@tanstack/react-query';

/**
 * 全站只有三种 loading 语言（见界面规格）：
 * - Spinner：14px 细线圆环，表示按钮或控件在等待
 * - ui-shimmer-text：扫光文字，表示「正在进行的这一步」（样式在 index.css）
 * - 骨架屏：灰块加扫光，表示首屏数据加载（class 为 ui-skeleton）
 */

/** 按钮 / 控件等待：14px 细线圆环。 */
export function Spinner({ size = 14, className = '' }: { size?: number; className?: string }) {
  return <span role="status" aria-label="加载中" className={`inline-block shrink-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent opacity-70 ${className}`} style={{ width: size, height: size }}/>;
}

/** 页面顶部的细进度条：只在「还没有数据」的首次加载时出现；已有缓存的后台刷新和轮询不触发。 */
export function TopProgressBar() {
  const loading = useIsFetching({ predicate: query => query.state.data === undefined }) > 0;
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (loading) { const timer = window.setTimeout(() => setVisible(true), 150); return () => window.clearTimeout(timer); }
    const timer = window.setTimeout(() => setVisible(false), 250);
    return () => window.clearTimeout(timer);
  }, [loading]);
  // 只在可见时挂动画节点：过去这条 2px 进度条的循环动画在 opacity-0 时也一直在合成器上跑，
  // 页面空闲时也永远无法进入静止状态。
  return <div aria-hidden="true" className={`pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px] overflow-hidden transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}>{visible && <div className="ui-topbar h-full w-1/3"/>}</div>;
}
