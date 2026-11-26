/**
 * 基于 CSS Custom Highlight API 的对话流文本高亮与定位工具。
 *
 * 不直接改写 ReactMarkdown / Prism 渲染出来的 DOM 树，避免破坏 React reconciliation、
 * 代码块高亮或逐字动画；同时支持跨行内标签（如 `**加粗**`、语法高亮 token）匹配。
 */

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD',
  'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
]);

function closestBlockAncestor(node: Node, root: Element): Element {
  let current: Element | null = node.parentElement;
  while (current && current !== root) {
    if (BLOCK_TAGS.has(current.tagName)) return current;
    current = current.parentElement;
  }
  return root;
}

function isHiddenTextNode(node: Text, root: Element): boolean {
  let current: Element | null = node.parentElement;
  while (current && current !== root) {
    const tag = current.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') return true;
    if (current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return true;
    current = current.parentElement;
  }
  return false;
}

/**
 * 在指定 DOM 根元素内查找所有大小写不敏感匹配对应的 Range。
 * 同一块级元素内的相邻文本节点会拼接匹配（支持跨行内标签），不同块级元素间插入 `\n` 分隔，
 * 避免跨段落误拼接。
 */
export function findTextRangesInElement(root: Element, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segments: TextSegment[] = [];
  let combined = '';
  let lastBlock: Element | null = null;

  let current = walker.nextNode();
  while (current) {
    const textNode = current as Text;
    const value = textNode.nodeValue;
    if (value && !isHiddenTextNode(textNode, root)) {
      const block = closestBlockAncestor(textNode, root);
      if (lastBlock && block !== lastBlock) combined += '\n';
      lastBlock = block;
      const start = combined.length;
      combined += value;
      segments.push({ node: textNode, start, end: combined.length });
    }
    current = walker.nextNode();
  }

  if (!segments.length) return [];

  const lower = combined.toLowerCase();
  const ranges: Range[] = [];
  const step = needle.length;
  let pos = 0;
  let segIndex = 0;

  while (pos <= lower.length - step) {
    const found = lower.indexOf(needle, pos);
    if (found === -1) break;
    const matchEnd = found + step;

    while (segIndex < segments.length && segments[segIndex]!.end <= found) segIndex++;
    const startSeg = segments[segIndex];
    if (!startSeg) break;

    let endSegIndex = segIndex;
    while (endSegIndex < segments.length && segments[endSegIndex]!.end < matchEnd) endSegIndex++;
    const endSeg = segments[endSegIndex];
    if (!endSeg) break;

    try {
      const range = document.createRange();
      range.setStart(startSeg.node, Math.max(0, found - startSeg.start));
      range.setEnd(endSeg.node, Math.max(0, matchEnd - endSeg.start));
      ranges.push(range);
    } catch {
      // 忽略极端情况下跨非连续节点构造失败的 Range
    }
    pos = matchEnd;
  }

  return ranges;
}

const HIGHLIGHT_ALL = 'timeline-search';
const HIGHLIGHT_ACTIVE = 'timeline-search-active';

type HighlightRegistry = {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
};

type HighlightCtor = new (...ranges: Range[]) => unknown;

const paneHighlights = new Map<string, { all: Range[]; active: Range | null }>();

function getCssHighlightRuntime(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  if (typeof globalThis === 'undefined') return null;
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const HighlightClass = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  if (!css?.highlights || typeof HighlightClass !== 'function') return null;
  return { registry: css.highlights, Highlight: HighlightClass };
}

function syncCssHighlights(): void {
  const runtime = getCssHighlightRuntime();
  if (!runtime) return;

  const mergedAll: Range[] = [];
  const mergedActive: Range[] = [];
  for (const entry of paneHighlights.values()) {
    for (const range of entry.all) {
      if (range !== entry.active) mergedAll.push(range);
    }
    if (entry.active) mergedActive.push(entry.active);
  }

  if (mergedAll.length) runtime.registry.set(HIGHLIGHT_ALL, new runtime.Highlight(...mergedAll));
  else runtime.registry.delete(HIGHLIGHT_ALL);

  if (mergedActive.length) runtime.registry.set(HIGHLIGHT_ACTIVE, new runtime.Highlight(...mergedActive));
  else runtime.registry.delete(HIGHLIGHT_ACTIVE);
}

export function applyTimelineSearchHighlights(paneKey: string, allRanges: Range[], activeRange: Range | null): void {
  if (!allRanges.length && !activeRange) {
    paneHighlights.delete(paneKey);
  } else {
    paneHighlights.set(paneKey, { all: allRanges, active: activeRange });
  }
  syncCssHighlights();
}

export function clearTimelineSearchHighlights(paneKey: string): void {
  if (!paneHighlights.delete(paneKey)) return;
  syncCssHighlights();
}

/**
 * 将匹配目标（文本 Range 或容器 Element）平滑滚动到对话容器可视区居中偏上位置，
 * 为顶部悬浮搜索条预留约 64px 缓冲，避免命中行被搜索条遮挡。
 */
export function scrollMatchIntoView(container: HTMLElement, target: Range | Element): void {
  const rect = target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const containerRect = container.getBoundingClientRect();
  const topOffset = rect.top - containerRect.top + container.scrollTop;
  const searchBarClearance = 64;
  const desiredTop = topOffset - Math.max(searchBarClearance, (container.clientHeight - rect.height) * 0.38);
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  const clampedTop = Math.min(maxScroll, Math.max(0, desiredTop));
  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ top: clampedTop, behavior: 'smooth' });
  } else {
    container.scrollTop = clampedTop;
  }
}
