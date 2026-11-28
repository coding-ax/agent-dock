import { beforeEach, describe, expect, it } from 'vitest';
import { closeAppDialog, getActiveAppDialog, openAppDialog } from './dialog-store';

describe('dialog-store', () => {
  beforeEach(() => closeAppDialog());

  it('打开后记录类型与可选的会话 id', () => {
    openAppDialog('schedule', { sessionId: 'ses_1' });
    expect(getActiveAppDialog()).toEqual({ kind: 'schedule', sessionId: 'ses_1' });
  });

  it('从全局入口打开时没有 sessionId，设置中心可携带目标分类与子 Tab', () => {
    openAppDialog('agent');
    expect(getActiveAppDialog()).toEqual({ kind: 'agent' });
    openAppDialog('output-plugins');
    expect(getActiveAppDialog()).toEqual({ kind: 'output-plugins' });
    openAppDialog('settings', { settingsCategory: 'lark', settingsSubTab: 'regex' });
    expect(getActiveAppDialog()).toEqual({ kind: 'settings', settingsCategory: 'lark', settingsSubTab: 'regex' });
  });

  it('会话级交互插件弹窗独立携带 sessionId，与全局交互插件中心隔离', () => {
    openAppDialog('session-output-plugins', { sessionId: 'ses_a' });
    expect(getActiveAppDialog()).toEqual({ kind: 'session-output-plugins', sessionId: 'ses_a' });
    openAppDialog('session-output-plugins', { sessionId: 'ses_b' });
    expect(getActiveAppDialog()).toEqual({ kind: 'session-output-plugins', sessionId: 'ses_b' });
  });

  it('重复打开同一个弹窗不换引用，避免订阅者做无意义重渲染', () => {
    openAppDialog('search');
    const first = getActiveAppDialog();
    openAppDialog('search');
    expect(getActiveAppDialog()).toBe(first);
  });

  it('同一个弹窗换到另一个会话时更新状态', () => {
    openAppDialog('schedule', { sessionId: 'ses_1' });
    openAppDialog('schedule', { sessionId: 'ses_2' });
    expect(getActiveAppDialog()).toEqual({ kind: 'schedule', sessionId: 'ses_2' });
  });

  it('关闭后清空；重复关闭是 no-op', () => {
    openAppDialog('import');
    closeAppDialog();
    expect(getActiveAppDialog()).toBeNull();
    closeAppDialog();
    expect(getActiveAppDialog()).toBeNull();
  });
});
