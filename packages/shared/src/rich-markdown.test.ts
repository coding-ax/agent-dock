import { describe, expect, it } from 'vitest';
import {
  degradeRichMarkdownForLark,
  parseCalloutMarker,
  parseMetricsBlock,
  parseStepsBlock
} from './rich-markdown.js';

describe('parseMetricsBlock', () => {
  it('parses JSON arrays and wrapped objects with tone normalization', () => {
    const fromArray = parseMetricsBlock(JSON.stringify([
      { label: '当前线上版本', value: 'v0.3.31', delta: '+6 路合入', tone: 'positive' },
      { label: '展开动画帧率', value: '60 FPS', sub: '↑0px 抽搐' },
      { label: '错误率', value: '0.2%', delta: '-0.5%' },
      { label: '待处理', value: '4 路', sub: 'v0.3.32 备发', tone: 'neutral' }
    ]));
    expect(fromArray).toEqual([
      { label: '当前线上版本', value: 'v0.3.31', sub: '+6 路合入', tone: 'positive' },
      { label: '展开动画帧率', value: '60 FPS', sub: '↑0px 抽搐', tone: 'positive' },
      { label: '错误率', value: '0.2%', sub: '-0.5%', tone: 'negative' },
      { label: '待处理', value: '4 路', sub: 'v0.3.32 备发', tone: 'neutral' }
    ]);

    const fromWrapped = parseMetricsBlock(JSON.stringify({
      metrics: [{ title: 'Latency', value: '18ms', note: 'P99', tone: 'info' }]
    }));
    expect(fromWrapped).toEqual([
      { label: 'Latency', value: '18ms', sub: 'P99', tone: 'info' }
    ]);
  });

  it('parses concise YAML lists with optional wrapper and comments', () => {
    const yaml = [
      '# 指标汇总',
      'metrics:',
      '- label: 当前线上版本',
      '  value: v0.3.31',
      '  delta: "+6 路合入"',
      '  tone: positive',
      '- label: 内存占用',
      '  value: 142 MB',
      '  sub: 略高于基线',
      '  tone: warning'
    ].join('\n');
    expect(parseMetricsBlock(yaml)).toEqual([
      { label: '当前线上版本', value: 'v0.3.31', sub: '+6 路合入', tone: 'positive' },
      { label: '内存占用', value: '142 MB', sub: '略高于基线', tone: 'warning' }
    ]);
  });

  it('parses compact key-value and pipe-delimited shorthand lines', () => {
    const shorthand = [
      '当前线上版本: v0.3.15 | +6 路合入',
      '展开动画帧率：60 FPS | ↑0px 抽搐 | positive',
      '- 并行精修中: 4 路 | v0.3.16 备发',
      '竞态单测通过 | 100% | +0 敏感词'
    ].join('\n');
    expect(parseMetricsBlock(shorthand)).toEqual([
      { label: '当前线上版本', value: 'v0.3.15', sub: '+6 路合入', tone: 'positive' },
      { label: '展开动画帧率', value: '60 FPS', sub: '↑0px 抽搐', tone: 'positive' },
      { label: '并行精修中', value: '4 路', sub: 'v0.3.16 备发', tone: 'neutral' },
      { label: '竞态单测通过', value: '100%', sub: '+0 敏感词', tone: 'positive' }
    ]);
  });

  it('returns null for malformed or non-metric content so UI silently falls back to code block', () => {
    expect(parseMetricsBlock('')).toBeNull();
    expect(parseMetricsBlock('{ broken json')).toBeNull();
    expect(parseMetricsBlock('[]')).toBeNull();
    expect(parseMetricsBlock('[{"label":"missing value"}]')).toBeNull();
    expect(parseMetricsBlock('plain paragraph without key value delimiter')).toBeNull();
  });
});

describe('parseStepsBlock', () => {
  it('parses JSON, YAML, and checkbox/shorthand step formats', () => {
    const fromJson = parseStepsBlock(JSON.stringify([
      { status: 'done', title: 'v0.3.15 六路合入与发版', detail: 'main @ 52a3cd3, hub 与 7799 已验活' },
      { status: 'in_progress', title: 'v0.3.16 四路细节精修', detail: 'Lightbox 阻尼、额度关闭' },
      { status: 'pending', title: 'mac 节点唤醒补升', detail: '当前合盖离线，上线后一键补齐' }
    ]));
    expect(fromJson).toEqual([
      { status: 'done', title: 'v0.3.15 六路合入与发版', detail: 'main @ 52a3cd3, hub 与 7799 已验活' },
      { status: 'active', title: 'v0.3.16 四路细节精修', detail: 'Lightbox 阻尼、额度关闭' },
      { status: 'pending', title: 'mac 节点唤醒补升', detail: '当前合盖离线，上线后一键补齐' }
    ]);

    const fromYaml = parseStepsBlock([
      '- status: done',
      '  title: 构建校验',
      '  detail: pnpm typecheck & build 全绿',
      '- status: active',
      '  title: 沙箱实机验收',
      '- status: pending',
      '  title: 汇报完成'
    ].join('\n'));
    expect(fromYaml).toEqual([
      { status: 'done', title: '构建校验', detail: 'pnpm typecheck & build 全绿' },
      { status: 'active', title: '沙箱实机验收' },
      { status: 'pending', title: '汇报完成' }
    ]);

    const fromCompact = parseStepsBlock([
      '[x] 第一步 | 已完成详情',
      '[~] 第二步',
      '  缩进副标题说明',
      '[ ] 第三步 | 待启动'
    ].join('\n'));
    expect(fromCompact).toEqual([
      { status: 'done', title: '第一步', detail: '已完成详情' },
      { status: 'active', title: '第二步', detail: '缩进副标题说明' },
      { status: 'pending', title: '第三步', detail: '待启动' }
    ]);
  });

  it('returns null for malformed step syntax', () => {
    expect(parseStepsBlock('')).toBeNull();
    expect(parseStepsBlock('[invalid json')).toBeNull();
    expect(parseStepsBlock('not a step list at all')).toBeNull();
    expect(parseStepsBlock('[{"status":"unknown_status","title":"bad"}]')).toBeNull();
  });
});

describe('parseCalloutMarker', () => {
  it('recognizes all 5 GFM alert kinds case-insensitively with optional custom titles', () => {
    expect(parseCalloutMarker('[!NOTE]')).toEqual({ kind: 'note' });
    expect(parseCalloutMarker('[!tip]')).toEqual({ kind: 'tip' });
    expect(parseCalloutMarker('[!IMPORTANT] 架构红线')).toEqual({ kind: 'important', title: '架构红线' });
    expect(parseCalloutMarker('[!WARNING] Concurrency')).toEqual({ kind: 'warning', title: 'Concurrency' });
    expect(parseCalloutMarker('[!CAUTION]')).toEqual({ kind: 'caution' });
    expect(parseCalloutMarker('[!UNKNOWN]')).toBeNull();
    expect(parseCalloutMarker('ordinary quote')).toBeNull();
  });
});

describe('degradeRichMarkdownForLark', () => {
  it('converts metrics, steps, svg, 5-level callouts, highlights, and kbd into readable Lark markdown', () => {
    const rich = [
      '```metrics',
      '当前线上版本: v0.3.31 | +6 路合入',
      '帧率: 60 FPS',
      '```',
      '',
      '```steps',
      '[x] 发版完成 | main @ 52a3cd3',
      '[~] 细节打磨 | Lightbox 与主题融合',
      '[ ] 离线节点补齐',
      '```',
      '',
      '> [!TIP]',
      '> 所有富文本块均坚持 ==无常驻灰顶栏==，按 <kbd>Esc</kbd> 关闭，支持 <mark>柔和荧光</mark>。',
      '',
      '```svg',
      '<svg viewBox="0 0 100 40"><rect width="100" height="40"/></svg>',
      '```'
    ].join('\n');

    const degradedZh = degradeRichMarkdownForLark(rich, 'zh-CN');
    expect(degradedZh).toContain('- **当前线上版本**：**v0.3.31**（+6 路合入）');
    expect(degradedZh).toContain('- **帧率**：**60 FPS**');
    expect(degradedZh).toContain('✅ **发版完成** — main @ 52a3cd3');
    expect(degradedZh).toContain('🔵 **细节打磨** — Lightbox 与主题融合');
    expect(degradedZh).toContain('⚪ 离线节点补齐');
    expect(degradedZh).toContain('> 💡 **提示**');
    expect(degradedZh).toContain('**无常驻灰顶栏**');
    expect(degradedZh).toContain('`Esc`');
    expect(degradedZh).toContain('**柔和荧光**');
    expect(degradedZh).toContain('SVG 矢量图表');
    expect(degradedZh).not.toContain('```metrics');
    expect(degradedZh).not.toContain('```steps');
    expect(degradedZh).not.toContain('<rect');

    // 幂等性校验
    expect(degradeRichMarkdownForLark(degradedZh, 'zh-CN')).toBe(degradedZh);

    // 英文模式
    const degradedEn = degradeRichMarkdownForLark(rich, 'en-US');
    expect(degradedEn).toContain('- **当前线上版本**: **v0.3.31** (+6 路合入)');
    expect(degradedEn).toContain('> 💡 **Tip**');
    expect(degradedEn).toContain('SVG Diagram');
  });

  it('preserves ordinary code fences, inline code, comparisons, and plain markdown byte-for-byte', () => {
    const plain = [
      '普通结论：**MR !1162** 已通过，检查 `==raw==` 和 `<kbd>noop</kbd>` 以及 a == b && c == d。',
      '',
      '```ts',
      'const eq = a == b && c == d;',
      'const tip = "> [!TIP]\\n==inside code==";',
      '```'
    ].join('\n');
    expect(degradeRichMarkdownForLark(plain, 'zh-CN')).toBe(plain);
  });
});
