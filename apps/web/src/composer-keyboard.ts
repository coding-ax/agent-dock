/**
 * 输入框 Enter / 输入法组合态的处理。
 *
 * 只判断 `isComposing` 不够：Safari 以及部分 Chromium + 第三方输入法在按 Enter
 * 确认候选词时，会先发 `compositionend`，再补一个 `isComposing === false`、
 * `keyCode === 13` 的 keydown。此时组合态已经结束，单看 isComposing 就会把
 * 「确认候选词」当成「发送」。
 */

/** 键盘事件里与输入法相关的字段（KeyboardEvent 的结构子集，便于单测构造）。 */
export interface ComposerKeyboardEvent {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export type ComposerKeyAction =
  | { type: 'ignore' }
  | { type: 'dismiss' }
  | { type: 'choose-command' }
  | { type: 'choose-skill' }
  | { type: 'send' }
  /** Enter 已按下但当前不能发送：吞掉，避免偷偷插入换行。 */
  | { type: 'handled' }
  /** Shift+Enter：交给编辑器插入换行。 */
  | { type: 'newline' }
  | { type: 'pass' };

/**
 * compositionend 之后补发的 keydown 只在这个窗口内认作同一次按键。
 * 100ms 足够覆盖事件补发，又不会吞掉用户确认候选词后隔一会儿才按的 Enter。
 */
export const IME_ENTER_GUARD_MS = 100;

/**
 * `composing`：组合还在进行，必须把默认行为留给输入法确认候选词；
 * `composition-enter`：compositionend 之后补发的 Enter，组合已结束，应 preventDefault 吞掉。
 */
export type ImeKeyState = 'none' | 'composing' | 'composition-enter';

export interface CompositionGuard {
  readonly composing: boolean;
  /** 是否还在等 compositionend 后补发的那次 Enter。 */
  readonly awaitingImeEnter: boolean;
  start(): void;
  end(at?: number): void;
  /**
   * 判定这次 keydown 是否属于输入法组合（含 compositionend 后补发的那一下）。
   * 组合中不要 preventDefault；补发的 Enter 则要 preventDefault，避免插入换行。
   */
  classify(event: ComposerKeyboardEvent, at?: number): ImeKeyState;
}

export function createCompositionGuard(now: () => number = () => Date.now()): CompositionGuard {
  let composing = false;
  let compositionEndedAt = Number.NEGATIVE_INFINITY;
  let pendingImeEnter = false;

  return {
    get composing() { return composing; },
    get awaitingImeEnter() { return pendingImeEnter; },
    start() {
      composing = true;
      pendingImeEnter = false;
    },
    end(at = now()) {
      composing = false;
      compositionEndedAt = at;
      // 只吞紧随其后的那一次 Enter；若中间来了别的按键，说明不是补发事件。
      pendingImeEnter = true;
    },
    classify(event, at = now()) {
      if (composing || event.isComposing || event.keyCode === 229) return 'composing';
      if (event.key !== 'Enter') {
        pendingImeEnter = false;
        return 'none';
      }
      if (!pendingImeEnter) return 'none';
      pendingImeEnter = false;
      // 只忽略一次：第二次按 Enter 一定是用户真的要发送。
      return at - compositionEndedAt <= IME_ENTER_GUARD_MS ? 'composition-enter' : 'none';
    }
  };
}

export function composerKeyAction(event: ComposerKeyboardEvent, options: {
  guard: CompositionGuard;
  panelOpen: boolean;
  commandPanel: boolean;
  hasCommand: boolean;
  hasSkill: boolean;
  canSend: boolean;
}): ComposerKeyAction {
  if (options.guard.classify(event) !== 'none') return { type: 'ignore' };
  if (event.key === 'Escape' && options.panelOpen) return { type: 'dismiss' };
  if (event.key !== 'Enter') return { type: 'pass' };
  // Shift+Enter 交给编辑器插入换行；组合态已在上面拦掉。
  if (event.shiftKey) return { type: 'newline' };
  if (options.commandPanel && !event.metaKey && !event.ctrlKey) {
    if (options.hasCommand) return { type: 'choose-command' };
    if (options.hasSkill) return { type: 'choose-skill' };
  }
  if (options.canSend) return { type: 'send' };
  return { type: 'handled' };
}
