import {
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  type AskUserQuestionAnswerPayload,
  type AskUserQuestionSpec
} from '@agent-dock/agent-dock-shared';
import {
  buildLarkAskUserQuestionAnsweredCard,
  buildLarkAskUserQuestionCard,
  isLarkAskUserQuestionAction,
  LARK_ASK_ACTION_PREVIEW,
  parseLarkAskUserQuestionAction
} from '../ask-user-question-card.js';
import type { LarkOutputPluginAdapter } from './types.js';

/** 内置插件 #1（`builtin:ask-user-question`）的飞书 Schema 2.0 适配器，无损复用既有卡片构建与解析逻辑。 */
export const askUserQuestionLarkAdapter: LarkOutputPluginAdapter<
  AskUserQuestionSpec,
  AskUserQuestionAnswerPayload
> = {
  pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  trailingHintMarkdown: "<font color='grey'>👇 请在下方交互卡片中确认并作答</font>",
  streamingPlaceholderText: '⏳ 正在生成选项卡片…',
  handlesAction(action: string): boolean {
    return isLarkAskUserQuestionAction(action);
  },
  isPreviewAction(action: string): boolean {
    return action === LARK_ASK_ACTION_PREVIEW;
  },
  buildCard({ cardId, spec, sessionId, webBaseUrl, previewBanner, previewMode }) {
    return buildLarkAskUserQuestionCard({
      cardId,
      spec,
      sessionId,
      webBaseUrl,
      previewBanner,
      previewMode
    });
  },
  buildAnsweredCard({ payload, sessionId, webBaseUrl, previewBanner }) {
    return buildLarkAskUserQuestionAnsweredCard({
      payload,
      sessionId,
      webBaseUrl,
      previewBanner
    });
  },
  parseAction(spec, action, value, formValue) {
    const parsed = parseLarkAskUserQuestionAction(spec, action, value, formValue);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      interaction: {
        answers: parsed.answers
      }
    };
  }
};
