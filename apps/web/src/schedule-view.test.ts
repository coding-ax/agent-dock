import { describe, expect, it } from 'vitest';
import { buildScheduleSessionSeed } from '../../server/src/schedules/service';
import { bindableSessions, canResume, describeTrigger, emptyScheduleForm, isScheduledSession, scheduleFormToInput, scheduleState, describeCountdown, summarizeSchedules } from './schedule-view';

const now = new Date('2026-10-14T10:00:00Z');

describe('schedule form', () => {
  const base = { ...emptyScheduleForm, prompt: '  汇总群消息 ', agentId: 'codex', cwd: '/repo' };

  it('creates a standalone new-session schedule from the picked agent and directory, defaulting to every day 9:00', () => {
    const result = scheduleFormToInput({ ...base, model: 'gpt-5' }, { now });
    expect(result.input).toMatchObject({ prompt: '汇总群消息', delivery: 'new_session', cron: '0 9 * * *', template: { agentId: 'codex', cwd: '/repo', model: 'gpt-5' } });
    expect(result.input).not.toHaveProperty('sessionId');
    expect(result.input?.timezone).toBeTruthy();
  });

  it('hangs new sessions under the session it was created from, and appends only to a picked session', () => {
    expect(scheduleFormToInput(base, { parentSessionId: 'ses_1', now }).input).toMatchObject({ sessionId: 'ses_1', template: { agentId: 'codex' } });
    const append = scheduleFormToInput({ ...base, delivery: 'append', appendSessionId: 'ses_2' }, { now }).input;
    expect(append).toMatchObject({ sessionId: 'ses_2', delivery: 'append' });
    expect(append).not.toHaveProperty('template');
  });

  it('turns the friendly recurrence and datetime-local values into cron / ISO', () => {
    expect(scheduleFormToInput({ ...base, recurrence: { ...base.recurrence, kind: 'weekly', weekdays: [1, 3], time: '10:30' } }, { now }).input?.cron).toBe('30 10 * * 1,3');
    expect(scheduleFormToInput({ ...base, kind: 'once', runAt: '2026-10-15T18:00' }, { now }).input).toMatchObject({ runAt: new Date('2026-10-15T18:00').toISOString() });
  });

  it('rejects incomplete input before calling the server', () => {
    expect(scheduleFormToInput({ ...base, prompt: ' ' }, { now }).error).toMatch(/内容/);
    expect(scheduleFormToInput({ ...base, agentId: '' }, { now }).error).toMatch(/Agent/);
    expect(scheduleFormToInput({ ...base, cwd: ' ' }, { now }).error).toMatch(/工作目录/);
    expect(scheduleFormToInput({ ...base, delivery: 'append', appendSessionId: '' }, { now }).error).toMatch(/会话/);
    expect(scheduleFormToInput({ ...base, recurrence: { ...base.recurrence, kind: 'weekly', weekdays: [] } }, { now }).error).toMatch(/至少选一天/);
    expect(scheduleFormToInput({ ...base, kind: 'once', runAt: '2020-01-01T00:00' }, { now }).error).toMatch(/过去/);
  });
});

describe('schedule display', () => {
  it('describes common cron shapes in words and falls back to the raw expression', () => {
    expect(describeTrigger({ cron: '0 9 * * 1-5' })).toBe('工作日 09:00');
    expect(describeTrigger({ cron: '0 9 1 * *' })).toBe('cron 0 9 1 * *');
    expect(describeTrigger({ cron: null, runAt: null })).toBe('单次 —');
  });

  it('tells a finished one-shot apart from a paused or auto-disabled schedule, matching server resume rules', () => {
    expect(scheduleState({ enabled: true, cron: '* * * * *' })).toMatchObject({ label: '启用中' });
    expect(scheduleState({ enabled: false, cron: null, lastRunAt: 'x' })).toMatchObject({ label: '已执行' });
    expect(scheduleState({ enabled: false, cron: '* * * * *', lastStatus: 'failed' })).toMatchObject({ label: '已停用' });
    expect(scheduleState({ enabled: false, cron: '* * * * *' })).toMatchObject({ label: '已暂停' });
    expect(canResume({ enabled: false, cron: null, lastRunAt: 'x' })).toBe(false);
    expect(canResume({ enabled: false, cron: null, lastRunAt: null })).toBe(true);
    expect(canResume({ enabled: true, cron: '* * * * *' })).toBe(false);
  });

  it('offers only live, non-scheduled sessions for binding, most recently used first', () => {
    const seed = buildScheduleSessionSeed({ id: 'sch_1', name: 'x', sessionId: 'a' });
    const sessions = [
      { id: 'old', updatedAt: '2026-10-01T00:00:00Z' },
      { id: 'recent', updatedAt: '2026-10-01T00:00:00Z', lastMessageAt: '2026-10-14T00:00:00Z' },
      { id: 'archived', updatedAt: '2026-10-14T00:00:00Z', archivedAt: '2026-10-14T00:00:00Z' },
      { id: 'spawned', updatedAt: '2026-10-14T00:00:00Z', systemPrompt: seed }
    ];
    expect(bindableSessions(sessions).map(item => item.id)).toEqual(['recent', 'old']);
  });

  it('recognises sessions created by a schedule from the seed the server writes', () => {
    expect(isScheduledSession({ systemPrompt: buildScheduleSessionSeed({ id: 'sch_1', name: '早报', sessionId: 'ses_1' }) })).toBe(true);
    expect(isScheduledSession({ systemPrompt: '你是一个侧边会话：由主会话派生' })).toBe(false);
    expect(isScheduledSession({})).toBe(false);
  });
});

describe('list overview', () => {
  const now = new Date(2026, 9, 15, 12, 0);
  const base = { sessionTemplate: null, delivery: 'new_session' as const, timezone: 'UTC', prompt: 'p', lastRunAt: null, lastStatus: null, runCount: 0, createdAt: '', updatedAt: '' };
  const at = (h: number, m = 0, day = 15) => new Date(2026, 9, day, h, m).toISOString();

  it('counts down to the next run in plain words', () => {
    expect(describeCountdown(new Date(2026, 9, 15, 12, 23), now)).toBe('23 分钟后');
    expect(describeCountdown(new Date(2026, 9, 15, 14, 30), now)).toBe('2 小时 30 分后');
    expect(describeCountdown(new Date(2026, 9, 17, 12, 0), now)).toBe('2 天后');
    expect(describeCountdown(new Date(2026, 9, 15, 11, 59), now)).toBe('即将触发');
  });

  it('summarizes what is active, due today and recently run', () => {
    const summary = summarizeSchedules([
      { ...base, id: 'a', name: 'A', enabled: true, cron: '0 18 * * *', nextRunAt: at(18) },
      { ...base, id: 'b', name: 'B', enabled: true, intervalMinutes: 30, nextRunAt: at(12, 30) },
      { ...base, id: 'c', name: 'C', enabled: true, cron: '0 9 * * *', nextRunAt: at(9, 0, 16) },
      { ...base, id: 'd', name: 'D', enabled: false, runAt: at(10), nextRunAt: null }
    ], [
      { id: 'r1', scheduleId: 'b', fireAt: at(11, 30), status: 'delivered', createdAt: '' },
      { id: 'r2', scheduleId: 'a', fireAt: at(18, 0, 14), status: 'failed', createdAt: '' },
      { id: 'r3', scheduleId: 'a', fireAt: at(9, 0, 13), status: 'delivered', createdAt: '' }
    ], now);
    expect(summary).toMatchObject({ active: 3, inactive: 1, dueToday: 2, ran24h: 1, failed24h: 1 });
    expect(summary.next?.id).toBe('b');
  });
});
