import {
  ASK_USER_QUESTION_ANSWER_ORIGIN,
  ASK_USER_QUESTION_XML_TAG,
  buildAskUserQuestionDisabledNotice,
  buildAskUserQuestionPromptGuidance,
  DEFAULT_ASK_USER_QUESTION_CONFIG,
  extractAskUserQuestionAnswerSearchText,
  extractAskUserQuestionSearchText,
  extractTrailingAskUserQuestion,
  formatAskUserQuestionAnswerForAgent,
  parseAskUserQuestionAnswer,
  serializeAskUserQuestionAnswer,
  splitStreamingAskUserQuestion,
  summarizeAskUserQuestionAnswer,
  type AskUserQuestionAnswerPayload,
  type AskUserQuestionSpec
} from '../ask-user-question.js';
import {
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  type OutputPluginDefinition,
  type OutputPluginParseResult,
  type OutputPluginStreamingSplit
} from './types.js';

export const ASK_USER_QUESTION_PROTOCOL_EXAMPLE = `<${ASK_USER_QUESTION_XML_TAG} id="db_choice" title="选择存储方案">
  <question id="q1" multi="false" allow-other="true">
    <prompt>希望采用哪种持久化方案？</prompt>
    <option value="sqlite" recommended="true" description="内置零运维">SQLite</option>
    <option value="postgres" description="适合多节点">PostgreSQL</option>
  </question>
</${ASK_USER_QUESTION_XML_TAG}>`;

/**
 * 内置插件 #1：`builtin:ask-user-question`（纯 XML 协议版 AskUserQuestion）。
 *
 * 将原有 XML 版 AskUserQuestion 无损迁移到统一交互插件契约：
 * - 零 MCP、零 Tool、全 Agent CLI（Claude / Codex / Antigravity / Trae 等）通用；
 * - 默认开启（`defaultEnabled: true`），兼容历史 `ask_user_question_enabled` 字段与事件 `origin`。
 */
export const askUserQuestionOutputPlugin: OutputPluginDefinition<
  AskUserQuestionSpec,
  AskUserQuestionAnswerPayload
> = {
  id: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  name: '询问卡片（AskUserQuestion）',
  description: '仅当 Agent 需要你拍板、多选一或确认关键参数时，在回复最末尾渲染结构化选项卡片；支持单选、多选、多题、推荐项与自定义填写，Web 与飞书双向实时同步。',
  icon: 'message-circle-question',
  tagName: ASK_USER_QUESTION_XML_TAG,
  defaultEnabled: DEFAULT_ASK_USER_QUESTION_CONFIG.askUserQuestionXmlEnabled,
  version: '1.0.0',
  builtin: true,
  source: 'builtin',
  capabilities: {
    web: true,
    lark: true,
    interactive: true,
    streamingPlaceholder: true
  },
  protocolExample: ASK_USER_QUESTION_PROTOCOL_EXAMPLE,
  interactionOrigin: ASK_USER_QUESTION_ANSWER_ORIGIN,
  promptInstruction: buildAskUserQuestionPromptGuidance,
  disabledNotice: buildAskUserQuestionDisabledNotice,
  parseOutput(text): OutputPluginParseResult<AskUserQuestionSpec> | null {
    const extracted = extractTrailingAskUserQuestion(text);
    if (!extracted) return null;
    return {
      pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      tagName: ASK_USER_QUESTION_XML_TAG,
      proseText: extracted.proseText,
      spec: extracted.spec,
      rawXml: extracted.rawXml,
      startIndex: extracted.startIndex,
      endIndex: extracted.endIndex
    };
  },
  splitStreaming(text, streaming): OutputPluginStreamingSplit<AskUserQuestionSpec> {
    const split = splitStreamingAskUserQuestion(text, streaming);
    if (split.kind === 'none') return split;
    if (split.kind === 'pending') {
      return {
        kind: 'pending',
        pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
        tagName: ASK_USER_QUESTION_XML_TAG,
        proseText: split.proseText,
        ...(split.partialTitle ? { partialTitle: split.partialTitle } : {})
      };
    }
    return {
      kind: 'complete',
      pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      tagName: ASK_USER_QUESTION_XML_TAG,
      proseText: split.proseText,
      spec: split.spec,
      rawXml: split.rawXml
    };
  },
  getInstanceId: spec => spec.id,
  getTitle: spec => spec.title,
  parseInteraction: parseAskUserQuestionAnswer,
  getInteractionInstanceId: payload => payload.questionId,
  serializeInteraction: serializeAskUserQuestionAnswer,
  formatInteractionForAgent: formatAskUserQuestionAnswerForAgent,
  summarizeInteraction: summarizeAskUserQuestionAnswer,
  extractSearchText: extractAskUserQuestionSearchText,
  extractInteractionSearchText: extractAskUserQuestionAnswerSearchText
};
