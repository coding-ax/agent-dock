import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  createDeclarativeOutputPlugin,
  createDefaultOutputPluginRegistry,
  defaultOutputPluginRegistry,
  resolveOutputPluginEnabled,
  type OutputPluginCatalogItem,
  type OutputPluginRegistry,
  type OutputPluginsGlobalConfig,
  type SessionOutputPluginsMap
} from '@agent-dock/agent-dock-shared';
import { api } from '../api';

export const OUTPUT_PLUGINS_QUERY_KEY = ['output-plugins'] as const;

/** 在服务端目录未返回前（或离线单测 SSR 时）使用的默认内置插件目录快照。 */
export function buildFallbackOutputPluginCatalogItems(): OutputPluginCatalogItem[] {
  return defaultOutputPluginRegistry.listMetadata().map(meta => ({
    ...meta,
    globalEnabled: meta.defaultEnabled
  }));
}

/** 将服务端下发的声明式扩展插件与本地内置插件拼装成完整的客户端 `OutputPluginRegistry`。 */
export function buildClientOutputPluginRegistry(
  catalogPlugins?: ReadonlyArray<OutputPluginCatalogItem>
): OutputPluginRegistry {
  if (!catalogPlugins?.some(item => !item.builtin && item.declarative)) {
    return defaultOutputPluginRegistry;
  }
  const registry = createDefaultOutputPluginRegistry();
  for (const item of catalogPlugins) {
    if (item.builtin || !item.declarative) continue;
    try {
      registry.register(createDeclarativeOutputPlugin(item.declarative, {
        source: item.source,
        sourcePath: item.sourcePath
      }));
    } catch { /* 忽略客户端异常条目，不阻塞渲染 */ }
  }
  return registry;
}

/** 根据全局默认 + 会话级覆写计算本会话已启用的全部插件 ID 集合。 */
export function resolveSessionEnabledOutputPluginIds(
  plugins: ReadonlyArray<Pick<OutputPluginCatalogItem, 'id' | 'defaultEnabled' | 'globalEnabled'>>,
  globalConfig?: OutputPluginsGlobalConfig | null,
  sessionOverrides?: SessionOutputPluginsMap | null,
  legacySessionAskEnabled?: boolean | null
): Set<string> {
  const enabled = new Set<string>();
  for (const plugin of plugins) {
    const active = resolveOutputPluginEnabled(plugin.id, {
      defaultEnabled: plugin.globalEnabled ?? plugin.defaultEnabled,
      globalConfig,
      sessionOverrides,
      legacySessionAskEnabled
    });
    if (active) enabled.add(plugin.id);
  }
  return enabled;
}

/** 订阅服务端交互插件目录（含内置插件、本地声明式插件与全局默认状态）。 */
export function useOutputPluginsCatalog(enabled = true) {
  const query = useQuery({
    queryKey: OUTPUT_PLUGINS_QUERY_KEY,
    queryFn: api.outputPlugins,
    enabled,
    retry: false,
    refetchOnWindowFocus: false
  });

  const plugins = useMemo(
    () => query.data?.plugins ?? buildFallbackOutputPluginCatalogItems(),
    [query.data?.plugins]
  );

  const registry = useMemo(
    () => buildClientOutputPluginRegistry(query.data?.plugins),
    [query.data?.plugins]
  );

  const globalConfig = useMemo<OutputPluginsGlobalConfig>(() => {
    if (query.data?.config) return query.data.config;
    const map: Record<string, boolean> = {};
    for (const plugin of plugins) {
      map[plugin.id] = plugin.globalEnabled;
    }
    return { plugins: map };
  }, [query.data?.config, plugins]);

  const enabledCount = useMemo(
    () => plugins.filter(plugin => plugin.globalEnabled).length,
    [plugins]
  );

  const askUserQuestionGlobalEnabled = resolveOutputPluginEnabled(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID, {
    defaultEnabled: true,
    globalConfig
  });

  return {
    query,
    catalog: query.data,
    plugins,
    registry,
    globalConfig,
    enabledCount,
    totalCount: plugins.length,
    askUserQuestionGlobalEnabled
  };
}
