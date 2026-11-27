import {
  normalizeOutputPluginId,
  type OutputPluginDefinition
} from '@agent-dock/agent-dock-shared';
import { askUserQuestionLarkAdapter } from './ask-user-question-adapter.js';
import { confirmActionLarkAdapter } from './confirm-action-adapter.js';
import { createDeclarativeLarkAdapter, LARK_DECLARATIVE_PLUGIN_ACTIONS } from './declarative-adapter.js';
import type { LarkOutputPluginAdapter } from './types.js';

/**
 * 飞书端纯 XML 交互插件适配器注册中心：
 * - 支持按插件 ID 显式注册定制 Schema 2.0 适配器（如 `builtin:ask-user-question`）；
 * - 对任意声明式扩展插件自动合成并缓存通用 Schema 2.0 适配器（零代码接入飞书双向卡片）。
 */
export class LarkOutputPluginAdapterRegistry {
  private readonly adapters = new Map<string, LarkOutputPluginAdapter<any, any>>();
  private readonly declarativeCache = new Map<string, { versionKey: string; adapter: LarkOutputPluginAdapter<any, any> }>();

  constructor(initialAdapters: ReadonlyArray<LarkOutputPluginAdapter<any, any>> = []) {
    for (const adapter of initialAdapters) {
      this.register(adapter);
    }
  }

  register<TSpec, TInteraction>(adapter: LarkOutputPluginAdapter<TSpec, TInteraction>): void {
    const id = normalizeOutputPluginId(adapter.pluginId);
    this.adapters.set(id, adapter);
  }

  resolve(plugin: OutputPluginDefinition): LarkOutputPluginAdapter | undefined {
    const id = normalizeOutputPluginId(plugin.id);
    const explicit = this.adapters.get(id);
    if (explicit) return explicit;
    if (plugin.declarative) {
      const versionKey = `${plugin.version}:${JSON.stringify(plugin.declarative)}`;
      const cached = this.declarativeCache.get(id);
      if (cached && cached.versionKey === versionKey) return cached.adapter;
      const built = createDeclarativeLarkAdapter(plugin);
      this.declarativeCache.set(id, { versionKey, adapter: built });
      return built;
    }
    return undefined;
  }

  isPluginCardAction(action: string, value: Record<string, unknown> = {}): boolean {
    if (LARK_DECLARATIVE_PLUGIN_ACTIONS.has(action)) return true;
    for (const adapter of this.adapters.values()) {
      if (adapter.handlesAction(action, value)) return true;
    }
    return false;
  }
}

export function createDefaultLarkOutputPluginAdapterRegistry(): LarkOutputPluginAdapterRegistry {
  return new LarkOutputPluginAdapterRegistry([
    askUserQuestionLarkAdapter,
    confirmActionLarkAdapter
  ]);
}

export const defaultLarkOutputPluginAdapterRegistry = createDefaultLarkOutputPluginAdapterRegistry();
