import type { ReactNode } from 'react';
import {
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  normalizeOutputPluginId,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionAnswerPayload,
  type AskUserQuestionSpec,
  type ConfirmActionInteractionPayload,
  type ConfirmActionSpec,
  type DeclarativeOutputPluginInteractionPayload,
  type DeclarativeOutputPluginSpec,
  type OutputPluginMetadata
} from '@agent-dock/agent-dock-shared';
import {
  AskUserQuestionAnswerCard,
  AskUserQuestionCard,
  AskUserQuestionStreamingPlaceholder
} from '../AskUserQuestionCard';
import {
  ConfirmActionCard,
  ConfirmActionInteractionCard,
  ConfirmActionStreamingPlaceholder,
  type ConfirmActionInteractInput
} from './ConfirmActionCard';
import {
  DeclarativeOutputPluginCard,
  DeclarativeOutputPluginInteractionCard,
  DeclarativeOutputPluginStreamingPlaceholder,
  type DeclarativeCardInteractPayload
} from './DeclarativeOutputPluginCard';
import type { WebOutputPluginCardProps, WebOutputPluginRenderer } from './types';

/** 内置插件 #1（`builtin:ask-user-question`）的专属 Web 交互渲染器，无损复用既有卡片与 Q&A 回显组件。 */
export const askUserQuestionWebRenderer: WebOutputPluginRenderer<
  AskUserQuestionSpec,
  AskUserQuestionAnswerPayload
> = {
  pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  renderCard({ spec, answered, disabled, disabledReason, submitting, error, onInteract }) {
    return (
      <AskUserQuestionCard
        spec={spec}
        answered={answered}
        disabled={disabled}
        disabledReason={disabledReason}
        submitting={submitting}
        error={error}
        onSubmit={onInteract
          ? (answers: AskUserQuestionAnswerItem[]) => onInteract({ answers })
          : undefined}
      />
    );
  },
  renderStreamingPlaceholder({ title }) {
    return <AskUserQuestionStreamingPlaceholder title={title}/>;
  },
  renderInteractionTurn({ payload, timestamp }) {
    return <AskUserQuestionAnswerCard payload={payload} timestamp={timestamp}/>;
  }
};

/** 内置插件 #2（`builtin:confirm-action`）的专属 Web 交互渲染器（高风险操作确认卡 + 回显轮次）。 */
export const confirmActionWebRenderer: WebOutputPluginRenderer<
  ConfirmActionSpec,
  ConfirmActionInteractionPayload
> = {
  pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  renderCard({ spec, answered, disabled, disabledReason, submitting, error, onInteract }) {
    return (
      <ConfirmActionCard
        spec={spec}
        answered={answered}
        disabled={disabled}
        disabledReason={disabledReason}
        submitting={submitting}
        error={error}
        onInteract={onInteract
          ? (input: ConfirmActionInteractInput) => onInteract(input)
          : undefined}
      />
    );
  },
  renderStreamingPlaceholder({ title }) {
    return <ConfirmActionStreamingPlaceholder title={title}/>;
  },
  renderInteractionTurn({ payload, timestamp }) {
    return <ConfirmActionInteractionCard payload={payload} timestamp={timestamp}/>;
  }
};

/** 通用声明式插件 Web 渲染器（自动服务所有通过 JSON 清单加载的社区/本地插件）。 */
const declarativeFallbackWebRenderer: WebOutputPluginRenderer<
  DeclarativeOutputPluginSpec,
  DeclarativeOutputPluginInteractionPayload
> = {
  pluginId: '__declarative__',
  renderCard({ plugin, spec, answered, disabled, disabledReason, submitting, error, onInteract }) {
    return (
      <DeclarativeOutputPluginCard
        plugin={plugin}
        spec={spec}
        answered={answered}
        disabled={disabled}
        disabledReason={disabledReason}
        submitting={submitting}
        error={error}
        onInteract={onInteract
          ? (input: DeclarativeCardInteractPayload) => onInteract(input)
          : undefined}
      />
    );
  },
  renderStreamingPlaceholder({ plugin, title }) {
    return <DeclarativeOutputPluginStreamingPlaceholder plugin={plugin} title={title}/>;
  },
  renderInteractionTurn({ plugin, payload, timestamp }) {
    return <DeclarativeOutputPluginInteractionCard plugin={plugin} payload={payload} timestamp={timestamp}/>;
  }
};

/**
 * Web 端交互插件渲染注册中心：
 * - 允许内置或代码插件按 `pluginId` 注册自定义 React 交互卡片与回显轮次组件；
 * - 未显式注册的声明式插件自动落到 `declarativeFallbackWebRenderer`，实现零代码热插拔。
 */
export class WebOutputPluginRendererRegistry {
  private readonly renderers = new Map<string, WebOutputPluginRenderer<any, any>>();

  constructor(initial: ReadonlyArray<WebOutputPluginRenderer<any, any>> = []) {
    for (const renderer of initial) {
      this.register(renderer);
    }
  }

  register<TSpec, TInteraction>(renderer: WebOutputPluginRenderer<TSpec, TInteraction>): void {
    this.renderers.set(normalizeOutputPluginId(renderer.pluginId), renderer);
  }

  resolve(plugin: OutputPluginMetadata): WebOutputPluginRenderer<any, any> | undefined {
    const explicit = this.renderers.get(normalizeOutputPluginId(plugin.id));
    if (explicit) return explicit;
    if (plugin.declarative) return declarativeFallbackWebRenderer;
    return undefined;
  }

  renderCard(props: WebOutputPluginCardProps): ReactNode {
    const renderer = this.resolve(props.plugin);
    return renderer ? renderer.renderCard(props) : null;
  }

  renderStreamingPlaceholder(plugin: OutputPluginMetadata, title?: string): ReactNode {
    const renderer = this.resolve(plugin);
    if (renderer?.renderStreamingPlaceholder) {
      return renderer.renderStreamingPlaceholder({ plugin, title });
    }
    return <DeclarativeOutputPluginStreamingPlaceholder plugin={plugin} title={title}/>;
  }

  renderInteractionTurn(plugin: OutputPluginMetadata, payload: unknown, timestamp: string): ReactNode {
    const renderer = this.resolve(plugin);
    if (renderer?.renderInteractionTurn) {
      return renderer.renderInteractionTurn({ plugin, payload, timestamp });
    }
    return null;
  }
}

export function createDefaultWebOutputPluginRendererRegistry(): WebOutputPluginRendererRegistry {
  return new WebOutputPluginRendererRegistry([
    askUserQuestionWebRenderer,
    confirmActionWebRenderer
  ]);
}

export const defaultWebOutputPluginRendererRegistry = createDefaultWebOutputPluginRendererRegistry();
