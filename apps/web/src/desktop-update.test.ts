import { describe, expect, it } from 'vitest';
import { downloadPercent, formatBytes, formatSpeed, formatTransferred, isDesktopUpdatePhase, type DesktopUpdateState } from './desktop-update';

const state = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({ phase: 'idle', currentVersion: '0.2.1', ...patch });

describe('desktop update helpers', () => {
  it('formats byte counts and speeds for the progress row', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(120 * 1024)).toBe('120 KB');
    expect(formatSpeed(2 * 1024 * 1024)).toBe('2.0 MB/s');
    expect(formatSpeed(0)).toBe('');
  });

  it('prints transferred / total only when the size is known', () => {
    expect(formatTransferred(state({ transferred: 1024, total: 4096 }))).toBe('1.0 KB / 4.0 KB');
    expect(formatTransferred(state({ transferred: 1024 }))).toBe('');
  });

  it('clamps progress percentages', () => {
    expect(downloadPercent(state({ percent: 42.4 }))).toBe(42.4);
    expect(downloadPercent(state({ percent: -1 }))).toBe(0);
    expect(downloadPercent(state({ percent: 140 }))).toBe(100);
    expect(downloadPercent(state({ percent: Number.NaN }))).toBe(0);
  });

  it('marks the phases that should badge the settings entry', () => {
    expect(isDesktopUpdatePhase(state({ phase: 'available' }))).toBe(true);
    expect(isDesktopUpdatePhase(state({ phase: 'downloading' }))).toBe(true);
    expect(isDesktopUpdatePhase(state({ phase: 'downloaded' }))).toBe(true);
    expect(isDesktopUpdatePhase(state({ phase: 'installing' }))).toBe(true);
    expect(isDesktopUpdatePhase(state({ phase: 'idle' }))).toBe(false);
    expect(isDesktopUpdatePhase(state({ phase: 'checking' }))).toBe(false);
    expect(isDesktopUpdatePhase(undefined)).toBe(false);
  });
});
