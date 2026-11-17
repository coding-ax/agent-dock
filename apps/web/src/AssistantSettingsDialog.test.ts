import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./DeferredMount', () => ({
  DeferredMount: ({ children }: { children: unknown }) => children,
  DeferredSkeleton: () => null
}));
vi.mock('./useModalFocusTrap', () => ({ useModalFocusTrap: () => undefined }));
vi.mock('./companion/useCompanion', () => ({
  useCompanion: () => ({
    adopted: false,
    name: '小A同学',
    mainSession: null,
    companion: null,
    counts: { needsUser: 0, planned: 0, pendingDrafts: 0, open: 0 },
    status: '',
    mood: 'curious',
    stage: 'kitten'
  }),
  useLifecycleOverview: () => ({ data: undefined })
}));

import { AssistantSettingsDialog } from './AssistantSettingsDialog';

describe('AssistantSettingsDialog', () => {
  it('no longer renders the removed quiet-hours and silent-reaction settings', () => {
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient },
      createElement(AssistantSettingsDialog, {
        onClose: () => undefined,
        onOpenMain: () => undefined,
        onAdopt: () => undefined
      })
    ));

    expect(html).toContain('小猫与督办');
    expect(html).not.toContain('静默时段');
    expect(html).not.toContain('静默触发表情');
    expect(html).not.toContain('静默开始时间');
  });
});
