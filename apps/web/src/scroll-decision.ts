import type { ScrollMetrics } from './useTimelineAutoScroll.js';

export type ScrollAction = 'pin' | 'release' | 'resume' | 'hold';

/**
 * 帧末滚动决策（从 useTimelineAutoScroll 抽出的纯函数）。
 *
 * 背景：流式输出时内容高度每一帧都在变（~40 token/秒），ResizeObserver 每帧都置
 * layoutDriven。若用户此时上滑翻历史，用户 scroll 与内容 RO 落在同一帧，旧逻辑一律
 * 按「布局驱动」钉回底部 → 用户上滑、被拽回，每帧打一次架，画面表现为上下鬼畜抖动。
 *
 * 用户意图（wheel / 触摸 / 键盘 / 指针滚动，含惯性期内）优先级高于布局驱动：
 * - 跟随中只要出现「向上」的滚动意图，即使此刻还在底部阈值内，也立即释放——
 *   不能等离底再释放，否则最初几帧惯性向上与程序钉底向下会对拉成鬼畜；
 * - 跟随中用户在交互且已离底（任意方向的惯性经过中段），同样释放；
 * - 滚回底部附近再恢复跟随。
 *
 * 阈值是**双阈值（滞回 / hysteresis）**：离开底部要超过 threshold 才停止跟随，回到
 * resumeThreshold 以内才恢复跟随。中间那一段「既不释放也不恢复」，状态保持不变。
 * 单阈值会让「恰好贴着阈值」的滚动/布局抖动每帧翻转 following，表现为「回到底部」
 * 按钮反复出现又消失、连带着重渲染。
 */
export function decideScrollAction(input: {
  layoutDriven: boolean;
  following: boolean;
  userInteracting: boolean;
  /** 用户最近的滚动意图是否指向「向上翻历史」（含惯性窗口内）。 */
  userScrollUp: boolean;
  metrics: ScrollMetrics;
  /** 离开底部多少像素才停止跟随。 */
  threshold?: number;
  /** 回到底部多少像素以内才恢复跟随；必须明显小于 threshold 才形成滞回带。 */
  resumeThreshold?: number;
}): ScrollAction {
  const { layoutDriven, following, userInteracting, userScrollUp, metrics, threshold = 96, resumeThreshold = 32 } = input;
  const gap = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  const farFromBottom = gap > threshold;
  const closeToBottom = gap <= resumeThreshold;

  if (following) {
    // 向上意图：哪怕还没离开底部阈值，也立刻放人走，杜绝头几帧钉底/惯性对拉。
    if (userScrollUp) return 'release';
    // 用户主动滚动且已离开底部：即使这一帧内容也在增高，也不钉底。
    if (userInteracting && farFromBottom) return 'release';
    // 折叠/展开/新增内容引起的高度变化：钉到新底部，保持跟随。
    if (layoutDriven) return 'pin';
    // 无用户意图的纯被动滚动且离底：跟随关闭。
    if (farFromBottom) return 'release';
    return 'hold';
  }

  // 非跟随中：只有回到更近的 resumeThreshold 以内才恢复跟随，避免与 release 阈值互相抖动。
  if (closeToBottom) return 'resume';
  return 'hold';
}

/** 滚动意图时间窗（ms）：触控板惯性滚动期间 wheel 持续派发，会不断刷新时间戳。 */
export const USER_SCROLL_INTENT_MS = 400;

export function isUserScrollIntent(lastInputAt: number, now: number): boolean {
  return lastInputAt > 0 && now - lastInputAt <= USER_SCROLL_INTENT_MS;
}
