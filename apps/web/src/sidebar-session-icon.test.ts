import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
  it('renders a 14px AgentIcon for normal sessions in time view without native title', () => {
    const claudeHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'claude', source: 'web' },
      agent: { id: 'claude', name: 'Claude Code' },
      showAgentIcon: true,
    }));
    expect(claudeHtml).toContain('src="/agent-icons/claudecode.svg"');
    expect(claudeHtml).toContain('width="14"');
    expect(claudeHtml).toContain('height="14"');
    expect(claudeHtml).toContain('shrink-0');
    expect(claudeHtml).not.toContain('title=');

    const agyHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'antigravity', source: 'web' },
      agent: { id: 'antigravity', name: 'Antigravity' },
      showAgentIcon: true,
    }));
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
    expect(unknownHtml).toContain('shrink-0');
  });

  it('pairs AgentIcon with kind icon for scheduled, companion note, and side-chat sessions', () => {
    const scheduledHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'codex', source: 'web', systemPrompt: '你是定时任务 sch_1 的执行会话' },
      showAgentIcon: true,
    }));
    expect(scheduledHtml).toContain('src="/agent-icons/codex.svg"');
    expect(scheduledHtml).toContain('aria-label="定时任务会话"');

    const noteHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'antigravity', source: 'side-chat', sourceId: 'sess_main' },
      noteOf: '小A同学',
      showAgentIcon: true,
    }));
    expect(noteHtml).toContain('src="/agent-icons/antigravity.svg"');
    expect(noteHtml).toContain('aria-label="小A同学派出的便签"');

    const sideChatHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'gemini', source: 'side-chat', sourceId: 'sess_parent' },
      showAgentIcon: true,
    }));
    expect(sideChatHtml).toContain('src="/agent-icons/gemini.svg"');
    expect(sideChatHtml).toContain('aria-label="侧边会话"');
  });

  it('omits AgentIcon when showAgentIcon is false while preserving kind icon', () => {
    const normalHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'claude', source: 'web' },
      showAgentIcon: false,
    }));
    expect(normalHtml).toBe('');

    const sideChatHtml = renderToStaticMarkup(createElement(SessionRowLeadingIcons, {
      session: { agentId: 'claude', source: 'side-chat', sourceId: 'sess_parent' },
      showAgentIcon: false,
    }));
    expect(sideChatHtml).not.toContain('/agent-icons/');
    expect(sideChatHtml).toContain('aria-label="侧边会话"');
  });
});
