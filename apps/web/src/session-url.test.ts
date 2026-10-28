import { describe, expect, it } from 'vitest';
import { parseRightParam, sessionUrl } from './session-url.js';
import type { PaneTab } from './store.js';

const tab = (partial: Partial<PaneTab> & Pick<PaneTab, 'kind'>): PaneTab => ({ id: 'x', ...partial });

describe('sessionUrl', () => {
  it('没有主会话时是根路径（右栏标签无处可挂）', () => {
    expect(sessionUrl()).toBe('/');
    expect(sessionUrl(undefined, tab({ kind: 'terminal' }))).toBe('/');
  });

  it('没有右栏标签时是干净的主会话路径', () => {
    expect(sessionUrl('ses_main')).toBe('/sessions/ses_main');
  });

  it('会话标签写成 ?pane=——与改造前的格式一致', () => {
    // 旧链接的格式必须保持，否则分享出去的链接会失效。
    expect(sessionUrl('ses_main', tab({ kind: 'session', sessionId: 'ses_side' }))).toBe('/sessions/ses_main?pane=ses_side');
  });

  it('侧边聊天也是会话，同样写 ?pane=', () => {
    expect(sessionUrl('ses_main', tab({ kind: 'side-chat', sessionId: 'ses_sc' }))).toBe('/sessions/ses_main?pane=ses_sc');
  });

  it('右栏就是主会话时不写参数', () => {
    expect(sessionUrl('ses_main', tab({ kind: 'session', sessionId: 'ses_main' }))).toBe('/sessions/ses_main');
  });

  it('终端 / 文件 / 原始日志写 ?right=，不带 id（它们锚定主会话）', () => {
    expect(sessionUrl('ses_main', tab({ kind: 'terminal', anchorSessionId: 'ses_main' }))).toBe('/sessions/ses_main?right=terminal');
    expect(sessionUrl('ses_main', tab({ kind: 'files', anchorSessionId: 'ses_main' }))).toBe('/sessions/ses_main?right=files');
    expect(sessionUrl('ses_main', tab({ kind: 'raw', anchorSessionId: 'ses_main' }))).toBe('/sessions/ses_main?right=raw');
  });

  it('会话 id 会被转义', () => {
    expect(sessionUrl('a b', tab({ kind: 'session', sessionId: 'c/d' }))).toBe('/sessions/a%20b?pane=c%2Fd');
  });
});

describe('parseRightParam', () => {
  it('认出改造前的 ?pane= 旧链接', () => {
    expect(parseRightParam('?pane=ses_side', 'ses_main')).toEqual({ kind: 'session', sessionId: 'ses_side' });
  });

  it('?pane= 指向主会话本身时忽略（右栏不重复显示主会话）', () => {
    expect(parseRightParam('?pane=ses_main', 'ses_main')).toBeUndefined();
  });

  it('认出 ?right=terminal / files / raw', () => {
    expect(parseRightParam('?right=terminal', 'ses_main')).toEqual({ kind: 'terminal' });
    expect(parseRightParam('?right=files', 'ses_main')).toEqual({ kind: 'files' });
    expect(parseRightParam('?right=raw', 'ses_main')).toEqual({ kind: 'raw' });
  });

  it('认不出的 right 值忽略，不猜', () => {
    expect(parseRightParam('?right=browser', 'ses_main')).toBeUndefined();
    expect(parseRightParam('', 'ses_main')).toBeUndefined();
  });

  it('往返一致：终端/文件/原始日志与会话各自回到同类', () => {
    // 注意 side-chat 不在这一组：它在 URL 里就是「一个会话」，刷新后回来的是会话标签。
    // 这不是 bug——侧边聊天本来就是一个普通会话（种子已经进了它的 systemPrompt），
    // 标签上少了「侧边聊天」这个叫法不影响任何行为，所以 URL 不为它单独编一种形态。
    for (const item of [tab({ kind: 'session', sessionId: 'ses_side' }), tab({ kind: 'terminal' }), tab({ kind: 'files' }), tab({ kind: 'raw' })]) {
      const url = sessionUrl('ses_main', item);
      const parsed = parseRightParam(url.slice(url.indexOf('?')), 'ses_main');
      expect(parsed).toBeDefined();
      if (item.kind === 'terminal' || item.kind === 'files' || item.kind === 'raw') expect(parsed!.kind).toBe(item.kind);
      else expect(parsed).toEqual({ kind: 'session', sessionId: item.sessionId });
    }
  });

  it('侧边聊天的链接刷新后回来是一个普通会话标签（行为等价）', () => {
    const url = sessionUrl('ses_main', tab({ kind: 'side-chat', sessionId: 'ses_sc' }));
    expect(parseRightParam(url.slice(url.indexOf('?')), 'ses_main')).toEqual({ kind: 'session', sessionId: 'ses_sc' });
  });
});
