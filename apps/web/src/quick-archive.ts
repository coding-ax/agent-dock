/**
 * 侧栏会话「快速归档」的纯状态机。
 *
 * 右键/长按菜单里的归档项、确认框和异步请求都分散在渲染层，容易漏掉重复提交、取消后
 * 仍然发请求这类边界。把状态迁移放在这里，UI 只负责把菜单事件映射成
 * open / confirm / cancel，单测就能覆盖确认、取消和失败重试。
 */
export type QuickArchiveSnapshot =
  | { status: 'closed' }
  | { status: 'confirming'; sessionId: string }
  | { status: 'archiving'; sessionId: string }
  | { status: 'error'; sessionId: string; message: string };

export type QuickArchiveController = {
  snapshot(): QuickArchiveSnapshot;
  /** 点菜单里的归档：只打开确认框，不碰接口。 */
  open(sessionId: string): void;
  cancel(): void;
  confirm(): Promise<void>;
};

export function archiveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createQuickArchiveController(options: {
  archive(sessionId: string): Promise<unknown>;
  onChange(snapshot: QuickArchiveSnapshot): void;
}): QuickArchiveController {
  let current: QuickArchiveSnapshot = { status: 'closed' };
  const publish = (next: QuickArchiveSnapshot) => {
    current = next;
    options.onChange(next);
  };

  return {
    snapshot: () => current,
    open(sessionId) {
      // 归档请求在飞时不允许换目标，否则成功回调会把新弹窗一起关掉。
      if (current.status === 'archiving') return;
      publish({ status: 'confirming', sessionId });
    },
    cancel() {
      if (current.status === 'closed' || current.status === 'archiving') return;
      publish({ status: 'closed' });
    },
    async confirm() {
      // 失败后停留在 error 态，允许原样重试；closed / archiving 时不再发请求。
      if (current.status !== 'confirming' && current.status !== 'error') return;
      const { sessionId } = current;
      publish({ status: 'archiving', sessionId });
      try {
        await options.archive(sessionId);
        publish({ status: 'closed' });
      } catch (error) {
        publish({ status: 'error', sessionId, message: archiveErrorMessage(error) });
      }
    }
  };
}

