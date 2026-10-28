import { describe, expect, it } from 'vitest';
import { isNearScrollBottom } from './useTimelineAutoScroll';

describe('timeline auto-scroll', () => {
  it('follows while the viewport is at or near the latest content', () => {
    expect(isNearScrollBottom({ scrollHeight: 1_000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isNearScrollBottom({ scrollHeight: 1_000, scrollTop: 540, clientHeight: 400 })).toBe(true);
  });

  it('stops following after the user scrolls far enough into history', () => {
    expect(isNearScrollBottom({ scrollHeight: 1_000, scrollTop: 500, clientHeight: 400 })).toBe(false);
  });

  it('stays following after a block collapses a little above the fold (content height shrinks, delta stays small)', () => {
    // 折叠前：正处于最底部，跟随中。
    expect(isNearScrollBottom({ scrollHeight: 3_000, scrollTop: 2_600, clientHeight: 400 })).toBe(true);
    // 折叠后：上面某块收起来，内容整体变矮，浏览器把 scrollTop 钳到新底部附近，
    // 与底部差距仍小 → 不应被判定为「用户主动翻走」。
    expect(isNearScrollBottom({ scrollHeight: 2_540, scrollTop: 2_140, clientHeight: 400 })).toBe(true);
  });

  it('still stops following when a collapse leaves a genuinely large gap to the bottom', () => {
    // 用户在中上部阅读历史时其上一块又折叠，离底部仍有很大距离 → 保持不跟随。
    expect(isNearScrollBottom({ scrollHeight: 2_540, scrollTop: 1_000, clientHeight: 400 })).toBe(false);
  });
});

