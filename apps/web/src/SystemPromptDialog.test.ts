import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Session } from './api';
import { TooltipProvider } from './HoverTooltip';
import { SystemPromptDialog } from './SystemPromptDialog';

function makeSession(systemPrompt?: string): Session {
  return {
    id: 'ses_prompt_readonly',
    agentId: 'claude',
    state: 'idle',
    cwd: '/tmp/workspace',
    runId: 'run_1',
    createdAt: '2026-11-28T00:00:00.000Z',
    updatedAt: '2026-11-28T00:00:00.000Z',
    ...(systemPrompt !== undefined ? { systemPrompt } : {})
  };
}

function renderDialog(session: Session) {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(SystemPromptDialog, { session, onClose: () => undefined })
    )
  );
}

describe('SystemPromptDialog 只读快照查看器', () => {
  it('诚实展示只读快照与一键复制按钮，不渲染可编辑 textarea 或误导性 AI 优化入口', () => {
    const prompt = '你是代码审查助手。\n请输出简洁、结构化的审查结论。';
    const html = renderDialog(makeSession(prompt));

    expect(html).toContain('系统提示词');
    expect(html).toContain('创建会话时注入的系统提示词快照（只读，可一键复制）');
    expect(html).toContain('创建时提示词');
    expect(html).toContain('只读快照');
    expect(html).toContain('data-testid="system-prompt-readonly-content"');
    expect(html).toContain(prompt);
    expect(html).toContain(`${prompt.length.toLocaleString()} 字 · 已创建会话的提示词不可修改`);
    expect(html).toContain('data-testid="system-prompt-copy-btn"');
    expect(html).toContain('复制提示词');
    expect(html).not.toContain('disabled=""');

    // 绝不出现可编辑表单控件或误导性 AI 改写/撤销文案
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('AI 优化');
    expect(html).not.toContain('支持 AI 优化改写');
    expect(html).not.toContain('写入后可随时一键撤销恢复原文');
    expect(html).not.toContain('优化后可复制到新会话使用');
    expect(html).not.toContain('恢复原值');
    expect(html).not.toContain('已修改草稿');
    expect(html).not.toContain('system-prompt-dialog-ai');
  });

  it('无系统提示词时展示空态并禁用复制按钮', () => {
    const html = renderDialog(makeSession('   '));
    expect(html).toContain('当前会话暂无系统提示词。');
    expect(html).toContain('data-testid="system-prompt-copy-btn"');
    expect(html).toContain('disabled=""');
  });

  it('源码不引入 AiTextAssist 且复用支持局域网回退的 copyText', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'SystemPromptDialog.tsx'), 'utf8');
    expect(source).not.toContain('AiTextAssist');
    expect(source).not.toContain('AiFieldHeader');
    expect(source).not.toContain('useAiFlash');
    expect(source).toContain('copyText');
    expect(source).toContain('useModalFocusTrap');
  });
});
