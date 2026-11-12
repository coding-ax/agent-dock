import { memo, type ReactNode } from 'react';
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
    tabIndex={-1}
    className={`ui-send-time absolute -bottom-3 ${align === 'right' ? 'right-1' : 'left-1'} z-10 select-none whitespace-nowrap rounded bg-canvas/85 px-1 text-[11px] leading-3 tabular-nums text-zinc-500 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50`}
  >{label}</time>;
});

/**
 * 一轮的时间线容器。时间角标本身不进 Tab 序列；已结束的轮次由一个容器承载唯一的
 * 键盘停靠点，聚焦轮内任意位置或悬停整轮都会显示这一处时间。
 */
export const TimelineTurn = memo(function TimelineTurn({ turnId, sendTime, children }: { turnId: string; sendTime?: { timestamp: string; align?: 'left' | 'right' }; children: ReactNode }) {
  const title = sendTime ? formatSendTimeTitle(sendTime.timestamp) : '';
  return <div
    className={`relative ${sendTime ? 'ui-send-time-row focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/40 focus-visible:ring-offset-4 focus-visible:ring-offset-canvas' : ''}`}
    data-timeline-turn={turnId}
    {...(sendTime ? { tabIndex: 0, role: 'group', 'aria-label': `发送于 ${title}` } : {})}
  >
    {children}
    {sendTime && <SendTimeHint timestamp={sendTime.timestamp} align={sendTime.align}/>}
  </div>;
});
