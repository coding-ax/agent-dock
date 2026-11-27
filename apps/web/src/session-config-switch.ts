/**
 * 会话模型 / 思考深度切换的串行化状态机（乐观更新 + last-write-wins + 失败回滚）。
 *
 * 连续快速点击多个选项时：
 * - 只有最新一次提交（序列号匹配）允许落地成功态或触发失败回滚；
 * - 整个突发连切期间锁定「连切前的初始值」，即使连切 A → B 后 B 失败，也能完整回滚到最初值而非中途值 A；
 * - 切换会话调用 `reset()` 会递增序列号，自动屏蔽旧会话在途响应。
 */
export interface SessionConfigSwitchCallbacks<TResult> {
  currentValue: string | undefined;
  request: (target: string) => Promise<TResult>;
  onOptimistic: (target: string) => void;
  onSuccess: (result: TResult) => void;
  onRollback: (previousValue: string | undefined, message: string) => void;
}

export type SessionConfigSwitchOutcome = 'skipped' | 'stale' | 'applied' | 'rolled_back';

export interface SessionConfigSwitchLane {
  readonly pending: string | undefined;
  readonly rollbackValue: string | undefined;
  reset(): void;
  submit<TResult>(nextValue: string, callbacks: SessionConfigSwitchCallbacks<TResult>): Promise<SessionConfigSwitchOutcome>;
}

export function createSessionConfigSwitchLane(): SessionConfigSwitchLane {
  let seq = 0;
  let pending: string | undefined;
  let rollback: { captured: boolean; value: string | undefined } = { captured: false, value: undefined };

  return {
    get pending() { return pending; },
    get rollbackValue() { return rollback.captured ? rollback.value : undefined; },
    reset() {
      seq += 1;
      pending = undefined;
      rollback = { captured: false, value: undefined };
    },
    async submit<TResult>(nextValue: string, callbacks: SessionConfigSwitchCallbacks<TResult>): Promise<SessionConfigSwitchOutcome> {
      const target = nextValue.trim();
      if (!target) return 'skipped';
      if (pending !== undefined ? target === pending : target === callbacks.currentValue) return 'skipped';

      const requestSeq = ++seq;
      if (!rollback.captured) {
        rollback = { captured: true, value: callbacks.currentValue };
      }
      pending = target;
      callbacks.onOptimistic(target);

      try {
        const result = await callbacks.request(target);
        if (requestSeq !== seq) return 'stale';
        pending = undefined;
        rollback = { captured: false, value: undefined };
        callbacks.onSuccess(result);
        return 'applied';
      } catch (error) {
        if (requestSeq !== seq) return 'stale';
        const previousValue = rollback.value;
        pending = undefined;
        rollback = { captured: false, value: undefined };
        const message = error instanceof Error ? error.message : String(error);
        callbacks.onRollback(previousValue, message);
        return 'rolled_back';
      }
    }
  };
}
