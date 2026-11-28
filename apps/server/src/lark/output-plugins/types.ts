import type { Locale, OutputPluginDefinition } from '@agent-dock/agent-dock-shared';
import type { LarkCardSourceBadge } from '../service.js';

/** 持久化在 `channel_mappings` 中的通用飞书插件卡片记录。 */
export interface PersistedLarkOutputPluginCard<TSpec = unknown> {
  cardId: string;
  pluginId: string;
  appId: string;
  chatId: string;
  /** 若原始投递目标为 `open_id` 私聊（`ou_...`），保留该接收 ID 供跨重启幂等匹配。 */
  receiveId?: string;
  chatType: string;
  messageId: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  threadId?: string;
  rootId?: string;
  sessionId: string;
  taskId?: string;
  instanceId: string;
  /** 历史 AskUserQuestion 卡片兼容字段（与 instanceId 同步）。 */
  questionId?: string;
  spec: TSpec;
  webBaseUrl?: string;
  createdAt: string;
}

export interface LarkOutputPluginCardBuildInput<TSpec = unknown> {
  cardId: string;
  plugin: OutputPluginDefinition;
  spec: TSpec;
  sessionId?: string;
  webBaseUrl?: string;
  previewBanner?: string;
  previewMode?: boolean;
  sourceBadge?: LarkCardSourceBadge;
  locale?: Locale;
}

export interface LarkOutputPluginAnsweredCardBuildInput<TInteraction = unknown> {
  plugin: OutputPluginDefinition;
  payload: TInteraction;
  sessionId?: string;
  webBaseUrl?: string;
  previewBanner?: string;
  sourceBadge?: LarkCardSourceBadge;
  locale?: Locale;
}

export type ParsedLarkOutputPluginAction =
  | {
      ok: true;
      /** 透传给 `OutputPluginService.submitInteraction` 的插件特定交互负载。 */
      interaction: {
        answers?: any[];
        decision?: 'confirm' | 'cancel';
        decisionLabel?: string;
        risk?: 'low' | 'medium' | 'high';
        comment?: string;
        actionValue?: string;
        actionLabel?: string;
        fields?: Array<{ name: string; label: string; value: string; displayValue?: string }>;
        note?: string;
      };
    }
  | { ok: false; error: string };

/**
 * 飞书端纯 XML 交互插件适配器契约：
 * - 出站：将解析出的 XML spec 构造成飞书 Schema 2.0 卡片；
 * - 入站：路由并解析 `card.action.trigger` 回调，返回给统一幂等提交服务；
 * - 锁定：在 Web 或飞书任一端响应后，将飞书卡片原地更新为只读锁定态。
 */
export interface LarkOutputPluginAdapter<TSpec = unknown, TInteraction = unknown> {
  readonly pluginId: string;
  /** 判断某条飞书卡片回调 action 是否归属本适配器。 */
  handlesAction(action: string, value: Record<string, unknown>): boolean;
  /** 是否为样式预览按钮（仅弹 toast，不入库不续跑）。 */
  isPreviewAction?(action: string): boolean;
  /** 构造出站飞书 Schema 2.0 卡片。 */
  buildCard(input: LarkOutputPluginCardBuildInput<TSpec>): Record<string, unknown>;
  /** 可选：当完整交互卡因飞书 Schema 限制（如 230099 / 200xxx）被拒收时的极简只读降级卡。 */
  buildFallbackCard?(input: LarkOutputPluginCardBuildInput<TSpec>): Record<string, unknown>;
  /** 构造已响应/已锁定回显卡片（只读信息卡可不提供）。 */
  buildAnsweredCard?(input: LarkOutputPluginAnsweredCardBuildInput<TInteraction>): Record<string, unknown>;
  /** 可选：当完整已响应锁定卡因飞书 Schema/内容审核被拒收（如 230099/230028）时的极简锁定兜底卡。 */
  buildAnsweredFallbackCard?(input: LarkOutputPluginAnsweredCardBuildInput<TInteraction>): Record<string, unknown>;
  /** 解析飞书回调载荷。 */
  parseAction?(
    spec: TSpec,
    action: string,
    value: Record<string, unknown>,
    formValue?: Record<string, unknown>,
    locale?: Locale
  ): ParsedLarkOutputPluginAction;
  /** 在主消息正文末尾附加的轻引导文案。 */
  trailingHintMarkdown?: string;
  /** 按当前服务端语言返回轻引导文案（优先于静态 trailingHintMarkdown）。 */
  getTrailingHintMarkdown?(locale: Locale): string;
  /** 流式未闭合阶段替换裸 XML 的占位提示。 */
  streamingPlaceholderText?: string;
  /** 按当前服务端语言返回流式占位提示（优先于静态 streamingPlaceholderText）。 */
  getStreamingPlaceholderText?(locale: Locale): string;
}
