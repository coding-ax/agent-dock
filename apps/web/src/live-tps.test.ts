import { describe, expect, it } from 'vitest';
import type { DockEvent } from './api';
import { computeLiveStreamTps, estimateTokensFromText, latestTurnUsageEventTps } from './live-tps';

const evt = (seq: number, type: DockEvent['type'], timestamp: string, data: Record<string, any>): DockEvent => ({
  id: `e_${seq}`,
  sequence: seq,
  type,
  timestamp,
  data
});

describe('live-tps 实时流式估算与校准', () => {
  it('按中英文权重估算 token 数', () => {
    // 12 ASCII chars -> 3 tokens
    expect(estimateTokensFromText('hello world!')).toBeCloseTo(3, 4);
    // 6 CJK chars -> 4 tokens
    expect(estimateTokensFromText('你好世界测试')).toBeCloseTo(4, 4);
    expect(estimateTokensFromText('')).toBe(0);
  });

  it('从最新 turn_usage 状态事件 0ms 算出校准 TPS（仅用 outputTokens）', () => {
    const events: DockEvent[] = [
      evt(1, 'status', '2026-11-26T00:00:01.000Z', { state: 'turn_usage', outputTokens: 200, thoughtTokens: 100, generationMs: 4000 }),
      evt(2, 'status', '2026-11-26T00:00:10.000Z', { state: 'turn_usage', outputTokens: 769, thoughtTokens: 547, generationMs: 6049 })
    ];
    expect(latestTurnUsageEventTps(events)).toBe(127.1);
  });

  it('流式输出期间按 3 秒滑动窗口计算实时 TPS，并在轮次结束后退出估算态', () => {
    const t0 = Date.parse('2026-11-26T00:00:00.000Z');
    const events: DockEvent[] = [
      evt(1, 'text', new Date(t0).toISOString(), { role: 'user', text: '写一段代码' }),
      // 1s: 160 ASCII chars = 40 tokens
      evt(2, 'text', new Date(t0 + 1000).toISOString(), { role: 'assistant', text: 'a'.repeat(160) }),
      // 2s: 160 ASCII chars = 40 tokens
      evt(3, 'text', new Date(t0 + 2000).toISOString(), { role: 'assistant', text: 'b'.repeat(160) }),
      // 3s: 160 ASCII chars = 40 tokens
      evt(4, 'text', new Date(t0 + 3000).toISOString(), { role: 'assistant', text: 'c'.repeat(160) })
    ];
    // t0 + 3000ms 时，样本跨度为 2000ms（1s..3s），累计 120 tokens -> 60.0 t/s
    const live = computeLiveStreamTps(events, t0 + 3000, true);
    expect(live.activeTool).toBe(false);
    expect(live.tps).toBe(60);

    // 收到 turn_usage 后立刻退出估算态，交由真实校准值接管
    const settled = computeLiveStreamTps([
      ...events,
      evt(5, 'status', new Date(t0 + 3200).toISOString(), { state: 'turn_usage', outputTokens: 120, generationMs: 2000 })
    ], t0 + 3200, true);
    expect(settled.tps).toBeNull();
  });

  it('工具执行期间保持最后生成速率且不归零衰减', () => {
    const t0 = Date.parse('2026-11-26T00:00:00.000Z');
    const events: DockEvent[] = [
      evt(1, 'text', new Date(t0).toISOString(), { role: 'user', text: '查文件' }),
      evt(2, 'thinking', new Date(t0 + 1000).toISOString(), { text: 'a'.repeat(200) }), // 50 tok
      evt(3, 'tool_call', new Date(t0 + 2000).toISOString(), { id: 'tc1', status: 'running', input: { path: 'a'.repeat(200) } }) // ~53 tok
    ];
    // 工具已经执行了 10 秒（t0 + 12000ms），仍保持 activeTool=true 且速率不归零
    const duringTool = computeLiveStreamTps(events, t0 + 12000, true);
    expect(duringTool.activeTool).toBe(true);
    expect(duringTool.tps).not.toBeNull();
    expect(duringTool.tps!).toBeGreaterThan(50);
  });
});
