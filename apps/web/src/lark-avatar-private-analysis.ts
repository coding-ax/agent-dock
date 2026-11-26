import type {
  LarkAvatarPrivateAnalyzeDelivery,
  LarkAvatarPrivateAnalyzeMode,
  LarkAvatarReactionIntent,
  LarkAvatarReactionRoute
} from './api';

export const PRIVATE_ANALYSIS_MODES: Array<{
  value: LarkAvatarPrivateAnalyzeMode;
  label: string;
  placeholder: string;
}> = [
  { value: 'summary', label: '总结群消息', placeholder: '可选补充关注点，例如：只看今天关于发版的结论和待办' },
  { value: 'analyze', label: '分析群问题', placeholder: '可选补充关注点，例如：分析老板的核心诉求和潜在风险' },
  { value: 'custom', label: '自定义提问', placeholder: '输入想私密问 AI 的问题，例如：帮我草拟一段委婉的回复思路' }
];

export const PRIVATE_ANALYSIS_DELIVERIES: Array<{
  value: LarkAvatarPrivateAnalyzeDelivery;
  label: string;
}> = [
  { value: 'main', label: '发到主会话' },
  { value: 'independent', label: '独立会话' },
  { value: 'private_chat', label: '私密发到飞书' }
];

export const REACTION_ROUTE_OPTIONS: Array<{ value: LarkAvatarReactionRoute; label: string }> = [
  { value: 'main', label: '主会话' },
  { value: 'independent', label: '独立轮次' },
  { value: 'private_chat', label: '私密转发' },
  { value: 'ask', label: '先询问' }
];

export const REACTION_INTENT_OPTIONS: Array<{ value: LarkAvatarReactionIntent; label: string }> = [
  { value: 'auto', label: '自动处理' },
  { value: 'summary', label: '总结群消息' },
  { value: 'analyze', label: '分析群问题' }
];

export function validatePrivateAnalysisSubmission(input: {
  chatId: string;
  mode: LarkAvatarPrivateAnalyzeMode;
  prompt: string;
  delivery: LarkAvatarPrivateAnalyzeDelivery;
  privateReplyChatId: string;
}): string | null {
  if (!input.chatId.trim()) return '请先选择要分析的会话';
  if (input.mode === 'custom' && !input.prompt.trim()) return '请输入想私密问 AI 的问题';
  if (input.delivery === 'private_chat') {
    const target = input.privateReplyChatId.trim();
    if (!target) return '请先在「设置 → 私密分析与防发群」里配置私密接收会话';
    if (target === input.chatId.trim()) return '私密接收会话与当前群相同，已拦截发送以防内容发到群里';
  }
  return null;
}

export function privateAnalysisSuccessMessage(input: {
  delivery: LarkAvatarPrivateAnalyzeDelivery;
  contextCount: number;
  targetChatName?: string;
}): string {
  const countText = input.contextCount > 0 ? `已带入最近 ${input.contextCount} 条消息` : '已提交分析';
  if (input.delivery === 'main') return `${countText}，结果将静默输出到 AgentDock 主会话（不会发到原群）`;
  if (input.delivery === 'independent') return `${countText}，已在 AgentDock 新开独立私密会话（不会发到原群）`;
  return `${countText}，结果将私密发送到「${input.targetChatName || '指定私密会话'}」（绝不发到原群）`;
}
