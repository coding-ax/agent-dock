import { describe, expect, it } from 'vitest';
import { rehypeTextUnits, splitTextUnits } from './rehype-text-units';

describe('splitTextUnits', () => {
  it('中文按单字切，观感才均匀', () => {
    expect(splitTextUnits('你好')).toEqual(['你', '好']);
  });

  it('拉丁片段整块切（含空格），遇到中文才断开', () => {
    expect(splitTextUnits('hello world')).toEqual(['hello world']);
    expect(splitTextUnits('hi 你好')).toEqual(['hi ', '你', '好']);
  });

  it('换行单独成单元，不并进前后词', () => {
    expect(splitTextUnits('a\nb')).toEqual(['a', '\n', 'b']);
  });
});

interface Node { type?: string; tagName?: string; value?: string; children?: Node[]; properties?: Record<string, unknown> }

describe('rehypeTextUnits', () => {
  it('把段落文本包成 ui-tw-unit，不改字符', () => {
    const tree: Node = { type: 'root', children: [{ type: 'element', tagName: 'p', children: [{ type: 'text', value: '你好 world' }] }] };
    rehypeTextUnits()(tree);
    const p = tree.children![0]!;
    const values = (p.children ?? []).map(child => (child.children?.[0]?.value) ?? child.value).join('');
    expect(values).toBe('你好 world');
    expect((p.children ?? []).every(child => child.tagName === 'span')).toBe(true);
  });

  it('跳过代码块，避免拆坏缩进与空格', () => {
    const tree: Node = { type: 'root', children: [{ type: 'element', tagName: 'pre', children: [{ type: 'element', tagName: 'code', children: [{ type: 'text', value: 'const a = 1;' }] }] }] };
    rehypeTextUnits()(tree);
    const code = (tree.children![0]!.children ?? [])[0]!;
    expect(code.children![0]!.type).toBe('text');
    expect(code.children![0]!.value).toBe('const a = 1;');
  });
});

describe('rehypeTextUnits structure', () => {
  it('结构元素之间的空白换行不包 span，避免 <table><span> 这类非法嵌套', () => {
    const tree: Node = { type: 'root', children: [{ type: 'element', tagName: 'table', children: [
      { type: 'text', value: '\n' },
      { type: 'element', tagName: 'tr', children: [{ type: 'text', value: '\n' }, { type: 'element', tagName: 'td', children: [{ type: 'text', value: '1' }] }, { type: 'text', value: '\n' }] },
      { type: 'text', value: '\n' }
    ] }] };
    rehypeTextUnits()(tree as any);
    const table = tree.children![0]!;
    expect(table.children!.map(child => child.type)).toEqual(['text', 'element', 'text']);
    const row = table.children![1]!;
    expect(row.children!.map(child => child.tagName ?? child.type)).toEqual(['text', 'td', 'text']);
    expect(row.children![1]!.children![0]).toMatchObject({ tagName: 'span', properties: { className: ['ui-tw-unit'] } });
  });
});
