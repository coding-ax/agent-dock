import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BUILTIN_THEMES, themeToCssVariables } from '@agent-dock/agent-dock-shared';
import { TooltipProvider } from './HoverTooltip';
import { ThemeStudioDialog, ThemeMiniPreview } from './ThemeStudioDialog';
import { ThemeSegmented } from './ThemeToggle';
import { referenceFromUpload } from './composer-utils';
import { setPreviewTheme, syncThemesSnapshot } from './themes';

function renderWithProviders(node: ReturnType<typeof createElement>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(TooltipProvider, null, node)
    )
  );
}

describe('frontend theme engine & ThemeStudioDialog', () => {
  it('renders ThemeStudioDialog gallery with all curated presets and 4 workspace tabs', () => {
    const html = renderWithProviders(
      createElement(ThemeStudioDialog, { onClose: () => {}, initialTab: 'gallery' })
    );
    expect(html).toContain('主题工坊');
    expect(html).toContain('画廊');
    expect(html).toContain('AI 定制');
    expect(html).toContain('VS Code');
    expect(html).toContain('调色板');
    expect(html).toContain('筛选主题…');
    expect(html).toContain('极光青松');
    expect(html).toContain('樱夜黑曜');
    expect(html).toContain('樱雾晨晓');
    expect(html).toContain('Tokyo Night');
    expect(html).toContain('京都抹茶浅色');
    expect(html).toContain('One Dark Pro');
    expect(html).toContain('Dracula');
    expect(html).toContain('Catppuccin Latte');
    expect(html).toContain('GitHub Light');
    expect(html).toContain('Solarized Light');
    expect(html).toContain('Everforest Light');
  });

  it('renders AI customization tab with disabled trigger & unconfigured banner when LLM is not configured', () => {
    const html = renderWithProviders(
      createElement(ThemeStudioDialog, { onClose: () => {}, onOpenLlmSettings: () => {}, initialTab: 'ai' })
    );
    expect(html).toContain('theme-ai-unconfigured-banner');
    expect(html).toContain('theme-ai-generate-unconfigured');
    expect(html).toContain('前往配置模型端点');
    expect(html).toContain('aria-disabled="true"');
  });

  it('renders VS Code import tab with dropzone and session upload hint', () => {
    const html = renderWithProviders(
      createElement(ThemeStudioDialog, { onClose: () => {}, initialTab: 'vscode' })
    );
    expect(html).toContain('vscode-dropzone');
    expect(html).toContain('.vsix');
    expect(html).toContain('agent-dock theme import-vscode');
  });

  it('renders palette editor tab with WCAG contrast dashboard and all semantic color inputs', () => {
    const html = renderWithProviders(
      createElement(ThemeStudioDialog, { onClose: () => {}, initialTab: 'editor' })
    );
    expect(html).toContain('WCAG 对比度实时校验');
    expect(html).toContain('一键护眼修正');
    expect(html).toContain('bgCanvas');
    expect(html).toContain('bgSidebar');
    expect(html).toContain('accentForeground');
    expect(html).toContain('theme-editor-save-btn');
  });

  it('renders ThemeSegmented with quick palette studio button when onOpenStudio is provided', () => {
    const html = renderWithProviders(
      createElement(ThemeSegmented, { onOpenStudio: () => {} })
    );
    expect(html).toContain('浅色');
    expect(html).toContain('跟随系统');
    expect(html).toContain('深色');
    expect(html).toContain('theme-studio-quick-trigger');
  });

  it('renders ThemeMiniPreview with real inline token colors and preserves originalName on uploaded .vsix reference', () => {
    const tokyo = BUILTIN_THEMES.find(theme => theme.id === 'builtin-tokyo-night')!;
    const html = renderToStaticMarkup(createElement(ThemeMiniPreview, { tokens: tokyo.tokens }));
    expect(html).toContain(tokyo.tokens.bgCanvas);
    expect(html).toContain(tokyo.tokens.bgSidebar);
    expect(html).toContain(tokyo.tokens.accent);

    const ref = referenceFromUpload(
      { path: '/Users/me/.agentdock/uploads/ses_1/1700-abc.vsix', url: '/api/sessions/ses_1/uploads/1700-abc.vsix', filename: '1700-abc.vsix', originalName: 'tokyo-night.vsix' },
      false
    );
    expect(ref.kind).toBe('file');
    expect(ref.label).toBe('tokyo-night.vsix');
    expect(ref.value).toBe('/Users/me/.agentdock/uploads/ses_1/1700-abc.vsix');
  });

  it('syncs server theme snapshot and ephemeral preview cleanly without crashing in non-DOM test env', () => {
    const matcha = BUILTIN_THEMES.find(theme => theme.id === 'builtin-kyoto-matcha')!;
    const vars = themeToCssVariables(matcha);
    expect(vars['--accent']).toBe('59 117 73');

    syncThemesSnapshot({
      themes: [...BUILTIN_THEMES],
      preferences: {
        modePreference: 'light',
        activeThemeId: matcha.id,
        activeLightThemeId: matcha.id,
        activeDarkThemeId: 'builtin-tokyo-night'
      },
      revision: 2,
      updatedAt: new Date().toISOString()
    });
    setPreviewTheme(BUILTIN_THEMES[2]!);
    setPreviewTheme(null);
  });
});
