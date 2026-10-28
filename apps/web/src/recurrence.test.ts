import { describe, expect, it } from 'vitest';
import { defaultRecurrence, describeCron, describeInterval, describeRunTime, nextCronRuns, oncePresets, recurrenceToCron, recurrenceToTrigger } from './recurrence';

describe('recurrence → cron', () => {
  it('builds cron for each friendly kind', () => {
    expect(recurrenceToCron({ ...defaultRecurrence, kind: 'daily', time: '09:30' }).cron).toBe('30 9 * * *');
    expect(recurrenceToCron({ ...defaultRecurrence, kind: 'weekdays', time: '18:05' }).cron).toBe('5 18 * * 1-5');
    expect(recurrenceToCron({ ...defaultRecurrence, kind: 'weekly', time: '10:00', weekdays: [5, 1, 1] }).cron).toBe('0 10 * * 1,5');
    expect(recurrenceToCron({ ...defaultRecurrence, kind: 'hourly', minute: 15 }).cron).toBe('15 * * * *');
    expect(recurrenceToCron({ ...defaultRecurrence, kind: 'custom', cron: ' 0  9 * * 1-5 ' }).cron).toBe('0 9 * * 1-5');
  });

  it('refuses to emit a half-built expression', () => {
    expect(recurrenceToCron({ ...defaultRecurrence, kind: 'daily', time: '' }).error).toMatch(/时间/);
    expect(recurrenceToCron({ ...defaultRecurrence, kind: 'weekly', weekdays: [] }).error).toMatch(/至少选一天/);
    expect(recurrenceToCron({ ...defaultRecurrence, kind: 'custom', cron: '0 9' }).error).toMatch(/5 段/);
  });
});

describe('fixed interval', () => {
  it('accepts any positive whole interval in minutes, hours or days instead of cron steps', () => {
    expect(recurrenceToTrigger({ ...defaultRecurrence, kind: 'interval', every: 7, everyUnit: 'minute' }).trigger).toEqual({ intervalMinutes: 7 });
    expect(recurrenceToTrigger({ ...defaultRecurrence, kind: 'interval', every: 3, everyUnit: 'hour' }).trigger).toEqual({ intervalMinutes: 180 });
    expect(recurrenceToTrigger({ ...defaultRecurrence, kind: 'interval', every: 0, everyUnit: 'minute' }).error).toBeTruthy();
    expect(recurrenceToTrigger({ ...defaultRecurrence, kind: 'interval', every: 31, everyUnit: 'day' }).error).toMatch(/30 天/);
    expect(recurrenceToTrigger({ ...defaultRecurrence, kind: 'daily', time: '09:30' }).trigger).toEqual({ cron: '30 9 * * *' });
  });

  it('describes intervals with the largest whole unit', () => {
    expect(describeInterval(7)).toBe('每 7 分钟');
    expect(describeInterval(90)).toBe('每 1 小时 30 分钟');
    expect(describeInterval(120)).toBe('每 2 小时');
    expect(describeInterval(2880)).toBe('每 2 天');
  });
});

describe('cron → 人话', () => {
  it('describes the shapes the form produces and falls back to raw cron otherwise', () => {
    expect(describeCron('30 9 * * *')).toBe('每天 09:30');
    expect(describeCron('5 18 * * 1-5')).toBe('工作日 18:05');
    expect(describeCron('0 10 * * 0,1,5')).toBe('每周一、五、日 10:00');
    expect(describeCron('0 * * * *')).toBe('每小时整点');
    expect(describeCron('15 * * * *')).toBe('每小时第 15 分');
    expect(describeCron('*/10 * * * *')).toBe('每 10 分钟');
    expect(describeCron('0 9 1 * *')).toBe('cron 0 9 1 * *');
  });
});

describe('next run preview', () => {
  const now = new Date(2026, 9, 14, 22, 10); // 周三 22:10
  it('lists upcoming runs in local time for the shapes the form produces', () => {
    expect(nextCronRuns('0 9 * * *', now).map(d => d.getDate())).toEqual([15, 16, 17]);
    expect(nextCronRuns('0 9 * * 1-5', now, 3).map(d => d.getDay())).toEqual([4, 5, 1]);
    expect(nextCronRuns('*/30 * * * *', now, 2).map(d => `${d.getHours()}:${d.getMinutes()}`)).toEqual(['22:30', '23:0']);
    expect(nextCronRuns('0 10 * * 7', now, 1)[0]!.getDay()).toBe(0);
    expect(nextCronRuns('0 9 1 * 1', now, 1)[0]!.getDay()).toBe(1); // 日与周都受限：满足其一
    expect(nextCronRuns('bad', now)).toEqual([]);
    expect(nextCronRuns('0 9 30 2 *', now)).toEqual([]);
  });

  it('describes run times relative to now', () => {
    expect(describeRunTime(new Date(2026, 9, 14, 23, 0), now)).toBe('今天 23:00');
    expect(describeRunTime(new Date(2026, 9, 15, 9, 0), now)).toBe('明天 09:00');
    expect(describeRunTime(new Date(2026, 9, 19, 9, 0), now)).toBe('周一（10月19日）09:00');
    expect(describeRunTime(new Date(2027, 0, 2, 9, 0), now)).toBe('2027年1月2日 09:00');
  });

  it('offers once presets that are all in the future', () => {
    const presets = oncePresets(now);
    expect(presets.map(item => item.label)).toEqual(['30 分钟后', '1 小时后', '明早 09:00']);
    expect(presets[2]!.value).toBe('2026-10-15T09:00');
    expect(oncePresets(new Date(2026, 9, 14, 8, 0)).map(item => item.label)).toContain('今晚 20:00');
  });
});
