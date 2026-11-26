import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FsReadResult } from './api';

let currentReadResult: FsReadResult | undefined;

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: (options: { queryKey: unknown[] }) => {
    if (options.queryKey[0] === 'fs-read') {
      return { data: currentReadResult, isLoading: false, error: null, refetch: vi.fn() };
    }
    return { data: undefined, isLoading: false, error: null, refetch: vi.fn() };
  }
}));

vi.mock('./theme', () => ({
  useResolvedTheme: () => 'light'
}));

import { FileExplorerPanel } from './FileExplorerPanel';
import { TooltipProvider } from './HoverTooltip';

function renderPanel(props: { initialPath?: string; cwd?: string }) {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        TooltipProvider,
        null,
        createElement(FileExplorerPanel, {
          sessionId: 'ses_1',
          cwd: props.cwd ?? '/Users/codeax/workspace/agent-dock',
          initialPath: props.initialPath
        })
      )
    )
  );
}

afterEach(() => {
  currentReadResult = undefined;
});

describe('FileExplorerPanel directory preview', () => {
  it('renders directory breadcrumbs, parent button, hidden toggle, entries, and hides file download', () => {
    currentReadResult = {
      kind: 'directory',
      cwd: '/Users/codeax/workspace/agent-dock',
      path: '/Users/codeax/workspace/agent-dock-site',
      absolutePath: '/Users/codeax/workspace/agent-dock-site',
      parentPath: '/Users/codeax/workspace',
      totalCount: 3,
      truncated: false,
      hiddenCount: 2,
      includeHidden: false,
      entries: [
        { name: 'src', path: '/Users/codeax/workspace/agent-dock-site/src', kind: 'directory', size: 0, mtime: '2026-11-26T00:00:00.000Z' },
        { name: 'README.md', path: '/Users/codeax/workspace/agent-dock-site/README.md', kind: 'file', size: 2048, mtime: '2026-11-26T00:00:00.000Z' },
        { name: 'index.html', path: '/Users/codeax/workspace/agent-dock-site/index.html', kind: 'file', size: 512, mtime: '2026-11-26T00:00:00.000Z' }
      ]
    };

    const html = renderPanel({ initialPath: '/Users/codeax/workspace/agent-dock-site' });

    expect(html).toContain('data-testid="directory-preview-view"');
    expect(html).toContain('data-testid="directory-parent-btn"');
    expect(html).toContain('data-testid="directory-breadcrumbs"');
    expect(html).toContain('agent-dock-site');
    expect(html).toContain('src');
    expect(html).toContain('README.md');
    expect(html).toContain('2.0 KB');
    expect(html).toContain('512 B');
    expect(html).toContain('共 3 项');
    expect(html).toContain('显示隐藏文件 (2)');
    // 目录视图不显示单文件下载按钮
    expect(html).not.toContain('aria-label="下载文件"');
  });

  it('shows truncation banner when directory exceeds entry limit', () => {
    currentReadResult = {
      kind: 'directory',
      cwd: '/Users/codeax/workspace/agent-dock',
      path: '/Users/codeax/workspace/huge-dir',
      absolutePath: '/Users/codeax/workspace/huge-dir',
      parentPath: '/Users/codeax/workspace',
      totalCount: 800,
      truncated: true,
      hiddenCount: 0,
      includeHidden: false,
      entries: [
        { name: 'file-1.txt', path: '/Users/codeax/workspace/huge-dir/file-1.txt', kind: 'file', size: 10, mtime: '2026-11-26T00:00:00.000Z' }
      ]
    };

    const html = renderPanel({ initialPath: '/Users/codeax/workspace/huge-dir' });
    expect(html).toContain('已展示 1 / 800 项');
    expect(html).toContain('仅展示前 1 项（共 800 项）');
    expect(html).not.toContain('toggle-hidden-btn');
  });

  it('keeps regular file preview and download button intact', () => {
    currentReadResult = {
      kind: 'file',
      cwd: '/Users/codeax/workspace/agent-dock',
      path: 'README.md',
      size: 12,
      content: '# Hello'
    };

    const html = renderPanel({ initialPath: 'README.md' });
    expect(html).not.toContain('data-testid="directory-preview-view"');
    expect(html).toContain('aria-label="下载文件"');
    expect(html).toContain('Hello');
  });
});
