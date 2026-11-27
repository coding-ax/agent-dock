import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  extractLinkedImages,
  isBlockCode,
  MarkdownContent,
  MAX_AUTO_IMAGE_THUMBNAILS,
  resolveCodeLanguage,
  resolveImageSrc
} from './MarkdownContent';

describe('stream-safe Markdown code rendering', () => {
  it('normalizes common fenced-code language aliases', () => {
    expect(resolveCodeLanguage('language-ts')).toEqual({ language: 'typescript', label: 'ts' });
    expect(resolveCodeLanguage('language-py')).toEqual({ language: 'python', label: 'py' });
  });

  it('falls back to plain text for an unknown grammar while retaining its label', () => {
    expect(resolveCodeLanguage('language-agentdock')).toEqual({ language: 'plain', label: 'agentdock' });
  });

  it('distinguishes inline code from fenced or multiline code', () => {
    expect(isBlockCode(undefined, 'const value = 1')).toBe(false);
    expect(isBlockCode('language-js', 'const value = 1')).toBe(true);
    expect(isBlockCode(undefined, 'line one\nline two\n')).toBe(true);
  });
});

describe('多行提示词保留换行', () => {
  it('单个换行渲染为 <br>，不会被折叠成一整段', () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: undefined, children: '第一行\n第二行\n第三行' }));
    expect(html).toContain('<br/>');
    expect(html).not.toContain('第一行第二行');
  });
});

describe('GFM markdown table rendering', () => {
  const table = [
    '| 列A | 列B |',
    '| --- | --- |',
    '| a   | b   |',
    '| c   | d   |',
  ].join('\n');

  it('renders a markdown table into <table>/<th>/<td> (remark-gfm 已启用)', () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: undefined, children: table }));
    expect(html).toContain('<table>');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
    // 不应把管道符原样残留成纯文本
    expect(html).not.toContain('| --- |');
    // GFM 表格内容能取到
    expect(html).toContain('列A');
    expect(html).toContain('b');
  });
});

describe('markdown 链接默认新开标签页', () => {
  it('renders 外链 <a> 带 target=_blank + rel 防止同页把会话时间线踢走', () => {
    const md = '查看 [Example](https://www.example.com/) 订单';
    const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: undefined, children: md }));
    expect(html).toMatch(/<a[^>]*href="https:\/\/www\.example\.com\/"[^>]*target="_blank"[^>]*>/);
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('相对链接（如站内 /sessions/xxx）同样新开标签页，避免同一 SPA 内跳走', () => {
    const md = '会话 [链接](/sessions/ses_1)';
    const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: undefined, children: md }));
    expect(html).toMatch(/<a[^>]*href="\/sessions\/ses_1"[^>]*target="_blank"/);
  });
});

describe('workspace file preview links', () => {
  it('turns local file links into side pane actions', () => {
    const md = '[报告](./docs/report.md) 和 [本地文件](file:///repo/readme.md)';
    const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: 'ses_1', children: md }));
    expect(html).toContain('<button type="button" title="./docs/report.md"');
    expect(html).toContain('<button type="button" title="/repo/readme.md"');
  });

  it('keeps session links as navigation', () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: 'ses_1', children: '[会话](/sessions/ses_2)' }));
    expect(html).toContain('href="/sessions/ses_2"');
  });

  it('turns bare file:// URLs into clickable preview chips without touching code blocks', () => {
    const md = '查看 file:///repo/src/app.ts#L14-L16 和 `file:///repo/ignored.ts`';
    const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: 'ses_1', children: md }));
    expect(html).toContain('<button type="button" title="/repo/src/app.ts"');
    expect(html).toContain('app.ts#L14-L16');
    expect(html).toContain('<code');
    expect(html).not.toContain('title="/repo/ignored.ts"');
  });

  it('resolves workspace, artifact, and uploads image sources', () => {
    expect(resolveImageSrc('/Users/me/.agentdock/uploads/ses_1/shot.png', 'ses_1')).toBe('/api/sessions/ses_1/uploads/shot.png');
    // 跨会话引用（例如侧边会话引用主会话上传的截图）必须保留路径中的原始 uploadSessionId，而非误用当前 sessionId。
    expect(resolveImageSrc('/Users/me/.agentdock/uploads/ses_main/1795626341008-9716ec55483c.png', 'ses_side'))
      .toBe('/api/sessions/ses_main/uploads/1795626341008-9716ec55483c.png');
    expect(resolveImageSrc('file:///Users/me/.agentdock/uploads/ses_main/1795626341008-9716ec55483c.png', 'ses_side'))
      .toBe('/api/sessions/ses_main/uploads/1795626341008-9716ec55483c.png');
    expect(resolveImageSrc('/Users/me/.agentdock/uploads/ses_main/sub/nested.png', 'ses_side'))
      .toBe('/api/sessions/ses_side/fs/read?path=%2FUsers%2Fme%2F.agentdock%2Fuploads%2Fses_main%2Fsub%2Fnested.png');
    expect(resolveImageSrc('file:///Users/me/.gemini/brain/chart.svg', 'ses_1')).toBe('/api/sessions/ses_1/fs/read?path=%2FUsers%2Fme%2F.gemini%2Fbrain%2Fchart.svg');
    expect(resolveImageSrc('./assets/pic.png', 'ses_1')).toBe('/api/sessions/ses_1/fs/read?path=.%2Fassets%2Fpic.png');
    expect(resolveImageSrc('https://example.com/a.png', 'ses_1')).toBe('https://example.com/a.png');
  });

  it('resolves cross-session upload links in linked image thumbnails to the source session', () => {
    const md = '已通过 `read_file` 读取 [1795626341008-9716ec55483c.png](file:///Users/me/.agentdock/uploads/ses_main/1795626341008-9716ec55483c.png)';
    const items = extractLinkedImages(md, 'ses_side');
    expect(items).toEqual([
      {
        src: '/api/sessions/ses_main/uploads/1795626341008-9716ec55483c.png',
        alt: '1795626341008-9716ec55483c.png',
        filePath: '/Users/me/.agentdock/uploads/ses_main/1795626341008-9716ec55483c.png'
      }
    ]);
    const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: 'ses_side', children: md }));
    expect(html).toContain('src="/api/sessions/ses_main/uploads/1795626341008-9716ec55483c.png"');
  });

  it('extracts linked local images/SVGs and caps auto thumbnails at 4 with expand button', () => {
    const md = [
      '[图1](file:///tmp/1.png)',
      '[图2](file:///tmp/2.svg)',
      '[图3](./3.webp)',
      '[图4](file:///tmp/4.jpg)',
      '[图5](file:///tmp/5.gif)',
      '![已内联](file:///tmp/inline.png)',
      '```txt\n[代码里](file:///tmp/code.png)\n```'
    ].join('\n');
    const items = extractLinkedImages(md, 'ses_1');
    expect(items).toHaveLength(5);
    expect(items.map(i => i.filePath)).toEqual(['/tmp/1.png', '/tmp/2.svg', './3.webp', '/tmp/4.jpg', '/tmp/5.gif']);

    const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: 'ses_1', children: md }));
    expect(html).toContain('data-testid="linked-image-thumbnails"');
    expect(html).toContain(`+${5 - MAX_AUTO_IMAGE_THUMBNAILS} 张`);
    expect(html).toContain('展开全部');
  });

  it('keeps file preview link buttons bounded and wrappable for long path labels', () => {
    const label = '/Users/codeax/workspace/ai-video-studio/output/daily_YYYYMMDD_contact_sheet.jpg';
    const md = `[${label}](file://${label})`;
    const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: 'ses_1', children: md }));
    expect(html).toMatch(/<button type="button" title="[^"]*" class="[^"]*\bmax-w-full\b[^"]*\btext-left\b/);
    expect(html).toContain('[overflow-wrap:anywhere]');
  });
});

describe('用户消息斜杠命令高亮边界', () => {
  it('仅高亮消息最开头的单个 /命令（支持命名空间与软换行）', () => {
    const simple = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: 'ses_1', highlightSlashCommands: true, children: '/plan 帮我分析这个架构' }));
    expect(simple).toContain('<code class="ui-slash-command">/plan</code>');

    const withNewline = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: 'ses_1', highlightSlashCommands: true, children: '/lark-doc\n帮我看这篇文档' }));
    expect(withNewline).toContain('<code class="ui-slash-command">/lark-doc</code><br/>');

    const namespaced = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: 'ses_1', highlightSlashCommands: true, children: '/sc:analyze 检查一下' }));
    expect(namespaced).toContain('<code class="ui-slash-command">/sc:analyze</code>');
  });

  it('正文中的反引号路径与命令绝不误判为 ui-slash-command', () => {
    const md = [
      '工作临时目录放在 `/Users/codeax/workspace/ai-video-studio/work/daily_YYYYMMDD_<slug>/`。',
      '最终成品输出到：',
      '`/Users/codeax/workspace/ai-video-studio/output/daily_YYYYMMDD_<slug>.mp4`',
      '`/Users/codeax/workspace/ai-video-studio/output/daily_YYYYMMDD_<slug>_contact_sheet.jpg`',
      '也不要误伤 `/compact` 或 `/api/v1/sessions`。'
    ].join('\n');
    const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: 'ses_1', highlightSlashCommands: true, children: md }));
    expect(html).not.toContain('ui-slash-command');
    expect(html).toContain('ui-inline-code');
    expect(html).toContain('/Users/codeax/workspace/ai-video-studio/output/daily_YYYYMMDD_&lt;slug&gt;_contact_sheet.jpg');
  });

  it('开头为真实命令且正文含反引号路径时，仅首 token 高亮', () => {
    const md = '/plan 检查 `/Users/codeax/workspace/ai-video-studio/output/daily_YYYYMMDD_<slug>.mp4` 和 `/compact`';
    const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: 'ses_1', highlightSlashCommands: true, children: md }));
    expect(html.match(/ui-slash-command/g)).toHaveLength(1);
    expect(html).toContain('<code class="ui-slash-command">/plan</code>');
    expect(html.match(/ui-inline-code/g)).toHaveLength(2);
  });

  it('开头为绝对路径、点文件、注释、带扩展名文件或手写反引号代码时不误判为命令', () => {
    const samples = [
      '/Users/codeax/workspace/ai-video-studio/output/demo.mp4 帮我看下',
      '/.env 请检查配置',
      '// 这是注释',
      '/README.md 帮我润色',
      '`/plan` 是计划命令',
      '/plan**紧凑**'
    ];
    for (const sample of samples) {
      const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: 'ses_1', highlightSlashCommands: true, children: sample }));
      expect(html, sample).not.toContain('ui-slash-command');
    }
  });

  it('助手消息（highlightSlashCommands=false）不高亮开头的 /命令', () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, { sessionId: 'ses_1', children: '/plan 帮我分析' }));
    expect(html).not.toContain('ui-slash-command');
  });
});
