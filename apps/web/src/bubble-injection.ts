import { splitInjectedPrefix } from './session-request-log';
import { bi } from './i18n';

export interface BubbleInjection {
  /** prefix：在用户可见消息前拼了一段注入前缀；rewritten：实际发送与可见文本不是简单前缀关系。 */
  kind: 'prefix' | 'rewritten';
  text: string;
  tags: string[];
  charCount: number;
}

const INJECTION_TAG_RULES: ReadonlyArray<{ pattern: RegExp; label: string; labelEn: string }> = [
  { pattern: /<agentdock-context>/, label: '上下文快照', labelEn: 'Context Snapshot' },
  { pattern: /<agentdock-superagent>/, label: '编排指令', labelEn: 'Orchestration' },
  { pattern: /\[AgentDock 飞书会话工具\]/, label: '飞书工具', labelEn: 'Lark Tools' },
  { pattern: /\[AgentDock 群工具提醒\]/, label: '群工具提醒', labelEn: 'Group Tool Reminder' },
  { pattern: /\[AgentDock 凭证保密(?:要求|提醒)\]/, label: '凭证保密', labelEn: 'Secret Protection' },
  { pattern: /\[AgentDock 机器人身份\]/, label: '机器人身份', labelEn: 'Bot Identity' },
  { pattern: /\[AgentDock 飞书回复方式\]/, label: '回复方式', labelEn: 'Reply Mode' },
  { pattern: /\[AgentDock 静默回复模式/, label: '静默回复', labelEn: 'Quiet Reply' },
  { pattern: /\[AgentDock 预注入 Prompt\]/, label: '预注入 Prompt', labelEn: 'Pre-injected Prompt' },
  { pattern: /\[AgentDock 飞书当前消息/, label: '飞书消息上下文', labelEn: 'Lark Message Context' },
  { pattern: /\[AgentDock 安全策略/, label: '安全策略', labelEn: 'Safety Policy' },
  { pattern: /\[(?:当前飞书会话|飞书聊天上下文)\]/, label: '飞书聊天上下文', labelEn: 'Lark Chat Context' },
  { pattern: /\[AgentDock 用户询问卡片协议\]/, label: '询问卡片协议', labelEn: 'AskUserQuestion Protocol' },
  { pattern: /用户询问卡片协议已关闭/, label: '询问卡片协议', labelEn: 'AskUserQuestion Protocol' },
  { pattern: /\[AgentDock 操作确认卡片协议\]/, label: '操作确认协议', labelEn: 'ConfirmAction Protocol' },
  { pattern: /操作确认卡片协议已关闭/, label: '操作确认协议', labelEn: 'ConfirmAction Protocol' },
  { pattern: /\[AgentDock 富文本排版块指引\]/, label: '富文本排版块', labelEn: 'Rich Blocks' },
  { pattern: /富文本排版块插件（metrics \/ steps）已关闭/, label: '富文本排版块', labelEn: 'Rich Blocks' },
  { pattern: /\[AgentDock 交互插件协议/, label: '交互插件协议', labelEn: 'Output Plugin Protocol' },
  { pattern: /交互插件「[^」]+」已关闭/, label: '交互插件协议', labelEn: 'Output Plugin Protocol' },
  { pattern: /\[AgentDock 定时任务\b/, label: '定时任务', labelEn: 'Scheduled Task' },
  { pattern: /\[AgentDock\]/, label: '运行约束', labelEn: 'Runtime Rules' }
];

/** 从注入文本里识别 AgentDock 的各个注入区块，用于在气泡折叠条上给出有体感的一行摘要。 */
export function detectInjectionTags(text: string): string[] {
  const tags: string[] = [];
  for (const rule of INJECTION_TAG_RULES) {
    const label = bi(rule.label, rule.labelEn);
    if (rule.pattern.test(text) && !tags.includes(label)) tags.push(label);
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
