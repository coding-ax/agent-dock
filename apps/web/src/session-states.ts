import type { Locale } from '@agent-dock/agent-dock-shared';
import { getCurrentLocale } from './i18n';

export const stateLabels: Record<string, string> = {
  created: '已创建', starting: '启动中', idle: '就绪', thinking: '思考中', running_tool: '正在调用工具', waiting_for_permission: '等待授权', interrupting: '正在取消', interrupted: '已取消', completed: '已完成', failed: '失败', stopped: '已停止'
};
const stateLabelsEn: Record<string, string> = {
  created: 'Created', starting: 'Starting', idle: 'Ready', thinking: 'Thinking', running_tool: 'Running Tool', waiting_for_permission: 'Approval Needed', interrupting: 'Stopping', interrupted: 'Cancelled', completed: 'Completed', failed: 'Failed', stopped: 'Stopped'
};
/** 中断状态要结合原因：区分用户主动停止与服务重启被动中断，避免显示成模糊的「已取消」。 */
export function sessionStateLabel(state: string, interruptIntent?: string | null, locale: Locale = getCurrentLocale()) {
  if (locale === 'en-US') {
    if (state === 'interrupted' && interruptIntent === 'user') return 'Stopped by user';
    if (state === 'interrupted' && interruptIntent === 'daemon_restart') return 'Interrupted by restart';
    return stateLabelsEn[state] ?? state;
  }
  if (state === 'interrupted' && interruptIntent === 'user') return '用户已停止';
  if (state === 'interrupted' && interruptIntent === 'daemon_restart') return '服务重启中断';
  return stateLabels[state] ?? state;
}
export const stateTone: Record<string, string> = { starting: 'bg-amber-500', thinking: 'bg-amber-500', running_tool: 'bg-blue-500', waiting_for_permission: 'bg-orange-500', failed: 'bg-red-500', stopped: 'bg-zinc-400', interrupted: 'bg-zinc-500', completed: 'bg-emerald-500', idle: 'bg-emerald-500' };
export const busyStates = new Set(['starting', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting']);

/**
 * 与 stateTone 对应的文字色，转圈指示用 currentColor 时的配色。
 * 必须是字面量：Tailwind 只扫描源码里的完整类名，运行时 replace('bg-','text-') 拼出来的
 * class 不会进 CSS，转圈会静默丢色。改这里的色值要同时改 stateTone。
 */
export const stateTextTone: Record<string, string> = {
  starting: 'text-amber-500',
  thinking: 'text-amber-500',
  running_tool: 'text-blue-500',
  waiting_for_permission: 'text-orange-500',
  interrupting: 'text-zinc-500',
  failed: 'text-red-500',
  stopped: 'text-zinc-400',
  interrupted: 'text-zinc-500',
  completed: 'text-emerald-500',
  idle: 'text-emerald-500'
};
