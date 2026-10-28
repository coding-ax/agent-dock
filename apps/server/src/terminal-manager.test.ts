import { describe, expect, it } from 'vitest';
import { parseTerminalFrame, encodeFrame, resolveLoginShell } from './terminal-manager.js';

describe('parseTerminalFrame', () => {
  it('accepts input frames', () => {
    expect(parseTerminalFrame(JSON.stringify({ type: 'input', data: 'ls\n' }))).toEqual({ type: 'input', data: 'ls\n' });
  });
  it('accepts resize frames and clamps to sane integer bounds', () => {
    expect(parseTerminalFrame(JSON.stringify({ type: 'resize', cols: 120.9, rows: 40 }))).toEqual({ type: 'resize', cols: 120, rows: 40 });
    expect(parseTerminalFrame(JSON.stringify({ type: 'resize', cols: 0, rows: -5 }))).toEqual({ type: 'resize', cols: 1, rows: 1 });
    expect(parseTerminalFrame(JSON.stringify({ type: 'resize', cols: 99999, rows: 99999 }))).toEqual({ type: 'resize', cols: 1000, rows: 1000 });
  });
  it.each([
    ['not json'],
    ['null'],
    ['{}'],
    [JSON.stringify({ type: 'output', data: 'x' })],
    [JSON.stringify({ type: 'input', data: '' })],
    [JSON.stringify({ type: 'input', data: 42 })],
    [JSON.stringify({ type: 'resize', cols: 80 })],
    [JSON.stringify({ type: 'resize', cols: 'a', rows: 40 })],
  ])('rejects %s', raw => {
    expect(parseTerminalFrame(raw)).toBeNull();
  });
});

describe('encodeFrame', () => {
  it('round-trips through parse for input frames', () => {
    const frame = { type: 'input' as const, data: 'echo hi\n' };
    expect(parseTerminalFrame(encodeFrame(frame))).toEqual(frame);
  });
});

describe('resolveLoginShell', () => {
  it('uses $SHELL with login flag when set', () => {
    expect(resolveLoginShell({ SHELL: '/opt/homebrew/bin/zsh' })).toEqual({ file: '/opt/homebrew/bin/zsh', args: ['-l'] });
  });
  it('falls back to zsh on darwin without $SHELL', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try { expect(resolveLoginShell({})).toEqual({ file: '/bin/zsh', args: ['-l'] }); }
    finally { if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform); }
  });
  it('falls back to bash on other platforms', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try { expect(resolveLoginShell({})).toEqual({ file: '/bin/bash', args: ['-l'] }); }
    finally { if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform); }
  });
});
