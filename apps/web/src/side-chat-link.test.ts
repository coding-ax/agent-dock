import { describe, expect, it } from 'vitest';
import { groupSideChats, sideChatParentId, sideChatSource } from './side-chat-link.js';
import type { Session } from './api.js';

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id, agentId: 'claude', state: 'idle', cwd: '/proj', runId: 'run', createdAt: '', updatedAt: '', ...overrides
});

describe('sideChatParentId', () => {
  it('只认 source === side-chat 的会话', () => {
    expect(sideChatParentId(session('a', { source: sideChatSource, sourceId: 'ses_main' }))).toBe('ses_main');
    // 普通会话没有父。
    expect(sideChatParentId(session('b'))).toBeUndefined();
    // 飞书会话共用 sourceId 这一个字段，靠 source 分流——绝不能被认成侧边会话。
    expect(sideChatParentId(session('c', { source: 'lark', sourceId: 'cli_x:oc_y:group:ou_z' }))).toBeUndefined();
  });

  it('source 对但 sourceId 空/全空白时不算有父', () => {
    expect(sideChatParentId(session('a', { source: sideChatSource }))).toBeUndefined();
    expect(sideChatParentId(session('a', { source: sideChatSource, sourceId: '   ' }))).toBeUndefined();
  });
});

describe('groupSideChats', () => {
  it('把子会话挂到列表里存在的父会话下', () => {
    const parent = session('ses_main');
    const child = session('ses_side', { source: sideChatSource, sourceId: 'ses_main' });
    const { children, nestedIds } = groupSideChats([parent, child]);
    expect(children.get('ses_main')?.map(s => s.id)).toEqual(['ses_side']);
    expect(nestedIds.has('ses_side')).toBe(true);
    expect(nestedIds.has('ses_main')).toBe(false);
  });

  it('父会话不在列表里时不挂——否则那条例会话在界面上直接消失', () => {
    const orphan = session('ses_side', { source: sideChatSource, sourceId: 'ses_gone' });
    const { children, nestedIds } = groupSideChats([orphan]);
    expect(children.size).toBe(0);
    expect(nestedIds.size).toBe(0);
  });

  it('自引用不当成有父（手改库或坏数据不能把分组搞成环）', () => {
    const self = session('ses_a', { source: sideChatSource, sourceId: 'ses_a' });
    const { nestedIds } = groupSideChats([self]);
    expect(nestedIds.size).toBe(0);
  });

  it('同一父会话可以带多个侧边会话，保持输入顺序', () => {
    const parent = session('ses_main');
    const first = session('ses_s1', { source: sideChatSource, sourceId: 'ses_main' });
    const second = session('ses_s2', { source: sideChatSource, sourceId: 'ses_main' });
    expect(groupSideChats([parent, first, second]).children.get('ses_main')?.map(s => s.id)).toEqual(['ses_s1', 'ses_s2']);
  });
});
