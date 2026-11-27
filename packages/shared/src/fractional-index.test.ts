import { describe, expect, it } from 'vitest';
import { compareOrderKeys, generateKeyBetween, generateNKeysBetween } from './fractional-index.js';

describe('fractional-index', () => {
  it('generates strictly ascending keys for empty, append, prepend, and middle insertions', () => {
    const first = generateKeyBetween(null, null);
    expect(first).toBe('V');

    const after = generateKeyBetween(first, null);
    expect(compareOrderKeys(first, after)).toBe(-1);

    const before = generateKeyBetween(null, first);
    expect(compareOrderKeys(before, first)).toBe(-1);

    const mid = generateKeyBetween(before, first);
    expect(compareOrderKeys(before, mid)).toBe(-1);
    expect(compareOrderKeys(mid, first)).toBe(-1);
  });

  it('handles adjacent digits and repeated middle insertions without collisions', () => {
    let left = 'a';
    const right = 'b';
    for (let i = 0; i < 40; i++) {
      const next = generateKeyBetween(left, right);
      expect(next.endsWith('0')).toBe(false);
      expect(compareOrderKeys(left, next)).toBe(-1);
      expect(compareOrderKeys(next, right)).toBe(-1);
      left = next;
    }
  });

  it('handles repeated prepends before lowest digits', () => {
    let head = '1';
    for (let i = 0; i < 30; i++) {
      const next = generateKeyBetween(null, head);
      expect(next.endsWith('0')).toBe(false);
      expect(compareOrderKeys(next, head)).toBe(-1);
      head = next;
    }
  });

  it('generates N compact strictly ordered keys', () => {
    const keys = generateNKeysBetween(null, null, 25);
    expect(keys).toHaveLength(25);
    for (let i = 1; i < keys.length; i++) {
      expect(compareOrderKeys(keys[i - 1]!, keys[i]!)).toBe(-1);
      expect(keys[i]!.endsWith('0')).toBe(false);
    }
  });

  it('rejects inverted bounds', () => {
    expect(() => generateKeyBetween('b', 'a')).toThrow();
    expect(() => generateKeyBetween('V', 'V')).toThrow();
  });
});
