import { describe, expect, it } from 'vitest';
import { absoluteActivityTime, describeActivityTime, sessionActivityRow, sessionSourceLabel, sessionStatusLabel } from './session-details';

// 用本地时间构造再转 ISO：断言里的小时数就成了本地钟点，不随跑测试的时区漂。
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).toISOString();
const now = new Date(2026, 9, 16, 14, 30);

describe('describeActivityTime', () => {
  it('一小时以内给相对时间', () => {
    expect(describeActivityTime(at(2026, 10, 16, 14, 30), now)).toBe('刚刚');
    expect(describeActivityTime(at(2026, 10, 16, 14, 5), now)).toBe('25 分钟前');
    expect(describeActivityTime(at(2026, 10, 16, 13, 31), now)).toBe('59 分钟前');
  });

  it('超过一小时按日历说今天/昨天，不按「多少小时前」', () => {
    expect(describeActivityTime(at(2026, 10, 16, 13, 0), now)).toBe('今天 13:00');
    expect(describeActivityTime(at(2026, 10, 15, 23, 0), now)).toBe('昨天 23:00');
  });

  // 凌晨看昨晚的事：说「昨天 23:00」比说「2 小时前」更对得上日历。
  it('跨零点后算「昨天」，即使只过了两小时', () => {
    expect(describeActivityTime(at(2026, 10, 15, 23, 0), new Date(2026, 9, 16, 1, 0))).toBe('昨天 23:00');
  });

  it('更早给日期，跨年才带年份', () => {
    expect(describeActivityTime(at(2026, 10, 8, 9, 0), now)).toBe('10月8日 09:00');
    expect(describeActivityTime(at(2025, 10, 8, 9, 0), now)).toBe('2025年10月8日 09:00');
  });

  it('非法时间原样返回，不产出 Invalid Date', () => {
    expect(describeActivityTime('不是时间', now)).toBe('不是时间');
  });
});

describe('absoluteActivityTime', () => {
  it('补零到分钟', () => {
    expect(absoluteActivityTime(at(2026, 10, 8, 9, 5))).toBe('2026-10-08 09:05');
  });
});

describe('sessionActivityRow', () => {
  it('有最后对话时间时，说「最后一次对话」，绝对时间与相对时间都在', () => {
    const row = sessionActivityRow({ lastMessageAt: at(2026, 10, 16, 14, 5), updatedAt: at(2026, 10, 16, 14, 29), createdAt: at(2026, 10, 1) }, now);
    expect(row.label).toBe('最后一次对话');
    expect(row.value).toContain('2026-10-16 14:05');
    expect(row.value).toContain('25 分钟前');
  });

  // 排序键就是 lastMessageAt → updatedAt → createdAt，卡片必须同一口径，否则用户会怀疑排序错了。
  it('没有最后对话时间时直说没有，退回最后活动时间', () => {
    const row = sessionActivityRow({ lastMessageAt: null, updatedAt: at(2026, 10, 15, 8, 0), createdAt: at(2026, 10, 1) }, now);
    expect(row.label).toBe('还没有对话记录');
    expect(row.value).toContain('2026-10-15 08:00');
  });
});

describe('sessionSourceLabel', () => {
  it('飞书会话带上机器人名，取不到名字就只写来源', () => {
    expect(sessionSourceLabel({ source: 'lark' }, { botName: '小助手' })).toBe('飞书 · 小助手');
    expect(sessionSourceLabel({ source: 'lark' })).toBe('飞书');
  });

  it('侧边会话点出派生自哪个会话，取不到父标题就降级', () => {
    expect(sessionSourceLabel({ source: 'side-chat' }, { parentLabel: '改一下副屏' })).toBe('侧边会话 · 派生自「改一下副屏」');
    expect(sessionSourceLabel({ source: 'side-chat' })).toBe('侧边会话');
  });

  // 定时任务会话在服务端也是 side-chat 建的，不加这层判断会被说成「派生自某个会话」。
  it('定时任务的侧边会话说成定时任务，不冒充派生会话', () => {
    expect(sessionSourceLabel({ source: 'side-chat', systemPrompt: '你是定时任务 sch_abc，请…' }, { parentLabel: '父' })).toBe('定时任务');
  });

  it('导入的外部会话与本地会话', () => {
    expect(sessionSourceLabel({ source: 'import' })).toBe('导入的外部会话');
    expect(sessionSourceLabel({})).toBe('本地');
  });
});

describe('sessionStatusLabel', () => {
  it('按 state 取中文名与色点', () => {
    expect(sessionStatusLabel({ state: 'running_tool' })).toEqual({ text: '正在调用工具', tone: 'bg-blue-500' });
  });

  // 归档行是只读的，再说「思考中」会误导。
  it('已归档压过 state', () => {
    expect(sessionStatusLabel({ state: 'thinking', archivedAt: at(2026, 10, 1, 0, 0) })).toEqual({ text: '已归档', tone: 'bg-zinc-400' });
  });

  it('未知 state 原样露出，不显示 undefined', () => {
    expect(sessionStatusLabel({ state: 'weird' }).text).toBe('weird');
  });
});
