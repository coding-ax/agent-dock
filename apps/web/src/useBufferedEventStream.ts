import { useEffect } from 'react';
import { useMemoizedFn } from 'ahooks';
import type { QueryClient } from '@tanstack/react-query';
import type { DockEvent } from './api';
import { mergeEventBatch } from './event-buffer';

/**
 * 订阅某个 Session 的 SSE 事件流，并按帧合批写入 ['events', sessionId] 缓存。
 *
 * 为什么要合批：流式输出是 token 级的（真实会话 6960 条事件里 5661 条是 thinking），
 * 过去每条事件都单独 setQueryData 一次，每次都要全量扫描 + 全量复制数组，还会触发
 * react-query 的 replaceEqualDeep 深比较，三重 O(n) 叠成 O(n²)——30000 条事件实测
 * 要 32 秒主线程时间。更要命的是每次写入都让 events.data 换引用，timeline、
 * contextStats、raw 等五个派生 memo 全部失效重算，整场会话累计约 4 秒。
 *
 * 合到一帧一次后，一轮对话里的 setQueryData 次数和派生次数都降一个数量级，
 * 而 rAF 的延迟在肉眼上和逐条写入没有区别（本来也要等浏览器绘制这一帧）。
 *
 * status / task 事件不进缓冲：它们量很小，且驱动的是会话状态徽标和任务队列，
 * 迟一帧会让「执行中 / 已完成」的翻转看起来发木，所以保持逐条旁路写入。
 */
export function useBufferedEventStream(options: {
  sessionId: string | undefined;
  enabled: boolean;
  runId: string | undefined;
  queryClient: QueryClient;
  onSidecarEvent(event: DockEvent): void;
}) {
  const { sessionId, enabled, runId, queryClient, onSidecarEvent } = options;
  // 回调每次 render 都是新引用，直接进依赖会把 SSE 连接反复重建；
  // useMemoizedFn 给出稳定引用且始终读到最新闭包。
  const sidecar = useMemoizedFn(onSidecarEvent);

  // 这里保留 useEffect：订阅 EventSource 属于「与 React 外部系统同步」，是 Effect 的
  // 正当用途，ahooks 没有语义更贴切的封装（useRequest / useMount 都不匹配长连接生命周期）。
  useEffect(() => {
    if (!sessionId || !enabled) return;
    const queryKey = ['events', sessionId];
    const cached = queryClient.getQueryData<DockEvent[]>(queryKey) ?? [];
    const after = cached.reduce((sequence, event) => Math.max(sequence, event.sequence), 0);
    const stream = new EventSource(`/api/sessions/${sessionId}/stream?after=${after}`);
    // 访问门拒绝（401/403）后立刻断开：否则 EventSource 会按浏览器内置退避无限重连，
    // 凭证不会凭空恢复，重连只是持续制造 401。拒绝事件由 api 层 fetch 统一派发。
    const closeOnDenied = () => stream.close();
    window.addEventListener('agentdock:web-access-denied', closeOnDenied);

    let pending: DockEvent[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      // 用 updater 形式读最新值，不缓存快照：这样即便 refetch 刚写过缓存，
      // 这一批也能正确合并，不会把 refetch 的结果覆盖掉。
      queryClient.setQueryData<DockEvent[]>(queryKey, current => mergeEventBatch(current ?? [], batch));
    };

    const receive = (message: MessageEvent<string>) => {
      if (typeof message.data !== 'string' || !message.data) return;
      let event: DockEvent;
      try { event = JSON.parse(message.data) as DockEvent; }
      catch { return; }
      pending.push(event);
      if (!frame) frame = requestAnimationFrame(flush);
      sidecar(event);
    };

    for (const name of ['text','thinking','tool_call','tool_result','permission_request','status','task','error','completed','raw_terminal']) stream.addEventListener(name, receive as EventListener);
    return () => {
      window.removeEventListener('agentdock:web-access-denied', closeOnDenied);
      if (frame) cancelAnimationFrame(frame);
      // 收尾时把残余事件写进**本次订阅的** queryKey：sessionId 变化时这个 cleanup
      // 先于新 effect 执行，闭包里的 queryKey 仍指向旧会话，不会串台。
      flush();
      stream.close();
    };
  }, [sessionId, enabled, runId, queryClient]);
}
