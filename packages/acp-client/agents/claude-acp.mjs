import { access, readFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

async function settingsEnvironment(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed?.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) return {};
    return Object.fromEntries(Object.entries(parsed.env).filter((entry) => typeof entry[1] === 'string'));
  } catch { return {}; }
}

async function fileEnvironment(file) {
  try { return parseEnv(await readFile(file, 'utf8')); }
  catch { return {}; }
}

async function findClaudeExecutable(pathValue) {
  if (process.env.CLAUDE_CODE_EXECUTABLE) return process.env.CLAUDE_CODE_EXECUTABLE;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  for (const directory of String(pathValue ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      try { await access(candidate, constants.X_OK); return candidate; }
      catch {}
    }
  }
}

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const settingsEnv = Object.assign(
  {},
  await settingsEnvironment(join(configDir, 'settings.json')),
  await fileEnvironment(join(process.cwd(), '.env')),
  await fileEnvironment(join(process.cwd(), '.env.local')),
  await settingsEnvironment(join(process.cwd(), '.claude', 'settings.json')),
  await settingsEnvironment(join(process.cwd(), '.claude', 'settings.local.json'))
);
const env = { ...settingsEnv, ...process.env };
const installedClaude = env.CLAUDE_CODE_EXECUTABLE || await findClaudeExecutable(env.PATH);
if (installedClaude) env.CLAUDE_CODE_EXECUTABLE = installedClaude;
const customCommand = process.env.AGENTDOCK_CLAUDE_ACP_COMMAND;
const customArgs = process.env.AGENTDOCK_CLAUDE_ACP_ARGS_JSON;
// 发布包不再携带 @anthropic-ai/claude-agent-sdk 的平台二进制，必须复用本机 CLI。
// 自定义 ACP 命令的调用方自行负责运行时，不做这个检查。
if (!installedClaude && !customCommand && !customArgs) {
  process.stderr.write('未找到本机 Claude Code。请先安装 claude CLI 并加入 PATH，或设置 CLAUDE_CODE_EXECUTABLE 后重试。\n');
  process.exit(1);
}
// 发布包里加载同目录的 vendor 产物；源码调试（packages/acp-client/agents）没有
// ../vendor，回退到 workspace 内的 node_modules。claude-agent-acp 0.103+ 不再
// 允许 deep import dist/*，所以从 package.json 的 bin 字段解析 CLI 入口。
let bundledClaudeAcp;
if (!customArgs) {
  const vendoredClaudeAcp = fileURLToPath(new URL('../vendor/claude-agent-acp.mjs', import.meta.url));
  if (existsSync(vendoredClaudeAcp)) bundledClaudeAcp = vendoredClaudeAcp;
  else {
    const packageJsonPath = fileURLToPath(import.meta.resolve('@agentclientprotocol/claude-agent-acp/package.json'));
    const { bin } = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    const relative = typeof bin === 'string' ? bin : bin?.['claude-agent-acp'];
    if (!relative) throw new Error('@agentclientprotocol/claude-agent-acp 未声明 CLI 入口。');
    bundledClaudeAcp = resolve(dirname(packageJsonPath), relative);
  }
}
const command = customCommand || process.execPath;
const args = customArgs
  ? JSON.parse(customArgs)
  : [bundledClaudeAcp];
const child = spawn(command, args, { cwd: process.cwd(), env, stdio: 'inherit' });

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once('exit', (code, signal) => {
  if (signal && process.platform !== 'win32') {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
