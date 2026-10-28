import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_PACKAGE_NAME = '@agent-dock/cli';

export interface AgentDockUpdateOptions {
  distTag?: string;
}

export interface AgentDockUpdateResult {
  action: 'update';
  packageName: string;
  distTag: string;
  previousVersion: string;
  version: string;
  updated: boolean;
  restarted: true;
}

export interface AgentDockUpdateDependencies {
  runNpm(args: string[]): Promise<string>;
  restart(installedEntrypoint: string): Promise<void>;
  packageName?: string;
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const defaultRunNpm = async (args: string[]) => {
  const { stdout } = await execFileAsync(npmCommand, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return stdout;
};

export function normalizeDistTag(value?: string): string {
  const tag = value?.trim() || 'latest';
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(tag)) {
    throw new Error(`Invalid npm dist-tag: ${JSON.stringify(tag)}. Use a name such as latest, fix, beta, or next.`);
  }
  return tag;
}

const json = (raw: string, label: string): any => {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`npm returned invalid JSON while reading ${label}.`);
  }
};

const publishedVersion = (raw: string): string => {
  const value = json(raw, 'the dist-tag version');
  if (typeof value !== 'string' || !value.trim()) throw new Error('The selected npm dist-tag did not resolve to a version.');
  return value.trim();
};

const installedVersion = (raw: string, packageName: string): string => {
  const value = json(raw, 'the installed package version')?.dependencies?.[packageName]?.version;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`npm did not report an installed version for ${packageName}.`);
  return value.trim();
};

export async function updateAgentDock(
  currentVersion: string,
  options: AgentDockUpdateOptions,
  dependencies: AgentDockUpdateDependencies
): Promise<AgentDockUpdateResult> {
  const packageName = dependencies.packageName ?? DEFAULT_PACKAGE_NAME;
  const distTag = normalizeDistTag(options.distTag);
  const targetVersion = publishedVersion(await dependencies.runNpm(['view', `${packageName}@${distTag}`, 'version', '--json']));
  await dependencies.runNpm(['install', '--global', `${packageName}@${distTag}`]);
  const version = installedVersion(await dependencies.runNpm(['list', '--global', packageName, '--depth=0', '--json']), packageName);
  if (version !== targetVersion) {
    throw new Error(`AgentDock update verification failed: ${distTag} resolved to ${targetVersion}, but npm installed ${version}. The service was not restarted.`);
  }
  const globalRoot = (await dependencies.runNpm(['root', '--global'])).trim();
  if (!globalRoot) throw new Error('npm did not report its global package directory. The service was not restarted.');
  await dependencies.restart(resolve(globalRoot, packageName, 'dist/cli.js'));
  return {
    action: 'update', packageName, distTag, previousVersion: currentVersion,
    version, updated: version !== currentVersion, restarted: true
  };
}

export const runNpmForAgentDockUpdate = defaultRunNpm;

/**
 * 按 semver 比较版本（含预发布段）：a<b 返回负数，相等 0，a>b 正数。
 * 只判断「是否不相等」不够：本地 npm pack 装的版本可能比 registry 上的高，那种情况不能提示升级，否则一点就降级。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = '', pre] = value.trim().replace(/^v/, '').split('+')[0]!.split(/-(.*)/s);
    return { core: core.split('.').map(part => Number(part) || 0), pre: pre ? pre.split('.') : [] };
  };
  const left = parse(a); const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff) return diff;
  }
  // 无预发布段的正式版高于同号预发布版。
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const l = left.pre[i]; const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l); const rn = /^\d+$/.test(r);
    if (ln && rn) { const diff = Number(l) - Number(r); if (diff) return diff; continue; }
    if (ln !== rn) return ln ? -1 : 1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** 当前版本所在的发布流：`0.4.60-beta.20261014.1` → beta，无预发布段 → latest。 */
export function distTagForVersion(version: string): string {
  const pre = /^[^-+]+-([a-zA-Z][a-zA-Z0-9_-]*)/.exec(version.trim())?.[1];
  return pre ? normalizeDistTag(pre) : 'latest';
}
