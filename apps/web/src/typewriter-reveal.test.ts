import { describe, expect, it } from 'vitest';
import { advanceRevealLength, closeIncompleteMarkdown, DEFAULT_TYPEWRITER_SPEED, renderRevealedText } from './typewriter-reveal';

describe('closeIncompleteMarkdown', () => {
  it('closes an unclosed bold span so it renders as bold instead of bare asterisks', () => {
    expect(closeIncompleteMarkdown('结论：**只动前端')).toBe('结论：**只动前端**');
  });

  it('closes an unclosed code fence so the block renders instead of waiting', () => {
    expect(closeIncompleteMarkdown('用法：\n```tsx\nconst a = 1;')).toBe('用法：\n```tsx\nconst a = 1;\n```');
  });

  it('closes a partial table row and synthesizes the separator row', () => {
    expect(closeIncompleteMarkdown('| 字段 | 值')).toBe('| 字段 | 值 |\n| --- | --- |');
  });

  it('ignores markers inside a closed fence', () => {
    expect(closeIncompleteMarkdown('```ts\nconst s = "**";\n```\n结尾')).toBe('```ts\nconst s = "**";\n```\n结尾');
  });

  it('keeps finished markdown untouched', () => {
    expect(closeIncompleteMarkdown('已经结束的 **加粗** 与 `代码`。')).toBe('已经结束的 **加粗** 与 `代码`。');
  });

  it('hides a half-streamed link until it closes, so it does not pop into an <a>', () => {
    // 流式截在 [标题](https://… 时，半截语法会先当纯文本渲染，等 ) 到了突然变链接，
    // 宽度/下划线/换行一起变，就是「链接一直跳动」。整段先不显示，闭合那一帧一次性出现。
    const full = '文档见 [TOM Bridge](https://bits.bytedance.net/devops/a/b?x=1)';
    expect(closeIncompleteMarkdown('文档见 [TOM Bridge](https://bits.bytedance.net/devops/a')).toBe('文档见 ');
    expect(closeIncompleteMarkdown('文档见 [TOM Bridge](')).toBe('文档见 ');
    expect(closeIncompleteMarkdown(full)).toBe(full);
  });

  it('does the same for images and keeps completed links in the middle of the text', () => {
    expect(closeIncompleteMarkdown('看图 ![shot](/tmp/a.png) 说明')).toBe('看图 ![shot](/tmp/a.png) 说明');
    expect(closeIncompleteMarkdown('看图 ![shot](/tmp/a')).toBe('看图 ');
  });

  it('keeps bracket text that is not a dangling link', () => {
    expect(closeIncompleteMarkdown('模型 [1m] 与 [见注] 后面还有正文')).toBe('模型 [1m] 与 [见注] 后面还有正文');
    expect(closeIncompleteMarkdown('```\n[not](a link\n```\n收尾')).toBe('```\n[not](a link\n```\n收尾');
    expect(closeIncompleteMarkdown('转义 \\[不是链接\\] 正常')).toBe('转义 \\[不是链接\\] 正常');
  });

  it('also hides the label-while-typing phase and handles multiple links', () => {
    expect(closeIncompleteMarkdown('文档见 [TOM Bridge')).toBe('文档见 ');
    expect(closeIncompleteMarkdown('[一](https://a.com) 和 [二](https://b')).toBe('[一](https://a.com) 和 ');
    expect(closeIncompleteMarkdown('[一](https://a.com) 和 [二](https://b.com)')).toBe('[一](https://a.com) 和 [二](https://b.com)');
  });

  it('does not append a stray marker for an odd backtick inside a table cell', () => {
    expect(closeIncompleteMarkdown('| a |\n| --- |\n| `x |')).toBe('| a |\n| --- |\n| `x |`');
  });
});

describe('renderRevealedText', () => {
  it('reveals the prefix and closes it so半截 markdown 不裸露标记', () => {
    const text = '开头 **加粗还没闭合';
    expect(renderRevealedText(text, text.length)).toBe('开头 **加粗还没闭合**');
    expect(renderRevealedText(text, 2)).toBe('开头');
  });

  it('reveals a link only on the frame where its closing paren arrives', () => {
    const full = '见 [文档](https://example.com/a) 结尾';
    const closedAt = full.indexOf(')') + 1;
    expect(renderRevealedText(full, closedAt - 1)).toBe('见 ');
    expect(renderRevealedText(full, closedAt)).toBe('见 [文档](https://example.com/a)');
  });
});

describe('advanceRevealLength', () => {
  it('在相同进度下按经过时间线性推进，与刷新率无关', () => {
    // 取两个都在单帧上限（100ms）以内的步长，避免被上限截断。
    const short = advanceRevealLength(0, 1000, 0.02, true);
    const long = advanceRevealLength(0, 1000, 0.04, true);
    expect(long).toBeCloseTo(short * 2, 6);
  });

  it('单帧最多按 100ms 计，避免切走标签页回来后一次性刷一大段', () => {
    const capped = advanceRevealLength(0, 100000, 0.1, true);
    expect(advanceRevealLength(0, 100000, 0.5, true)).toBeCloseTo(capped, 6);
    expect(advanceRevealLength(0, 100000, 30, true)).toBeCloseTo(capped, 6);
  });

  it('流结束后能在收干时间内把尾巴播完', () => {
    const { drainSeconds } = DEFAULT_TYPEWRITER_SPEED;
    let shown = 0;
    // 模拟 16ms 一帧的真实节奏。
    const frames = Math.ceil((drainSeconds * 1000) / 16) + 2;
    for (let i = 0; i < frames && shown < 10; i += 1) shown = advanceRevealLength(shown, 10, 0.016, false);
    expect(shown).toBe(10);
  });

  it('不会超过全文长度', () => {
    let shown = 9;
    for (let i = 0; i < 100 && shown < 10; i += 1) shown = advanceRevealLength(shown, 10, 0.1, false);
    expect(shown).toBe(10);
    expect(advanceRevealLength(10, 10, 5, true)).toBe(10);
  });

  it('落后越多追得越快（自适应）', () => {
    const near = advanceRevealLength(990, 1000, 0.02, true);
    const far = advanceRevealLength(0, 1000, 0.02, true);
    expect(far - 0).toBeGreaterThan(near - 990);
  });
});
