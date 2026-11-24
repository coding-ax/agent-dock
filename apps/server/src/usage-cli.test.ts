import { describe, expect, it } from 'vitest';
import { resolveUsageFromOption } from './usage-cli.js';
import { createCliProgram } from './cli-program.js';

describe('usage CLI 参数解析与命令注册', () => {
  it('支持 today / 7d / 30d 与原始日期参数', () => {
    const now = new Date(2026, 10, 24, 15, 30, 0); // 2026-11-24
    expect(resolveUsageFromOption('today', now)).toBe('2026-11-24');
    expect(resolveUsageFromOption('7d', now)).toBe('2026-11-18');
    expect(resolveUsageFromOption('30d', now)).toBe('2026-10-26');
    expect(resolveUsageFromOption('2026-11-01', now)).toBe('2026-11-01');
    expect(resolveUsageFromOption(undefined, now)).toBeUndefined();
  });

  it('正确注册 usage summary / breakdown / session 子命令', async () => {
    const calls: Array<{ cmd: string; arg?: string; options: unknown }> = [];
    const program = createCliProgram('0.0.0', {
      usageSummary: options => { calls.push({ cmd: 'summary', options }); },
      usageBreakdown: options => { calls.push({ cmd: 'breakdown', options }); },
      usageSession: (sessionId, options) => { calls.push({ cmd: 'session', arg: sessionId, options }); }
    });

    await program.parseAsync(['node', 'agent-dock', 'usage', 'summary', '--from', '7d', '--agent', 'claude', '--json']);
    await program.parseAsync(['node', 'agent-dock', 'usage', 'breakdown', '--by', 'project', '--limit', '10']);
    await program.parseAsync(['node', 'agent-dock', 'usage', 'session', 'ses_123', '--json']);

    expect(calls).toEqual([
      { cmd: 'summary', options: { from: '7d', agent: 'claude', json: true } },
      { cmd: 'breakdown', options: { by: 'project', limit: '10' } },
      { cmd: 'session', arg: 'ses_123', options: { json: true } }
    ]);
  });
});
