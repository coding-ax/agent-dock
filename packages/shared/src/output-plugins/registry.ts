import { askUserQuestionOutputPlugin } from './ask-user-question-plugin.js';
import { confirmActionOutputPlugin } from './confirm-action-plugin.js';
import { richBlocksOutputPlugin } from './rich-blocks-plugin.js';
import {
  normalizeOutputPluginId,
  resolvePluginPromptInstruction,
  type OutputPluginDefinition,
  type OutputPluginMetadata,
  type OutputPluginParseResult,
  type OutputPluginStreamingSplit
} from './types.js';
import { detectPendingStreamingXmlTag, maskProtectedMarkdown } from './xml-utils.js';

export interface ParsedOutputPluginInteraction {
  plugin: OutputPluginDefinition;
  payload: unknown;
  instanceId: string;
}

/**
 * 纯 XML 输出交互插件注册中心：
 * - 管理全部内置插件与社区/本地声明式扩展插件；
 * - 强制插件 ID 与 XML `tagName` 唯一，防止冲突劫持；
 * - 提供统一的末尾 XML 提取、流式未闭合探测与交互事件反查路由。
 */
export class OutputPluginRegistry {
  private readonly pluginsById = new Map<string, OutputPluginDefinition>();
  private readonly pluginsByTag = new Map<string, OutputPluginDefinition>();
  private readonly pluginsByOrigin = new Map<string, OutputPluginDefinition>();

  constructor(initialPlugins: ReadonlyArray<OutputPluginDefinition<any, any>> = []) {
    for (const plugin of initialPlugins) {
      this.register(plugin);
    }
  }

  register<TSpec, TInteraction>(plugin: OutputPluginDefinition<TSpec, TInteraction>): void {
    const id = normalizeOutputPluginId(plugin.id);
    const tagLower = plugin.tagName.trim().toLowerCase();
    if (!id) throw new Error('Output plugin id must not be empty');
    if (!tagLower) throw new Error(`Output plugin ${id} must declare a non-empty tagName`);

    const existingId = this.pluginsById.get(id);
    if (existingId) {
      throw new Error(`Duplicate output plugin id: ${id}`);
    }
    const existingTag = this.pluginsByTag.get(tagLower);
    if (existingTag) {
      throw new Error(`Output plugin tagName <${plugin.tagName}> conflicts with existing plugin ${existingTag.id}`);
    }
    if (plugin.interactionOrigin) {
      const existingOrigin = this.pluginsByOrigin.get(plugin.interactionOrigin);
      if (existingOrigin) {
        throw new Error(`Output plugin interactionOrigin "${plugin.interactionOrigin}" conflicts with existing plugin ${existingOrigin.id}`);
      }
    }

    const normalizedPlugin = (id === plugin.id ? plugin : { ...plugin, id }) as OutputPluginDefinition;
    this.pluginsById.set(id, normalizedPlugin);
    this.pluginsByTag.set(tagLower, normalizedPlugin);
    if (normalizedPlugin.interactionOrigin) {
      this.pluginsByOrigin.set(normalizedPlugin.interactionOrigin, normalizedPlugin);
    }
  }

  unregister(pluginId: string): boolean {
    const id = normalizeOutputPluginId(pluginId);
    const existing = this.pluginsById.get(id);
    if (!existing || existing.builtin) return false;
    this.pluginsById.delete(id);
    this.pluginsByTag.delete(existing.tagName.trim().toLowerCase());
    if (existing.interactionOrigin) {
      this.pluginsByOrigin.delete(existing.interactionOrigin);
    }
    return true;
  }

  /**
   * 原子替换全部非内置扩展插件（供本地目录热重载或前端同步远端声明式插件使用）。
   * 保留所有内置插件不动，并自动跳过与内置插件或彼此冲突的非法项。
   */
  replaceExternalPlugins(
    plugins: ReadonlyArray<OutputPluginDefinition<any, any>>
  ): { loaded: OutputPluginDefinition[]; skipped: Array<{ id: string; reason: string }> } {
    for (const existing of [...this.pluginsById.values()]) {
      if (!existing.builtin) {
        this.unregister(existing.id);
      }
    }
    const loaded: OutputPluginDefinition[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const plugin of plugins) {
      if (plugin.builtin) {
        skipped.push({ id: plugin.id, reason: '外部插件不允许声明 builtin=true' });
        continue;
      }
      try {
        this.register(plugin);
        loaded.push(this.get(plugin.id)!);
      } catch (error) {
        skipped.push({
          id: plugin.id,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { loaded, skipped };
  }

  get(pluginId: string): OutputPluginDefinition | undefined {
    return this.pluginsById.get(normalizeOutputPluginId(pluginId));
  }

  has(pluginId: string): boolean {
    return this.pluginsById.has(normalizeOutputPluginId(pluginId));
  }

  getByTagName(tagName: string): OutputPluginDefinition | undefined {
    return this.pluginsByTag.get(tagName.trim().toLowerCase());
  }

  getByInteractionOrigin(origin: string | null | undefined): OutputPluginDefinition | undefined {
    if (!origin) return undefined;
    return this.pluginsByOrigin.get(origin);
  }

  list(): OutputPluginDefinition[] {
    return [...this.pluginsById.values()].sort((left, right) => {
      if (left.builtin !== right.builtin) return left.builtin ? -1 : 1;
      return left.id.localeCompare(right.id);
    });
  }

  listMetadata(): Array<OutputPluginMetadata & { promptInstruction: string }> {
    return this.list().map(plugin => ({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      icon: plugin.icon,
      tagName: plugin.tagName,
      ...(plugin.syntaxKind ? { syntaxKind: plugin.syntaxKind } : {}),
      defaultEnabled: plugin.defaultEnabled,
      version: plugin.version,
      builtin: plugin.builtin,
      source: plugin.source,
      capabilities: { ...plugin.capabilities },
      ...(plugin.protocolExample ? { protocolExample: plugin.protocolExample } : {}),
      ...(plugin.interactionOrigin ? { interactionOrigin: plugin.interactionOrigin } : {}),
      ...(plugin.declarative ? { declarative: plugin.declarative } : {}),
      ...(plugin.sourcePath ? { sourcePath: plugin.sourcePath } : {}),
      promptInstruction: resolvePluginPromptInstruction(plugin)
    }));
  }

  private resolveCandidates(enabledPluginIds?: ReadonlySet<string>): OutputPluginDefinition[] {
    const all = this.list();
    if (!enabledPluginIds) return all;
    if (enabledPluginIds.size === 0) return [];
    const normalized = new Set<string>();
    for (const id of enabledPluginIds) normalized.add(normalizeOutputPluginId(id));
    return all.filter(plugin => normalized.has(plugin.id));
  }

  /**
   * 从助手回答末尾解析匹配任一已启用插件的完整 XML 块。
   * 只需做一次 Markdown 围栏掩码，即可 O(N) 扫描全部已启用插件。
   */
  parseTrailingOutput(
    text: string | null | undefined,
    enabledPluginIds?: ReadonlySet<string>
  ): OutputPluginParseResult | null {
    if (!text) return null;
    const candidates = this.resolveCandidates(enabledPluginIds)
      .filter(plugin => plugin.syntaxKind !== 'markdown-blocks');
    if (!candidates.length) return null;

    const lower = text.toLowerCase();
    const possible = candidates.filter(plugin => lower.includes(plugin.tagName.toLowerCase()));
    if (!possible.length) return null;

    const masked = maskProtectedMarkdown(text);
    for (const plugin of possible) {
      const parsed = plugin.parseOutput(text, masked);
      if (parsed) return parsed;
    }
    return null;
  }

  /**
   * 统一流式/终态拆分器：
   * - 末尾已有完整有效插件 XML 块 -> `kind: 'complete'`
   * - 流式阶段末尾出现任一已启用插件未闭合标签或 `<agentd...` 前缀 -> `kind: 'pending'`
   * - 否则 -> `kind: 'none'`
   */
  splitStreamingOutput(
    text: string | null | undefined,
    streaming: boolean,
    enabledPluginIds?: ReadonlySet<string>
  ): OutputPluginStreamingSplit {
    if (!text) return { kind: 'none', proseText: '' };
    const candidates = this.resolveCandidates(enabledPluginIds)
      .filter(plugin => plugin.syntaxKind !== 'markdown-blocks');
    if (!candidates.length) return { kind: 'none', proseText: text };

    const masked = maskProtectedMarkdown(text);
    const lower = text.toLowerCase();
    for (const plugin of candidates) {
      if (!lower.includes(plugin.tagName.toLowerCase())) continue;
      const parsed = plugin.parseOutput(text, masked);
      if (parsed) {
        return {
          kind: 'complete',
          pluginId: parsed.pluginId,
          tagName: parsed.tagName,
          proseText: parsed.proseText,
          spec: parsed.spec,
          rawXml: parsed.rawXml
        };
      }
    }

    if (!streaming) return { kind: 'none', proseText: text };

    // 优先匹配已出现完整标签名的插件；其次匹配刚吐到 `<agentd...` 前缀的插件
    let fallbackPrefixMatch: OutputPluginStreamingSplit | null = null;
    for (const plugin of candidates) {
      if (!plugin.capabilities.streamingPlaceholder) continue;
      const pending = detectPendingStreamingXmlTag(text, plugin.tagName, masked);
      if (!pending) continue;
      const hit: OutputPluginStreamingSplit = {
        kind: 'pending',
        pluginId: plugin.id,
        tagName: plugin.tagName,
        proseText: pending.proseText,
        ...(pending.partialTitle ? { partialTitle: pending.partialTitle } : {})
      };
      if (pending.exactTag) return hit;
      if (!fallbackPrefixMatch) fallbackPrefixMatch = hit;
    }

    return fallbackPrefixMatch ?? { kind: 'none', proseText: text };
  }

  /** 按事件/任务 `origin` 反查归属插件并解析结构化交互回传载荷。 */
  parseInteractionEvent(
    origin: string | null | undefined,
    text: string | null | undefined
  ): ParsedOutputPluginInteraction | null {
    const plugin = this.getByInteractionOrigin(origin);
    if (!plugin || !plugin.parseInteraction || !plugin.getInteractionInstanceId) return null;
    const payload = plugin.parseInteraction(text);
    if (!payload) return null;
    return {
      plugin,
      payload,
      instanceId: plugin.getInteractionInstanceId(payload)
    };
  }
}

export const BUILTIN_OUTPUT_PLUGINS: ReadonlyArray<OutputPluginDefinition<any, any>> = [
  askUserQuestionOutputPlugin,
  confirmActionOutputPlugin,
  richBlocksOutputPlugin
];

export function createDefaultOutputPluginRegistry(): OutputPluginRegistry {
  return new OutputPluginRegistry(BUILTIN_OUTPUT_PLUGINS);
}

/** 进程默认只读内置注册表（Web/Server 无自定义扩展时的轻量默认实例）。 */
export const defaultOutputPluginRegistry = createDefaultOutputPluginRegistry();
