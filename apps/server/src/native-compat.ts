import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeBindingFallback } from '@agent-dock/agent-dock-storage';

/**
 * 随包分发的原生兜底产物（见 packages/storage/src/native.ts 的说明）。
 *
 * 打包布局的知识留在这一侧：产物随构建从 `vendor/native` 复制到 `dist/vendor/native`，
 * 所以按模块位置往上找两级，源码运行（apps/server/src）和构建产物（apps/server/dist）都能命中。
 */
export interface NativeManifestEntry {
  /** 相对 manifest 所在目录的 .node 路径。 */
  file: string;
  /** 该产物由哪个 better-sqlite3 版本编译；必须与安装到的版本一致才启用。 */
  version: string;
  /** 产物对宿主的符号基线要求，便于排查时对照。 */
  requires?: Record<string, string>;
  builtFrom?: string;
}

interface NativeManifest {
  package: string;
  targets: Record<string, NativeManifestEntry>;
}

export interface PackagedNativeFallback extends NativeBindingFallback {
  requires?: Record<string, string>;
  builtFrom?: string;
}

const manifestCandidates = ['./vendor/native/better-sqlite3.json', '../vendor/native/better-sqlite3.json'];

/** 主机目标三元组：与 manifest 的 key、better-sqlite3 的 prebuilds 命名一致。 */
export function nativeTarget(platform: string = process.platform, arch: string = process.arch, musl = isMusl()): string {
  return `${platform === 'linux' && musl ? 'linuxmusl' : platform}-${arch}`;
}

function isMusl(): boolean {
  try {
    // @types/node 把 getReport() 的 header 收窄成 object，这里按 libuv 的实际字段取。
    const header = (process.report?.getReport() as { header?: Record<string, string> } | undefined)?.header;
    return process.platform === 'linux' && !header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/** 读 manifest；不存在或格式不对返回 undefined（此时按"没有随包产物"处理）。 */
export function readNativeManifest(urls: string[] = manifestCandidates): { manifest: NativeManifest; dir: string } | undefined {
  for (const candidate of urls) {
    const file = fileURLToPath(new URL(candidate, import.meta.url));
    try {
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as NativeManifest;
      return { manifest, dir: dirname(file) };
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * 当前机器可用的随包兜底产物。产物缺失或该平台没编过就返回 undefined —— 宁可不开兜底，
 * 也不要给出一条指向不存在文件的路径。
 */
export function packagedNativeFallback(target: string = nativeTarget()): PackagedNativeFallback | undefined {
  const found = readNativeManifest();
  const entry = found?.manifest.targets[target];
  if (!found || !entry) return undefined;
  const path = resolve(join(found.dir, entry.file));
  if (!existsSync(path)) return undefined;
  return { path, version: entry.version, ...(entry.requires ? { requires: entry.requires } : {}), ...(entry.builtFrom ? { builtFrom: entry.builtFrom } : {}) };
}
