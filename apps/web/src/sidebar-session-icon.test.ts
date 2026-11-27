import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SessionRowLeadingIcons, shouldShowSessionRowAgentIcon } from './sidebar-session-icon';

describe('shouldShowSessionRowAgentIcon', () => {
  it('always shows AgentIcon in time view', () => {
    expect(shouldShowSessionRowAgentIcon('time', 'claude')).toBe(true);
    expect(shouldShowSessionRowAgentIcon('time', 'codex', 'codex')).toBe(true);
    expect(shouldShowSessionRowAgentIcon('time', 'antigravity')).toBe(true);
  });

  it('hides redundant AgentIcon for same-agent rows in project view, but keeps it for cross-agent side-chats', () => {
    expect(shouldShowSessionRowAgentIcon('project', 'claude', 'claude')).toBe(false);
    expect(shouldShowSessionRowAgentIcon('project', 'codex', 'claude')).toBe(true);
    expect(shouldShowSessionRowAgentIcon('project', 'antigravity', 'codex')).toBe(true);
    expect(shouldShowSessionRowAgentIcon('project', 'claude')).toBe(false);
  });
});

describe('SessionRowLeadingIcons', () => {
  it('renders a 14px AgentIcon inside a fixed 20x20 slot for normal sessions without native title', () => {
    const claudeHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'claude', source: 'web' },
      agent: { id: 'claude', name: 'Claude Code' },
      showAgentIcon: true,
    }));
    expect(claudeHtml).toContain('h-5 w-5');
    expect(claudeHtml).toContain('src="/agent-icons/claudecode.svg"');
    expect(claudeHtml).toContain('width="14"');
    expect(claudeHtml).toContain('height="14"');
    expect(claudeHtml).toContain('shrink-0');
    expect(claudeHtml).not.toContain('ui-session-badge-cutout');
    expect(claudeHtml).not.toContain('title=');

    const agyHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'antigravity', source: 'web' },
      agent: { id: 'antigravity', name: 'Antigravity' },
      showAgentIcon: true,
    }));
    expect(agyHtml).toContain('h-5 w-5');
    expect(agyHtml).toContain('src="/agent-icons/antigravity.svg"');

    const codexHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'codex', source: 'web' },
      agent: { id: 'codex', name: 'Codex' },
      showAgentIcon: true,
    }));
    expect(codexHtml).toContain('src="/agent-icons/codex.svg"');

    const unknownHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'custom-bot', source: 'web' },
      agent: { id: 'custom-bot', name: 'Custom' },
      showAgentIcon: true,
    }));
    expect(unknownHtml).toContain('<svg');
    expect(unknownHtml).toContain('h-5 w-5');
  });

  it('overlays a cutout corner badge in the same 20x20 slot for scheduled, companion note, and side-chat sessions', () => {
    const scheduledHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'codex', source: 'web', systemPrompt: '你是定时任务 sch_1 的执行会话' },
      showAgentIcon: true,
    }));
    expect(scheduledHtml).toContain('h-5 w-5');
    expect(scheduledHtml).toContain('src="/agent-icons/codex.svg"');
    expect(scheduledHtml).toContain('ui-session-badge-cutout');
    expect(scheduledHtml).toContain('data-session-badge="scheduled"');
    expect(scheduledHtml).toContain('stroke-width="2.4"');
    expect(scheduledHtml).toContain('aria-label="定时任务会话"');
    expect(scheduledHtml).not.toContain('gap-1');
    expect(scheduledHtml).not.toContain('data-active="true"');

    const noteHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'antigravity', source: 'side-chat', sourceId: 'sess_main' },
      noteOf: '小A同学',
      showAgentIcon: true,
      active: true,
    }));
    expect(noteHtml).toContain('h-5 w-5');
    expect(noteHtml).toContain('src="/agent-icons/antigravity.svg"');
    expect(noteHtml).toContain('ui-session-badge-cutout');
    expect(noteHtml).toContain('data-session-badge="note"');
    expect(noteHtml).toContain('data-active="true"');
    expect(noteHtml).toContain('text-amber-600');
    expect(noteHtml).not.toContain('text-amber-600/80');
    expect(noteHtml).toContain('aria-label="小A同学派出的便签"');

    const sideChatHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'gemini', source: 'side-chat', sourceId: 'sess_parent' },
      showAgentIcon: true,
    }));
    expect(sideChatHtml).toContain('h-5 w-5');
    expect(sideChatHtml).toContain('src="/agent-icons/gemini.svg"');
    expect(sideChatHtml).toContain('data-session-badge="side-chat"');
    expect(sideChatHtml).toContain('aria-label="侧边会话"');
  });

  it('centers standalone kind icons when showAgentIcon is false and omits normal rows', () => {
    const normalHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'claude', source: 'web' },
      showAgentIcon: false,
    }));
    expect(normalHtml).toBe('');

    const noteHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'claude', source: 'side-chat', sourceId: 'sess_main' },
      noteOf: '小A同学',
      showAgentIcon: false,
    }));
    expect(noteHtml).not.toContain('/agent-icons/');
    expect(noteHtml).not.toContain('ui-session-badge-cutout');
    expect(noteHtml).toContain('h-5 w-5');
    expect(noteHtml).toContain('width="13"');
    expect(noteHtml).toContain('text-amber-600');
    expect(noteHtml).not.toContain('text-amber-600/80');
    expect(noteHtml).toContain('aria-label="小A同学派出的便签"');

    const sideChatHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'claude', source: 'side-chat', sourceId: 'sess_parent' },
      showAgentIcon: false,
    }));
    expect(sideChatHtml).not.toContain('/agent-icons/');
    expect(sideChatHtml).not.toContain('ui-session-badge-cutout');
    expect(sideChatHtml).toContain('aria-label="侧边会话"');
  });

  it('defines light/dark cutout styling synced to rail/hover/active states in index.css', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.css'), 'utf8');
    expect(css).toContain('.ui-session-badge-cutout');
    expect(css).toContain('.group:hover .ui-session-badge-cutout');
    expect(css).toContain('.ui-session-badge-cutout[data-active="true"]');
    expect(css).toContain('html[data-theme="dark"] .text-amber-500, html[data-theme="dark"] .text-amber-600');
  });
});
