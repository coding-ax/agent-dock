import { describe, expect, it } from 'vitest';
import { formatSendTime, formatSendTimeTitle, formatUserMessageTime } from './send-time';

// 用本机时区构造，断言与运行测试的机器时区无关。
const local = (year: number, month: number, day: number, hour: number, minute: number, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second).toISOString();

describe('formatSendTime', () => {
  const now = new Date(2026, 10, 12, 22, 5);

  it('shows only HH:mm for today', () => {
    expect(formatSendTime(local(2026, 11, 12, 21, 50), now)).toBe('21:50');
    expect(formatSendTime(local(2026, 11, 12, 0, 3), now)).toBe('00:03');
  });

  it('adds the date for another day in the same year', () => {
    expect(formatSendTime(local(2026, 11, 11, 9, 5), now)).toBe('11月11日 09:05');
    expect(formatSendTime(local(2026, 1, 1, 7, 0), now)).toBe('1月1日 07:00');
  });

  it('adds the year across years', () => {
    expect(formatSendTime(local(2025, 12, 31, 23, 59), now)).toBe('2025年12月31日 23:59');
  });

  it('uses the local timezone of the stored instant', () => {
    const instant = '2026-11-12T13:50:10.000Z';
    const date = new Date(instant);
    const pad = (value: number) => String(value).padStart(2, '0');
    const expected = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const reference = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59);
    expect(formatSendTime(instant, reference)).toBe(expected);
  });

  it('returns an empty string for missing or invalid timestamps', () => {
    expect(formatSendTime(undefined, now)).toBe('');
    expect(formatSendTime('', now)).toBe('');
    expect(formatSendTime('not-a-date', now)).toBe('');
  });
});

describe('formatSendTimeTitle', () => {
  it('renders a full local timestamp for the native tooltip', () => {
    expect(formatSendTimeTitle(local(2026, 11, 12, 9, 5, 7))).toBe('2026-11-12 09:05:07');
    expect(formatSendTimeTitle('nope')).toBe('');
  });
});

describe('formatUserMessageTime', () => {
  const now = new Date(2026, 10, 12, 22, 5);

  it('uses relative days for today and yesterday', () => {
    expect(formatUserMessageTime(local(2026, 11, 12, 0, 3), now)).toBe('今天 00:03');
    expect(formatUserMessageTime(local(2026, 11, 12, 21, 50), now)).toBe('今天 21:50');
    expect(formatUserMessageTime(local(2026, 11, 11, 9, 5), now)).toBe('昨天 09:05');
    expect(formatUserMessageTime(local(2026, 11, 11, 23, 59), now)).toBe('昨天 23:59');
  });

  it('adds month and day for older messages in the same year', () => {
    expect(formatUserMessageTime(local(2026, 11, 10, 9, 5), now)).toBe('11月10日 09:05');
    expect(formatUserMessageTime(local(2026, 1, 1, 7, 0), now)).toBe('1月1日 07:00');
  });

  it('always writes the year across years, even for the previous calendar day', () => {
    const newYear = new Date(2026, 0, 1, 0, 30);
    expect(formatUserMessageTime(local(2025, 12, 31, 23, 59), newYear)).toBe('2025年12月31日 23:59');
    expect(formatUserMessageTime(local(2025, 12, 30, 23, 59), newYear)).toBe('2025年12月30日 23:59');
  });

  it('compares calendar days in the local timezone instead of a fixed 24-hour window', () => {
    // 22:05 的 25 小时前是「昨天 21:05」，不是「前天」；反过来 23 小时前可能已经是昨天。
    expect(formatUserMessageTime(local(2026, 11, 11, 21, 5), now)).toBe('昨天 21:05');
    expect(formatUserMessageTime(local(2026, 11, 11, 23, 30), now)).toBe('昨天 23:30');
    // UTC 的 16:30 在上海已是次日 00:30，必须按本机日历判定。
    const instant = '2026-11-12T16:30:00.000Z';
    const date = new Date(instant);
    const reference = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0);
    expect(formatUserMessageTime(instant, reference)).toBe(`今天 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`);
  });

  it('returns an empty string for missing or invalid timestamps', () => {
    expect(formatUserMessageTime(undefined, now)).toBe('');
    expect(formatUserMessageTime('', now)).toBe('');
    expect(formatUserMessageTime('not-a-date', now)).toBe('');
  });
});
