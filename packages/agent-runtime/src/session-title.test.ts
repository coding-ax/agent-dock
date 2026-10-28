import { describe, expect, it } from 'vitest';
import { SESSION_TITLE_MAX_CHARS, normalizeSessionTitle, resolveSessionTitle, summarizeSessionTitle } from './session-title.js';

describe('summarizeSessionTitle', () => {
  it('null/undefined/纯空白 → 空串', () => {
    expect(summarizeSessionTitle(undefined)).toBe('');
    expect(summarizeSessionTitle(null)).toBe('');
    expect(summarizeSessionTitle('   \n\t ')).toBe('');
  });

  it('折叠换行与连续空白为单空格', () => {
    expect(summarizeSessionTitle('帮我\n爬   85\t个群')).toBe('帮我 爬 85 个群');
  });

  it('短文本原样返回并去首尾空白', () => {
    expect(summarizeSessionTitle('  修一下闪屏  ')).toBe('修一下闪屏');
  });

  it('超长截断并加省略号', () => {
    const out = summarizeSessionTitle('a'.repeat(200));
    expect(out).toHaveLength(SESSION_TITLE_MAX_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('支持自定义上限', () => {
    expect(summarizeSessionTitle('abcdef', 3)).toBe('abc…');
  });
});

describe('normalizeSessionTitle', () => {
  it('接受一个已经是标题的字符串，同样折叠空白并截断', () => {
    expect(normalizeSessionTitle('  修一下  闪屏 ')).toBe('修一下 闪屏');
    expect(normalizeSessionTitle('a'.repeat(200))).toHaveLength(SESSION_TITLE_MAX_CHARS + 1);
  });

  // Agent 侧没有统一的长度约定（Claude 限 256、Codex 不限），落库前必须自己收口。
  it('全空白视为没有标题', () => {
    expect(normalizeSessionTitle('   ')).toBe('');
    expect(normalizeSessionTitle(null)).toBe('');
  });
});

describe('resolveSessionTitle', () => {
  it('三级优先级：用户 > Agent > 首条 prompt', () => {
    expect(resolveSessionTitle({ customTitle: '我起的', agentTitle: 'Agent 起的', firstPrompt: '原问题' })).toEqual({ title: '我起的', source: 'user' });
    expect(resolveSessionTitle({ agentTitle: 'Agent 起的', firstPrompt: '原问题' })).toEqual({ title: 'Agent 起的', source: 'agent' });
    expect(resolveSessionTitle({ firstPrompt: '原问题' })).toEqual({ title: '原问题', source: 'prompt' });
  });

  // 清空自定义名 = 恢复自动，靠的就是「空串不算数」这条。
  it('空白字符串的 custom/agent 不算数，继续往下回落', () => {
    expect(resolveSessionTitle({ customTitle: '  ', agentTitle: '\n', firstPrompt: '原问题' })).toEqual({ title: '原问题', source: 'prompt' });
  });

  it('三级都空时返回 undefined（调用方据此不加字段，而不是加一个空串）', () => {
    expect(resolveSessionTitle({})).toBeUndefined();
    expect(resolveSessionTitle({ customTitle: null, agentTitle: null, firstPrompt: '' })).toBeUndefined();
  });

  it('Agent 标题也走截断，不会把侧栏撑坏', () => {
    const resolved = resolveSessionTitle({ agentTitle: 'b'.repeat(300) });
    expect(resolved?.source).toBe('agent');
    expect(resolved?.title).toHaveLength(SESSION_TITLE_MAX_CHARS + 1);
  });
});
