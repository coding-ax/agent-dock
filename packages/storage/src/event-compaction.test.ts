import { describe, expect, it } from 'vitest';
import { createRepositories } from './index.js';

describe('历史事件压缩', () => {
  it('只合并连续的思考片段，保留顺序、最终序号及原始事件', async () => {
    const repos = createRepositories(':memory:');
    try {
      const append = async (sequence: number, type: 'thinking' | 'text' | 'status', data: Record<string, unknown>) => {
        await repos.events.append({ id: `event-${sequence}`, sessionId: 'session-a', sequence, type, timestamp: `2026-09-23T00:00:0${sequence}.000Z`, data });
      };
      await append(1, 'thinking', { text: 'one' });
      await append(2, 'thinking', { text: ' two' });
      await append(3, 'status', { state: 'usage', used: 12 });
      await append(4, 'thinking', { text: 'three' });
      await append(5, 'text', { role: 'assistant', text: 'answer' });

      const compacted = await repos.events.listCompacted('session-a');
      expect(compacted.map(event => [event.sequence, event.type])).toEqual([[2, 'thinking'], [3, 'status'], [4, 'thinking'], [5, 'text']]);
      expect(compacted[0]?.data).toEqual({ text: 'one two' });
      expect(compacted[0]?.id).toBe('event-1');
      expect(compacted[0]?.timestamp).toBe('2026-09-23T00:00:02.000Z');
      expect((await repos.events.list('session-a')).map(event => event.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect((await repos.events.listCompacted('session-a', 3)).map(event => event.sequence)).toEqual([4, 5]);
    } finally {
      repos.close();
    }
  });

  it('原始事件可以按序号向前翻页，保留未压缩的事件', async () => {
    const repos = createRepositories(':memory:');
    try {
      for (let sequence = 1; sequence <= 5; sequence++) {
        await repos.events.append({ id: `raw-${sequence}`, sessionId: 'session-b', sequence, type: 'thinking', timestamp: '2026-09-23T00:00:00.000Z', data: { text: String(sequence) } });
      }
      expect((await repos.events.listRecent('session-b', 2)).map(event => event.sequence)).toEqual([4, 5]);
      expect((await repos.events.listRecent('session-b', 2, 4)).map(event => event.sequence)).toEqual([2, 3]);
      expect((await repos.events.listRecent('session-b', 2, 2)).map(event => event.sequence)).toEqual([1]);
    } finally {
      repos.close();
    }
  });

  it('按会话数事件行数，只数本会话', async () => {
    const repos = createRepositories(':memory:');
    try {
      for (let sequence = 1; sequence <= 3; sequence++) {
        await repos.events.append({ id: `c-${sequence}`, sessionId: 'session-c', sequence, type: 'text', timestamp: '2026-09-23T00:00:00.000Z', data: { text: String(sequence) } });
      }
      await repos.events.append({ id: 'other-1', sessionId: 'session-d', sequence: 1, type: 'text', timestamp: '2026-09-23T00:00:00.000Z', data: { text: '别算进来' } });
      // 被截断的读取要靠它标出总数，数错等于告诉用户「这就是全部」。
      expect(await repos.events.countBySession('session-c')).toBe(3);
      expect(await repos.events.countBySession('session-d')).toBe(1);
      expect(await repos.events.countBySession('session-missing')).toBe(0);
    } finally {
      repos.close();
    }
  });

  it('按序号区间取事件时连正文一起合并，用户锚点原样留下当分隔符', async () => {
    const repos = createRepositories(':memory:');
    try {
      const append = async (sequence: number, type: 'thinking' | 'text' | 'status', data: Record<string, unknown>) => {
        await repos.events.append({ id: `event-${sequence}`, sessionId: 'session-turn', sequence, type, timestamp: `2026-09-23T00:00:0${sequence}.000Z`, data });
      };
      await append(1, 'text', { role: 'user', taskId: 'task_1', text: '用户问题' });
      await append(2, 'thinking', { text: '先' });
      await append(3, 'thinking', { text: '想' });
      await append(4, 'text', { text: '答' });
      await append(5, 'text', { text: '案' });
      await append(6, 'status', { state: 'usage' });
      await append(7, 'text', { text: '补' });
      await append(8, 'text', { text: '充', role: 'user' });

      const range = await repos.events.listCompactedRange('session-turn', { after: 1, before: 9, limit: 100 });
      // 分片必须合并：一条半句话的正文分片在面板上没法看，思考同理。
      expect(range.map(event => [event.sequence, event.type])).toEqual([[3, 'thinking'], [5, 'text'], [6, 'status'], [7, 'text'], [8, 'text']]);
      expect(range[0]?.data).toEqual({ text: '先想' });
      expect(range[1]?.data).toEqual({ text: '答案' });
      // role:'user' 的分片不能被并进别人：并掉之后就再也切不回轮次了。
      expect(range[3]?.data).toEqual({ text: '补' });
      expect(range[4]?.data).toEqual({ role: 'user', text: '充' });
      // limit 截在原始行上，不是合并后的段数——否则一轮几千段就再也取不全。
      expect((await repos.events.listCompactedRange('session-turn', { after: 1, before: 9, limit: 2 })).map(event => event.sequence)).toEqual([3]);
      // 两端都排他：上一轮不会蹭到下一轮的锚点。
      expect((await repos.events.listCompactedRange('session-turn', { after: 5, before: 9, limit: 100 })).map(event => event.sequence)).toEqual([6, 7, 8]);
    } finally {
      repos.close();
    }
  });

  it('按字节预算截断单轮读取，且不把一条事件切成半截', async () => {
    const repos = createRepositories(':memory:');
    try {
      const append = async (sequence: number, type: 'text', data: Record<string, unknown>) => {
        await repos.events.append({ id: `event-${sequence}`, sessionId: 'session-bytes', sequence, type, timestamp: '2026-09-23T00:00:00.000Z', data });
      };
      await append(1, 'text', { role: 'user', taskId: 'task_1', text: '问题' });
      // 一条巨大的工具结果：整页 HTML 那种。光靠行数限不住单轮大小。
      await append(2, 'text', { text: 'x'.repeat(5_000) });
      await append(3, 'text', { text: 'y'.repeat(5_000) });
      await append(4, 'text', { text: 'z'.repeat(5_000) });

      const capped = await repos.events.listCompactedRange('session-bytes', { after: 1, before: 5, limit: 100, maxBytes: 6_000 });
      expect(capped.map(event => event.sequence)).toEqual([2]);
      // 截断是「这条不要了」，不是「这条只留一半」——半截的 HTML 谁也没法看。
      expect((capped[0]?.data as { text: string }).text).toHaveLength(5_000);
      // 超大行也必须收下第一条，否则调用方按 nextAfter continue 时会原地打转。
      const single = await repos.events.listCompactedRange('session-bytes', { after: 1, before: 5, limit: 100, maxBytes: 10 });
      expect(single.map(event => event.sequence)).toEqual([2]);
      // 不给预算时三段连续正文合成一条（这正是「按轮取」需要的形态），预算只影响取到哪。
      const uncapped = await repos.events.listCompactedRange('session-bytes', { after: 1, before: 5, limit: 100 });
      expect(uncapped.map(event => event.sequence)).toEqual([4]);
      expect((uncapped[0]?.data as { text: string }).text).toHaveLength(15_000);
    } finally {
      repos.close();
    }
  });

  it('按锚点切分轮次，给出每轮边界与过程条数', async () => {
    const repos = createRepositories(':memory:');
    try {
      const append = async (sequence: number, type: 'thinking' | 'text', data: Record<string, unknown>) => {
        await repos.events.append({ id: `event-${sequence}`, sessionId: 'session-turns', sequence, type, timestamp: '2026-09-23T00:00:00.000Z', data });
      };
      await append(1, 'text', { role: 'user', taskId: 'task_1', text: '第一轮' });
      await append(2, 'thinking', { text: '想' });
      await append(3, 'text', { text: '答' });
      await append(4, 'text', { role: 'user', taskId: 'task_2', text: '第二轮' });
      await append(5, 'thinking', { text: '再想' });
      // 没有 taskId 的 user 文本（历史遗留 / 非锚点）不能当成轮次边界。
      await append(6, 'text', { role: 'user', text: '没有 taskId' });
      await append(7, 'thinking', { text: '收尾' });

      const turns = await repos.events.listTurns('session-turns');
      expect(turns).toEqual([
        { taskId: 'task_1', startSequence: 1, endSequence: 4, segments: 2 },
        { taskId: 'task_2', startSequence: 4, endSequence: 8, segments: 3 }
      ]);
      // 末轮的 endSequence 要用会话最大序号 +1：用 0 或 null 会让最后一轮整个取不到。
      expect(turns[1]?.endSequence).toBe(8);
      expect(await repos.events.listTurns('session-missing')).toEqual([]);
      expect(await repos.events.maxSequence('session-turns')).toBe(7);
    } finally {
      repos.close();
    }
  });

  it('惰性迭代原始事件，内存占用与历史长度无关', async () => {
    const repos = createRepositories(':memory:');
    try {
      for (let sequence = 1; sequence <= 4; sequence++) {
        await repos.events.append({ id: `it-${sequence}`, sessionId: 'session-iterate', sequence, type: 'thinking', timestamp: '2026-09-23T00:00:00.000Z', data: { text: String(sequence) } });
      }
      const iterated = repos.events.iterate('session-iterate');
      // 是个迭代器而不是数组：全量回放（SSE / CLI 转录）靠这一点才不会被历史撑爆。
      expect(typeof (iterated as unknown as { next?: unknown }).next).toBe('function');
      expect([...iterated].map(event => event.sequence)).toEqual([1, 2, 3, 4]);
      expect([...repos.events.iterate('session-iterate', 2)].map(event => event.sequence)).toEqual([3, 4]);
      expect([...(repos.events.iterate('session-iterate'))][0]?.data).toEqual({ text: '1' });
    } finally {
      repos.close();
    }
  });

  it('有界前向分页读：读一页就能继续写，不会把 statement 挂着', async () => {
    const repos = createRepositories(':memory:');
    try {
      for (let sequence = 1; sequence <= 5; sequence++) {
        await repos.events.append({ id: `page-${sequence}`, sessionId: 'session-page', sequence, type: 'thinking', timestamp: '2026-09-23T00:00:00.000Z', data: { text: String(sequence) } });
      }
      const first = await repos.events.listPage('session-page', { after: 0, limit: 2 });
      expect(first.map(event => event.sequence)).toEqual([1, 2]);
      // 关键：分页读已同步 finalize，页与页之间往同一条连接写必须成功。
      // 换成 events.iterate 挂在生成器里，这一句会抛 "database connection is busy executing a query"。
      await repos.events.append({ id: 'page-6', sessionId: 'session-page', sequence: 6, type: 'thinking', timestamp: '2026-09-23T00:00:00.000Z', data: { text: '6' } });
      const second = await repos.events.listPage('session-page', { after: 2, limit: 10 });
      expect(second.map(event => event.sequence)).toEqual([3, 4, 5, 6]);
      // limit 不足一页：拿到的行数少于 limit，调用方据此判定读完。
      const third = await repos.events.listPage('session-page', { after: 6, limit: 10 });
      expect(third).toEqual([]);
    } finally {
      repos.close();
    }
  });

  it('原始事件的区间读不合并分片，两端排他', async () => {
    const repos = createRepositories(':memory:');
    try {
      const append = async (sequence: number, type: 'thinking' | 'text', data: Record<string, unknown>) => {
        await repos.events.append({ id: `raw-range-${sequence}`, sessionId: 'session-raw-range', sequence, type, timestamp: '2026-09-23T00:00:00.000Z', data });
      };
      await append(1, 'text', { role: 'user', taskId: 'task_1', text: '问题' });
      await append(2, 'thinking', { text: '先' });
      await append(3, 'thinking', { text: '想' });
      await append(4, 'text', { text: '答' });
      await append(5, 'text', { role: 'user', taskId: 'task_2', text: '下一轮' });

      // 终态判定要的是「这一轮原本有哪些事件」：合并会把「最后一条 assistant 文本」的
      // 边界和分片次序抹掉，所以这里必须保持原始分片。
      const range = await repos.events.listRange('session-raw-range', { after: 1, before: 5 });
      expect(range.map(event => [event.sequence, event.type])).toEqual([[2, 'thinking'], [3, 'thinking'], [4, 'text']]);
      expect(range[0]?.data).toEqual({ text: '先' });
      expect(range[1]?.data).toEqual({ text: '想' });
      expect(await repos.events.listRange('session-raw-range', { after: 5, before: 6 })).toEqual([]);
      expect(await repos.events.listRange('session-raw-range', { after: 0, before: 2 })).toHaveLength(1);
    } finally {
      repos.close();
    }
  });

  it('单个 taskId 的轮次边界靠锚点，找不到就说找不到', async () => {
    const repos = createRepositories(':memory:');
    try {
      const append = async (sequence: number, type: 'thinking' | 'text', data: Record<string, unknown>) => {
        await repos.events.append({ id: `anchor-${sequence}`, sessionId: 'session-anchor', sequence, type, timestamp: '2026-09-23T00:00:00.000Z', data });
      };
      await append(1, 'text', { role: 'user', taskId: 'task_1', text: '第一轮' });
      await append(2, 'thinking', { text: '想' });
      await append(4, 'text', { role: 'user', taskId: 'task_2', text: '第二轮' });
      await append(7, 'thinking', { text: '收尾' });

      expect(await repos.events.turnRange('session-anchor', 'task_1')).toEqual({ startSequence: 1, endSequence: 4 });
      // 末轮没有下一条锚点，上界取会话最大序号 +1，否则最后一轮整个取不到。
      expect(await repos.events.turnRange('session-anchor', 'task_2')).toEqual({ startSequence: 4, endSequence: 8 });
      // 没有锚点（历史数据）就返回 undefined：退化成「整个会话都算它的」会把别人的输出
      // 当成这一轮的最终输出，比承认不知道更糟。
      expect(await repos.events.turnRange('session-anchor', 'task_legacy')).toBeUndefined();
    } finally {
      repos.close();
    }
  });
});
