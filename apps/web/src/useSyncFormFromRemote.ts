import { useEffect } from 'react';
import { useMemoizedFn } from 'ahooks';

/**
 * 远端数据到达后，把它一次性灌进本地表单 state。
 *
 * 这是「与 React 外部系统（服务端配置）同步」而不是派生状态：表单随后由用户编辑，
 * 不能在每次渲染时重新从 config 推导，否则会把用户正在输入的内容冲掉。所以这里
 * 确实需要 Effect，但包成命名清晰的自定义 hook，而不是在组件里散落裸 useEffect。
 *
 * 触发条件用 `!= null` 而不是 truthy：`''` / `0` / `false` 都可能是合法的 source。
 * 飞书配置面板就用 `selectedAppId === ''` 表示「新增机器人」，按 truthy 判定会跳过
 * 这次灌入，表单会残留上一个机器人的内容。
 *
 * 只依赖 source：回调用 useMemoizedFn 稳定引用并读取最新闭包，避免把一堆 setter
 * 和中间变量塞进依赖数组，也避免依赖变化导致重复灌入。幂等由调用方自己用
 * hydratedSelection 之类的标记保证。
 */
export function useSyncFormFromRemote(source: unknown, hydrate: () => void) {
  const run = useMemoizedFn(hydrate);
  useEffect(() => { if (source != null) run(); }, [source, run]);
}
