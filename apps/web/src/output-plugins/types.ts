import type { ReactNode } from 'react';
import type { OutputPluginMetadata } from '@agent-dock/agent-dock-shared';

export interface WebOutputPluginCardProps<TSpec = unknown, TInteraction = unknown> {
  plugin: OutputPluginMetadata;
  spec: TSpec;
  answered?: TInteraction;
  disabled?: boolean;
  disabledReason?: string;
  submitting?: boolean;
  error?: string;
  onInteract?(input: unknown): void | Promise<void>;
}

export interface WebOutputPluginStreamingPlaceholderProps {
  plugin: OutputPluginMetadata;
  title?: string;
}

export interface WebOutputPluginInteractionTurnProps<TInteraction = unknown> {
  plugin: OutputPluginMetadata;
  payload: TInteraction;
  timestamp: string;
}

/**
 * Web 端纯 XML 输出插件渲染契约：
 * - `renderCard`：助手轮次末尾的交互卡片或只读展示卡片；
 * - `renderStreamingPlaceholder`：流式未闭合 XML 阶段的轻盈占位；
 * - `renderInteractionTurn`：用户交互回传轮次的专属视觉回显卡片。
 */
export interface WebOutputPluginRenderer<TSpec = unknown, TInteraction = unknown> {
  readonly pluginId: string;
  renderCard(props: WebOutputPluginCardProps<TSpec, TInteraction>): ReactNode;
  renderStreamingPlaceholder?(props: WebOutputPluginStreamingPlaceholderProps): ReactNode;
  renderInteractionTurn?(props: WebOutputPluginInteractionTurnProps<TInteraction>): ReactNode;
}
