/**
 * 平台模型能力的功能提示词。结构固定、只拼接用户可编辑的上下文与草稿，
 * 避免把任意输入直接当指令传给模型。
 */
/** 超长草稿只取开头和结尾：补全需要知道风格，不必把整篇人设重复发给慢模型。 */
const maxPreInjectDraftChars = 1_200;

export function summarizePreInjectDraft(draft: string): string {
  const text = draft.trim();
  if (text.length <= maxPreInjectDraftChars) return text;
  const headLength = Math.floor(maxPreInjectDraftChars * 0.7);
  const tailLength = maxPreInjectDraftChars - headLength;
  return `${text.slice(0, headLength)}\n\n…（草稿中间省略 ${text.length - headLength - tailLength} 字）…\n\n${text.slice(-tailLength)}`;
}

export function buildPreInjectAssistPrompt(context: string, draft: string): string {
  return [
    '你是 AgentDock 的配置助手。请为下面的飞书机器人写一段「预注入 Prompt」。',
    '这段文字会在每轮飞书对话中、用户请求之前隐式注入给 Agent，用来约束它的行为、偏好和回复方式。',
    '',
    '要求：',
    '- 只输出提示词正文，使用中文 Markdown；不要解释、不要加代码围栏。',
    '- 控制在 180 字以内，用短段落或分点，便于 Agent 快速遵守。',
    '- 结合机器人场景和已有草稿；草稿为空时写一段通用、克制的默认提示词。',
    '- 不要编造权限、密钥、内部系统或人员信息；不要试图覆盖 AgentDock 的安全策略。',
    '',
    '机器人上下文：',
    context.trim() || '（未提供）',
    '',
    '用户已有草稿（仅摘要，保留开头与结尾）：',
    summarizePreInjectDraft(draft) || '（空）'
  ].join('\n');
}
