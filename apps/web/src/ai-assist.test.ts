import { describe, expect, it } from 'vitest';
import { buildPreInjectAssistPrompt } from './ai-assist';

describe('buildPreInjectAssistPrompt', () => {
  it('includes the bot context and current draft, and asks for prompt-only output', () => {
    const prompt = buildPreInjectAssistPrompt('机器人名称：巡检助手\nAgent：Claude', '回复尽量简短');
    expect(prompt).toContain('飞书机器人');
    expect(prompt).toContain('机器人名称：巡检助手');
    expect(prompt).toContain('回复尽量简短');
    expect(prompt).toContain('只输出提示词正文');
    expect(prompt).toContain('不要编造权限');
  });

  it('marks missing context and empty drafts explicitly', () => {
    const prompt = buildPreInjectAssistPrompt('', '');
    expect(prompt).toContain('（未提供）');
    expect(prompt).toContain('（空）');
  });
});
