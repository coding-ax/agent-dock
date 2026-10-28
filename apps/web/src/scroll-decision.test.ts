import { describe, expect, it } from 'vitest';
import { decideScrollAction, isUserScrollIntent, USER_SCROLL_INTENT_MS } from './scroll-decision.js';

const m = (scrollTop: number, scrollHeight = 3000, clientHeight = 400) => ({ scrollHeight, scrollTop, clientHeight });
const bottomM = m(2560); // gap = 40，在 64 阈值内
const upM = m(800);

describe('decideScrollAction', () => {
  it('跟随中 + 内容增高（无用户意图）→ pin', () => {
    expect(decideScrollAction({ layoutDriven: true, following: true, userInteracting: false, userScrollUp: false, metrics: m(2540, 3040) })).toBe('pin');
  });

  it('跟随中 + 用户正在上滑且已离底，即使内容同帧增高 → release', () => {
    expect(decideScrollAction({ layoutDriven: true, following: true, userInteracting: true, userScrollUp: true, metrics: upM })).toBe('release');
  });

  it('关键：上滑最初几帧仍在底部阈值内 → 立即 release，不与惯性对拉', () => {
    expect(decideScrollAction({ layoutDriven: true, following: true, userInteracting: true, userScrollUp: true, metrics: bottomM })).toBe('release');
  });

  it('跟随中 + 用户向下滚且仍在底部 → 继续 pin（贴底不断流）', () => {
    expect(decideScrollAction({ layoutDriven: true, following: true, userInteracting: true, userScrollUp: false, metrics: bottomM })).toBe('pin');
  });

  it('跟随中 + 用户惯性经过中段（方向不明）→ release', () => {
    expect(decideScrollAction({ layoutDriven: true, following: true, userInteracting: true, userScrollUp: false, metrics: upM })).toBe('release');
  });

  it('跟随中 + 纯被动滚动离底 → release', () => {
    expect(decideScrollAction({ layoutDriven: false, following: true, userInteracting: false, userScrollUp: false, metrics: upM })).toBe('release');
  });

  it('非跟随中 + 滚回底部附近 → resume', () => {
    expect(decideScrollAction({ layoutDriven: false, following: false, userInteracting: true, userScrollUp: false, metrics: m(2580) })).toBe('resume');
  });

  it('滞回带内状态保持：既不 release 也不 resume，避免按钮反复闪', () => {
    const band = m(2550); // gap = 50，落在 resumeThreshold(32) 与 threshold(96) 之间
    expect(decideScrollAction({ layoutDriven: false, following: true, userInteracting: false, userScrollUp: false, metrics: band })).toBe('hold');
    expect(decideScrollAction({ layoutDriven: false, following: false, userInteracting: false, userScrollUp: false, metrics: band })).toBe('hold');
  });

  it('离开滞回带才切换状态（gap 40 仍跟随，gap 120 才释放）', () => {
    expect(decideScrollAction({ layoutDriven: false, following: true, userInteracting: false, userScrollUp: false, metrics: m(2560) })).toBe('hold');
    expect(decideScrollAction({ layoutDriven: false, following: true, userInteracting: false, userScrollUp: false, metrics: m(2480) })).toBe('release');
  });

  it('非跟随中 + 停在历史区 → hold（新 token 到达也不打扰）', () => {
    expect(decideScrollAction({ layoutDriven: true, following: false, userInteracting: false, userScrollUp: false, metrics: m(900) })).toBe('hold');
  });

  it('自定义阈值生效', () => {
    expect(decideScrollAction({ layoutDriven: false, following: true, userInteracting: false, userScrollUp: false, metrics: m(2400), threshold: 120 })).toBe('release');
  });
});

describe('isUserScrollIntent', () => {
  it('时间窗内为 true，窗外为 false，从未输入为 false', () => {
    expect(isUserScrollIntent(900, 1000)).toBe(true);
    expect(isUserScrollIntent(100, 100 + USER_SCROLL_INTENT_MS)).toBe(true);
    expect(isUserScrollIntent(100, 100 + USER_SCROLL_INTENT_MS + 1)).toBe(false);
    expect(isUserScrollIntent(0, 1000)).toBe(false);
  });
});
