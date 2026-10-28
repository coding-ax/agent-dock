import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isBlockCode, resolveCodeLanguage, MarkdownContent } from './MarkdownContent';

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
});
