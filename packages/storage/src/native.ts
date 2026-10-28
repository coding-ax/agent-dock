import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * 原生 SQLite 的加载兜底。
 *
 * better-sqlite3 13 起把 8 个平台的 `.node` 直接打进 npm 包，并优先加载它们；同一版本又去掉了
 * `install: prebuild-install || node-gyp rebuild`。结果是安装期不再有"下载不到就本地编译"的兜底：
 * 这份预编译产物按 glibc ≥ 2.34 / GLIBCXX ≥ 3.4.29 编，Debian 10（glibc 2.28 / GCC 8）这类老机器
 * 安装会成功，但进程一打开数据库就 ERR_DLOPEN_FAILED，且每次更新都会把同一个不可用的产物放回来。
 *
 * 这里的策略：默认路径照旧（新机器行为完全不变），只有默认加载失败、且随包带了与之版本一致的
 * 老 glibc 基线产物时，才带 `nativeBinding` 重试一次。
 */
export interface NativeBindingFallback {
  /** 兜底 `.node` 的绝对路径。 */
  path: string;
  /** 该产物对应的 better-sqlite3 版本；与已安装版本不一致时不用，避免 addon 与 JS 侧错配。 */
  version: string;
}

export interface OpenDatabaseOptions {
  fallback?: NativeBindingFallback;
  /** 仅测试注入：替代 `new Database(filename, options)`。 */
  create?: (options?: Database.Options) => Database.Database;
}

let configuredFallback: NativeBindingFallback | undefined;
const localRequire = createRequire(import.meta.url);

/** 由应用入口（packages 之外、知道打包布局的一侧）注册随包产物；不注册就只走默认加载。 */
export function configureNativeFallback(fallback?: NativeBindingFallback): void {
  configuredFallback = fallback;
}

/** 已安装的 better-sqlite3 版本与目录；解析不到时返回 undefined（此时不使用兜底产物）。 */
export function installedBetterSqlite(): { version: string; dir: string } | undefined {
  try {
    const entry = localRequire.resolve('better-sqlite3/package.json');
    const version = (JSON.parse(readFileSync(entry, 'utf8')) as { version?: string }).version;
    return version ? { dir: dirname(entry), version } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 打开数据库。默认路径失败且错误是原生加载失败时，用兜底产物重试一次；重试仍失败则抛原始错误
 * 并附上中文诊断，不再抛重试的那条（重试错误与原始错误同源，只会更难读）。
 */
export function openDatabase(filename: string, options: OpenDatabaseOptions = {}): Database.Database {
  const create = options.create ?? ((sqliteOptions?: Database.Options) => new Database(filename, sqliteOptions));
  try {
    return create();
  } catch (error) {
    // 只接管原生加载失败：库文件损坏、只读、权限这类错误重试一次没有意义，也不该盖掉原始错误。
    if (errorCode(error) !== 'ERR_DLOPEN_FAILED') throw error;
    const requested = options.fallback ?? configuredFallback;
    const usable = usableFallback(requested);
    if (!usable) throw nativeLoadError(error, requested, false);
    try {
      return create({ nativeBinding: usable.path });
    } catch {
      throw nativeLoadError(error, requested, true);
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code ?? undefined;
}

/** 产物存在、且与已安装版本一致才可用——版本不一致宁可退回原始错误，也不拿旧产物硬顶。 */
function usableFallback(fallback?: NativeBindingFallback): NativeBindingFallback | undefined {
  if (!fallback || !existsSync(fallback.path)) return undefined;
  return installedBetterSqlite()?.version === fallback.version ? fallback : undefined;
}

/** 预编译产物在包内的相对路径；deno/其他运行时不会走到这里，只按 node 的平台命名。 */
function prebuildRelativePath(): string {
  const arch = process.arch;
  if (process.platform === 'linux') return join('prebuilds', `${hasGlibc() ? 'linux' : 'linuxmusl'}-${arch}.node`);
  return join('prebuilds', `${process.platform}-${arch}.node`);
}

function hasGlibc(): boolean {
  try {
    // @types/node 把 getReport() 的 header 收窄成 object，这里按 libuv 的实际字段取。
    const header = (process.report?.getReport() as { header?: Record<string, string> } | undefined)?.header;
    return Boolean(header?.glibcVersionRuntime);
  } catch {
    return false;
  }
}

/**
 * 启动失败的诊断。这段文本会直接打给用户，所以给的是可执行的处置，而不是"联系管理员"。
 * 机器标识（错误码、路径、库名）保持原文，便于检索。
 */
function nativeLoadError(error: unknown, requested: NativeBindingFallback | undefined, retried: boolean): Error {
  const installed = installedBetterSqlite();
  const lines = [
    `better-sqlite3 的原生产物无法加载：${error instanceof Error ? error.message : String(error)}`,
    '',
    '最常见的原因是宿主 glibc / libstdc++ 太旧：better-sqlite3 随包分发的预编译产物要求 glibc ≥ 2.34、libstdc++ ≥ GLIBCXX_3.4.29，',
    '而 Debian 10 只有 glibc 2.28 / GLIBCXX 3.4.25。这种机器安装会成功，启动才会失败。'
  ];
  if (!requested) lines.push('本机没有可用的随包兜底产物（平台不在支持列表内，或产物缺失）。');
  else if (!retried) lines.push(`随包兜底产物不适用：${requested.path}（文件缺失，或版本与已安装的 better-sqlite3 ${installed?.version ?? '未知'} 不一致）。`);
  else lines.push(`已尝试随包兜底产物 ${requested.path}，仍然加载失败。`);
  if (installed) {
    lines.push(
      '',
      '临时处置：在该机器上手工编译当前依赖，然后重启 daemon ——',
      `  cd ${installed.dir}`,
      `  rm -f ${prebuildRelativePath()}`,
      "  sed -i 's/-std=c++20/-std=c++2a/' binding.gyp   # 仅 g++ 低于 10 时需要",
      '  npx --yes node-gyp@9 rebuild --release'
    );
  }
  return new Error(lines.join('\n'), { cause: error });
}
