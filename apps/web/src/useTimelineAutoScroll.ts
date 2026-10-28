import { useEffect, useRef, useState } from 'react';
import { useMemoizedFn } from 'ahooks';
import { decideScrollAction, isUserScrollIntent } from './scroll-decision.js';

export type ScrollMetrics = Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>;

export const isNearScrollBottom = (metrics: ScrollMetrics, threshold = 64) =>
  metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;

/**
 * 时间线自动贴底。
 *
 * 贴底与「何时关闭跟随」两条必须与内容高度协同，不能只看 scroll 事件的即时画面：
 * - 内容在跑（阶段/工具/思考）时会不断「折叠」「展开」，这些只改 DOM 高度，不改
 *   contentVersion/activityVersion。折叠/展开会让浏览器钳制 scrollTop 并派发 scroll，
 *   若把这种「布局驱动的被动滚动」误当成「用户翻走」关掉跟随，之后内容再增长也不会贴底，
 *   底部就永久卡住。
 * - 内容增长（新 token 到达）也会同时改变 DOM 高度。
 *
 * 所以这里把 scroll 事件与 ResizeObserver（观察内容区高度）汇到同一个「帧末一次决策」：
 *   某一帧内若发生了内容高度变化（sizeChanged），就把它视为布局驱动：
 *     跟随中 → 钉到最新底部（且不被判成离开）；不跟随 → 仍尊重用户、不打扰。
 *   只有「既没发生内容高度变化、又是新滚动」时，才按 isNearScrollBottom 判定跟随开关。
 * 这样既修复「折叠后卡死」，又保住「回看历史不被拽走」。
 */
export function useTimelineAutoScroll(scopeKey: string | undefined, contentVersion: unknown, activityVersion: unknown) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 内容区（滚动容器的直接子节点）：高度随内部 <details> 折叠/展开变化，是观察对象。
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);

  // 本帧内是否发生内容高度变化（折叠/展开/新内容）。置位后，触发的 scroll 视为布局驱动。
  const sizeChangedRef = useRef(false);
  // 最近一次用户主动滚动输入（wheel/触摸/键盘/指针）的时间戳；惯性滚动期内持续刷新。
  // 流式输出时 RO 每帧都置 layoutDriven，不靠它区分不开「用户上滑」与「布局钳制」。
  const lastUserInputAtRef = useRef(0);
  // 最近一次「向上翻历史」意图的时间戳（wheel deltaY<0 / 触摸下拉 / PageUp 等）。
  const lastUserUpAtRef = useRef(0);
  // 触摸滚动上一帧的触点 Y，用于判定手指方向。
  const lastTouchYRef = useRef<number | null>(null);
  // 是否有待处理的帧末决策（RO 与 scroll 都汇聚到这里，去重、延后到帧末执行一次）。
  const pendingFrameRef = useRef<number | null>(null);

  const updateFollowing = useMemoizedFn((next: boolean) => {
    if (followingRef.current === next) return;
    followingRef.current = next;
    setIsFollowing(next);
  });

  // 内容高度要等这一帧绘制完才是最终值，所以贴底统一放到 rAF 里做。
  const stickToBottomNextFrame = useMemoizedFn((force: boolean) => {
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (container && (force || followingRef.current)) container.scrollTop = container.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  });

  // 切换会话：无条件回到底部，并重置跟随状态。
  useEffect(() => {
    updateFollowing(true);
    return stickToBottomNextFrame(true);
  }, [scopeKey, updateFollowing, stickToBottomNextFrame]);

  // 新内容到达：仅在用户仍处于跟随状态时贴底，别把正在回看历史的用户拽走。
  // （折叠不触发这里，由下方的 ResizeObserver 兜住。）
  useEffect(() => {
    if (!followingRef.current) return;
    return stickToBottomNextFrame(false);
  }, [contentVersion, activityVersion, stickToBottomNextFrame]);

  // 帧末统一决策：发生在「这一帧的 RO 与 scroll 都进来之后」。
  const flush = useMemoizedFn(() => {
    pendingFrameRef.current = null;
    const container = containerRef.current;
    if (!container) return;
    const layoutDriven = sizeChangedRef.current;
    sizeChangedRef.current = false;
    const action = decideScrollAction({
      layoutDriven,
      following: followingRef.current,
      userInteracting: isUserScrollIntent(lastUserInputAtRef.current, performance.now()),
      userScrollUp: isUserScrollIntent(lastUserUpAtRef.current, performance.now()),
      metrics: { scrollHeight: container.scrollHeight, scrollTop: container.scrollTop, clientHeight: container.clientHeight }
    });
    if (action === 'pin') {
      container.scrollTop = container.scrollHeight;
      return;
    }
    if (action === 'release') {
      updateFollowing(false);
      return;
    }
    if (action === 'resume') updateFollowing(true);
  });
  const scheduleFlush = useMemoizedFn(() => {
    if (pendingFrameRef.current !== null) return; // 本帧已排过，去重
    pendingFrameRef.current = requestAnimationFrame(flush);
  });
  // 卸载/换帧时清理。
  useEffect(() => () => {
    if (pendingFrameRef.current !== null) cancelAnimationFrame(pendingFrameRef.current);
  }, [flush]);

  // 观察高度变化：内容区（折叠/展开/新内容）和滚动容器自身（输入框长高、软键盘弹出导致
  // 可用高度变化）都要看。
  //
  // 只观察内容区会漏掉容器缩小这一路：输入多行、移动端键盘弹出时容器 clientHeight 变小，
  // scrollHeight / scrollTop 都不变（不触发 scroll，也不触发内容 RO），于是内容不再贴着
  // 底部、最后一条被裁掉，却没有任何事件去重新贴底。把容器也纳入观察后，跟随中会按
  // layoutDriven 重新钉到底部；非跟随中仍 hold，不打扰回看历史的用户。
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const targets: HTMLElement[] = [];
    if (contentRef.current) targets.push(contentRef.current);
    if (containerRef.current) targets.push(containerRef.current);
    if (!targets.length) return;
    const observer = new ResizeObserver(() => {
      sizeChangedRef.current = true;
      scheduleFlush();
    });
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [scheduleFlush]);

  // 用户主动滚动意图：wheel（含触控板惯性，惯性期持续刷新）/ 触摸拖动 / 键盘 / 指针。
  // 流式输出每帧都在改内容高度，只有显式记录用户输入，才能在帧末把「人要翻走」和
  // 「布局把 scrollTop 钳走」区分开，避免上滑被贴底逻辑反复拽回。
  // 方向必须单独记：上滑最初几帧 scrollTop 还在底部阈值内，不靠方向信号就会与钉底对拉。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const mark = () => { lastUserInputAtRef.current = performance.now(); };
    const markUp = () => { const now = performance.now(); lastUserInputAtRef.current = now; lastUserUpAtRef.current = now; };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < -0.5) markUp();
      else mark();
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? null;
      // 手指向下滑（clientY 增大）= 内容向上走 = 回看历史。
      if (y !== null && lastTouchYRef.current !== null && y > lastTouchYRef.current) markUp();
      else mark();
      lastTouchYRef.current = y;
    };
    const onTouchEnd = () => { lastTouchYRef.current = null; };
    const upKeys = new Set(['PageUp', 'ArrowUp', 'Home']);
    const onKeyDown = (event: KeyboardEvent) => {
      if (upKeys.has(event.key)) markUp();
      else mark();
    };
    container.addEventListener('wheel', onWheel, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchEnd, { passive: true });
    container.addEventListener('keydown', onKeyDown);
    container.addEventListener('pointerdown', mark, { passive: true });
    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('pointerdown', mark);
    };
  }, []);

  // scroll：先攒起来帧末统一决策，避免在折叠钳制/重排的中途误判成「用户翻走」。
  const onScroll = useMemoizedFn(() => {
    scheduleFlush();
  });

  const scrollToBottom = useMemoizedFn(() => {
    updateFollowing(true);
    const container = containerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      // 紧跟其后的折叠会再触发 scroll + RO，帧末 flush 会按 layoutDriven 再钉一次底。
      stickToBottomNextFrame(false);
    }
  });

  // 用户主动开合执行过程时，保留当前阅读位置。随后的 ResizeObserver 只负责记录
  // 高度变化，不再把点击的行从视口里推走；用户滚回底部后会自动恢复跟随。
  const pauseFollowing = useMemoizedFn(() => updateFollowing(false));

  return { containerRef, contentRef, isFollowing, onScroll, scrollToBottom, pauseFollowing };
}
