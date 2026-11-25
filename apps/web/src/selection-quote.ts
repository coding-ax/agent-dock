export interface SelectionRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface SelectionPopoverPosition {
  left: number;
  top: number;
  placement: 'top' | 'bottom';
}

export interface SelectionQuoteTarget {
  text: string;
  rect: SelectionRect;
}

/** 选区归属标记：只有挂了此属性的 Agent 输出区域才触发划词引用浮层。 */
export const ASSISTANT_OUTPUT_SELECTOR = '[data-assistant-output]';

/**
 * 规范化选中的引用文本：统一换行符、裁剪首尾空白，并压缩连续 3 个及以上换行。
 */
export function normalizeQuotedText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 将引用文本格式化为标准 Markdown blockquote。
 * 空行保留为 `>`，避免多段引用被拆成多个不连续的 blockquote 块。
 */
export function formatQuoteBlock(quote: string): string {
  const normalized = normalizeQuotedText(quote);
  if (!normalized) return '';
  return normalized
    .split('\n')
    .map(line => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * 将引用块与用户回复正文组合成发送文本。
 */
export function composeQuotedMessage(quote: string | undefined, message: string): string {
  const quoteBlock = quote ? formatQuoteBlock(quote) : '';
  const body = message.trim();
  if (!quoteBlock) return body;
  if (!body) return quoteBlock;
  return `${quoteBlock}\n\n${body}`;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * 计算划词浮层在视口中的 fixed 坐标：
 * - 优先放在选区正上方居中；
 * - 若上方空间不足（低于视口安全边距或容器顶边），自动翻转到选区下方；
 * - 左右做视口 clamp，防止超出屏幕边缘。
 */
export function computeSelectionPopoverPosition({
  selectionRect,
  popoverSize,
  viewport,
  bounds,
  gap = 8,
  margin = 12
}: {
  selectionRect: SelectionRect;
  popoverSize: { width: number; height: number };
  viewport: { width: number; height: number };
  bounds?: Pick<SelectionRect, 'top' | 'bottom' | 'left' | 'right'>;
  gap?: number;
  margin?: number;
}): SelectionPopoverPosition {
  const minLeft = margin;
  const maxLeft = Math.max(minLeft, viewport.width - popoverSize.width - margin);
  const idealLeft = selectionRect.left + selectionRect.width / 2 - popoverSize.width / 2;
  const left = Math.round(clamp(idealLeft, minLeft, maxLeft));

  const minTop = Math.max(margin, bounds ? bounds.top + 4 : 0);
  const maxTop = Math.max(minTop, viewport.height - popoverSize.height - margin);
  const aboveTop = selectionRect.top - popoverSize.height - gap;

  if (aboveTop >= minTop) {
    return { left, top: Math.round(clamp(aboveTop, minTop, maxTop)), placement: 'top' };
  }

  const belowTop = selectionRect.bottom + gap;
  return { left, top: Math.round(clamp(belowTop, minTop, maxTop)), placement: 'bottom' };
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/**
 * 检查当前浏览器选区是否落在指定时间线容器内的 Agent 输出区域中。
 * 仅当起止点均位于容器内的 `[data-assistant-output]` 中且选中文本非空、矩形可见时返回目标信息。
 */
export function resolveAssistantSelection(
  selection: Selection | null,
  container: HTMLElement | null
): SelectionQuoteTarget | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !container) return null;

  const text = normalizeQuotedText(selection.toString());
  if (!text) return null;

  const range = selection.getRangeAt(0);
  const startEl = elementOf(range.startContainer);
  const endEl = elementOf(range.endContainer);
  if (!startEl || !endEl) return null;
  if (!container.contains(startEl) || !container.contains(endEl)) return null;

  const startAssistant = startEl.closest(ASSISTANT_OUTPUT_SELECTOR);
  const endAssistant = endEl.closest(ASSISTANT_OUTPUT_SELECTOR);
  if (!startAssistant || !endAssistant) return null;
  if (!container.contains(startAssistant) || !container.contains(endAssistant)) return null;

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  const containerRect = container.getBoundingClientRect();
  const visibleVertically = rect.bottom > containerRect.top && rect.top < containerRect.bottom;
  if (!visibleVertically) return null;

  return {
    text,
    rect: {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height
    }
  };
}
