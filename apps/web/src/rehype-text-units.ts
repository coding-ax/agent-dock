/**
 * 把渲染出来的文本节点拆成「词 / 字」单元（`<span class="ui-tw-unit">`），配合 CSS 做
 * 词级模糊入场——新到的字从模糊 + 半透明收敛到清晰。
 *
 * 为什么走 rehype 而不是改 markdown 源：这里拿到的是 HAST，`**`、表格管道符、围栏这些
 * 标记语法已经被解析掉了，剩下的才是真正会显示的字；在源文本上拆词会把标记也算进去。
 *
 * 拆出来的 span 只影响包裹，不插字符，复制 / 选中 / 无障碍都不受影响；`code` / `pre` 跳过，
 * 代码块里的空格与缩进有语义，拆了会变形。
 *
 * 代价：每个字/词一个 DOM 节点。所以只对「正在流式输出的那条且文本不长」的消息启用
 * （见 TypewriterText 的 UNIT_ANIMATION_MAX_CHARS），历史消息完全不挂。
 */

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: Record<string, unknown>;
}

const SKIP_TAGS = new Set(['code', 'pre']);

/** 中日韩字符：这类语言没有空格分词，按单字切，观感才均匀。 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

export function splitTextUnits(text: string): string[] {
  const units: string[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) {
      units.push(buffer);
      buffer = '';
    }
  };
  for (const char of text) {
    if (char === '\n') {
      flush();
      units.push(char);
      continue;
    }
    if (CJK.test(char)) {
      flush();
      units.push(char);
      continue;
    }
    // 拉丁字母 / 数字 / 空格：空格挂在前一个词尾部，保证换行与空格不被拆散。
    buffer += char;
  }
  flush();
  return units;
}

function unitElement(value: string): HastNode {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['ui-tw-unit'] },
    children: [{ type: 'text', value }]
  };
}

function walk(node: HastNode, insideSkip: boolean): void {
  if (!Array.isArray(node.children)) return;
  const isSkip = insideSkip || (node.type === 'element' && SKIP_TAGS.has(node.tagName ?? ''));
  const next: HastNode[] = [];
  for (const child of node.children) {
    // 纯空白文本节点原样保留：它们是 table/tr/ul 等结构之间的换行，包成 span 会产生非法嵌套
    // （<table><span>），还会抢走 :last-child，让光标选择器找不到真正的最后一格/最后一项。
    if (child.type === 'text' && typeof child.value === 'string' && !isSkip && child.value.trim()) {
      for (const unit of splitTextUnits(child.value)) next.push(unitElement(unit));
      continue;
    }
    walk(child, isSkip);
    next.push(child);
  }
  node.children = next;
}

export function rehypeTextUnits() {
  return (tree: HastNode): void => {
    walk(tree, false);
  };
}
