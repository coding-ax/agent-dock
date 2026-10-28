import { useMemoizedFn, useMount, useUpdateEffect } from 'ahooks';
import { useState } from 'react';
import { api, type DockEvent, type TurnRange } from './api';

/** 单轮一次取回的原始行数上限。服务端还会叠加 1 MB 字节预算，两者谁先到谁生效。 */
export const TURN_PAGE_ROWS = 20_000;

export type RoundProcessState = {
  /** 用户是否展开了这一轮的过程。展开是取出事件的唯一手动入口。 */
  open: boolean;
  toggle: () => void;
  /** 这一轮确实在取事件（首次或继续加载）。 */
  loading: boolean;
  error?: string;
  events: DockEvent[];
  /** 还有没取完的行；继续加载按钮据此出现。 */
  truncated: boolean;
  loadMore: () => void;
  /** 首次取回成功过。错在「继续加载」时仍然为真，重试不该从第一页重来。 */
  loaded: boolean;
  /** 接着失败的那一页重试：第一页失败就重来，续页失败就从 nextAfter 追加。 */
  retry: () => void;
};

/**
 * 一轮过程事件的按需读取。两条入口：
 * - 用户点开「思考与工具调用」；
 * - 落库的最终输出缺失、但这一轮有过程事件——不自动取的话，面板打开像什么都没有。
 *
 * 事件按页追加，不覆盖；重复展开不会重复请求（已经在手里或正在取就跳过）。
 */
export function useRoundProcess({ sessionId, taskId, bounds, autoLoad }: { sessionId: string; taskId: string; bounds?: TurnRange; autoLoad: boolean }): RoundProcessState {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<DockEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  const [nextAfter, setNextAfter] = useState<number>();
  const [loaded, setLoaded] = useState(false);

  // 边界是 /turns 一次算出来的；没有边界就让服务端自己扫一次锚点，别在这里猜。
  const firstAfter = bounds?.startSequence ?? 0;

  const fetchPage = useMemoizedFn(async (after: number, append: boolean) => {
    setLoading(true);
    setError(undefined);
    try {
      const page = await api.turnEvents(sessionId, taskId, { after, ...(bounds ? { before: bounds.endSequence } : {}), limit: TURN_PAGE_ROWS });
      // 追加页拿到的是「更早的那一段之后」的行，顺序天然接得上，不再排序。
      setEvents(current => append ? [...current, ...page.events] : page.events);
      setTruncated(page.truncated);
      setNextAfter(page.nextAfter);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  });

  const load = useMemoizedFn(() => {
    if (loading || (loaded && !error)) return;
    void fetchPage(firstAfter, false);
  });

  const active = open || autoLoad;
  // 挂载时已在取（自动还原），与「之后才需要取」（用户展开 / 数据到达后才有过程）各管一次，不重复触发。
  useMount(() => { if (active) load(); });
  useUpdateEffect(() => { if (active) load(); }, [active, load]);

  const loadMore = useMemoizedFn(() => {
    if (loading || !truncated || nextAfter === undefined) return;
    void fetchPage(nextAfter, true);
  });

  // 重试要接着失败的那一页继续：
  // - 第一页就失败（loaded=false）：从 firstAfter 重来；
  // - 「继续加载」失败（loaded=true、还有下一页）：从 nextAfter 追加，
  //   否则会把已经拿到的几页丢掉、从第一页重来（注释说好不这么干）。
  const retry = useMemoizedFn(() => {
    if (loading) return;
    if (!loaded) { void fetchPage(firstAfter, false); return; }
    if (truncated && nextAfter !== undefined) void fetchPage(nextAfter, true);
  });

  return {
    open,
    toggle: useMemoizedFn(() => setOpen(value => !value)),
    loading,
    ...(error ? { error } : {}),
    events,
    truncated,
    loadMore,
    loaded,
    retry
  };
}
