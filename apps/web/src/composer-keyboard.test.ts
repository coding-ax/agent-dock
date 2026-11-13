import { describe, expect, it } from 'vitest';
import { composerKeyAction, createCompositionGuard, IME_ENTER_GUARD_MS, type ComposerKeyboardEvent } from './composer-keyboard';

function harness() {
  let now = 1_000;
  let sent = 0;
  const guard = createCompositionGuard(() => now);
  const run = (event: ComposerKeyboardEvent, canSend = true) => composerKeyAction(event, {
    guard,
    panelOpen: false,
    commandPanel: false,
    hasCommand: false,
    hasSkill: false,
    canSend
  });
  const press = (event: ComposerKeyboardEvent) => {
    const action = run(event);
    if (action.type === 'send') sent++;
    return action;
  };
  return {
    guard,
    press,
    run,
    get sent() { return sent; },
    advance(ms: number) { now += ms; },
    at() { return now; }
  };
}

describe('composerKeyAction 输入法组合态', () => {
  it('区分「组合中」与「compositionend 后补发」：前者交给输入法，后者吞掉默认行为', () => {
    const h = harness();
    h.guard.start();
    expect(h.guard.classify({ key: 'Enter', isComposing: true })).toBe('composing');
    h.guard.end(h.at());
    h.advance(5);
    expect(h.guard.awaitingImeEnter).toBe(true);
    expect(h.guard.classify({ key: 'Enter' })).toBe('composition-enter');
    expect(h.guard.awaitingImeEnter).toBe(false);
  });

  it('组合中按 Enter（isComposing）不发送', () => {
    const h = harness();
    h.guard.start();
    expect(h.press({ key: 'Enter', isComposing: true })).toEqual({ type: 'ignore' });
    expect(h.sent).toBe(0);
  });

  it('组合中按 Enter（仅 keyCode 229）不发送', () => {
    const h = harness();
    h.guard.start();
    expect(h.press({ key: 'Enter', keyCode: 229 })).toEqual({ type: 'ignore' });
    expect(h.sent).toBe(0);
  });

  it('compositionend 后补发的 Enter（isComposing=false）不发送', () => {
    const h = harness();
    h.guard.start();
    h.guard.end(h.at());
    h.advance(5);
    // Safari 的时序：compositionend 先到，keydown 后到且 isComposing 已为 false。
    expect(h.press({ key: 'Enter', isComposing: false })).toEqual({ type: 'ignore' });
    expect(h.sent).toBe(0);
  });

  it('补发的那次只吞一次，紧接着再按 Enter 正常发送', () => {
    const h = harness();
    h.guard.start();
    h.guard.end(h.at());
    h.advance(5);
    expect(h.press({ key: 'Enter' })).toEqual({ type: 'ignore' });
    h.advance(5);
    expect(h.press({ key: 'Enter' })).toEqual({ type: 'send' });
    expect(h.sent).toBe(1);
  });

  it('compositionend 后正常按 Enter（超出保护窗口）发送', () => {
    const h = harness();
    h.guard.start();
    h.guard.end(h.at());
    h.advance(IME_ENTER_GUARD_MS + 1);
    expect(h.press({ key: 'Enter' })).toEqual({ type: 'send' });
    expect(h.sent).toBe(1);
  });

  it('compositionend 后先按了别的键，再按 Enter 不会被误吞', () => {
    const h = harness();
    h.guard.start();
    h.guard.end(h.at());
    h.advance(1);
    expect(h.press({ key: 'a' })).toEqual({ type: 'pass' });
    h.advance(1);
    expect(h.press({ key: 'Enter' })).toEqual({ type: 'send' });
    expect(h.sent).toBe(1);
  });

  it('Shift+Enter 始终换行、不发送', () => {
    const h = harness();
    expect(h.press({ key: 'Enter', shiftKey: true })).toEqual({ type: 'newline' });
    h.guard.start();
    expect(h.press({ key: 'Enter', shiftKey: true, isComposing: true })).toEqual({ type: 'ignore' });
    expect(h.sent).toBe(0);
  });

  it('不能发送时 Enter 被吞掉，不发送也不换行', () => {
    const h = harness();
    expect(h.run({ key: 'Enter' }, false)).toEqual({ type: 'handled' });
    expect(h.sent).toBe(0);
  });
});

describe('composerKeyAction 面板与普通按键', () => {
  it('命令面板打开时 Enter 选择第一项', () => {
    const guard = createCompositionGuard();
    const options = { guard, panelOpen: true, commandPanel: true, hasCommand: true, hasSkill: true, canSend: true };
    expect(composerKeyAction({ key: 'Enter' }, options)).toEqual({ type: 'choose-command' });
    expect(composerKeyAction({ key: 'Enter', metaKey: true }, options)).toEqual({ type: 'send' });
  });

  it('Escape 关闭面板，其他按键原样放行', () => {
    const guard = createCompositionGuard();
    const options = { guard, panelOpen: true, commandPanel: false, hasCommand: false, hasSkill: false, canSend: true };
    expect(composerKeyAction({ key: 'Escape' }, options)).toEqual({ type: 'dismiss' });
    expect(composerKeyAction({ key: 'a' }, options)).toEqual({ type: 'pass' });
  });
});
