import { describe, expect, it } from 'vitest';
import { lineDiff, toolDetailView } from './tool-detail';

describe('toolDetailView', () => {
  it('command：命令、退出码与输出', () => {
    const view = toolDetailView({
      name: 'Bash',
      input: { command: 'pnpm test', cwd: '/repo' },
      output: { formatted_output: 'ok', exit_code: 0 }
    });
    expect(view).toEqual({ kind: 'command', command: 'pnpm test', exitCode: 0, output: 'ok' });
  });

  it('diff：优先用 patch，并区分增删与上下文', () => {
    const view = toolDetailView({
      name: 'apply_patch',
      input: { patch: '--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n context\n-old\n+new' }
    });
    expect(view.kind).toBe('diff');
    if (view.kind !== 'diff') return;
    expect(view.lines).toEqual([
      { kind: 'meta', text: '--- a/x.ts' },
      { kind: 'meta', text: '+++ b/x.ts' },
      { kind: 'meta', text: '@@ -1,2 +1,2 @@' },
      { kind: 'context', text: 'context' },
      { kind: 'remove', text: 'old' },
      { kind: 'add', text: 'new' }
    ]);
  });

  it('diff：没有 patch 时用 old/new 文本生成差异', () => {
    const view = toolDetailView({
      name: 'Edit',
      input: { file_path: '/repo/src/x.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc' }
    });
    expect(view).toEqual({
      kind: 'diff',
      path: '/repo/src/x.ts',
      lines: [
        { kind: 'context', text: 'a' },
        { kind: 'remove', text: 'b' },
        { kind: 'add', text: 'B' },
        { kind: 'context', text: 'c' }
      ]
    });
  });

  it('paths：读取文件展示路径与输出', () => {
    const view = toolDetailView({ name: 'Read', input: { file_path: '/repo/package.json' }, output: '{"name":"x"}' });
    expect(view).toEqual({ kind: 'paths', mode: 'read', items: ['/repo/package.json'], output: '{"name":"x"}' });
  });

  it('paths：搜索展示关键词', () => {
    const view = toolDetailView({ name: 'Grep', input: { pattern: 'TODO', path: 'src' } });
    expect(view).toEqual({ kind: 'paths', mode: 'search', items: ['src', 'TODO'] });
  });

  it('json：其他工具回退成结构化数据', () => {
    const view = toolDetailView({ name: 'mcp__something', input: { foo: 1 }, output: { bar: 2 } });
    expect(view).toEqual({ kind: 'json', input: { foo: 1 }, output: { bar: 2 } });
  });

  it('lineDiff 只标出中间变化段', () => {
    expect(lineDiff('a\nb\nc\nd', 'a\nc\nd')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'context', text: 'c' },
      { kind: 'context', text: 'd' }
    ]);
  });
});
