import { describe, expect, it } from 'vitest';
import { buildInitialSystemPrompt } from './initial-system-prompt.js';

describe('会话初始 system prompt', () => {
  it('保留原提示词，并带上当前会话 ID 与一次性运行约束', () => {
    const result = buildInitialSystemPrompt({ id: 'ses_main', systemPrompt: 'Agent 原有提示词' });
    expect(result.startsWith('Agent 原有提示词')).toBe(true);
    expect(result).toContain('[AgentDock]');
    expect(result).toContain('ses_main');
    expect(result).toMatch(/同步等到结果/);
  });

  it('定时与会话通信只指向 CLI 入口和 -h，并拦住进程内的替代工具', () => {
    for (const session of [{ id: 'ses_main' }, { id: 'ses_side', source: 'side-chat' }]) {
      const result = buildInitialSystemPrompt(session);
      expect(result).toContain('agent-dock schedule -h');
      expect(result).toContain('agent-dock session -h');
      expect(result).toMatch(/不要用 CronCreate/);
      expect(result).toMatch(/不要用 Claude 的 ListAgents/);
    }
  });

  it('不再内嵌命令细节，控制在少量行数', () => {
    const result = buildInitialSystemPrompt({ id: 'ses_main' });
    expect(result).not.toContain('--delivery');
    expect(result).not.toContain('TARGET_ID');
    expect(result.split('\n').length).toBeLessThanOrEqual(6);
  });
});
