import { parseCalloutMarker } from '@agent-dock/agent-dock-shared';

interface MdastNode {
  type: string;
  value?: string;
  lang?: string | null;
  children?: MdastNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  position?: {
    start?: { offset?: number; line?: number };
    end?: { offset?: number; line?: number };
  };
}

export type InlineMathSegment =
  | { type: 'text'; value: string }
  | { type: 'inlineMath'; value: string }
  | { type: 'blockMath'; value: string };

const SKIP_INLINE_PARENTS = new Set([
  'code',
  'inlineCode',
  'html',
  'link',
  'linkReference',
  'definition',
  'mathBlock',
  'mathInline',
  'richKbd'
]);

const ASCII_ALNUM = /^[A-Za-z0-9]$/;
const ASCII_DIGIT = /^[0-9]$/;
const INLINE_WS = /^[ \t\r\n]$/;

/**
 * 将一段纯文本切分为普通文本、行内公式（`$...$`）与行内嵌入块级公式（`$$...$$`）。
 *
 * 金额防误判规则：
 * 1. 开 `$` 不能紧跟在 ASCII 字母/数字之后，也不能紧跟空白；
 * 2. 闭 `$` 不能紧跟在空白之后，也不能紧接数字（防止 `$5-$10`、`$100/$200` 误判）；
 * 3. 行内 `$...$` 不跨换行，且绝不跨过中间未转义的 `$`（确保 `花费 $100 计算 $x^2$` 准确保留 `$100` 并渲染 `$x^2$`）；
 * 4. 若 `$...$` 内以纯数字/货币格式开头且不含数学运算符却含空格词组，同样不误判为公式。
 */
export function extractMathSegments(text: string): InlineMathSegment[] {
  if (!text.includes('$')) return [{ type: 'text', value: text }];

  const segments: InlineMathSegment[] = [];
  let cursor = 0;
  let i = 0;

  const pushText = (chunk: string) => {
    if (!chunk) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.type === 'text') {
      prev.value += chunk;
    } else {
      segments.push({ type: 'text', value: chunk });
    }
  };

  while (i < text.length) {
    if (text[i] !== '$') {
      i++;
      continue;
    }

    // 跳过反斜杠转义（如 raw 文本中残留的 \$）
    if (i > 0 && text[i - 1] === '\\') {
      i++;
      continue;
    }

    // 1) 块级 $$...$$
    if (text[i + 1] === '$') {
      let closeIdx = -1;
      for (let j = i + 2; j < text.length - 1; j++) {
        if (text[j] === '$' && text[j + 1] === '$' && text[j - 1] !== '\\') {
          closeIdx = j;
          break;
        }
      }
      if (closeIdx > i + 2) {
        const expr = text.slice(i + 2, closeIdx).trim();
        if (expr) {
          pushText(text.slice(cursor, i));
          segments.push({ type: 'blockMath', value: expr });
          i = closeIdx + 2;
          cursor = i;
          continue;
        }
      }
      i += 2;
      continue;
    }

    // 2) 行内 $...$
    const prevChar = i > 0 ? text[i - 1]! : '';
    const nextChar = i + 1 < text.length ? text[i + 1]! : '';
    if (!nextChar || INLINE_WS.test(nextChar) || nextChar === '$' || (prevChar && ASCII_ALNUM.test(prevChar))) {
      i++;
      continue;
    }

    // 向后寻找同一行上的下一个未转义 $（绝不跨过中间的 $ 或换行）
    let nextDollar = -1;
    for (let j = i + 1; j < text.length; j++) {
      const ch = text[j]!;
      if (ch === '\n' || ch === '\r') break;
      if (ch === '$' && text[j - 1] !== '\\') {
        nextDollar = j;
        break;
      }
    }

    if (nextDollar <= i + 1) {
      i++;
      continue;
    }

    const beforeClose = text[nextDollar - 1]!;
    const afterClose = nextDollar + 1 < text.length ? text[nextDollar + 1]! : '';
    const validClose =
      !INLINE_WS.test(beforeClose) &&
      afterClose !== '$' &&
      !(afterClose && ASCII_DIGIT.test(afterClose));

    if (!validClose) {
      // 不跨过中间的 $，直接把外层扫描推进到该 $，让它自己有机会作为下一个公式起点（如 `花费 $100 计算 $x^2$`）
      i = nextDollar;
      continue;
    }

    const expr = text.slice(i + 1, nextDollar);
    // 二次防误伤：像 "$100 per seat" 这种以纯数字+空白开头的自然语言金额，若不含数学操作符则放行
    const looksLikeCurrencyProse =
      /^\d+(?:[.,]\d+)?(?:\s+[A-Za-z\u4e00-\u9fff]+)/.test(expr) &&
      !/[=+\-*/^_\\<>|{}]/.test(expr);

    if (looksLikeCurrencyProse) {
      i = nextDollar;
      continue;
    }

    pushText(text.slice(cursor, i));
    segments.push({ type: 'inlineMath', value: expr });
    i = nextDollar + 1;
    cursor = i;
  }

  if (cursor < text.length) {
    pushText(text.slice(cursor));
  }
  return segments;
}

/**
 * 识别 GFM 5 级 Alert Callout（> [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]）。
 * 必须在 remarkBreaks 之前运行，以可靠切分首行标记与后续正文。
 */
export function remarkCallouts() {
  return (tree: MdastNode) => {
    const visit = (node: MdastNode) => {
      if (!node || !Array.isArray(node.children)) return;
      if (node.type === 'blockquote' && node.children.length > 0) {
        const firstBlock = node.children[0];
        if (firstBlock?.type === 'paragraph' && Array.isArray(firstBlock.children) && firstBlock.children.length > 0) {
          const firstInline = firstBlock.children[0];
          if (firstInline?.type === 'text' && typeof firstInline.value === 'string') {
            const raw = firstInline.value;
            const nlIdx = raw.indexOf('\n');
            const firstLine = nlIdx >= 0 ? raw.slice(0, nlIdx) : raw;
            const hasRestInFirstText = nlIdx >= 0;
            const canStripMarkerLine =
              hasRestInFirstText ||
              firstBlock.children.length === 1 ||
              firstBlock.children[1]?.type === 'break';

            const parsed = canStripMarkerLine ? parseCalloutMarker(firstLine) : null;
            if (parsed) {
              node.data = {
                ...node.data,
                hProperties: {
                  ...(node.data?.hProperties ?? {}),
                  'data-callout': parsed.kind,
                  ...(parsed.title ? { 'data-callout-title': parsed.title } : {})
                }
              };

              if (hasRestInFirstText) {
                const remainder = raw.slice(nlIdx + 1);
                if (remainder.length > 0) {
                  firstInline.value = remainder;
                } else {
                  firstBlock.children.shift();
                  if (firstBlock.children.length === 0) {
                    node.children.shift();
                  }
                }
              } else if (firstBlock.children.length === 1) {
                node.children.shift();
              } else if (firstBlock.children[1]?.type === 'break') {
                firstBlock.children.splice(0, 2);
                if (firstBlock.children.length === 0) {
                  node.children.shift();
                }
              }
            }
          }
        }
      }

      for (const child of node.children) {
        visit(child);
      }
    };
    visit(tree);
  };
}

/**
 * 轻量 LaTeX 数学公式 remark 插件（配合按需懒加载的 KaTeX 渲染器，零首屏依赖）。
 * 必须在 remarkBreaks 之前运行，确保多行 `$$\n...\n$$` 块级公式完整识别。
 */
export function remarkSafeMath() {
  return (tree: MdastNode) => {
    const transformBlockChildren = (parent: MdastNode) => {
      if (!parent || !Array.isArray(parent.children)) return;

      const nextBlocks: MdastNode[] = [];
      for (const child of parent.children) {
        // 独立成段的 $$...$$ 块级公式
        if (
          child.type === 'paragraph' &&
          Array.isArray(child.children) &&
          child.children.length === 1 &&
          child.children[0]?.type === 'text' &&
          typeof child.children[0].value === 'string'
        ) {
          const trimmed = child.children[0].value.trim();
          if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) {
            const inner = trimmed.slice(2, -2).trim();
            // 确保中间没有额外的未配对 $$（避免两段独立 $$a$$ ... $$b$$ 被合并成一个公式）
            if (inner && !inner.includes('$$')) {
              nextBlocks.push({
                type: 'mathBlock',
                data: {
                  hName: 'div',
                  hProperties: { 'data-math-block': 'true', 'data-math-expr': inner }
                },
                children: [{ type: 'text', value: inner }]
              });
              continue;
            }
          }
        }

        transformBlockChildren(child);
        nextBlocks.push(child);
      }
      parent.children = nextBlocks;
    };

    const transformInlineNodes = (node: MdastNode) => {
      if (!node || !Array.isArray(node.children) || SKIP_INLINE_PARENTS.has(node.type)) return;
      const nextChildren: MdastNode[] = [];
      let changed = false;

      for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('$')) {
          const segments = extractMathSegments(child.value);
          if (segments.some(seg => seg.type !== 'text')) {
            changed = true;
            for (const seg of segments) {
              if (seg.type === 'text') {
                nextChildren.push({ type: 'text', value: seg.value });
              } else if (seg.type === 'blockMath') {
                // 嵌在混排段落内的 $$...$$ 使用 span（CSS block 展示），避免非法 <p><div> 嵌套。
                nextChildren.push({
                  type: 'mathBlock',
                  data: {
                    hName: 'span',
                    hProperties: { 'data-math-block': 'inline-block', 'data-math-expr': seg.value }
                  },
                  children: [{ type: 'text', value: seg.value }]
                });
              } else {
                nextChildren.push({
                  type: 'mathInline',
                  data: {
                    hName: 'span',
                    hProperties: { 'data-math-inline': 'true', 'data-math-expr': seg.value }
                  },
                  children: [{ type: 'text', value: seg.value }]
                });
              }
            }
            continue;
          }
        }

        transformInlineNodes(child);
        nextChildren.push(child);
      }

      if (changed) node.children = nextChildren;
    };

    transformBlockChildren(tree);
    transformInlineNodes(tree);
  };
}

const highlightPattern = /(?<!=)==(?![\s=])((?:(?!==)[^\n])+?)(?<![\s=])==(?!=)/g;
const allowedOpenTagPattern = /^<(kbd|mark)>$/i;
const allowedCloseTagPattern = /^<\/(kbd|mark)>$/i;

function pairSafeHtmlInlineTags(children: MdastNode[]): MdastNode[] {
  const hasCandidate = children.some(
    c => c.type === 'html' && typeof c.value === 'string' && allowedOpenTagPattern.test(c.value.trim())
  );
  if (!hasCandidate) return children;

  const result: MdastNode[] = [];
  let i = 0;

  while (i < children.length) {
    const node = children[i]!;
    const openMatch =
      node.type === 'html' && typeof node.value === 'string'
        ? allowedOpenTagPattern.exec(node.value.trim())
        : null;

    if (openMatch) {
      const tag = openMatch[1]!.toLowerCase() as 'kbd' | 'mark';
      let closeIdx = -1;
      for (let j = i + 1; j < children.length; j++) {
        const candidate = children[j]!;
        const closeMatch =
          candidate.type === 'html' && typeof candidate.value === 'string'
            ? allowedCloseTagPattern.exec(candidate.value.trim())
            : null;
        if (closeMatch && closeMatch[1]!.toLowerCase() === tag) {
          closeIdx = j;
          break;
        }
      }

      if (closeIdx > i) {
        const inner = pairSafeHtmlInlineTags(children.slice(i + 1, closeIdx));
        result.push({
          type: tag === 'kbd' ? 'richKbd' : 'richMark',
          data: {
            hName: tag,
            hProperties: { className: [tag === 'kbd' ? 'ui-md-kbd' : 'ui-md-mark'] }
          },
          children: inner
        });
        i = closeIdx + 1;
        continue;
      }
    }

    result.push(node);
    i++;
  }

  return result;
}

/**
 * 安全行内微排版 remark 插件（不启用 rehype-raw，杜绝任意 HTML XSS）：
 * - `==荧光重点==` -> `<mark class="ui-md-mark">`
 * - 白名单无属性 `<mark>...</mark>` -> `<mark class="ui-md-mark">`
 * - 白名单无属性 `<kbd>...</kbd>` -> `<kbd class="ui-md-kbd">`
 */
export function remarkInlineRichSyntax() {
  return (tree: MdastNode) => {
    const visit = (node: MdastNode) => {
      if (!node || !Array.isArray(node.children) || SKIP_INLINE_PARENTS.has(node.type)) return;

      // 先配对白名单 <kbd>...</kbd> 与 <mark>...</mark>
      const paired = pairSafeHtmlInlineTags(node.children);
      const nextChildren: MdastNode[] = [];

      for (const child of paired) {
        if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('==')) {
          const text = child.value;
          highlightPattern.lastIndex = 0;
          let lastIndex = 0;
          let matched = false;
          for (const match of text.matchAll(highlightPattern)) {
            const start = match.index ?? 0;
            const full = match[0];
            const inner = match[1]!;
            matched = true;
            if (start > lastIndex) {
              nextChildren.push({ type: 'text', value: text.slice(lastIndex, start) });
            }
            nextChildren.push({
              type: 'richMark',
              data: {
                hName: 'mark',
                hProperties: { className: ['ui-md-mark'] }
              },
              children: [{ type: 'text', value: inner }]
            });
            lastIndex = start + full.length;
          }
          if (matched) {
            if (lastIndex < text.length) {
              nextChildren.push({ type: 'text', value: text.slice(lastIndex) });
            }
            continue;
          }
        }

        visit(child);
        nextChildren.push(child);
      }

      node.children = nextChildren;
    };

    visit(tree);
  };
}

/** 判断一段切片后的围栏代码块是否已闭合（用于流式输出防抽搐）。 */
export function isFencedCodeSliceUnclosed(slice: string): boolean {
  const lines = slice.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === 0) return false;
  const openMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(lines[0]!);
  if (!openMatch) return false; // 缩进代码块，不视为未闭合围栏
  const fenceChar = openMatch[1]![0]!;
  const fenceLen = openMatch[1]!.length;
  if (lines.length < 2) return true;
  // 去掉尾部空行再检查最后一行是否是合法闭合围栏
  let lastIdx = lines.length - 1;
  while (lastIdx > 0 && lines[lastIdx]!.trim() === '') lastIdx--;
  if (lastIdx === 0) return true;
  const closePattern = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLen},}[ \\t]*$`);
  return !closePattern.test(lines[lastIdx]!);
}

/**
 * 利用 AST 原始位置切片，给富文本组件附加精准元信息：
 * 1) 未闭合围栏代码块挂 `data-unclosed="true"`（让 mermaid / svg / metrics / steps 流式不闪烁报错）；
 * 2) GFM 表格挂 `data-raw-markdown`（让「复制表格」和「MD / 表格」切换还原 100% 原始源码）。
 */
export function remarkRichBlockMetadata() {
  return (tree: MdastNode, file?: { value?: unknown; toString?: () => string }) => {
    const source = typeof file?.value === 'string' ? file.value : typeof file?.toString === 'function' ? file.toString() : '';
    if (!source) return;

    const visit = (node: MdastNode) => {
      if (!node) return;
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;

      if (node.type === 'code' && typeof start === 'number' && typeof end === 'number' && end > start) {
        const slice = source.slice(start, end);
        if (isFencedCodeSliceUnclosed(slice)) {
          node.data = {
            ...node.data,
            hProperties: {
              ...(node.data?.hProperties ?? {}),
              'data-unclosed': 'true'
            }
          };
        }
      } else if (node.type === 'table' && typeof start === 'number' && typeof end === 'number' && end > start) {
        const rawTable = source.slice(start, end).trim();
        if (rawTable) {
          node.data = {
            ...node.data,
            hProperties: {
              ...(node.data?.hProperties ?? {}),
              'data-raw-markdown': rawTable
            }
          };
        }
      }

      if (Array.isArray(node.children)) {
        for (const child of node.children) visit(child);
      }
    };

    visit(tree);
  };
}
