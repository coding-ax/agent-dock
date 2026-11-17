import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Session } from './api';
import {
  copyText,
  isContextMenuKeyboardEvent,
  placeContextMenu,
  sessionContextMenuEntries,
  sessionInfoText,
  sessionLink,
  shouldOpenSessionFromClick
} from './session-context-menu';

const session: Session = {
  id: 'ses_1',
  agentId: 'codex',
  state: 'idle',
  cwd: '/Users/me/repo',
  model: 'gpt-6',
  reasoningEffort: 'high',
  title: '修复登录页崩溃',
  runId: 'run_1',
  createdAt: '2026-11-16T15:00:00',
  updatedAt: '2026-11-16T15:40:00'
};

describe('会话链接', () => {
  it('用现有 /sessions/:id 路由拼成可直接打开的绝对 URL', () => {
    expect(sessionLink('ses_1', 'http://127.0.0.1:4399')).toBe('http://127.0.0.1:4399/sessions/ses_1');
  });

  it('会话 id 按路由规则转义', () => {
    expect(sessionLink('a b/c', 'https://dock.example')).toBe('https://dock.example/sessions/a%20b%2Fc');
  });
});

describe('会话信息文本', () => {
  it('包含标题、ID、Agent、模型、目录、状态和两个绝对时间', () => {
    expect(sessionInfoText(session, 'Codex')).toBe([
      '标题：修复登录页崩溃',
      '会话 ID：ses_1',
      'Agent：Codex',
      '模型：gpt-6 · high',
      '工作目录：/Users/me/repo',
      '状态：就绪',
      '创建时间：2026-11-16 15:00',
      '更新时间：2026-11-16 15:40'
    ].join('\n'));
  });

  it('没有模型时写「默认」，标题与 Agent 缺失也有回退', () => {
    const bare = { ...session, title: undefined, model: undefined, reasoningEffort: undefined, agentId: 'claude' };
    const text = sessionInfoText(bare);
    expect(text).toContain('标题：claude');
    expect(text).toContain('Agent：claude');
    expect(text).toContain('模型：默认');
  });
});

describe('菜单项', () => {
  it('重命名在前；复制项之后是危险色的归档，且归档最后', () => {
    const entries = sessionContextMenuEntries(session, { agentName: 'Codex', origin: 'http://127.0.0.1:4399' });
    expect(entries.map(entry => entry.kind === 'item' ? entry.label : '---')).toEqual([
      '重命名会话',
      '---',
      '复制会话链接',
      '复制会话 ID',
      '复制会话标题',
      '复制会话信息',
      '---',
      '归档会话'
    ]);
    const archive = entries.at(-1);
    expect(archive).toMatchObject({ kind: 'item', action: 'archive', danger: true });
    expect(entries.at(-2)).toEqual({ kind: 'separator' });
  });

  it('每个复制项拿到对应的值，归档项没有值', () => {
    const entries = sessionContextMenuEntries(session, { agentName: 'Codex', origin: 'http://127.0.0.1:4399' });
    const values = Object.fromEntries(entries.flatMap(entry => entry.kind === 'item' && entry.value ? [[entry.action, entry.value]] : []));
    expect(values['copy-link']).toBe('http://127.0.0.1:4399/sessions/ses_1');
    expect(values['copy-id']).toBe('ses_1');
    expect(values['copy-title']).toBe('修复登录页崩溃');
    expect(values['copy-info']).toContain('会话 ID：ses_1');
  });
});

describe('右键坐标与视口翻转', () => {
  const menu = { width: 240, height: 220 };
  const viewport = { width: 1_000, height: 800 };

  it('空间足够时从鼠标位置向右下展开', () => {
    expect(placeContextMenu({ x: 100, y: 100 }, menu, viewport)).toEqual({ left: 100, top: 100, flippedHorizontally: false, flippedVertically: false });
  });

  it('右边放不下就翻到光标左侧', () => {
    expect(placeContextMenu({ x: 900, y: 100 }, menu, viewport)).toEqual({ left: 660, top: 100, flippedHorizontally: true, flippedVertically: false });
  });

  it('下边放不下就翻到光标上方', () => {
    expect(placeContextMenu({ x: 100, y: 750 }, menu, viewport)).toEqual({ left: 100, top: 530, flippedHorizontally: false, flippedVertically: true });
  });

  it('翻过去仍越界时夹回视口内', () => {
    expect(placeContextMenu({ x: -40, y: -40 }, menu, viewport)).toEqual({ left: 8, top: 8, flippedHorizontally: false, flippedVertically: false });
    expect(placeContextMenu({ x: 990, y: 790 }, menu, viewport)).toEqual({ left: 750, top: 570, flippedHorizontally: true, flippedVertically: true });
  });
});

describe('键盘入口', () => {
  it('Shift+F10 与菜单键都算右键', () => {
    expect(isContextMenuKeyboardEvent({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isContextMenuKeyboardEvent({ key: 'ContextMenu', shiftKey: false })).toBe(true);
  });

  it('普通 F10 / Enter / 空格不算', () => {
    expect(isContextMenuKeyboardEvent({ key: 'F10', shiftKey: false })).toBe(false);
    expect(isContextMenuKeyboardEvent({ key: 'Enter', shiftKey: false })).toBe(false);
    expect(isContextMenuKeyboardEvent({ key: ' ', shiftKey: false })).toBe(false);
  });

  it('长按后的补发 click 不打开会话，过窗口后恢复正常', () => {
    expect(shouldOpenSessionFromClick(1_500, 1_200)).toBe(false);
    expect(shouldOpenSessionFromClick(1_500, 1_500)).toBe(true);
    expect(shouldOpenSessionFromClick(0, 1)).toBe(true);
  });
});

describe('复制降级', () => {
  it('Clipboard API 成功时不走 execCommand', async () => {
    const writeText = vi.fn(async () => undefined);
    const execCommand = vi.fn(() => true);
    await expect(copyText('hello', { clipboard: { writeText }, execCommand })).resolves.toEqual({ ok: true, method: 'clipboard' });
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('Clipboard API 拒绝时退回 execCommand', async () => {
    const writeText = vi.fn(async () => { throw new Error('denied'); });
    const execCommand = vi.fn(() => true);
    await expect(copyText('hello', { clipboard: { writeText }, execCommand })).resolves.toEqual({ ok: true, method: 'execCommand' });
    expect(execCommand).toHaveBeenCalledWith('hello');
  });

  it('两种方式都失败时返回可展示的手动复制提示', async () => {
    const execCommand = vi.fn(() => false);
    await expect(copyText('hello', { clipboard: null, execCommand })).resolves.toEqual({ ok: false, message: '复制失败，请手动选择文本复制' });
  });

  it('execCommand 抛错也按失败处理', async () => {
    const execCommand = vi.fn(() => { throw new Error('blocked'); });
    await expect(copyText('hello', { clipboard: null, execCommand })).resolves.toEqual({ ok: false, message: '复制失败，请手动选择文本复制' });
  });
});

describe('菜单接线', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const menuSource = readFileSync(join(here, 'SessionContextMenu.tsx'), 'utf8');
  const app = readFileSync(join(here, 'App.tsx'), 'utf8');
  const titleSource = readFileSync(join(here, 'SessionTitleEditor.tsx'), 'utf8');
  const rowSource = app.slice(app.indexOf('function SessionRow'), app.indexOf('export default function App'));

  it('菜单使用 role=menu/menuitem，并在 portal 里渲染，不会被侧栏 overflow 裁掉', () => {
    expect(menuSource).toContain('role="menu"');
    expect(menuSource).toContain('role="menuitem"');
    expect(menuSource).toContain('createPortal');
    expect(menuSource).toContain('document.body');
  });

  it('归档菜单项复用现有的 quickArchiveController.open，而不是第二套确认逻辑', () => {
    expect(app).toContain('onArchive={() => { setSessionMenu(undefined); quickArchiveController.open(session.id); }}');
    expect(app.match(/title=\{`归档「/g)).toHaveLength(1);
  });

  it('行内不再有任何操作图标；重命名/归档都从右键菜单发起', () => {
    expect(rowSource).not.toContain('SessionArchiveButton');
    expect(rowSource).not.toContain('onArchiveRequest');
    expect(rowSource).not.toContain('<button');
    expect(rowSource).toContain('<SessionTitleEditor');
    expect(rowSource).not.toContain('editButtonVisible');
    expect(rowSource).toContain('editRequest={renameRequest}');
    expect(titleSource).not.toContain('归档会话：');
    expect(titleSource).not.toContain('aria-label="重命名会话"');
    expect(titleSource).not.toContain('Sparkles');
    expect(app).toContain('onRename={() => { setSessionMenu(undefined); setRenameRequest(');
    expect(app).toContain('renameRequest={renameRequest?.sessionId === session.id ? renameRequest.nonce : undefined}');
  });

  it('右键、Shift+F10/菜单键和移动端长按都能打开同一个菜单', () => {
    expect(app).toContain('onContextMenu={event => { event.preventDefault(); openContextMenu({ x: event.clientX, y: event.clientY }); }}');
    expect(app).toContain('isContextMenuKeyboardEvent(event)');
    expect(app).toContain('onPointerDown={event => {');
    expect(app).toContain('}, 480);');
  });
});
