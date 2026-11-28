import { memo, type ReactNode } from 'react';
import { formatSendTime, formatSendTimeTitle, formatUserMessageTime } from './send-time';
import { useBi } from './i18n';

/**
 * 轮次末尾的时间角标。
 *
 * 绝对定位挂在片段下方：不参与布局，所以悬停时出现、移开后隐藏都不会让时间线跳动。
 * 角标高 16px，文字左边缘与本轮内容左边缘重合，往上 12px 离开本轮内容；
 * 轮次容器在带时间时改用 40px 轮间距（mb-10），角标占 16px 后上下各余 12px，
 * 不贴卡片也不挤下一条消息。
 * 桌面端靠悬停或键盘聚焦出现；触摸设备没有 hover，CSS 让它常驻成一行小字（见 index.css）。
 */
export const SendTimeHint = memo(function SendTimeHint({ timestamp, align = 'left', kind }: { timestamp: string; align?: 'left' | 'right'; kind?: string }) {
  const L = useBi();
  const resolvedKind = kind === '完成' || kind === 'Done' ? L("完成", "Done") : (kind === '发送' || kind === 'Sent' || !kind ? L("发送", "Sent") : kind);
  const timeText = formatSendTime(timestamp);
  if (!timeText) return null;
  return <time
    dateTime={timestamp}
    title={L(`${resolvedKind}于 ${formatSendTimeTitle(timestamp)}`, `${resolvedKind} at ${formatSendTimeTitle(timestamp)}`)}
    tabIndex={-1}
    className={`ui-send-time absolute -bottom-7 ${align === 'right' ? 'right-0' : 'left-0'} z-10 select-none whitespace-nowrap py-0.5 text-[11px] leading-3 tabular-nums text-zinc-500 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50`}
  >{resolvedKind} {timeText}</time>;
});

/**
 * 用户消息的发送时间。桌面端靠悬停整条消息或键盘聚焦出现；
 * 触摸设备没有 hover，CSS 让它常驻。日期口径见 formatUserMessageTime。
 */
export const UserMessageTime = memo(function UserMessageTime({ timestamp }: { timestamp: string }) {
  const L = useBi();
  const label = formatUserMessageTime(timestamp);
  if (!label) return null;
  return <time
    dateTime={timestamp}
    title={L(`发送于 ${formatSendTimeTitle(timestamp)}`, `Sent at ${formatSendTimeTitle(timestamp)}`)}
    className="ui-user-send-time select-none whitespace-nowrap text-[11px] leading-3 tabular-nums text-zinc-500"
  >{L("发送", "Sent")} {label}</time>;
});

/**
 * 一轮的时间线容器。时间角标本身不进 Tab 序列；已结束的轮次由一个容器承载唯一的
 * 键盘停靠点，聚焦轮内任意位置或悬停整轮都会显示这一处时间。
 */
export const TimelineTurn = memo(function TimelineTurn({ turnId, time, children }: { turnId: string; time?: { timestamp: string; align?: 'left' | 'right'; kind?: string }; children: ReactNode }) {
  const L = useBi();
  const title = time ? formatSendTimeTitle(time.timestamp) : '';
  const kind = time?.kind === '完成' || time?.kind === 'Done' ? L("完成", "Done") : (time?.kind === '发送' || time?.kind === 'Sent' || !time?.kind ? L("发送", "Sent") : time.kind);
  return <div
    className={`relative ${time ? 'ui-send-time-row mb-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/40 focus-visible:ring-offset-4 focus-visible:ring-offset-canvas' : ''}`}
    data-timeline-turn={turnId}
    {...(time ? { tabIndex: 0, role: 'group', 'aria-label': L(`${kind}于 ${title}`, `${kind} at ${title}`) } : {})}
  >
    {children}
    {time && <SendTimeHint timestamp={time.timestamp} align={time.align} kind={time.kind}/>}
  </div>;
});
