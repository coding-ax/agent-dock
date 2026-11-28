import { describe, expect, it } from 'vitest';
import { sessionStateLabel } from './session-states';

describe('session state labels', () => {
  it('distinguishes a user stop, daemon restart interruption, and passive cancellation', () => {
    expect(sessionStateLabel('interrupted', 'user')).toBe('用户已停止');
    expect(sessionStateLabel('interrupted', 'daemon_restart')).toBe('服务重启中断');
    expect(sessionStateLabel('interrupted', 'agent_cancelled')).toBe('已取消');
    expect(sessionStateLabel('interrupted')).toBe('已取消');
  });

  it('keeps the normal failure and stopped labels', () => {
    expect(sessionStateLabel('failed')).toBe('失败');
    expect(sessionStateLabel('stopped')).toBe('已停止');
  });
});
