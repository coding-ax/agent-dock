import type { ReactNode } from 'react';
import { ExitGate } from './ExitGate';
import { useActiveAppDialog, type AppDialogKind } from './dialog-store';

/** 普通弹窗直接传 ReactNode；定时任务需要「从哪个会话打开」，用渲染函数拿 sessionId。 */
type DialogSlot = ReactNode | ((sessionId?: string) => ReactNode);

/**
 * App 级弹窗的宿主。只订阅 dialog-store，因此打开/关闭弹窗不会重渲染 App 的会话树。
 * 每个弹窗仍包一层 ExitGate，保留原来的 180ms 退出动画。
 *
 * 这里不直接 import 各弹窗：它们在 App.tsx 里需要拿到当前会话/Agent/回调，
 * 由 App 以 ReactNode 传入，DialogHost 只负责「哪个开着」。
 */
export function DialogHost({ dialogs }: { dialogs: Partial<Record<AppDialogKind, DialogSlot>> }) {
  const active = useActiveAppDialog();
  return <>
    {(Object.keys(dialogs) as AppDialogKind[]).map(kind => {
      const open = active?.kind === kind;
      const slot = dialogs[kind];
      // 关闭中的弹窗由 ExitGate 保留上一帧的 children，所以这里只在 open 时求值。
      const content = open ? (typeof slot === 'function' ? slot(active.sessionId) : slot) : null;
      return <ExitGate key={kind} open={open}>{content}</ExitGate>;
    })}
  </>;
}
