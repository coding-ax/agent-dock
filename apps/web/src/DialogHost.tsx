import type { ReactNode } from 'react';
import { ExitGate } from './ExitGate';
import { useActiveAppDialog, type AppDialogKind } from './dialog-store';
import {
  resolveDialogKindToSettingsTarget,
  type SettingsCategoryId,
  type SettingsNavigationTarget,
  type SettingsSubTab
} from './settings/settings-registry';

/** 普通弹窗直接传 ReactNode；定时任务需要「从哪个会话打开」，用渲染函数拿 sessionId。 */
type DialogSlot = ReactNode | ((sessionId?: string) => ReactNode);

/**
 * App 级弹窗的宿主。只订阅 dialog-store，因此打开/关闭弹窗不会重渲染 App 的会话树。
 * 每个弹窗仍包一层 ExitGate，保留原来的 180ms 退出动画。
 *
 * 所有全局设置类入口（settings / theme-studio / agent / side-chat / output-plugins /
 * assistant / task-recovery / lark / lark-regex / lark-avatar / notifications / 全局 schedule）
 * 统一收敛进单个 SettingsCenterDialog 宿主槽位，切类不闪屏、零回归保留既有深链契约。
 */
export function DialogHost({
  dialogs,
  settingsCenter
}: {
  dialogs: Partial<Record<AppDialogKind, DialogSlot>>;
  settingsCenter?: (target: SettingsNavigationTarget) => ReactNode;
}) {
  const active = useActiveAppDialog();
  const settingsTarget = settingsCenter && active
    ? resolveDialogKindToSettingsTarget(active.kind, {
        sessionId: active.sessionId,
        settingsCategory: active.settingsCategory as SettingsCategoryId | undefined,
        settingsSubTab: active.settingsSubTab as SettingsSubTab | undefined
      })
    : null;

  return <>
    {settingsCenter && (
      <ExitGate key="__settings-center__" open={Boolean(settingsTarget)}>
        {settingsTarget ? settingsCenter(settingsTarget) : null}
      </ExitGate>
    )}
    {(Object.keys(dialogs) as AppDialogKind[]).map(kind => {
      const open = !settingsTarget && active?.kind === kind;
      const slot = dialogs[kind];
      // 关闭中的弹窗由 ExitGate 保留上一帧的 children，所以这里只在 open 时求值。
      const content = open ? (typeof slot === 'function' ? slot(active.sessionId) : slot) : null;
      return <ExitGate key={kind} open={open}>{content}</ExitGate>;
    })}
  </>;
}
