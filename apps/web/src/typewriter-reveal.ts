import { useEffect, useRef, useState } from 'react';

/**
 * 流式文本的自适应打字机。
 *
 * 思路参考 tom-ai 的 typewriterReveal：模型吐字是攒批的（网络把几十个 token 合成一帧），
 * 直接渲染就是「一跳一跳」；这里本地维护一个显示游标，按时间推进把它补出来。
 *
 * 速度模型（按**每秒**算，跟刷新率无关，120Hz 屏不会更快）：
 *   速度 = 基础速度 + 落后量 / 追赶窗口
 * 于是稳态落后量 ≈ 基础速度 × 追赶窗口：模型比基础速度快时不会无限落后，只在一个固定
 * 水位上下浮动；流结束后再用「收干」速度把尾巴播完，不会把快模型拖成慢模型。
 *
 * 半截 Markdown 不裸露：文本切到一半时先按最终形态**预闭合**（未闭合的 `**` / 围栏 /
 * 表格行补上收尾标记），只影响渲染、不改原文。
 */

export interface TypewriterSpeed {
  /** 基础打字速度（字/秒）：手感下限，也是稳态落后的决定项之一。 */
  baseCharsPerSecond: number;
  /** 追赶窗口（秒）：落后越多追得越快。 */
  catchUpSeconds: number;
  /** 流结束后把剩余量播完的时间（秒）。 */
  drainSeconds: number;
}

export const DEFAULT_TYPEWRITER_SPEED: TypewriterSpeed = {
  baseCharsPerSecond: 14,
  catchUpSeconds: 3,
  drainSeconds: 0.9
};

/** 单帧最多按 100ms 计，避免切走标签页回来后一次性刷一大段。 */
const MAX_FRAME_SECONDS = 0.1;
/**
 * 渲染提交间隔（毫秒）。
 *
 * 每次提交都会让 ReactMarkdown 重新 parse 整段文本（代码块还要重跑 Prism），所以不能
 * 按 60fps 提。40ms（≈25fps）在观感上仍然是连续吐字，主线程开销却只有 60fps 的三分之二。
 */
const COMMIT_INTERVAL_MS = 40;

/**
 * 按经过的时间推进显示游标（返回**小数**，调用方只在提交时取整）。
 * `streaming` 为 false 时用「收干」速度，保证结尾是快速播完而不是跳变。
 */
export function advanceRevealLength(
  current: number,
  total: number,
  elapsedSeconds: number,
  streaming: boolean,
  speed: TypewriterSpeed = DEFAULT_TYPEWRITER_SPEED
): number {
  if (current >= total) return total;
  const remaining = total - current;
  const charsPerSecond = streaming
    ? speed.baseCharsPerSecond + remaining / Math.max(0.1, speed.catchUpSeconds)
    : remaining / Math.max(0.05, speed.drainSeconds);
  const step = charsPerSecond * Math.max(0, Math.min(MAX_FRAME_SECONDS, elapsedSeconds));
  // 收干阶段必须有下界：remaining/drainSeconds × elapsed 是几何收敛，纯小数推进永远碰不到
  // total，会让 rAF 一直空转、光标不消失。流式阶段不加下界，否则 60fps 下「每帧至少 1 字」
  // 会把基础速度架空成 60 字/秒。
  return Math.min(total, current + (streaming ? step : Math.max(1, step)));
}

interface Range { start: number; end: number }

/**
 * 返回「当前这一帧该渲染的 Markdown」：截到 target 个字符，再补上未闭合的收尾标记。
 *
 * 只改渲染文本，不改原文——下一批字到了就用新的原文重新闭合一次。
 * 处理顺序有讲究：围栏没闭合时里面的内容不是 markdown，补完围栏就返回；
 * 其余情况先补表格行，再补行内标记。
 */
export function closeIncompleteMarkdown(text: string): string {
  if (!text) return text;
  const fences = scanFences(text);
  if (fences.openStart >= 0) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(text.slice(fences.openStart))?.[1] ?? '```';
    return `${text}\n${marker}`;
  }
  return closeIncompleteInline(closeIncompleteTable(text), fences.ranges);
}

export function renderRevealedText(fullText: string, target: number): string {
  return closeIncompleteMarkdown(fullText.slice(0, Math.max(0, Math.min(target, fullText.length))));
}

interface FenceScan {
  ranges: Range[];
  /** 未闭合围栏的起点；-1 表示没有。 */
  openStart: number;
}

function scanFences(text: string): FenceScan {
  const ranges: Range[] = [];
  let index = 0;
  let start = -1;
  while (index < text.length) {
    const lineEnd = text.indexOf('\n', index);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(index, end);
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      if (start < 0) start = index;
      else if (/^\s*(`{3,}|~{3,})\s*$/.test(line)) {
        ranges.push({ start, end: end + 1 });
        start = -1;
      }
    }
    if (lineEnd === -1) break;
    index = lineEnd + 1;
  }
  return { ranges, openStart: start };
}

/** 把围栏区间替换成等长空格，做行内标记计数时忽略代码块里的 `**` / 反引号。 */
function maskRanges(text: string, ranges: Range[]): string {
  if (ranges.length === 0) return text;
  const chars = text.split('');
  for (const range of ranges) {
    for (let i = range.start; i < Math.min(range.end, chars.length); i += 1) chars[i] = ' ';
  }
  return chars.join('');
}

function closeIncompleteTable(text: string): string {
  const lines = text.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && (lines[end] ?? '').trim() === '') end -= 1;
  if (end < 0) return text;
  if (!(lines[end] ?? '').trimStart().startsWith('|')) return text;

  let start = end;
  while (start > 0 && (lines[start - 1] ?? '').trimStart().startsWith('|')) start -= 1;

  const lastLine = lines[end] ?? '';
  if (!/\|\s*$/.test(lastLine)) lines[end] = `${lastLine} |`;

  // 表头到了但分隔行还没到：GFM 不认，补一行等价分隔行，让表头先按表格渲染。
  if (end === start && !/^\s*\|[\s:|-]+\|\s*$/.test(lastLine)) {
    const columns = Math.max(1, (lines[end] ?? '').split('|').length - 2);
    lines.splice(end + 1, 0, `|${' --- |'.repeat(columns)}`);
  }
  return lines.join('\n');
}

/** 行内标记：切在半截会露出裸标记。 */
const INLINE_MARKERS = ['**', '~~', '`'] as const;

function closeIncompleteInline(text: string, closedFenceRanges: Range[]): string {
  const masked = maskRanges(text, closedFenceRanges);
  let result = text;
  for (const marker of INLINE_MARKERS) {
    if (isMarkerOpen(masked, masked.length, marker)) result += marker;
  }
  return result;
}

function isMarkerOpen(text: string, cut: number, marker: string): boolean {
  const slice = text.slice(0, cut);
  let count = 0;
  let from = 0;
  for (;;) {
    const found = slice.indexOf(marker, from);
    if (found === -1) break;
    count += 1;
    from = found + marker.length;
  }
  return count % 2 === 1;
}

/**
 * 返回「当前应该显示出来」的文本。
 *
 * 首帧一律从「当前已有文本长度」起算：
 *   - 历史消息 / 已结束消息：直接就是全文，不做动画；
 *   - 刷新页面 / 切回正在跑的任务：不要把已经显示的整段重打一遍；
 *   - 从头开始流的消息：text 本来就是空串，从 0 开始，正常逐字。
 */
export function useAdaptiveTypewriter(
  fullText: string,
  streaming: boolean,
  speed: TypewriterSpeed = DEFAULT_TYPEWRITER_SPEED,
  /**
   * 这一行是不是「首屏 payload 里就已经存在」的历史内容。
   * true：刷新页面 / 切回会话时不要把已经显示的整段重打一遍；false：真正在流的新内容，从 0 起算。
   */
  replay = false
): string {
  // 判定只看「这一行是不是首屏 payload 里就已经存在的」：
  //   - replay=true：刷新页面 / 切回会话，这一段之前就显示过 → 直接从全文起算，绝不重播。
  //   - replay=false：这次打开页面之后才出现的行 → 从 0 起算，逐字播出来。
  // 不叠加 streaming 判断：事件是攒批推上来的，一条回答很可能「第一次渲染就已经带了整段文本、
  // 而且那一帧 task 已经结束」，用 streaming 做门槛会让打字机时灵时不灵。
  const initialCursor = replay ? fullText.length : 0;
  const [shown, setShown] = useState(() => initialCursor);
  const progressRef = useRef(initialCursor);
  const shownRef = useRef(initialCursor);
  const total = fullText.length;

  useEffect(() => {
    if (!streaming && shownRef.current >= fullText.length) return;

    let frame = 0;
    let cancelled = false;
    let last = performance.now();
    let lastCommit = 0;
    const tick = (now: number) => {
      if (cancelled) return;
      const elapsed = (now - last) / 1000;
      last = now;
      progressRef.current = advanceRevealLength(progressRef.current, fullText.length, elapsed, streaming, speed);
      const pending = progressRef.current;
      if (now - lastCommit >= COMMIT_INTERVAL_MS || pending >= fullText.length) {
        lastCommit = now;
        const next = Math.floor(pending);
        shownRef.current = next;
        setShown(next);
      }
      // 流结束后追平就停掉 rAF，不用一直空转。
      if (!streaming && pending >= fullText.length) return;
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
    // 依赖拆成基本类型：调用方每次 render 新建的 speed 对象不应该重置动画循环。
  }, [streaming, total, speed.baseCharsPerSecond, speed.catchUpSeconds, speed.drainSeconds]);
  // replay 只决定「首帧游标」，不参与 effect 依赖：它翻成 false 之后不该重置动画循环。

  if (!streaming && shownRef.current >= total && shown >= total) return fullText;
  return renderRevealedText(fullText, shown);
}
