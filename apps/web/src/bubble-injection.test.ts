import { describe, expect, it } from 'vitest';
import { detectInjectionTags, extractBubbleInjection } from './bubble-injection';

describe('bubble injection extraction', () => {
  it('returns null when sentPrompt is missing or identical to visible prompt', () => {
    expect(extractBubbleInjection('你好', undefined)).toBeNull();
    expect(extractBubbleInjection('你好', null)).toBeNull();
    expect(extractBubbleInjection('你好', '你好')).toBeNull();
  });

  it('extracts injected prefix and identifies known AgentDock tags', () => {
    const sent = [
      '<agentdock-context>\n你的名字：小橘\n</agentdock-context>',
      '<agentdock-superagent>\n这条消息是可执行请求。\n</agentdock-superagent>',
      '帮我看一下代码'
    ].join('\n\n');
    const result = extractBubbleInjection('帮我看一下代码', sent);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('prefix');
    expect(result?.tags).toEqual(['上下文快照', '编排指令']);
    expect(result?.text).toContain('<agentdock-context>');
    expect(result?.text).not.toContain('帮我看一下代码');
    expect(result?.charCount).toBe(result?.text.length);
  });

  it('recognizes lark bot and group tool injections without duplicates', () => {
    const prefix = [
      '[AgentDock 飞书会话工具]\n...',
      '[AgentDock 机器人身份]\n...',
      '[AgentDock 预注入 Prompt]\n请简洁回答',
      '[AgentDock 飞书当前消息 · 系统上下文]\n...',
      '[AgentDock 安全策略 · 自动注入]\n...'
    ].join('\n\n');
    expect(detectInjectionTags(prefix)).toEqual([
      '飞书工具',
      '机器人身份',
      '预注入 Prompt',
      '飞书消息上下文',
      '安全策略'
    ]);
  });

  it('falls back to rewritten kind when sentPrompt does not end with visible prompt', () => {
    const result = extractBubbleInjection('飞书表情触发（THUMBSUP）：你好', '用户在飞书消息上添加了「THUMBSUP」表情');
    expect(result).toEqual({
      kind: 'rewritten',
      text: '用户在飞书消息上添加了「THUMBSUP」表情',
      tags: [],
      charCount: '用户在飞书消息上添加了「THUMBSUP」表情'.length
    });
  });
});
