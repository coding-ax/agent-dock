import { useState } from 'react';
import { useMemoizedFn } from 'ahooks';
import { autoCollapseOpen, toggleAutoCollapse, type ManualDisclosureState } from './auto-collapse-state';

/**
 * 执行过程区块的开合状态：
 * - 挂载时：进行中（active）默认展开，已结束默认收起；
 * - active 由 true 变 false（区块完成）时，当次渲染直接收起，
 *   包括进行中手动展开过的情况，避免 effect 再触发一次高度跳变；
 * - 完成后仍可手动展开查看历史过程。
 *
 * <details> 的 toggle 事件也会由 open 属性更新触发，不能拿它判断用户操作。
 * 调用方应在 summary 的 click 上 preventDefault 后调用 toggle。
 */
export function useAutoCollapse(active: boolean) {
  const [manual, setManual] = useState<ManualDisclosureState>();
  const open = autoCollapseOpen(active, manual);

  const toggle = useMemoizedFn(() => {
    setManual(value => toggleAutoCollapse(active, value));
  });

  return { open, toggle };
}
