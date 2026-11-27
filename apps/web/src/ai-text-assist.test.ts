import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmEndpointState } from './api';

let mockLlmState: LlmEndpointState = {
  configured: false,
  formats: []
};

vi.mock('./api', async importOriginal => ({
  ...(await importOriginal<typeof import('./api')>()),
  api: {
    llm: vi.fn(async () => mockLlmState),
    assistLlm: vi.fn(async () => ({
      mode: 'prompt_write',
      text: '已生成的提示词',
      model: 'gpt-5',
      format: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1'
    }))
  }
}));

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({ data: mockLlmState, isLoading: false })
}));

vi.mock('react-dom', async importOriginal => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: unknown) => node
}));

import {
  AiTextAssistButton,
  AiTextAssistControl,
  AiUndoCapsule,
  LLM_UNCONFIGURED_TOOLTIP,
  createAiTextUndoState,
  getAiAssistPresets,
  getAiModeMeta,
  placeAiPopover,
  popAiTextSnapshot,
  pushAiTextSnapshot
} from './AiTextAssist';
import { MAX_AI_UNDO_STEPS } from './ai-text-assist-state';
import { TooltipProvider } from './HoverTooltip';

function renderControl(element: ReturnType<typeof createElement>) {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(TooltipProvider, null, element)
    )
  );
}

afterEach(() => {
  mockLlmState = { configured: false, formats: [] };
});

describe('多步撤销栈（useUndoableAiText 状态模型）', () => {
  it('支持单步与多步无损回撤（含空串原值）', () => {
    let state = createAiTextUndoState();
    state = pushAiTextSnapshot(state, '', '第一版 AI 文案', '已生成', 1);
    state = pushAiTextSnapshot(state, '第一版 AI 文案', '第二版 AI 润色', '已优化清晰', 2);
    state = pushAiTextSnapshot(state, '第二版 AI 润色', '第三版 AI 精简', '已精简提炼', 3);

    expect(state.stack).toHaveLength(3);
    expect(state.lastAppliedLabel).toBe('已精简提炼');

    const step1 = popAiTextSnapshot(state);
    expect(step1.restored?.value).toBe('第二版 AI 润色');
    expect(step1.state.stack).toHaveLength(2);
    expect(step1.state.lastAppliedLabel).toBe('已优化清晰');

    const step2 = popAiTextSnapshot(step1.state);
    expect(step2.restored?.value).toBe('第一版 AI 文案');
    expect(step2.state.stack).toHaveLength(1);

    const step3 = popAiTextSnapshot(step2.state);
    expect(step3.restored?.value).toBe('');
    expect(step3.state.stack).toHaveLength(0);

    const empty = popAiTextSnapshot(step3.state);
    expect(empty.restored).toBeUndefined();
  });

  it('内容未变化时不污染撤销栈，且限制最大历史步数', () => {
    let state = createAiTextUndoState();
    state = pushAiTextSnapshot(state, '相同文本', '相同文本', '已优化', 1);
    expect(state.stack).toHaveLength(0);

    for (let i = 0; i < MAX_AI_UNDO_STEPS + 5; i++) {
      state = pushAiTextSnapshot(state, `v${i}`, `v${i + 1}`, `step-${i}`, i);
    }
    expect(state.stack).toHaveLength(MAX_AI_UNDO_STEPS);
    expect(state.stack[0]?.value).toBe('v5');
  });
});

describe('各模式预设与 Popover 视口定位', () => {
  it('覆盖全部 6 种模式且随输入空/非空自适应预设', () => {
    expect(getAiAssistPresets('prompt_write', false).some(p => p.action === 'write')).toBe(true);
    expect(getAiAssistPresets('prompt_write', true).map(p => p.action)).toEqual(['optimize', 'concise', 'structure']);
    expect(getAiAssistPresets('message_polish', true).map(p => p.action)).toEqual(['optimize', 'concise', 'structure']);
    expect(getAiAssistPresets('message_polish', false)).toEqual([]);
    expect(getAiAssistPresets('title_generate', false).some(p => p.mode === 'title_generate')).toBe(true);
    expect(getAiAssistPresets('regex_generate', true).some(p => p.mode === 'regex_generate')).toBe(true);
    expect(getAiAssistPresets('description_polish', true).map(p => p.action)).toEqual(['optimize', 'concise', 'structure']);
    expect(getAiModeMeta('regex_generate').title).toContain('正则');
  });

  it('在 390×844 移动端与贴底控件处自动翻转并夹回视口安全区', () => {
    const mobileBottom = placeAiPopover(
      { top: 780, bottom: 812, left: 320, right: 352, width: 32, height: 32 },
      { width: 340, height: 240 },
      { width: 390, height: 844 },
      { side: 'bottom', align: 'end' }
    );
    expect(mobileBottom.side).toBe('top');
    expect(mobileBottom.left).toBeGreaterThanOrEqual(8);
    expect(mobileBottom.left + mobileBottom.maxWidth).toBeLessThanOrEqual(390 - 8);
    expect(mobileBottom.top).toBeGreaterThanOrEqual(8);
  });
});

describe('AiTextAssistControl 渲染：未配置置灰 + 已配置交互 + 撤销胶囊', () => {
  it('未配置 LLM 端点时保留位置、按钮置灰禁用，并由外层可聚焦 span 承载 Radix HoverTooltip', () => {
    mockLlmState = { configured: false, formats: [] };
    const html = renderControl(
      createElement(AiTextAssistControl, {
        mode: 'prompt_write',
        value: '',
        onChange: () => undefined
      })
    );
    expect(html).toContain('data-ai-assist-unconfigured="true"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('需先配置 LLM 模型端点');
    // 禁止原生 title，确保严格走 Radix HoverTooltip
    expect(html).not.toMatch(/<button[^>]*\btitle="/);
    expect(LLM_UNCONFIGURED_TOOLTIP).toContain('模型端点');
  });

  it('已配置 LLM 端点时渲染可点击微光按钮，并按草稿状态切换文案', () => {
    mockLlmState = { configured: true, model: 'gpt-5', format: 'openai-chat', formats: [] };

    const emptyHtml = renderControl(
      createElement(AiTextAssistControl, {
        mode: 'prompt_write',
        value: '',
        onChange: () => undefined
      })
    );
    expect(emptyHtml).toContain('data-testid="ai-assist-trigger"');
    expect(emptyHtml).toContain('ui-ai-trigger');
    expect(emptyHtml).toContain('aria-haspopup="dialog"');
    expect(emptyHtml).toContain('AI 帮写');
    expect(emptyHtml).not.toContain('disabled=""');

    const filledHtml = renderControl(
      createElement(AiTextAssistControl, {
        mode: 'prompt_write',
        value: '已有提示词草稿',
        onChange: () => undefined
      })
    );
    expect(filledHtml).toContain('AI 优化');

    const iconBtnHtml = renderControl(
      createElement(AiTextAssistButton, {
        mode: 'regex_generate',
        value: '',
        onChange: () => undefined
      })
    );
    expect(iconBtnHtml).toContain('ui-ai-trigger');
    expect(iconBtnHtml).toContain('aria-label="AI 写正则"');
  });

  it('AiUndoCapsule 展示单步与多步回撤计数', () => {
    const oneStep = renderControl(
      createElement(AiUndoCapsule, {
        undoDepth: 1,
        lastLabel: '已优化清晰',
        onUndo: () => undefined,
        onDismiss: () => undefined
      })
    );
    expect(oneStep).toContain('data-testid="ai-undo-capsule"');
    expect(oneStep).toContain('已优化清晰');
    expect(oneStep).toContain('撤销');
    expect(oneStep).not.toContain('撤销 (1)');

    const multiStep = renderControl(
      createElement(AiUndoCapsule, {
        undoDepth: 3,
        lastLabel: '已精简提炼',
        onUndo: () => undefined
      })
    );
    expect(multiStep).toContain('撤销 (3)');
  });
});

describe('全站输入框接入覆盖守卫', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    'Composer.tsx',
    'SessionPane.tsx',
    'SystemPromptDialog.tsx',
    'PromptTemplates.tsx',
    'ScheduleDialog.tsx',
    'PromptEditor.tsx',
    'App.tsx',
    'LarkAvatarPanel.tsx',
    'board/KittenBoardDock.tsx',
    'board/BoardModals.tsx',
    'board/BoardDetailDrawer.tsx'
  ];

  it('所有核心用户输入场景均已接入统一 AiTextAssistControl', () => {
    for (const file of files) {
      const source = readFileSync(join(here, file), 'utf8');
      expect(source, `${file} 缺少 AiTextAssistControl 接入`).toContain('AiTextAssistControl');
    }
  });
});
