/**
 * 全站统一为三种 loading 语言（见界面规格），不再有全局顶部进度条：
 * - Spinner：14px 细线圆环，表示按钮或控件在等待
 * - ui-shimmer-text：扫光文字，表示「正在进行的这一步」（样式在 index.css）
 * - 骨架屏：灰块加扫光，表示首屏数据加载（class 为 ui-skeleton）
 */

/** 按钮 / 控件等待：14px 细线圆环。 */
export function Spinner({ size = 14, className = '', label = '加载中' }: { size?: number; className?: string; label?: string }) {
  return <span role="status" aria-label={label} className={`inline-block shrink-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent opacity-70 ${className}`} style={{ width: size, height: size }}/>;
}
