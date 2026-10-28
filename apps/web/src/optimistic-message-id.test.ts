import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOptimisticMessageId } from './optimistic-message-id';

afterEach(() => vi.unstubAllGlobals());

describe('optimistic message IDs', () => {
  it.each([{}, undefined])('works without randomUUID (crypto: %s)', crypto => {
    vi.stubGlobal('crypto', crypto);
    const ids = Array.from({ length: 1000 }, () => createOptimisticMessageId());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => id.startsWith('optimistic-'))).toBe(true);
  });
});
