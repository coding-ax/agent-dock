import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createDeclarativeOutputPlugin,
  declarativeOutputPluginManifestSchema,
  type OutputPluginDefinition,
  type OutputPluginLoadWarning
} from '@agent-dock/agent-dock-shared';

export interface LocalOutputPluginsLoadResult {
  dir: string;
  exists: boolean;
  plugins: OutputPluginDefinition[];
  warnings: OutputPluginLoadWarning[];
}

export function resolveLocalOutputPluginsDir(options: {
  dir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  if (options.dir?.trim()) return resolve(options.dir.trim());
  const fromEnv = options.env?.AGENTDOCK_OUTPUT_PLUGINS_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  const home = options.env?.HOME?.trim() || homedir();
  return join(home, '.agentdock', 'output-plugins');
}

/**
 * 扫描本地声明式插件目录（默认 `~/.agentdock/output-plugins/*.json`）。
 * 单个文件损坏或 schema 非法不会影响其他插件或阻塞启动，而是汇总到 `warnings` 展示给用户排查。
 */
export function loadLocalDeclarativeOutputPlugins(options: {
  dir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): LocalOutputPluginsLoadResult {
  const dir = resolveLocalOutputPluginsDir(options);
  if (!existsSync(dir)) {
    return { dir, exists: false, plugins: [], warnings: [] };
  }

  let entries: string[];
  try {
    entries = readdirSync(dir)
      .filter(name => name.toLowerCase().endsWith('.json') && !name.startsWith('.'))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    return {
      dir,
      exists: true,
      plugins: [],
      warnings: [{
        file: dir,
        message: `读取插件目录失败：${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }

  const plugins: OutputPluginDefinition[] = [];
  const warnings: OutputPluginLoadWarning[] = [];

  for (const file of entries) {
    const fullPath = join(dir, file);
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(readFileSync(fullPath, 'utf8'));
    } catch (error) {
      warnings.push({
        file,
        message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }

    const parsed = declarativeOutputPluginManifestSchema.safeParse(rawJson);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(issue => `${issue.path.join('.') || 'manifest'} ${issue.message}`)
        .join('；');
      warnings.push({ file, message: `清单校验失败：${detail}` });
      continue;
    }

    try {
      const plugin = createDeclarativeOutputPlugin(parsed.data, {
        source: 'local',
        sourcePath: fullPath
      });
      plugins.push(plugin);
    } catch (error) {
      warnings.push({
        file,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { dir, exists: true, plugins, warnings };
}
