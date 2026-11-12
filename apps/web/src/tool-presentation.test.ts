import { describe, expect, it } from 'vitest';
import { elapsedMilliseconds, formatElapsed, groupToolActivityRows, noteCommandPresentation, summarizeTools, toolActionLabel, toolDescription, toolPresentation } from './tool-presentation';

const event = (id: string, name: string, input: unknown) => ({ id, sequence: 1, type: 'tool_result', timestamp: '2026-01-01T00:00:00.000Z', data: { id, name, input, status: 'completed' } });

describe('tool presentation', () => {
  it('classifies common tools and keeps the concrete operation as detail', () => {
    expect(toolPresentation({ name: 'tool call', input: { command: 'pwd' } })).toEqual({ kind: 'terminal', label: '运行命令', detail: 'pwd' });
    expect(toolPresentation({ name: 'Read', input: { path: 'README.md' } })).toEqual({ kind: 'read', label: '读取文件', detail: 'README.md' });
    expect(toolPresentation({ name: 'apply_patch', input: {} })).toMatchObject({ kind: 'edit', label: '编辑文件' });
    expect(toolPresentation({ name: 'Terminal', input: { command: 'agent-dock group messages --limit 20' } })).toMatchObject({ kind: 'agent', label: 'Agent 群协作' });
  });

  it('summarizes a batch without exposing lifecycle event noise', () => {
    expect(summarizeTools([
      event('one', 'Terminal', { command: 'pwd' }),
      event('two', 'Terminal', { command: 'pnpm test' }),
      event('three', 'Read', { path: 'README.md' })
    ])).toBe('运行了命令 · 运行了测试 · 读取了文件');
    expect(toolActionLabel(toolPresentation({ name: 'Terminal', input: { command: 'pwd' } }), true)).toBe('已运行命令');
  });

  it('speaks the kitten\'s note commands in plain words', () => {
    expect(toolPresentation({ name: 'Terminal', input: { command: 'agent-dock task start --title "edit README 并跑 test" --done-when "有 diff" --json' } }))
      .toEqual({ kind: 'note', label: '派出便签', detail: 'edit README 并跑 test' });
    expect(noteCommandPresentation("agent-dock task plan --title='整理发布说明'")).toEqual({ label: '写计划便签', detail: '整理发布说明' });
    expect(noteCommandPresentation('agent-dock task start atask_abc')).toEqual({ label: '便签开工', detail: 'atask_abc' });
    expect(noteCommandPresentation('agent-dock task review atask_abc --verdict accepted --check "测试=met:CI 绿"')).toEqual({ label: '验收通过', detail: 'atask_abc' });
    expect(noteCommandPresentation('agent-dock task review atask_abc --verdict rework')).toMatchObject({ label: '打回返工' });
    expect(noteCommandPresentation('agent-dock task cancel atask_abc --reason 不需要了')).toEqual({ label: '撕掉便签', detail: 'atask_abc' });
    expect(noteCommandPresentation('agent-dock task report --kind done --text "改好了" --evidence log')).toEqual({ label: '汇报完成', detail: '改好了' });
    expect(noteCommandPresentation('cd /repo && agent-dock notify "发版前需要你确认" --ask')).toEqual({ label: '请你拍板', detail: '发版前需要你确认' });
    expect(noteCommandPresentation('agent-dock watch add --name ci --command "gh run list"')).toEqual({ label: '布置盯梢', detail: 'ci' });
    expect(noteCommandPresentation('agent-dock session show ses_1')).toBeUndefined();
    expect(noteCommandPresentation('echo agent-docker task')).toBeUndefined();
    expect(toolActionLabel(toolPresentation({ name: 'Terminal', input: { command: 'agent-dock task start --title x' } }), false)).toBe('正在派出便签');
    expect(summarizeTools([event('one', 'Terminal', { command: 'agent-dock task start --title a' })])).toBe('派出便签');
  });

  it('formats tool and turn elapsed time', () => {
    expect(elapsedMilliseconds('2026-01-01T00:00:00.000Z', '2026-01-01T00:01:37.000Z')).toBe(97_000);
    expect(formatElapsed(780)).toBe('780 毫秒');
    expect(formatElapsed(97_000)).toBe('1 分 37 秒');
  });

  it('uses a tool description as the human-readable action', () => {
    expect(toolDescription({ input: { command: 'find . -type f', description: '统计各项目 specs 数量' } })).toBe('统计各项目 specs 数量');
  });

  it('collapses only consecutive tools with the same description', () => {
    const first = event('one', 'Terminal', { command: 'echo one', description: '检查项目' });
    const second = event('two', 'Terminal', { command: 'echo two', description: '检查项目' });
    const thinking = { ...event('thinking', 'thinking', {}), type: 'thinking', data: { text: '继续分析' } };
    const third = event('three', 'Terminal', { command: 'echo three', description: '检查项目' });
    const rows = groupToolActivityRows([first, second, thinking, third]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: 'batch', description: '检查项目', events: [first, second] });
    expect(rows[1]).toMatchObject({ kind: 'event', event: thinking });
    expect(rows[2]).toMatchObject({ kind: 'event', event: third });
  });
});
