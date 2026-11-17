import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

const status = {
  currentVersion: '0.3.9',
  distTag: 'latest',
  latestVersion: '0.3.10',
  updateAvailable: true,
  canUpdate: true,
  updating: false,
  runtime: 'daemon' as const
};

vi.mock('./api', () => ({
  api: {
    selfUpdateStatus: vi.fn(async () => status),
    startSelfUpdate: vi.fn(async () => status)
  }
}));
// SSR 不跑 effects，直接给组件一份「已查到新版本」的查询结果。
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({ data: status, refetch: vi.fn(), isPending: false })
}));
// 服务端渲染不支持 portal，测试里把弹窗内容直接渲染在内联位置。
vi.mock('react-dom', async importOriginal => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: unknown) => node
}));
vi.mock('./Toast', () => ({
  useToast: () => ({ toast: null, show: () => undefined })
}));
vi.mock('./desktop-update', () => ({ desktopUpdateApi: () => undefined }));
vi.mock('./DesktopUpdateNotice', () => ({ DesktopUpdateNotice: () => null }));

import { SelfUpdateNotice } from './SelfUpdateNotice';
import { TooltipProvider } from './HoverTooltip';

describe('SelfUpdateNotice', () => {
  it('keeps the manual re-check available while an outdated update banner is visible', () => {
    // createPortal 的第二个参数在渲染时就会求值；SSR 没有 document，给一个占位 body。
    vi.stubGlobal('document', { body: {} });
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient },
      createElement(TooltipProvider, null, createElement(SelfUpdateNotice, { enabled: true }))
    ));

    expect(html).toContain('新版本');
    expect(html).toContain('0.3.10');
    // 服务端缓存可能比 npm 落后：横幅出现时也必须能手动再查一次。
    expect(html).toContain('aria-label="检查更新"');
  });
});
