import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_CWD_ENV, DAEMON_ENV_FLAG, DAEMON_STARTED_AT_ENV } from './daemon/daemon.js';

/**
 * `agent-dock dev`：用当前源码的构建产物起一个完全隔离的 daemon，给「Agent 迭代 AgentDock 自己」做验证。
 *
 * 隔离靠三样东西，缺一不可：
 * - 独立 HOME：daemon 的「上次启动目录」指针写在 $HOME/.agentdock 下，共用会把用户的 agent-dock status/restart
 *   指到沙箱上；
 * - 独立工作目录与数据库：不碰正在用的 agentdock.db；
 * - 独立端口，关掉飞书监听：不和正式实例抢同一个机器人的消息。
 * 另外 PATH 最前面垫一个 bin/agent-dock，指向同一份构建：沙箱里跑的 Agent（主会话派活、侧边会话汇报）
 * 调 agent-dock 时用的是正在验证的代码，而不是全局装的旧版本。
 * 状态放在 仓库/.agentdock/dev/，已在 .gitignore 里；不同仓库各自一份。
 */

export interface DevSandbox {
  root: string;
  home: string;
  work: string;
  database: string;
  entrypoint: string;
  port: number;
}

export interface DevOptions {
  /** 仓库根目录；默认从当前目录往上找含 apps/server 的目录。 */
  repo?: string;
  port?: number;
  /** 测试用：替换子进程执行。 */
  run?: (args: string[], env: NodeJS.ProcessEnv, cwd: string, inherit: boolean) => { status: number | null; stdout: string };
}

const SANDBOX_FILE = 'sandbox.json';

export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'apps', 'server', 'package.json')) && existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('找不到 agent-dock 源码仓库。请在仓库目录下运行 agent-dock dev，或用 --repo 指定。');
    dir = parent;
  }
}

export function sandboxPaths(repo: string, port: number): DevSandbox {
  const root = join(repo, '.agentdock', 'dev');
  return { root, home: join(root, 'home'), work: join(root, 'work'), database: join(root, 'agentdock.db'), entrypoint: join(repo, 'apps', 'server', 'dist', 'cli.js'), port };
}

/** 沙箱里运行 CLI 的环境：独立 HOME，去掉会把命令引回正式实例的变量。 */
const shimDir = (sandbox: DevSandbox) => join(sandbox.root, 'bin');

export function sandboxEnv(sandbox: DevSandbox, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, HOME: sandbox.home, AGENTDOCK_DISABLE_LARK_LISTENER: 'true', AGENTDOCK_WEB_AUTH: 'off', agentdock_database: sandbox.database };
  env.PATH = [shimDir(sandbox), base.PATH].filter(Boolean).join(delimiter);
  // 这些是正式实例注入给当前 Agent 的：带进沙箱会让 session/group 类命令打到正式实例上。
  for (const key of ['agentdock_session_id', 'agentdock_group_tools_url', 'agentdock_group_tools_token']) delete env[key];
  // Agent 跑在正式 daemon 的子进程树里，会继承它的 daemon 标记；带进去后沙箱的 `daemon start` 会把自己当成 daemon 本体，
  // 直接在前台起服务（dev up 卡住、日志写不出来）。
  for (const key of [DAEMON_ENV_FLAG, DAEMON_CWD_ENV, DAEMON_STARTED_AT_ENV]) delete env[key];
  // 不覆盖 CLAUDE_CONFIG_DIR / CODEX_HOME：macOS 上 Claude 的登录态在钥匙串里，临时 HOME 下仍能取到；
  // 显式改 CLAUDE_CONFIG_DIR 会让它换一个钥匙串条目去查。
  return env;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** 沙箱专用的 agent-dock 命令：daemon 会把 PATH 传给它拉起的 Agent。Windows 上不垫（没有 sh）。 */
function writeCliShim(sandbox: DevSandbox, node = process.execPath) {
  if (process.platform === 'win32') return;
  const dir = shimDir(sandbox);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'agent-dock');
  writeFileSync(file, `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(sandbox.entrypoint)} "$@"\n`);
  chmodSync(file, 0o755);
}

function readSandbox(repo: string): DevSandbox | undefined {
  try { return JSON.parse(readFileSync(join(repo, '.agentdock', 'dev', SANDBOX_FILE), 'utf8')) as DevSandbox; }
  catch { return undefined; }
}

async function freePort(preferred: number): Promise<number> {
  const tryPort = (port: number) => new Promise<number | undefined>(done => {
    const server = createServer();
    server.once('error', () => done(undefined));
    server.listen(port, '127.0.0.1', () => { const address = server.address(); server.close(() => done(typeof address === 'object' && address ? address.port : undefined)); });
  });
  return (await tryPort(preferred)) ?? (await tryPort(0)) ?? preferred;
}

const defaultRun: NonNullable<DevOptions['run']> = (args, env, cwd, inherit) => {
  const result = spawnSync(process.execPath, args, { env, cwd, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
  return { status: result.status, stdout: result.stdout ?? '' };
};

export async function devUp(options: DevOptions = {}): Promise<string> {
  const repo = findRepoRoot(options.repo);
  const existing = readSandbox(repo);
  const port = existing?.port ?? options.port ?? await freePort(4399);
  const sandbox = sandboxPaths(repo, port);
  if (!existsSync(sandbox.entrypoint)) throw new Error(`没有构建产物：${sandbox.entrypoint}。先在仓库根目录运行 pnpm build。`);
  for (const dir of [sandbox.home, sandbox.work]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(sandbox.root, SANDBOX_FILE), `${JSON.stringify(sandbox, null, 2)}\n`);
  writeCliShim(sandbox);
  const run = options.run ?? defaultRun;
  const env = sandboxEnv(sandbox);
  // 已在跑就重启，确保用的是最新一次 build。沙箱自己的 restart 不会触发自杀保护：目标库不是正式库。
  const action = existing && run([sandbox.entrypoint, 'status', '--json'], env, sandbox.work, false).stdout.includes('"running":true') ? 'restart' : 'start';
  const result = run([sandbox.entrypoint, 'daemon', action, '--port', String(port), '--local-only', '--database', sandbox.database], env, sandbox.work, false);
  if (result.status !== 0) throw new Error(`沙箱启动失败：\n${result.stdout}`);
  return [
    `沙箱已${action === 'restart' ? '重启' : '启动'}（使用 ${sandbox.entrypoint}）`,
    `  地址      http://127.0.0.1:${port}/  （本地免鉴权）`,
    `  数据库    ${sandbox.database}`,
    `  运行命令  agent-dock dev run -- <参数>   例如 agent-dock dev run -- schedule list --all`,
    '  清理      agent-dock dev down',
    ''
  ].join('\n');
}

/** 在沙箱环境里运行一条 agent-dock 命令（用当前源码的构建产物），返回退出码。 */
export function devRun(args: string[], options: DevOptions = {}): number {
  const repo = findRepoRoot(options.repo);
  const sandbox = readSandbox(repo);
  if (!sandbox) throw new Error('沙箱还没启动。先运行 agent-dock dev up。');
  return (options.run ?? defaultRun)([sandbox.entrypoint, ...args], sandboxEnv(sandbox), sandbox.work, true).status ?? 1;
}

export function devEnv(options: DevOptions = {}): string {
  const repo = findRepoRoot(options.repo);
  const sandbox = readSandbox(repo);
  if (!sandbox) throw new Error('沙箱还没启动。先运行 agent-dock dev up。');
  return `${JSON.stringify({ url: `http://127.0.0.1:${sandbox.port}/`, ...sandbox }, null, 2)}\n`;
}

export function devDown(options: DevOptions & { keepData?: boolean } = {}): string {
  const repo = findRepoRoot(options.repo);
  const sandbox = readSandbox(repo);
  if (!sandbox) return '沙箱没有在运行。\n';
  (options.run ?? defaultRun)([sandbox.entrypoint, 'daemon', 'stop'], sandboxEnv(sandbox), sandbox.work, false);
  if (!options.keepData) rmSync(sandbox.root, { recursive: true, force: true });
  return options.keepData ? `沙箱已停止，数据保留在 ${sandbox.root}。\n` : '沙箱已停止并清理。\n';
}

export const devCliEntrypoint = () => fileURLToPath(import.meta.url);
