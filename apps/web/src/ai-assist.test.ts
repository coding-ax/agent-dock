import { describe, expect, it } from 'vitest';
import { buildPreInjectAssistPrompt, summarizePreInjectDraft } from './ai-assist';

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

  it('limits long drafts without losing their beginning and ending', () => {
    const draft = `开头-${'很长的草稿'.repeat(300)}-结尾`;
    const summary = summarizePreInjectDraft(draft);
    expect(summary.length).toBeLessThanOrEqual(1_240);
    expect(summary).toContain('开头-');
    expect(summary).toContain('-结尾');
    expect(summary).toContain('草稿中间省略');
    expect(buildPreInjectAssistPrompt('机器人名称：巡检助手', draft)).toContain(summary);
  });
});
