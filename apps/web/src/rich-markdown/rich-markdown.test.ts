import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import katex from 'katex';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_THEMES } from '@agent-dock/agent-dock-shared';
import { MarkdownContent } from '../MarkdownContent';
import { I18nProvider, resetLocaleForTest } from '../i18n';
import { TooltipProvider } from '../HoverTooltip';
import { resolveLightboxSlides } from '../ImageLightbox';
import { extractMathSegments, isFencedCodeSliceUnclosed } from './remark-plugins';
import { parseSvgDimensions, sanitizeSvgMarkup } from './svg-sanitize';
import { buildMermaidConfig } from './mermaid-theme';
import { renderLatexSync } from './MathRenderer';

const richDir = dirname(fileURLToPath(import.meta.url));
const webSrcDir = dirname(richDir);

function renderMarkdown(markdown: string, locale: 'zh-CN' | 'en-US' = 'zh-CN', extraProps: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale },
      createElement(
        TooltipProvider,
        null,
        createElement(MarkdownContent, { sessionId: 'ses_rich', children: markdown, ...extraProps })
      )
    )
  );
}

afterEach(() => {
  resetLocaleForTest('system', 'zh-CN');
});

describe('5-level frameless GFM Callouts', () => {
  it('renders all 5 callout kinds with bilingual default headings and custom titles', () => {
    const md = [
      '> [!NOTE]\n> 备注内容',
      '',
      '> [!TIP]\n> 提示内容',
      '',
      '> [!IMPORTANT] 关键决策\n> 重要说明',
      '',
      '> [!WARNING]\n> 警告说明',
      '',
      '> [!CAUTION]\n> 危险提示'
    ].join('\n');

    const zhHtml = renderMarkdown(md, 'zh-CN');
    for (const kind of ['note', 'tip', 'important', 'warning', 'caution']) {
      expect(zhHtml).toContain(`data-callout="${kind}"`);
    }
    expect(zhHtml).toContain('备注');
    expect(zhHtml).toContain('提示');
    expect(zhHtml).toContain('关键决策');
    expect(zhHtml).toContain('警告');
    expect(zhHtml).toContain('注意');
    expect(zhHtml).not.toContain('[!NOTE]');
    expect(zhHtml).not.toContain('[!TIP]');

    const enHtml = renderMarkdown(md, 'en-US');
    expect(enHtml).toContain('Note');
    expect(enHtml).toContain('Tip');
    expect(enHtml).toContain('关键决策');
    expect(enHtml).toContain('Warning');
    expect(enHtml).toContain('Caution');
  });

  it('keeps ordinary blockquotes untouched', () => {
    const html = renderMarkdown('> 普通引用内容');
    expect(html).toContain('<blockquote>');
    expect(html).not.toContain('ui-rich-callout');
  });
});

describe('inline micro-typography: ==highlight==, <mark>, <kbd>, rounded task checkboxes', () => {
  it('renders ==highlight==, <mark>, <kbd>, and custom rounded checkboxes safely without rehype-raw', () => {
    const md = [
      '支持 ==荧光重点== 与 <mark>标记重点</mark>，按 <kbd>⌘</kbd> + <kbd>K</kbd> 或 <kbd>Esc</kbd> 关闭。',
      '普通比较 a == b && c == d 与行内代码 `==raw==` 不误伤。',
      '<script>alert("xss")</script><img src=x onerror=alert(1)>',
      '',
      '- [x] 已完成任务',
      '- [ ] 待办任务'
    ].join('\n');

    const html = renderMarkdown(md);
    expect(html).toContain('<mark class="ui-md-mark">荧光重点</mark>');
    expect(html).toContain('<mark class="ui-md-mark">标记重点</mark>');
    expect(html).toContain('<kbd class="ui-md-kbd">⌘</kbd>');
    expect(html).toContain('<kbd class="ui-md-kbd">K</kbd>');
    expect(html).toContain('<kbd class="ui-md-kbd">Esc</kbd>');
    expect(html).toContain('a == b &amp;&amp; c == d');
    expect(html).toContain('==raw==');
    // 危险 HTML 标签绝不作为真实 DOM 元素输出（会被安全转义为纯文本）
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img ');
    expect(html).toContain('&lt;script&gt;');
    // 圆角复选框
    expect(html).toContain('class="ui-md-checkbox" data-checked="true"');
    expect(html).toContain('class="ui-md-checkbox" data-checked="false"');
  });
});

describe('metrics KPI bar & steps stepper blocks', () => {
  it('keeps metrics and steps as ordinary code blocks by default (enableRichBlocks=false) while standard Markdown renders richly', () => {
    const md = [
      '> [!NOTE]\n> 标准 Callout 始终默认可用',
      '',
      '```metrics',
      '当前线上版本: v0.3.31 | +6 路合入',
      '```',
      '',
      '```steps',
      '[x] 第一步 | 已完成',
      '```'
    ].join('\n');

    const defaultOffHtml = renderMarkdown(md);
    expect(defaultOffHtml).toContain('data-callout="note"');
    expect(defaultOffHtml).not.toContain('data-testid="rich-metrics"');
    expect(defaultOffHtml).not.toContain('data-testid="rich-steps"');
    expect(defaultOffHtml).toContain('code-renderer');
    expect(defaultOffHtml).toContain('metrics');
    expect(defaultOffHtml).toContain('steps');

    // 默认关闭状态下，未闭合的 metrics / steps 围栏也保持普通代码块，不显示流式骨架占位
    const unclosedMetricsOff = renderMarkdown('```metrics\n版本: v0.3.31', 'zh-CN', { isStreaming: true });
    expect(unclosedMetricsOff).not.toContain('data-testid="rich-streaming-placeholder"');
    expect(unclosedMetricsOff).toContain('code-renderer');
  });

  it('renders metrics and steps blocks cleanly when enableRichBlocks=true, and falls back silently to code block on invalid syntax', () => {
    const md = [
      '```metrics',
      '当前线上版本: v0.3.31 | +6 路合入',
      '展开动画帧率: 60 FPS | ↑0px 抽搐',
      '并行精修中: 4 路 | v0.3.32 备发',
      '竞态单测通过: 100% | +0 敏感词',
      '```',
      '',
      '```steps',
      '[x] 第一步 | 已完成',
      '[~] 第二步 | 进行中',
      '[ ] 第三步 | 待开始',
      '```',
      '',
      '```metrics',
      '{ broken json',
      '```'
    ].join('\n');

    const html = renderMarkdown(md, 'zh-CN', { enableRichBlocks: true });
    expect(html).toContain('data-testid="rich-metrics"');
    expect(html).toContain('当前线上版本');
    expect(html).toContain('data-tone="positive"');
    expect(html).toContain('data-testid="rich-steps"');
    expect(html).toContain('data-status="done"');
    expect(html).toContain('data-status="active"');
    expect(html).toContain('data-status="pending"');
    // 解析失败的 metrics 静默回退为正常代码块，不抛异常
    expect(html).toContain('{ broken json');
    expect(html).toContain('code-renderer');
  });
});

describe('KaTeX math parsing & currency protection ($5 / $100)', () => {
  it('does not misidentify currency amounts or ranges as LaTeX math', () => {
    const currencySamples = [
      '售价仅 $5 起',
      '预算为 $100 左右',
      '价格从 $5 涨到 $10 了',
      '区间在 $5-$10 或 $100/$200 之间',
      'Cost is $100 and $200 respectively.',
      'Between $5.99 and $12.50 per month',
      'Spend $50 on food ($30) today'
    ];
    for (const sample of currencySamples) {
      const segs = extractMathSegments(sample);
      expect(segs, sample).toEqual([{ type: 'text', value: sample }]);
    }
  });

  it('parses inline math alongside currency on the same line and renders real KaTeX HTML safely', () => {
    const mixed = extractMathSegments('花费 $100 计算 $E = mc^2$ 与 $O(n \\log n)$');
    expect(mixed).toEqual([
      { type: 'text', value: '花费 $100 计算 ' },
      { type: 'inlineMath', value: 'E = mc^2' },
      { type: 'text', value: ' 与 ' },
      { type: 'inlineMath', value: 'O(n \\log n)' }
    ]);

    const blockMd = '行内 $E = mc^2$ 与金额 $100：\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$';
    const html = renderMarkdown(blockMd);
    expect(html).toContain('data-rich-math="inline"');
    expect(html).toContain('data-rich-math="block"');
    expect(html).toContain('$100');

    // KaTeX 真实渲染输出验证 + trust: false 安全守卫（拦截 \href 绝不渲染可执行 <a href="javascript:...">）
    const rendered = renderLatexSync(katex, '\\frac{a+b}{c}', true);
    expect(rendered).toContain('class="katex-display"');
    const dangerousLatex = renderLatexSync(katex, '\\href{javascript:alert(1)}{click}', false);
    expect(dangerousLatex).not.toContain('<a ');
    expect(dangerousLatex).not.toContain('href="javascript:');
  });
});

describe('SVG XSS sanitization', () => {
  it('strips <script>, onload/onclick handlers, <foreignObject>, external hrefs, and dangerous styles', () => {
    const hostile = [
      '<svg width="240" height="120" onload="alert(1)">',
      '  <script>alert("xss")</script>',
      '  <foreignObject width="100" height="100"><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(2)/></body></foreignObject>',
      '  <defs><linearGradient id="g1"><stop offset="0%" stop-color="#3b82f6"/></linearGradient></defs>',
      '  <style>@import url(https://evil.example/a.css); .ok { fill: url(#g1); background: url(https://evil.example/track.png); }</style>',
      '  <a href="javascript:alert(3)" xlink:href="https://evil.example"><rect width="80" height="40" onclick="steal()" style="fill:red;behavior:expression(alert(4))"/></a>',
      '  <use href="#g1" xlink:href="#g1"/>',
      '</svg>'
    ].join('\n');

    const safe = sanitizeSvgMarkup(hostile);
    expect(safe).not.toBeNull();
    expect(safe!).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(safe!).toContain('viewBox="0 0 240 120"');
    expect(safe!).toContain('href="#g1"');
    expect(safe!).toContain('url(#g1)');
    expect(safe!).not.toMatch(/<script/i);
    expect(safe!).not.toMatch(/<foreignObject/i);
    expect(safe!).not.toMatch(/\bon(?:load|click|error)\s*=/i);
    expect(safe!).not.toMatch(/javascript:/i);
    expect(safe!).not.toContain('https://evil.example');
    expect(safe!).not.toContain('@import');
    expect(safe!).not.toContain('expression(');

    expect(parseSvgDimensions(safe!)).toEqual({ width: 240, height: 120 });
    expect(sanitizeSvgMarkup('not an svg')).toBeNull();
  });

  it('renders closed valid ```svg blocks natively and falls back to code for invalid svg', () => {
    const validMd = '```svg\n<svg viewBox="0 0 120 60"><circle cx="60" cy="30" r="20"/></svg>\n```';
    const html = renderMarkdown(validMd);
    expect(html).toContain('data-testid="rich-svg-block"');
    expect(html).toContain('width="120"');
    expect(html).toContain('<circle');
    expect(html).toContain('data-testid="rich-svg-fullscreen"');

    // Prism markdown table token 必须强制 display: inline，防止与 Tailwind .table 冲突导致逐词换行
    const richCss = readFileSync(join(richDir, 'rich-markdown.css'), 'utf8');
    expect(richCss).toContain('.prism-code .token.table');
    expect(richCss).toContain('display: inline;');

    const invalidMd = '```svg\nnot xml at all\n```';
    const fallbackHtml = renderMarkdown(invalidMd);
    expect(fallbackHtml).not.toContain('data-testid="rich-svg-block"');
    expect(fallbackHtml).toContain('code-renderer');
  });
});

describe('Mermaid theme integration, lazy loading & streaming unclosed placeholders', () => {
  it('maps all 20 built-in AgentDock themes cleanly into strict base Mermaid configs', () => {
    expect(BUILTIN_THEMES.length).toBeGreaterThanOrEqual(20);
    for (const theme of BUILTIN_THEMES) {
      const cfg = buildMermaidConfig(theme);
      expect(cfg.theme).toBe('base');
      expect(cfg.securityLevel).toBe('strict');
      expect(cfg.darkMode).toBe(theme.mode === 'dark');
      expect(cfg.themeVariables.textColor).toBe(theme.tokens.textPrimary);
      expect(cfg.themeVariables.background).toBe('transparent');
    }
  });

  it('keeps mermaid and katex strictly lazy-loaded via dynamic import()', () => {
    const mermaidSrc = readFileSync(join(richDir, 'mermaid-theme.ts'), 'utf8');
    const mathSrc = readFileSync(join(richDir, 'MathRenderer.tsx'), 'utf8');
    const katexLoaderSrc = readFileSync(join(richDir, 'katex-loader.ts'), 'utf8');
    const mdSrc = readFileSync(join(webSrcDir, 'MarkdownContent.tsx'), 'utf8');

    expect(mermaidSrc).toContain("import('mermaid')");
    expect(mermaidSrc).not.toMatch(/^\s*import\s+mermaid\s+from\s+['"]mermaid['"]/m);
    expect(mathSrc).toContain("import('./katex-loader')");
    expect(katexLoaderSrc).toContain("import 'katex/dist/katex.min.css'");
    expect(mathSrc).not.toMatch(/^\s*import\s+katex\s+from\s+['"]katex['"]/m);
    expect(mdSrc).not.toContain("from 'mermaid'");
    expect(mdSrc).not.toContain("from 'katex'");
  });

  it('renders calm streaming placeholder for unclosed mermaid/svg/metrics/steps fences and real block when closed', () => {
    expect(isFencedCodeSliceUnclosed('```mermaid\ngraph TD\n  A --> B')).toBe(true);
    expect(isFencedCodeSliceUnclosed('```mermaid\ngraph TD\n  A --> B\n```')).toBe(false);

    for (const [lang, body] of [
      ['mermaid', 'graph TD\n  A --> B'],
      ['svg', '<svg viewBox="0 0 100 100"><circle'],
      ['metrics', '版本: v0.3.31'],
      ['steps', '[x] 第一步']
    ] as const) {
      const unclosedHtml = renderMarkdown(`\`\`\`${lang}\n${body}`, 'zh-CN', { isStreaming: true, enableRichBlocks: true });
      expect(unclosedHtml, `unclosed ${lang}`).toContain('data-testid="rich-streaming-placeholder"');
      expect(unclosedHtml, `unclosed ${lang}`).toContain(`data-rich-kind="${lang}"`);
    }

    const closedMermaidHtml = renderMarkdown('```mermaid\ngraph TD\n  A[Start] --> B[End]\n```', 'zh-CN');
    expect(closedMermaidHtml).toContain('data-testid="rich-mermaid-block"');
    expect(closedMermaidHtml).not.toContain('data-testid="rich-streaming-placeholder"');
  });
});

describe('frameless compact table & unified Lightbox slides', () => {
  it('renders frameless table with bilingual copy and MD toggle buttons', () => {
    const md = [
      '| 组件 | 适用场景 | 移动端适配 |',
      '| --- | --- | --- |',
      '| `metrics` | 指标速览 | 自动 2×2 细线网格 |'
    ].join('\n');

    const zhHtml = renderMarkdown(md, 'zh-CN');
    expect(zhHtml).toContain('data-testid="rich-table"');
    expect(zhHtml).toContain('data-testid="rich-table-copy"');
    expect(zhHtml).toContain('复制表格');
    expect(zhHtml).toContain('data-testid="rich-table-toggle-md"');
    expect(zhHtml).toContain('>MD<');
    expect(zhHtml).toContain('markdown-table-scroll');

    const enHtml = renderMarkdown(md, 'en-US');
    expect(enHtml).toContain('>Copy<');
    expect(enHtml).toContain('>MD<');
    expect(enHtml).not.toContain('复制表格');
  });

  it('resolves unified SVG/Mermaid and image slides for ImageLightbox', () => {
    const svgSlides = resolveLightboxSlides(undefined, undefined, 'Mermaid 图表', '<svg></svg>', 'flow.svg', 'mermaid');
    expect(svgSlides).toEqual([
      { svgMarkup: '<svg></svg>', alt: 'Mermaid 图表', downloadName: 'flow.svg', kind: 'mermaid' }
    ]);
  });
});
