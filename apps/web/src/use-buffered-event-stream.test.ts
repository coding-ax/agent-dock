import { describe, expect, it, vi } from 'vitest';
import { createReconnectNotifier } from './useBufferedEventStream';

describe('SSE reconnect notification', () => {
  it('does not refetch on the first open, but does after every reconnect', () => {
    // 断线期间漏掉的 task 事件不会补发：重连必须触发一次兜底重取。
    const refetch = vi.fn();
    const onOpen = createReconnectNotifier(refetch);
    onOpen();
    expect(refetch).not.toHaveBeenCalled();
    onOpen();
    expect(refetch).toHaveBeenCalledTimes(1);
    onOpen();
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
