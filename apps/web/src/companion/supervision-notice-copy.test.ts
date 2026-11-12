import { describe, expect, it } from 'vitest';
import { supervisionSystemRoundCopy } from './supervision-notice-copy';

describe('supervision system round copy', () => {
  it('keeps the visible system-round explanation stable', () => {
    expect(supervisionSystemRoundCopy()).toEqual({
      title: '系统自动开了一轮 · 督办',
      badge: '系统轮次',
      description: 'daemon 在侧边会话完成后自动注入，不是用户消息'
    });
  });
});
