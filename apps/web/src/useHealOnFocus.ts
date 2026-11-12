import { useRef } from 'react';
import { useEventListener } from 'ahooks';

/**
 * 事件增量拉取是 append-only（storage 的 getEvents 严格 `sequence > after`），
 * 因此无法修正已经缓存下来的过期条目：标签页切到后台、且 SSE 在某个工具的终态更新
 * 到达前断开时，refetch 只会往后追加，那条工具会一直停在「执行中」。
 *
 * 窗口重新获得焦点是「期间可能错过了更新」的信号。这个 hook 在 focus 时置位，
 * queryFn 读取并复位后改走一次自愈拉取：只重拉缓存里最后一轮并整段替换（见
 * event-buffer 的 healBoundary）。以前这里退回整段历史重拉——重会话一次几十 MB，
 * 经隧道远程打开时每次切回窗口都要等十几秒到一分多钟。SSE 保活期间的其他 refetch 仍走增量。
 *
 * 返回的 ref 由调用方在 queryFn 里 consume（读取后必须复位），因此只影响紧随其后的
 * 那一次拉取。
 */
export function useHealOnFocus() {
  const heal = useRef(false);
  useEventListener('focus', () => { heal.current = true; }, { target: () => window });
  return heal;
}
