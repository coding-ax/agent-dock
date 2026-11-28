import { describe, expect, it } from 'vitest';
import {
  buildRecoveryAgentPrompt,
  buildRecoveryVisiblePrompt,
  DEFAULT_TASK_RECOVERY_CONFIG,
  normalizeTaskRecoveryConfig,
  parseRecoveryTriggerSourceFromPrompt,
  stripRecoveryVisiblePrefix
} from './task-recovery.js';

describe('task-recovery shared helpers', () => {
  it('normalizes task recovery config with safe defaults and bounds', () => {
    expect(normalizeTaskRecoveryConfig()).toEqual(DEFAULT_TASK_RECOVERY_CONFIG);
    expect(normalizeTaskRecoveryConfig({ mode: 'confirm', windowMinutes: 30, maxAutoAttempts: 2, staggerSeconds: 5 })).toEqual({
      mode: 'confirm',
      windowMinutes: 30,
      maxAutoAttempts: 2,
      staggerSeconds: 5
    });
    expect(normalizeTaskRecoveryConfig({ mode: 'invalid' as never, windowMinutes: 0, maxAutoAttempts: 99, staggerSeconds: -5 })).toEqual({
      mode: 'auto',
      windowMinutes: 1,
      maxAutoAttempts: 3,
      staggerSeconds: 0
    });
    expect(normalizeTaskRecoveryConfig({ windowMinutes: 99999, staggerSeconds: 999 })).toEqual({
      mode: 'auto',
      windowMinutes: 1440,
      maxAutoAttempts: 1,
      staggerSeconds: 60
    });
  });

  it('builds concise visible prompt and strips nested recovery prefixes', () => {
    expect(buildRecoveryVisiblePrompt('修复登录态校验并补齐单测')).toBe('🔄 断点续跑：修复登录态校验并补齐单测');
    expect(buildRecoveryVisiblePrompt('🔄 断点续跑：再次续跑的任务')).toBe('🔄 断点续跑：再次续跑的任务');
    expect(stripRecoveryVisiblePrefix('🔄 断点续跑 · 清理日志')).toBe('清理日志');
    expect(buildRecoveryVisiblePrompt('   ')).toBe('🔄 断点续跑 · 续接因服务重启中断的任务');
  });

  it('builds checkpoint self-inspection agent prompt with anti-side-effect guardrails and trigger detection', () => {
    const autoPrompt = buildRecoveryAgentPrompt({
      interruptedTaskId: 'task_1',
      interruptedAt: '2026-11-28T07:00:00.000Z',
      originalPrompt: '帮我跑完测试并汇报',
      triggerSource: 'auto',
      attemptNumber: 1,
      maxAutoAttempts: 1
    });
    expect(autoPrompt).toContain('[AgentDock 系统断点续跑指令]');
    expect(autoPrompt).toContain('严禁重复执行已完成且带有外部副作用的操作');
    expect(autoPrompt).toContain('帮我跑完测试并汇报');
    expect(parseRecoveryTriggerSourceFromPrompt(autoPrompt)).toBe('auto');

    const larkPrompt = buildRecoveryAgentPrompt({
      interruptedTaskId: 'task_2',
      interruptedAt: '2026-11-28T07:00:00.000Z',
      originalPrompt: '整理发布清单',
      triggerSource: 'lark',
      attemptNumber: 1,
      maxAutoAttempts: 1
    });
    expect(parseRecoveryTriggerSourceFromPrompt(larkPrompt)).toBe('lark');

    const webPrompt = buildRecoveryAgentPrompt({
      interruptedTaskId: 'task_3',
      interruptedAt: '2026-11-28T07:00:00.000Z',
      originalPrompt: '整理发布清单',
      triggerSource: 'web',
      attemptNumber: 1,
      maxAutoAttempts: 1
    });
    expect(parseRecoveryTriggerSourceFromPrompt(webPrompt)).toBe('web');
  });
});
