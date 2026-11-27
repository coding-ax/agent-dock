import { splitInjectedPrefix } from './session-request-log';

export interface BubbleInjection {
  /** prefix：在用户可见消息前拼了一段注入前缀；rewritten：实际发送与可见文本不是简单前缀关系。 */
  kind: 'prefix' | 'rewritten';
  text: string;
  tags: string[];
  charCount: number;
}

const INJECTION_TAG_RULES: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /<agentdock-context>/, label: '上下文快照' },
  { pattern: /<agentdock-superagent>/, label: '编排指令' },
  { pattern: /\[AgentDock 飞书会话工具\]/, label: '飞书工具' },
  { pattern: /\[AgentDock 群工具提醒\]/, label: '群工具提醒' },
  { pattern: /\[AgentDock 凭证保密(?:要求|提醒)\]/, label: '凭证保密' },
  { pattern: /\[AgentDock 机器人身份\]/, label: '机器人身份' },
  { pattern: /\[AgentDock 飞书回复方式\]/, label: '回复方式' },
  { pattern: /\[AgentDock 静默回复模式/, label: '静默回复' },
  { pattern: /\[AgentDock 预注入 Prompt\]/, label: '预注入 Prompt' },
  { pattern: /\[AgentDock 飞书当前消息/, label: '飞书消息上下文' },
  { pattern: /\[AgentDock 安全策略/, label: '安全策略' },
  { pattern: /\[(?:当前飞书会话|飞书聊天上下文)\]/, label: '飞书聊天上下文' },
  { pattern: /\[AgentDock 用户询问卡片协议\]/, label: '询问卡片协议' },
  { pattern: /用户询问卡片协议已关闭/, label: '询问卡片协议' },
  { pattern: /\[AgentDock 操作确认卡片协议\]/, label: '操作确认协议' },
  { pattern: /操作确认卡片协议已关闭/, label: '操作确认协议' },
  { pattern: /\[AgentDock 交互插件协议/, label: '交互插件协议' },
  { pattern: /交互插件「[^」]+」已关闭/, label: '交互插件协议' },
  { pattern: /\[AgentDock 定时任务\b/, label: '定时任务' },
  { pattern: /\[AgentDock\]/, label: '运行约束' }
];

/** 从注入文本里识别 AgentDock 的各个注入区块，用于在气泡折叠条上给出有体感的一行摘要。 */
export function detectInjectionTags(text: string): string[] {
  const tags: string[] = [];
  for (const rule of INJECTION_TAG_RULES) {
    if (rule.pattern.test(text) && !tags.includes(rule.label)) tags.push(rule.label);
  }
  return tags;
}

/**
 * 提取用户气泡对应的隐式注入内容。
 * 复用 RequestTrajectory 的 splitInjectedPrefix 判定：与轨迹面板口径完全一致。
 */
export function extractBubbleInjection(visible: string, sentPrompt?: string | null): BubbleInjection | null {
  if (!sentPrompt) return null;
  const payload = splitInjectedPrefix(visible, sentPrompt);
  if (payload.state !== 'sent') return null;
  if (payload.form === 'injected') {
    const trimmed = payload.prefix.trim();
    if (!trimmed) return null;
    return { kind: 'prefix', text: trimmed, tags: detectInjectionTags(trimmed), charCount: trimmed.length };
  }
  if (payload.form === 'unrelated') {
    const trimmed = payload.text.trim();
    if (!trimmed) return null;
    return { kind: 'rewritten', text: trimmed, tags: detectInjectionTags(trimmed), charCount: trimmed.length };
  }
  return null;
}
