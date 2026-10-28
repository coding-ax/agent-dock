import { describe, expect, it } from 'vitest';
import { buildSideSessionSeed } from './side-session';

describe('buildSideSessionSeed', () => {
  const seed = buildSideSessionSeed('ses_abc');

  it('指向主会话与只读 CLI，而不是内嵌历史', () => {
    expect(seed).toContain('agent-dock session show ses_abc');
    expect(seed).toContain('独立会话');
  });

  it('不冒充 fork，通信细节指向 session -h 而不是内嵌', () => {
    expect(seed).toContain('历史和任务队列不共享');
    expect(seed).toContain('agent-dock session -h');
    expect(seed).not.toContain('session cancel');
  });

  it('按给模型的指令来写，不冒充用户说的话', () => {
    // 这段文本走 systemPrompt，读它的不是用户而是模型，所以不能有「你会看到…」之类的对话口吻。
    expect(seed).toMatch(/^你是一个侧边会话/);
    expect(seed).toContain('不要假设自己已经知道主会话的内容');
    // 早先它是当用户消息发的，开头是「【侧边会话】你是从主会话延续出的…」这种第三人称旁白。
    expect(seed).not.toContain('【侧边会话】');
    expect(seed).not.toContain('你是从主会话延续出的');
  });

  it('同一 id 稳定（可重复用于同一主会话）', () => {
    expect(buildSideSessionSeed('ses_abc')).toBe(seed);
    expect(buildSideSessionSeed('ses_xyz')).not.toBe(seed);
  });
});
