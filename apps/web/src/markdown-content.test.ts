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
    expect(resolveImageSrc('file:///Users/me/.gemini/brain/chart.svg', 'ses_1')).toBe('/api/sessions/ses_1/fs/read?path=%2FUsers%2Fme%2F.gemini%2Fbrain%2Fchart.svg');
    expect(resolveImageSrc('./assets/pic.png', 'ses_1')).toBe('/api/sessions/ses_1/fs/read?path=.%2Fassets%2Fpic.png');
    expect(resolveImageSrc('https://example.com/a.png', 'ses_1')).toBe('https://example.com/a.png');
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
});
