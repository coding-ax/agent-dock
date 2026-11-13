import { memo, type ReactNode } from 'react';
import { formatSendTime, formatSendTimeTitle, formatUserMessageTime } from './send-time';

/**
 * 轮次末尾的时间角标。
 *
 * 绝对定位挂在片段下方：不参与布局，所以悬停时出现、移开后隐藏都不会让时间线跳动。
 * 桌面端靠悬停或键盘聚焦出现；触摸设备没有 hover，CSS 让它常驻成一行小字（见 index.css）。
 */
export const SendTimeHint = memo(function SendTimeHint({ timestamp, align = 'left', kind = '发送' }: { timestamp: string; align?: 'left' | 'right'; kind?: '发送' | '完成' }) {
  const timeText = formatSendTime(timestamp);
  if (!timeText) return null;
  return <time
    dateTime={timestamp}
    title={`${kind}于 ${formatSendTimeTitle(timestamp)}`}
    tabIndex={-1}
    className={`ui-send-time absolute -bottom-3 ${align === 'right' ? 'right-1' : 'left-1'} z-10 select-none whitespace-nowrap rounded bg-canvas/85 px-1 text-[11px] leading-3 tabular-nums text-zinc-500 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50`}
  >{kind} {timeText}</time>;
});

/**
 * 用户消息的发送时间。跟着气泡常驻，不依赖悬停：
 * 触摸设备和桌面都能直接看到，日期口径见 formatUserMessageTime。
 */
export const UserMessageTime = memo(function UserMessageTime({ timestamp }: { timestamp: string }) {
  const label = formatUserMessageTime(timestamp);
  if (!label) return null;
  return <time
    dateTime={timestamp}
    title={`发送于 ${formatSendTimeTitle(timestamp)}`}
    className="ui-user-send-time select-none whitespace-nowrap text-[11px] leading-3 tabular-nums text-zinc-500"
  >发送 {label}</time>;
});

/**
 * 一轮的时间线容器。时间角标本身不进 Tab 序列；已结束的轮次由一个容器承载唯一的
 * 键盘停靠点，聚焦轮内任意位置或悬停整轮都会显示这一处时间。
 */
export const TimelineTurn = memo(function TimelineTurn({ turnId, time, children }: { turnId: string; time?: { timestamp: string; align?: 'left' | 'right'; kind?: '发送' | '完成' }; children: ReactNode }) {
  const title = time ? formatSendTimeTitle(time.timestamp) : '';
  const kind = time?.kind ?? '发送';
  return <div
    className={`relative ${time ? 'ui-send-time-row focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/40 focus-visible:ring-offset-4 focus-visible:ring-offset-canvas' : ''}`}
    data-timeline-turn={turnId}
    {...(time ? { tabIndex: 0, role: 'group', 'aria-label': `${kind}于 ${title}` } : {})}
  >
    {children}
    {time && <SendTimeHint timestamp={time.timestamp} align={time.align} kind={time.kind}/>}
  </div>;
});
