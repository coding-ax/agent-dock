import { describe, expect, it } from 'vitest';
import { agentToDraft, canSave, draftToPayload, nameToId, newAgentDraft, uniqueAgentId, validateDraft } from './agent-config-form.js';

describe('agentToDraft / newAgentDraft', () => {
  it('空模板三项都为空', () => {
    expect(newAgentDraft()).toEqual({ name: '', command: '', cwd: '' });
  });

  it('只回填仍然可编辑的三个字段', () => {
    const draft = agentToDraft({ id: 'x', name: 'X', command: '/bin/x', cwd: '/tmp/work', args: ['-v'], protocol: 'acp', env: { A: '1' }, permissionMode: 'full-trust', timeout: 42, capabilities: { pause: true, resume: false }, builtin: true, extraModels: ['m1'] });
    expect(draft).toEqual({ name: 'X', command: '/bin/x', cwd: '/tmp/work' });
  });
});

describe('nameToId', () => {
  it('转小写、把非字母数字压成连字符、去掉首尾连字符', () => {
    expect(nameToId('DeepSeek Harness')).toBe('deepseek-harness');
    expect(nameToId('  My  Bot__1  ')).toBe('my-bot-1');
    expect(nameToId('Claude Code (v2)')).toBe('claude-code-v2');
  });

  it('压不出合法 id 的名称返回空串，交给调用方兜底', () => {
    // 纯中文名压完是空串——不能拿它当 id，否则 idPattern 通不过。
    expect(nameToId('深度求索')).toBe('');
    expect(nameToId('---')).toBe('');
    expect(nameToId('')).toBe('');
  });

  it('派生结果一定满足 idPattern（有字符时）', () => {
    for (const name of ['A', 'a b', '9x', 'x-9', 'UPPER_case-Mix']) {
      const id = nameToId(name);
      if (id) expect(id).toMatch(/^[a-z0-9][a-z0-9-_]*$/);
    }
  });
});

describe('uniqueAgentId', () => {
  it('不冲突时直接用派生 id', () => {
    expect(uniqueAgentId('DeepSeek Harness', ['codex', 'claude'])).toBe('deepseek-harness');
  });

  it('冲突时依次加后缀，不静默顶掉同名的另一个 Agent', () => {
    expect(uniqueAgentId('DeepSeek Harness', ['deepseek-harness'])).toBe('deepseek-harness-2');
    expect(uniqueAgentId('DeepSeek Harness', ['deepseek-harness', 'deepseek-harness-2'])).toBe('deepseek-harness-3');
  });

  it('名称压不出 id 时兜底成 agent / agent-2', () => {
    expect(uniqueAgentId('深度求索', [])).toBe('agent');
    expect(uniqueAgentId('深度求索', ['agent'])).toBe('agent-2');
  });
});

describe('validateDraft', () => {
  it('名称与启动命令齐了就能存，工作目录可以留空', () => {
    const draft = { name: 'B', command: 'bot', cwd: '' };
    expect(validateDraft(draft)).toEqual([]);
    expect(canSave(draft)).toBe(true);
  });

  it('拒绝空名称与空启动命令', () => {
    const fields = validateDraft({ name: '   ', command: '', cwd: '' }).map(error => error.field);
    expect(fields).toEqual(['name', 'command']);
    expect(canSave({ name: '', command: 'bot', cwd: '' })).toBe(false);
  });
});

describe('draftToPayload', () => {
  it('只下发三个字段，工作目录留空时省略该键', () => {
    const payload = draftToPayload({ name: ' B ', command: ' /bin/b ', cwd: '   ' }) as any;
    expect(payload).toEqual({ name: 'B', command: '/bin/b' });
    // 空串不能写成一个真实的空路径——省略即「跟随会话 cwd」。
    expect('cwd' in payload).toBe(false);
  });

  it('工作目录有值时下发（去空白）', () => {
    expect(draftToPayload({ name: 'B', command: 'b', cwd: ' /tmp/w ' })).toEqual({ name: 'B', command: 'b', cwd: '/tmp/w' });
  });

  it('不再下发已从表单移除的字段', () => {
    const payload = draftToPayload({ name: 'B', command: 'b', cwd: '' }) as any;
    // 这些字段现在一律走服务端 schema 的默认值。
    for (const key of ['args', 'protocol', 'env', 'systemPrompt', 'timeout', 'permissionMode', 'extraModels', 'model', 'reasoningEffort', 'capabilities']) {
      expect(key in payload).toBe(false);
    }
  });
});
