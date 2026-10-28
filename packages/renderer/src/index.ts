import type { AgentEvent } from '@agent-dock/agent-dock-shared';

export function eventText(event: AgentEvent): string {
  const data = event.data as any;
  if (event.type === 'text' || event.type === 'thinking' || event.type === 'raw_terminal') return data.text ?? event.raw ?? '';
  if (event.type === 'error') return data.message ?? 'Unknown error';
  if (event.type === 'tool_call' || event.type === 'tool_result') return `${data.name ?? 'tool'} · ${data.status ?? ''}`;
  if (event.type === 'permission_request') return data.title ?? 'Permission required';
  // 改名走 status 事件（与 model / reasoningEffort 同一个通道）。不特判的话会掉到最后一行
  // 显示成状态名（「就绪」），用户看到一条「就绪」根本不知道发生了什么。
  if (event.type === 'status' && typeof data.title === 'string') return `会话名改为「${data.title}」`;
  if (event.type === 'status' && data.titleSource === 'prompt') return '恢复了自动命名的会话名';
  return data.state ?? data.stopReason ?? event.type;
}
