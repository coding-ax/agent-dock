import { describe, expect, it } from 'vitest';
import { matchesShortcut, shortcutLabel, type Shortcut } from './useShortcuts.js';

const event = (init: Partial<KeyboardEvent> & { key: string }) => ({
  key: init.key,
  metaKey: init.metaKey ?? false,
  ctrlKey: init.ctrlKey ?? false,
  shiftKey: init.shiftKey ?? false
});

describe('matchesShortcut', () => {
  const terminal: Pick<Shortcut, 'key' | 'shift'> = { key: 't' };

  it('⌘T / Ctrl+T 都命中', () => {
    expect(matchesShortcut(event({ key: 't', metaKey: true }), terminal)).toBe(true);
    expect(matchesShortcut(event({ key: 't', ctrlKey: true }), terminal)).toBe(true);
  });

  it('不带修饰键不命中——输入框里打字不能触发面板', () => {
    expect(matchesShortcut(event({ key: 't' }), terminal)).toBe(false);
  });

  it('大小写不敏感（按住 shift 时 key 是大写）', () => {
    expect(matchesShortcut(event({ key: 'T', metaKey: true, shiftKey: true }), { key: 't', shift: true })).toBe(true);
  });

  it('⇧⌘S 与 ⌘S 是两回事，不互相命中', () => {
    const sideChat: Pick<Shortcut, 'key' | 'shift'> = { key: 's', shift: true };
    const plain: Pick<Shortcut, 'key' | 'shift'> = { key: 's' };
    expect(matchesShortcut(event({ key: 's', metaKey: true, shiftKey: true }), sideChat)).toBe(true);
    expect(matchesShortcut(event({ key: 's', metaKey: true }), sideChat)).toBe(false);
    expect(matchesShortcut(event({ key: 's', metaKey: true }), plain)).toBe(true);
    // 没要求 shift 的键位也不接受多按了 shift 的情况。
    expect(matchesShortcut(event({ key: 's', metaKey: true, shiftKey: true }), plain)).toBe(false);
  });

  it('别的键不命中', () => {
    expect(matchesShortcut(event({ key: 'k', metaKey: true }), terminal)).toBe(false);
  });
});

describe('shortcutLabel', () => {
  it('Mac 用 ⌘ / ⇧⌘', () => {
    expect(shortcutLabel('t', false, true)).toBe('⌘T');
    expect(shortcutLabel('s', true, true)).toBe('⇧⌘S');
    expect(shortcutLabel('p', false, true)).toBe('⌘P');
  });

  it('其他平台用 Ctrl+，且 shift 写在中间', () => {
    expect(shortcutLabel('t', false, false)).toBe('Ctrl+T');
    expect(shortcutLabel('s', true, false)).toBe('Ctrl+Shift+S');
  });
});
