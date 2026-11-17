import { describe, expect, it } from 'vitest';
import { sessionStateLabel } from './session-states';

describe('session state labels', () => {
  it('distinguishes a user stop from a passive cancellation', () => {
    expect(sessionStateLabel('interrupted', 'user')).toBe('用户已停止');
    expect(sessionStateLabel('interrupted', 'agent_cancelled')).toBe('已取消');
    expect(sessionStateLabel('interrupted')).toBe('已取消');
  });

  it('keeps the normal failure and stopped labels', () => {
    expect(sessionStateLabel('failed')).toBe('失败');
    expect(sessionStateLabel('stopped')).toBe('已停止');
  });
});
