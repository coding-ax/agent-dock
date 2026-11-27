import type { OutputPluginDefinition } from '@agent-dock/agent-dock-shared';

/** 持久化在 `channel_mappings` 中的通用飞书插件卡片记录。 */
export interface PersistedLarkOutputPluginCard<TSpec = unknown> {
  cardId: string;
  pluginId: string;
  appId: string;
  chatId: string;
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
}

export interface LarkOutputPluginAnsweredCardBuildInput<TInteraction = unknown> {
  plugin: OutputPluginDefinition;
  payload: TInteraction;
  sessionId?: string;
  webBaseUrl?: string;
  previewBanner?: string;
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
  /** 构造已响应/已锁定回显卡片（只读信息卡可不提供）。 */
  buildAnsweredCard?(input: LarkOutputPluginAnsweredCardBuildInput<TInteraction>): Record<string, unknown>;
  /** 解析飞书回调载荷。 */
  parseAction?(
    spec: TSpec,
    action: string,
    value: Record<string, unknown>,
    formValue?: Record<string, unknown>
  ): ParsedLarkOutputPluginAction;
  /** 在主消息正文末尾附加的轻引导文案。 */
  trailingHintMarkdown?: string;
  /** 流式未闭合阶段替换裸 XML 的占位提示。 */
  streamingPlaceholderText?: string;
}
