import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from './HoverTooltip';
import { TimelineSearchBar } from './TimelineSearchBar';

const renderBar = (props: Partial<Parameters<typeof TimelineSearchBar>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(TimelineSearchBar, {
        inputRef: createRef<HTMLInputElement>(),
        query: '',
        hasQuery: false,
        activeIndex: -1,
        total: 0,
        onQueryChange: () => {},
        onNext: () => {},
        onPrev: () => {},
        onClear: () => {},
        onClose: () => {},
        ...props
      })
    )
  );

describe('TimelineSearchBar', () => {
  it('renders current/total counter and enables navigation buttons when matches exist', () => {
    const html = renderBar({ query: 'agent', hasQuery: true, activeIndex: 1, total: 5 });
    expect(html).toContain('data-testid="timeline-search-bar"');
    expect(html).toContain('2 / 5');
    expect(html).toContain('aria-label="清空关键词"');
    expect(html).toContain('aria-label="上一条匹配"');
    expect(html).toContain('aria-label="下一条匹配"');
    expect(html).toContain('aria-label="关闭搜索"');
    expect(html).not.toMatch(/aria-label="上一条匹配"[^>]*\sdisabled=""/);
    expect(html).not.toMatch(/aria-label="下一条匹配"[^>]*\sdisabled=""/);
  });

  it('renders no-result indicator and disables navigation buttons when total is 0', () => {
    const html = renderBar({ query: 'nonexistent', hasQuery: true, activeIndex: -1, total: 0 });
    expect(html).toContain('无结果');
    expect(html).toMatch(/aria-label="上一条匹配"[^>]*\sdisabled=""/);
    expect(html).toMatch(/aria-label="下一条匹配"[^>]*\sdisabled=""/);
  });

  it('hides counter and clear button when query is empty', () => {
    const html = renderBar({ query: '', hasQuery: false, activeIndex: -1, total: 0 });
    expect(html).not.toContain('data-testid="timeline-search-count"');
    expect(html).not.toContain('aria-label="清空关键词"');
  });

  it('never uses bare native title attributes on icon buttons (tooltip consistency)', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TimelineSearchBar.tsx'), 'utf8');
    expect(source).not.toMatch(/<button[^>]*\btitle=/);
    expect(source).toContain('HoverTooltip');
  });
});
