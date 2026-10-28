import { describe, expect, it } from 'vitest';
import { buildPrompt, commandsFromEvents, contextStatsFromEvents, getModelReadiness, parsePromptToDraft, queuedImageThumbnailUrl, replaceSlashQuery, shouldDismissComposerPanel, slashQuery, workspaceBasename } from './composer-utils';

describe('composer references', () => {
  it('never emits a leading slash, which the CLI would read as a slash command', () => {
    const prompt = buildPrompt('检查这里', [
      { id: 'f', kind: 'file', label: 'App.tsx', value: '/repo/App.tsx' },
      { id: 's', kind: 'skill', label: 'review', value: 'review' }
    ]);
    expect(prompt).toBe('[文件] /repo/App.tsx\n\n[技能] review\n\n检查这里');
    // 以 / 开头会被 Claude Code 当成斜杠命令，回一条 Unknown command: /file 混进会话。
    expect(prompt.startsWith('/')).toBe(false);
  });

  it('writes an image reference as a path line plus the markdown image', () => {
    const prompt = buildPrompt('看图', [{ id: 'i', kind: 'image', label: 'shot.png', value: '/Users/me/.agentdock/uploads/ses1/1700-abc.png' }]);
    expect(prompt).toBe('[图片] /Users/me/.agentdock/uploads/ses1/1700-abc.png\n\n![shot.png](/Users/me/.agentdock/uploads/ses1/1700-abc.png)\n\n看图');
    expect(prompt.startsWith('/')).toBe(false);
  });

  it('writes an advertised skill as a real slash command on the first line', () => {
    // 通告过的技能就是真的斜杠命令，`/名字` 必须独占首行才能被 CLI 执行，
    // 所以它要排在其他引用块前面（引用块本身对 CLI 是惰性文本）。
    const prompt = buildPrompt('看下这个文档', [
      { id: 'f', kind: 'file', label: 'App.tsx', value: '/repo/App.tsx' },
      { id: 's', kind: 'skill', label: 'lark-doc', value: 'lark-doc' }
    ], ['lark-doc', 'compact']);
    expect(prompt).toBe('/lark-doc\n\n[文件] /repo/App.tsx\n\n看下这个文档');

    const { text, references } = parsePromptToDraft(prompt, ['lark-doc', 'compact']);
    expect(text).toBe('看下这个文档');
    // 提升会把技能挪到最前面，退回草稿时顺序跟着变，内容不丢。
    expect(references).toEqual([
      { id: 'skill-lark-doc', kind: 'skill', label: 'lark-doc', value: 'lark-doc' },
      { id: 'file-/repo/App.tsx', kind: 'file', label: 'App.tsx', value: '/repo/App.tsx' }
    ]);
  });

  it('keeps an advertised /plan first when an uploaded file is attached', () => {
    expect(buildPrompt('/plan review this', [{ id: 'f', kind: 'file', label: 'a.md', value: '/repo/a.md' }], ['plan']))
      .toBe('/plan review this\n\n[文件] /repo/a.md');
  });

  it('keeps a leading slash that the Agent never advertised as plain text', () => {
    // 用户手打的未知命令不该被当成技能 chip 退回来，否则编辑排队任务会改写他的输入。
    const { text, references } = parsePromptToDraft('/not-a-real-command\n\n读一下', ['compact']);
    expect(references).toEqual([]);
    expect(text).toBe('/not-a-real-command\n\n读一下');
  });

  it('detects and replaces the slash token at the caret', () => {
    expect(slashQuery('先看一下 /ski')).toBe('ski');
    expect(replaceSlashQuery('先看一下 /ski', '/skills ')).toBe('先看一下 /skills ');
  });

  it('derives context usage, compaction, and advertised commands from ACP status events', () => {
    const events: any[] = [
      { type: 'status', data: { state: 'usage', used: 18_000, size: 200_000 } },
      { type: 'status', data: { state: 'usage', used: 8_000, size: 200_000 } },
      { type: 'status', data: { state: 'usage', used: 11_000, size: 200_000 } },
      { type: 'status', data: { state: 'commands', availableCommands: [{ name: '/compact', description: 'Compact context' }] } }
    ];
    expect(contextStatsFromEvents(events)).toEqual({ used: 11_000, size: 200_000, compacted: 10_000, percentage: 5.5 });
    expect(commandsFromEvents(events)).toEqual([{ name: 'compact', description: 'Compact context' }]);
  });

  it('ignores zero-usage reports from proxied models instead of showing 0/200k', () => {
    // 反代模型（auto_model/seed-*）会吐 used=0 的 usage_update：不能接受，否则上下文显示 0，
    // 且此前的真实用量会被误算进「压缩」。
    expect(contextStatsFromEvents([{ type: 'status', data: { state: 'usage', used: 0, size: 200_000 } } as any])).toEqual({});
    const mixed: any[] = [
      { type: 'status', data: { state: 'usage', used: 30_000, size: 200_000 } },
      { type: 'status', data: { state: 'usage', used: 0, size: 200_000 } }
    ];
    expect(contextStatsFromEvents(mixed)).toMatchObject({ used: 30_000, compacted: 0 });
  });

  it('lets the user keep sending while the model catalog loads or fails', () => {
    // 模型列表只服务于「切换模型」下拉，发消息用会话已有的 model。
    // 探测一次要真起 ACP 会话（实测 codex 首次 9.1s），不该把输入框锁住。
    expect(getModelReadiness({ loaded: false, loading: true, switching: false, failed: false })).toMatchObject({ kind: 'loading' });
    expect(getModelReadiness({ loaded: false, loading: false, switching: false, failed: true })).toMatchObject({ kind: 'loading' });
    expect(getModelReadiness({ loaded: false, loading: false, switching: false, failed: false })).toMatchObject({ kind: 'loading' });
    expect(getModelReadiness({ loaded: true, loading: true, switching: false, failed: false })).toEqual({ kind: 'ready' });
  });

  it('only blocks sending while a model switch is in flight', () => {
    // 切换途中会话 model 处于中间态，这时发出去可能用错模型——这是唯一该拦的情况。
    expect(getModelReadiness({ loaded: true, loading: false, switching: true, failed: false })).toMatchObject({ kind: 'blocked', label: '模型切换中…' });
  });

  it('does not leave the composer stuck on 模型加载中 when a failed probe keeps retrying', () => {
    // react-query 失败后会重试，重试期间 isFetching 仍为 true，调用方算出的
    // loading 与 failed 会同时为真。旧实现在此永远返回「模型加载中」且阻塞发送，
    // 表现为输入框被无限锁死。现在无论落在哪个分支都不再是 blocked。
    const retrying = getModelReadiness({ loaded: false, loading: true, switching: false, failed: true });
    expect(retrying.kind).not.toBe('blocked');
  });

  it('dismisses an open panel only for interactions outside the popover and its triggers', () => {
    expect(shouldDismissComposerPanel({ insidePopover: true, onPanelTrigger: false })).toBe(false);
    expect(shouldDismissComposerPanel({ insidePopover: false, onPanelTrigger: true })).toBe(false);
    expect(shouldDismissComposerPanel({ insidePopover: false, onPanelTrigger: false })).toBe(true);
  });

  it('parses a queued prompt back into body text and reference chips for editing', () => {
    const prompt = buildPrompt('帮我看看这张图', [
      { id: 'i', kind: 'image', label: 'screenshot.png', value: '/Users/me/.agentdock/uploads/ses1/1700-abc.png' },
      { id: 'f', kind: 'file', label: 'App.tsx', value: '/repo/App.tsx' },
      { id: 's', kind: 'skill', label: 'review', value: 'review' }
    ]);
    const { text, references } = parsePromptToDraft(prompt);
    expect(text).toBe('帮我看看这张图');
    expect(references).toEqual([
      { id: 'image-/Users/me/.agentdock/uploads/ses1/1700-abc.png', kind: 'image', label: 'screenshot.png', value: '/Users/me/.agentdock/uploads/ses1/1700-abc.png' },
      { id: 'file-/repo/App.tsx', kind: 'file', label: 'App.tsx', value: '/repo/App.tsx' },
      { id: 'skill-review', kind: 'skill', label: 'review', value: 'review' }
    ]);
  });

  it('treats a file line not followed by an image block as a file reference', () => {
    const { text, references } = parsePromptToDraft('[文件] /repo/App.tsx\n\n读一下');
    expect(text).toBe('读一下');
    expect(references).toEqual([{ id: 'file-/repo/App.tsx', kind: 'file', label: 'App.tsx', value: '/repo/App.tsx' }]);
  });

  it('still parses the legacy /file and /skills prefixes stored in queued tasks', () => {
    const { text, references } = parsePromptToDraft('/file /repo/App.tsx\n\n/skills review\n\n读一下');
    expect(text).toBe('读一下');
    expect(references).toEqual([
      { id: 'file-/repo/App.tsx', kind: 'file', label: 'App.tsx', value: '/repo/App.tsx' },
      { id: 'skill-review', kind: 'skill', label: 'review', value: 'review' }
    ]);
  });

  it('keeps body content that merely looks like reference syntax as plain text', () => {
    // 正文一旦开始，后续 [文件]、![]() 等都是用户写的内容，不再解析为引用。
    const { text, references } = parsePromptToDraft('先读这个：\n\n[文件] /repo/secret.ts\n\n![不是引用](x.png)');
    expect(references).toEqual([]);
    expect(text).toBe('先读这个：\n\n[文件] /repo/secret.ts\n\n![不是引用](x.png)');
  });
});

describe('queuedImageThumbnailUrl', () => {
  it('把上传路径还原成带 /uploads/ 段的接口 URL', () => {
    expect(queuedImageThumbnailUrl('/Users/x/.agentdock/uploads/ses_abc/shot.png'))
      .toBe('/api/sessions/ses_abc/uploads/shot.png');
  });
  it('支持多级文件名（子目录）', () => {
    expect(queuedImageThumbnailUrl('/data/uploads/ses_1/sub/dir/img.jpg'))
      .toBe('/api/sessions/ses_1/uploads/sub/dir/img.jpg');
  });
  it('缺少 /uploads/ 或只有一段时返回 undefined，回退到原引用', () => {
    expect(queuedImageThumbnailUrl('/tmp/agentdock/shot.png')).toBeUndefined();
    expect(queuedImageThumbnailUrl('/tmp/uploads/ses_abc')).toBeUndefined();
    expect(queuedImageThumbnailUrl('/tmp/uploads//file.png')).toBeUndefined();
  });
});

describe('workspaceBasename', () => {
  it('只取最后一段，chip 上不展示长路径', () => {
    expect(workspaceBasename('/Users/me/Desktop/code/agent-dock')).toBe('agent-dock');
    expect(workspaceBasename('/Users/me/')).toBe('me');
  });

  it('空串与根路径原样返回，不产生越界', () => {
    expect(workspaceBasename('')).toBe('');
    expect(workspaceBasename('/')).toBe('/');
  });
});
