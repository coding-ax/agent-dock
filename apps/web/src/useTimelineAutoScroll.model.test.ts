import { describe, expect, it } from 'vitest';

// 链路排查 · 折叠让「跟随」失效的决策级验证。
//
// 对 useTimelineAutoScroll（修复后）「帧末统一决策」的忠实控制流建模（不依赖 DOM）：
// 状态为「当前滚动指标 current」与「是否跟随 following」；RO 与 scroll 都汇聚到一个
// 帧末 flush。真实浏览器时序：折叠/展开 → 内容高度变化(RO 置 sizeChanged) → 浏览器
// 钳制 scrollTop 派发 scroll → 帧末 rAF 统一决策。
//
// 决策规则（与 hook 的 flush 一一对应）：
//   - 本帧发生内容高度变化(layoutDriven) 且 跟随中 → 钉到新底部，且绝不判成离开；
//   - 反之（纯用户滚动、无高度变化）→ 按 isNearScrollBottom 判定跟随开关。

const THRESHOLD = 64;
type M = { scrollHeight: number; scrollTop: number; clientHeight: number };
const nearBottom = (m: M) => m.scrollHeight - m.scrollTop - m.clientHeight <= THRESHOLD;
const pinned = (m: M): M => ({ ...m, scrollTop: Math.max(0, m.scrollHeight - m.clientHeight) });

type Strategy = 'immediate' | 'flush';

/** 模拟一帧的决策。 */
function frameDecision(strategy: Strategy): { following: boolean; scrollTop: number } {
  // 帧开始：跟随中（在底部附近）。
  let following = true;
  let current: M = { scrollHeight: 3000, scrollTop: 2540, clientHeight: 400 };

  // 折叠(收掉上面一块) + 同一批新增(下面继续流过)：scrollHeight 变为 3040，
  // 但 render 后、帧末 flush 前的此刻，scrollTop 还停留在旧位置 → 距底部 gap=100>64。
  // 这正是「折叠引入的跳动」，也是旧「立即判定」误关跟随的现场。
  current = { scrollHeight: 3040, scrollTop: 2540, clientHeight: 400 };

  if (strategy === 'immediate') {
    // 旧版：scroll 一到立刻按当前画面判定。
    if (!nearBottom(current)) following = false; // gap=100 → 误关，之后 RO 不再贴底 → 卡死
    return { following, scrollTop: current.scrollTop };
  }

  // flush 版本：RO 已置 sizeChanged（有内容高度变化）。
  const layoutDriven = true;
  if (layoutDriven && following) {
    current = pinned(current); // 钉到最新底部
    // 不判离开。
    return { following, scrollTop: current.scrollTop };
  }
  if (!nearBottom(current)) following = false;
  return { following, scrollTop: current.scrollTop };
}

describe('折叠误关跟随 - 决策级', () => {
  it('上一版（immediate）：折叠+增长的跳动中间态被误判成离开 → 关闭跟随', () => {
    const r = frameDecision('immediate');
    expect(r.following).toBe(false);
  });

  it('修复后（flush）：同一画面判定为有内容高度变化 → 钉到新底部且保持跟随', () => {
    const r = frameDecision('flush');
    expect(r.following).toBe(true);
    // 钉到了新底部：scrollTop == scrollHeight - clientHeight
    expect(r.scrollTop).toBe(3040 - 400);
  });

  it('纯用户滚远、无内容高度变化时，flush 也正确关闭跟随', () => {
    // 只有滚动，没有 RO 高度变化(layoutDriven=false)。
    let following = true;
    const current: M = { scrollHeight: 3000, scrollTop: 800, clientHeight: 400 };
    const layoutDriven = false;
    if (!layoutDriven && !nearBottom(current)) following = false;
    expect(following).toBe(false);
  });
});