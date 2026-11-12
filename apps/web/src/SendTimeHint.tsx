import { memo } from 'react';
import { formatSendTime, formatSendTimeTitle } from './send-time';

/**
 * 终态片段的发送时间。
 *
 * 绝对定位挂在片段下方：不参与布局，所以悬停时出现、移开后隐藏都不会让时间线跳动。
 * 桌面端靠悬停或键盘聚焦出现；触摸设备没有 hover，CSS 让它常驻成一行小字（见 index.css）。
 */
export const SendTimeHint = memo(function SendTimeHint({ timestamp, align = 'left' }: { timestamp: string; align?: 'left' | 'right' }) {
  const label = formatSendTime(timestamp);
  if (!label) return null;
  return <time
    dateTime={timestamp}
    title={`发送于 ${formatSendTimeTitle(timestamp)}`}
    tabIndex={0}
    className={`ui-send-time absolute -bottom-3 ${align === 'right' ? 'right-1' : 'left-1'} z-10 select-none whitespace-nowrap rounded bg-canvas/85 px-1 text-[11px] leading-3 tabular-nums text-zinc-500 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50`}
  >{label}</time>;
});
