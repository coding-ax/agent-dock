import { describe, expect, it } from 'vitest';
import type { SelfUpdateStatus } from './api';
import { resolveUpdateProgress, shortVersion, UPDATE_TIMEOUT_MS } from './self-update-progress';

const status = (patch: Partial<SelfUpdateStatus>): SelfUpdateStatus => ({ currentVersion: '0.4.60', distTag: 'latest', updateAvailable: true, canUpdate: true, updating: true, ...patch });

describe('resolveUpdateProgress', () => {
  it('keeps waiting while the server restarts or is still installing', () => {
    expect(resolveUpdateProgress('0.4.60', undefined, 10_000)).toEqual({ phase: 'pending' });
    expect(resolveUpdateProgress('0.4.60', status({}), 10_000)).toEqual({ phase: 'pending' });
  });

  it('finishes once the running version changes', () => {
    expect(resolveUpdateProgress('0.4.60', status({ currentVersion: '0.4.61', updating: false }), 30_000)).toEqual({ phase: 'done', version: '0.4.61' });
  });

  it('surfaces install failures reported by the old server', () => {
    expect(resolveUpdateProgress('0.4.60', status({ updating: false, lastError: '没有写权限' }), 5_000)).toEqual({ phase: 'failed', message: '没有写权限' });
  });

  it('gives up after the timeout', () => {
    expect(resolveUpdateProgress('0.4.60', undefined, UPDATE_TIMEOUT_MS + 1).phase).toBe('failed');
  });
});

describe('shortVersion', () => {
  it('keeps the core version and channel only', () => {
    expect(shortVersion('0.4.62-beta.20261014.1')).toBe('0.4.62-beta');
    expect(shortVersion('0.4.23')).toBe('0.4.23');
    expect(shortVersion('weird')).toBe('weird');
  });
});
