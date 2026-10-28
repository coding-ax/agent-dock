import { describe, expect, it } from 'vitest';
import { sessionPaneTab } from './pane-tab.js';
import { parseRightParam, sessionUrl } from './session-url.js';

describe('sessionPaneTab', () => {
  it('产出会话类标签，id 格式固定', () => {
    expect(sessionPaneTab('ses_main', 'ses_side', '侧边')).toEqual({ id: 'session:ses_main:ses_side', kind: 'session', sessionId: 'ses_side', title: '侧边' });
  });

  it('标题可缺省', () => {
    expect(sessionPaneTab('ses_main', 'ses_side').title).toBeUndefined();
  });

  // 最关键的一条：拖拽入口与 URL 还原必须产出同一个 id，否则 openTab 去重失效、会开出两个标签。
  it('与 URL 还原出的标签是同一个 id', () => {
    const tab = sessionPaneTab('ses_main', 'ses_side', '会话名');
    // URL 还原侧（App.tsx）用同一格式合成 id，这里用往返把它钉死。
    expect(sessionUrl('ses_main', tab)).toBe('/sessions/ses_main?pane=ses_side');
    const restored = parseRightParam('?pane=ses_side', 'ses_main');
    expect(`session:${'ses_main'}:${restored!.sessionId}`).toBe(tab.id);
  });
});
