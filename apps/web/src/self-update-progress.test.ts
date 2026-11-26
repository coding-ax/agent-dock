import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelfUpdateStatus } from './api';
import {
  getSelfUpdateClientState,
  resetSelfUpdateClientState,
  resolveServerUpdateBadge,
  resolveUpdateProgress,
  setSelfUpdateStarting,
  setSelfUpdateWatch,
  shortVersion,
  subscribeSelfUpdateClientState,
  UPDATE_TIMEOUT_MS
} from './self-update-progress';

const status = (patch: Partial<SelfUpdateStatus>): SelfUpdateStatus => ({ currentVersion: '0.4.60', distTag: 'latest', updateAvailable: true, canUpdate: true, updating: true, ...patch });

afterEach(() => {
  resetSelfUpdateClientState();
});

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

describe('resolveServerUpdateBadge & shared client state', () => {
  it('resolves outer badge state across available, starting, watching, server updating and recovery', () => {
    expect(resolveServerUpdateBadge(undefined, { starting: false })).toBe('none');
    expect(resolveServerUpdateBadge(status({ updateAvailable: false, updating: false }), { starting: false })).toBe('none');
    expect(resolveServerUpdateBadge(status({ updateAvailable: true, updating: false }), { starting: false })).toBe('available');
    expect(resolveServerUpdateBadge(status({ updateAvailable: true, updating: true }), { starting: false })).toBe('updating');
    expect(resolveServerUpdateBadge(status({ updateAvailable: true, updating: false }), { starting: true })).toBe('updating');
    expect(resolveServerUpdateBadge(status({ updateAvailable: true, updating: false }), {
      starting: false,
      watch: { fromVersion: '0.4.60', targetVersion: '0.4.61', startedAt: 1 }
    })).toBe('updating');
    // 升级失败恢复后，退回有新版本；升级成功后，不再显示任何徽标。
    expect(resolveServerUpdateBadge(status({ updateAvailable: true, updating: false, lastError: 'failed' }), { starting: false })).toBe('available');
    expect(resolveServerUpdateBadge(status({ currentVersion: '0.4.61', updateAvailable: false, updating: false }), { starting: false })).toBe('none');
  });

  it('notifies subscribers when shared starting/watch state changes', () => {
    const listener = vi.fn();
    const unsub = subscribeSelfUpdateClientState(listener);
    setSelfUpdateStarting(true);
    expect(getSelfUpdateClientState().starting).toBe(true);
    setSelfUpdateWatch({ fromVersion: '0.4.60', targetVersion: '0.4.61', startedAt: 100 });
    expect(getSelfUpdateClientState().watch?.fromVersion).toBe('0.4.60');
    setSelfUpdateStarting(false);
    setSelfUpdateWatch(undefined);
    expect(getSelfUpdateClientState()).toEqual({ starting: false });
    expect(listener).toHaveBeenCalledTimes(4);
    unsub();
  });
});

describe('shortVersion', () => {
  it('keeps the core version and channel only', () => {
    expect(shortVersion('0.4.62-beta.20261014.1')).toBe('0.4.62-beta');
    expect(shortVersion('0.4.23')).toBe('0.4.23');
    expect(shortVersion('weird')).toBe('weird');
  });
});
