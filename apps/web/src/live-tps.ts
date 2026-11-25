import type { DockEvent } from './api';

const CJK_RE = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

/**
 * 分语言字符→Token 粗估（仅用于流式进行中的实时 TPS 预览，轮次结束后由上游真实 usage 校准）：
 * - CJK 字符（中文/日文/全角标点）：约 1.5 字符 / token（~0.67 tok/char）
 * - ASCII / 英文 / 代码：约 4 字符 / token（0.25 tok/char）
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = Math.max(0, text.length - cjkCount);
  return cjkCount / 1.5 + otherCount / 4;
}

/**
 * 直接从 SSE 推来的 status(state='turn_usage') 事件计算本轮校准后的 TPS，
 * 用于前端 0ms 乐观更新，不必等 /api/sessions/:id/usage 的 HTTP 往返。
 */
export function latestTurnUsageEventTps(events: DockEvent[] | undefined): number | null {
  if (!events?.length) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const item = events[i]!;
    if (item.type !== 'status' || item.data?.state !== 'turn_usage') continue;
    const outputTokens = Number(item.data.outputTokens ?? 0);
    const generationMs = Number(item.data.generationMs ?? 0);
    if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;
    if (!Number.isFinite(generationMs) || generationMs <= 0) return null;
    return Math.round((outputTokens / (generationMs / 1000)) * 10) / 10;
  }
  return null;
}

export interface LiveStreamTpsResult {
  /** 流式估算的实时 TPS（tokens/sec）；无有效输出或已结算时为 null。 */
  tps: number | null;
  /** 当前是否有正在执行的工具调用（此时保留进入工具前的生成速率，不归零）。 */
  activeTool: boolean;
}

const LIVE_WINDOW_MS = 3_000;
const MIN_SPAN_MS = 500;
const STALE_AFTER_MS = 6_000;
const MIN_ESTIMATED_TOKENS = 4;

/**
 * 基于当前运行轮次的流式输出事件，用 3 秒滑动窗口估算实时 TPS。
 *
 * 为什么用 3 秒滑动窗口：
 * 后端 StreamEventCoalescer 按 2KB / 250ms 合批推送，若直接算相邻两帧差值会产生剧烈锯齿；
 * 3 秒窗口既能平滑合批抖动，又能在模型降速/提速时 1~2 秒内感知变化。
 */
export function computeLiveStreamTps(
  events: DockEvent[] | undefined,
  nowMs: number,
  isBusy: boolean
): LiveStreamTpsResult {
  if (!isBusy || !events?.length) return { tps: null, activeTool: false };

  // 找到当前活跃轮次的起点（最后一条 user 提问或上一轮 completed 之后）。
  let startIndex = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const item = events[i]!;
    if (item.type === 'completed' || (item.type === 'status' && item.data?.state === 'turn_usage')) {
      return { tps: null, activeTool: false };
    }
    if (item.type === 'text' && item.data?.role === 'user') {
      startIndex = i + 1;
      break;
    }
  }

  const samples: Array<{ at: number; tokens: number }> = [];
  const activeToolIds = new Set<string>();
  const seenToolInputTokens = new Map<string, number>();

  for (let i = startIndex; i < events.length; i -= -1) {
    const item = events[i]!;
    const at = Date.parse(item.timestamp);
    if (!Number.isFinite(at)) continue;

    if (item.type === 'tool_call') {
      const id = typeof item.data?.id === 'string' ? item.data.id : undefined;
      if (id) activeToolIds.add(id);
      if (item.data?.input !== undefined) {
        const serialized = typeof item.data.input === 'string' ? item.data.input : JSON.stringify(item.data.input);
        const totalEst = estimateTokensFromText(serialized);
        const prevEst = id ? (seenToolInputTokens.get(id) ?? 0) : 0;
        const delta = totalEst - prevEst;
        if (delta > 0) {
          if (id) seenToolInputTokens.set(id, totalEst);
          samples.push({ at, tokens: delta });
        }
      }
      continue;
    }

    if (item.type === 'tool_result') {
      const id = typeof item.data?.id === 'string' ? item.data.id : undefined;
      if (id) activeToolIds.delete(id);
      else activeToolIds.clear();
      continue;
    }

    if ((item.type === 'text' && item.data?.role !== 'user') || item.type === 'thinking') {
      const text = typeof item.data?.text === 'string' ? item.data.text : '';
      const est = estimateTokensFromText(text);
      if (est > 0) samples.push({ at, tokens: est });
    }
  }

  const activeTool = activeToolIds.size > 0;
  if (!samples.length) return { tps: null, activeTool };

  const lastSampleAt = samples[samples.length - 1]!.at;
  // 非工具等待态下如果超过 STALE_AFTER_MS 没有任何新输出，不再显示过期的实时速率。
  if (!activeTool && nowMs - lastSampleAt > STALE_AFTER_MS) {
    return { tps: null, activeTool: false };
  }

  // 工具执行期间锚定在最后一次模型输出时刻，避免等待工具时速率不断向 0 衰减。
  const anchorAt = activeTool ? lastSampleAt : Math.max(nowMs, lastSampleAt);
  const windowStart = anchorAt - LIVE_WINDOW_MS;

  let windowTokens = 0;
  let earliestInWindow = anchorAt;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const s = samples[i]!;
    if (s.at < windowStart) break;
    windowTokens += s.tokens;
    if (s.at < earliestInWindow) earliestInWindow = s.at;
  }

  if (windowTokens < MIN_ESTIMATED_TOKENS) return { tps: null, activeTool };

  // 若样本覆盖满窗口则按完整 LIVE_WINDOW_MS 计；刚起步时按实际跨度（至少 500ms）计，防首帧尖峰。
  const firstOverallAt = samples[0]!.at;
  const effectiveSpanMs = firstOverallAt <= windowStart
    ? LIVE_WINDOW_MS
    : Math.max(MIN_SPAN_MS, anchorAt - earliestInWindow);

  const tps = Math.round((windowTokens / (effectiveSpanMs / 1000)) * 10) / 10;
  return { tps: Number.isFinite(tps) && tps > 0 ? tps : null, activeTool };
}
