import { Kitten } from './companion/Kitten';
import { useBi } from './i18n';

/**
 * 空状态的线条小猫。实现已经并入 companion/Kitten（主会话小猫也是同一只）；
 * 这里保留旧入口：跟随光标、输入框聚焦时低头看、按键时耳朵抖。
 */
export function DockMascot({ size = 96 }: { size?: number }) {
  const L = useBi();
  return <Kitten size={size} track typingAware label={L("AgentDock 小猫", "AgentDock Kitten")} className="mx-auto"/>;
}
