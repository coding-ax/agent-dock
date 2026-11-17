import { describe, expect, it } from 'vitest';
import { shouldCloseEmojiMenuOnScroll } from './ReactionEmojiPicker';

describe('ReactionEmojiPicker scroll handling', () => {
  it('keeps the menu open while its own list scrolls', () => {
    const inside = {} as Node;
    const menu = { contains: (node: Node) => node === inside };
    expect(shouldCloseEmojiMenuOnScroll(menu, inside)).toBe(false);
  });

  it('closes when the page or panel behind it scrolls', () => {
    const outside = {} as Node;
    const menu = { contains: () => false };
    expect(shouldCloseEmojiMenuOnScroll(menu, outside)).toBe(true);
    expect(shouldCloseEmojiMenuOnScroll(null, outside)).toBe(true);
  });
});
