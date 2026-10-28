#!/usr/bin/env node
import { AutostartService } from './daemon/autostart.js';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { configureNativeFallback } from '@agent-dock/agent-dock-storage';
import { createCliProgram, environmentFromCli, type CliOptions } from './cli-program.js';
import { packagedNativeFallback } from './native-compat.js';
import { startLocalServer } from './service.js';
import { runLarkSend, runLarkUpdate } from './lark/cli.js';
import { acpxPassThroughArgs, runAcpx } from './acpx.js';
import { AgentGroupToolCliError, runGroupBots, runGroupMembers, runGroupMessage, runGroupMessages, runGroupPeers, runGroupReplyMode, runGroupSelf, runGroupSend, runGroupWait } from './lark/agent-tools-cli.js';
import { agentDockGroupToolsCommand } from './lark/agent-tools.js';
import { daemonRestart, daemonStart, daemonStatus, daemonStop, type DaemonReadyInfo } from './daemon/command.js';
import { formatAccessUrls, formatDaemonCommandResult, formatDaemonStatus } from './daemon/command-format.js';
import { accessUrls } from './access-urls.js';
import { sleep } from './daemon/time.js';
import { resolveDaemonDir } from './daemon/daemon.js';
import { selfRestartBlockReason, targetDaemonDatabase, type SelfRestartAction } from './daemon/self-guard.js';
import { runNpmForAgentDockUpdate, updateAgentDock } from './update.js';
import { runSessionCancel, runSessionInterrupt, runSessionList, runSessionPeers, runSessionSend, runSessionShow, streamSessionShow } from './session-cli.js';
import { devDown, devEnv, devRun, devUp } from './dev-sandbox.js';
import { runPasswordClear, runPasswordSet, runPasswordStatus } from './password-cli.js';
import { webPasswordEnabled } from './web-password.js';
import { runScheduleAdd, runScheduleList, runSchedulePause, runScheduleRemove, runScheduleResume, runScheduleRun, runScheduleShow } from './schedule-cli.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
const interactiveOutput = () => Boolean(process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb');

try { loadEnvFile(); } catch {}

async function serve(options: CliOptions, onReady?: (info?: DaemonReadyInfo) => void) {
  const service = await startLocalServer({ env: environmentFromCli(options), groupToolsCommand: agentDockGroupToolsCommand(fileURLToPath(import.meta.url)), cliEntrypoint: fileURLToPath(import.meta.url) });
  // 监听行不带凭证（这一行会进日志文件）；凭证只出现在下面分条的控制台块里。
  const bare = accessUrls({ host: service.config.host, port: service.config.port });
  process.stdout.write(`AgentDock UI and API listening on ${bare.map(entry => entry.url).join('  ')}\n`);
  const token = service.webAccess.enabled ? service.webAccess.adminToken : undefined;
  const urls = token ? accessUrls({ host: service.config.host, port: service.config.port, token }) : bare;
  // 绑定局域网时 127.0.0.1 不是唯一入口：本机还有 [::1]，同网络的其他设备要用
  // 局域网 IPv4/IPv6（且必须带凭证，它的源地址不是回环）。
  const webConsoleUrl = urls.find(entry => entry.kind === 'local')?.url;
  const accessLines = formatAccessUrls({ webAccessUrls: urls }, { interactive: interactiveOutput() });
  if (accessLines.length) process.stdout.write(`${accessLines.join('\n')}\n`);
  // 密码是可选的第二条入口：没设时提醒一句，用户换设备 / 链接过期时就不必来回找带凭证地址。
  if (token && !webPasswordEnabled()) process.stdout.write('提示：可运行 agent-dock password set 设置访问密码，之后在登录页输入密码也能进入控制台。\n');
  // 凭证链接只在启动时主动打印；此后可通过 `agent-dock status` / `restart` 输出里的
  // webConsoleUrl / webAccessUrls 随时取回（daemon state 文件按 0600 落盘）。
  onReady?.({ ...(webConsoleUrl ? { webConsoleUrl } : {}), webAccessUrls: urls });
  let closing = false;
  let hardStop: NodeJS.Timeout | undefined;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (closing) {
      process.stderr.write(`Received ${signal} again; forcing exit.\n`);
      process.exit(130);
    }
    closing = true;
    process.stdout.write('Shutting down AgentDock… Press Ctrl-C again to force exit.\n');
    hardStop = setTimeout(() => {
      process.stderr.write('Shutdown exceeded 5 seconds; forcing exit.\n');
      process.exit(1);
    }, 5_000);
    try {
      await service.close();
      clearTimeout(hardStop);
      process.exit(0);
    } catch (error) {
      clearTimeout(hardStop);
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Observe fatal errors without installing a recovery handler. Continuing
  // after an uncaught exception can leave the DB, PTY, and session queues in an
  // unknown state; Node must retain its default non-zero exit behavior so the
  // runner/daemon supervisor can start a clean process. Unhandled rejections
  // reach this monitor through Node's default `throw` mode as well.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    process.stderr.write(`Fatal ${origin}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  });
}

async function restartWithInstalledCli(entrypoint: string) {
  if (!existsSync(entrypoint)) throw new Error(`Updated AgentDock entrypoint was not found: ${entrypoint}. The service was not restarted.`);
  const previousPid = daemonStatus().pid;
  const child = spawn(process.execPath, [entrypoint, 'daemon', 'restart'], { stdio: 'inherit', env: process.env });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`AgentDock restart exited with code ${code ?? 'unknown'}.`)));
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = daemonStatus();
    if (status.running && status.ready && status.pid && status.pid !== previousPid) return;
    await sleep(200);
  }
  throw new Error('AgentDock was updated, but the restarted service did not become ready within 15 seconds. Run agent-dock status and inspect the daemon log.');
}

async function main() {
  // 老 glibc 机器上 better-sqlite3 随包的预编译产物加载不了（见 native-compat.ts）：先把随包兜底登记给
  // storage，默认加载失败时才用它重试。本机没有对应产物就什么都不做，行为与以前一致。
  configureNativeFallback(packagedNativeFallback());
  const acpxArgs = acpxPassThroughArgs(process.argv);
  if (acpxArgs) {
    process.exitCode = await runAcpx(acpxArgs);
    return;
  }
  // AgentDock 会话里的 Agent 重启/停止/升级自己所在的 daemon 会把自己杀掉：在动手前拦下，指向沙箱。
  const guardSelfRestart = (action: SelfRestartAction) => {
    const reason = selfRestartBlockReason(action, { env: process.env, targetDatabase: targetDaemonDatabase(resolveDaemonDir()), ownDatabase: process.env.agentdock_database });
    if (reason) throw new Error(reason);
  };
  const output = (result: unknown) => process.stdout.write(`${JSON.stringify({ ok: true, ...result as object })}\n`);
  const daemonServe: typeof serve = (options, onReady) => serve(options, onReady);
  const program = createCliProgram(packageJson.version, {
    serve,
    daemonStart: async options => {
      const result = await daemonStart(options, { serve: daemonServe });
      process.stdout.write(`${formatDaemonCommandResult(result, { interactive: interactiveOutput() })}\n`);
      if (!result.ok) process.exitCode = 1;
    },
    daemonStop: async () => {
      guardSelfRestart('stop');
      const result = await daemonStop();
      process.stdout.write(`${JSON.stringify(result)}\n`);
    },
    daemonRestart: async options => {
      guardSelfRestart('restart');
      const result = await daemonRestart(options, { serve: daemonServe });
      process.stdout.write(`${formatDaemonCommandResult(result, { interactive: interactiveOutput() })}\n`);
      if (!result.ok) process.exitCode = 1;
    },
    daemonStatus: options => {
      const status = daemonStatus();
      process.stdout.write(`${options.json ? JSON.stringify({ ok: true, action: 'status', ...status }) : formatDaemonStatus(status, { interactive: interactiveOutput() })}\n`);
    },
    autostart: async (action, options) => {
      const service = new AutostartService({ entrypoint: fileURLToPath(import.meta.url) });
      const status = action === 'enable' ? await service.enable() : action === 'disable' ? await service.disable() : service.status();
      if (options.json) { output({ action, ...status }); return; }
      process.stdout.write(`${!status.supported ? `不支持：${status.reason}` : status.enabled ? `开机自启：已开启\n${status.plistPath}` : '开机自启：未开启'}\n`);
    },
    update: async options => {
      guardSelfRestart('update');
      output(await updateAgentDock(packageJson.version, options, {
        packageName: packageJson.name,
        runNpm: runNpmForAgentDockUpdate,
        restart: restartWithInstalledCli
      }));
    },
    larkSend: async (markdown, options) => { output(await runLarkSend(markdown, options)); },
    larkUpdate: async (markdown, options) => { output(await runLarkUpdate(markdown, options)); },
    groupSelf: async () => { output(await runGroupSelf()); },
    groupPeers: async () => { output(await runGroupPeers()); },
    groupMembers: async () => { output(await runGroupMembers()); },
    groupBots: async () => { output(await runGroupBots()); },
    groupMessages: async options => { output(await runGroupMessages(options)); },
    groupMessage: async messageId => { output(await runGroupMessage(messageId)); },
    groupSend: async (content, options) => { output(await runGroupSend(content, options)); },
    groupWait: async options => { output(await runGroupWait(options)); },
    groupReplyMode: async mode => { output(await runGroupReplyMode(mode)); },
    sessionList: async options => { process.stdout.write(await runSessionList(options)); },
    // 默认走流式：转录可能百万行，不能先拼成一个字符串。--json 是显式导出，仍取完整一份。
    sessionShow: async (sessionId, options) => {
      if (options.json) { process.stdout.write(await runSessionShow(sessionId, options)); return; }
      await streamSessionShow(sessionId, options, chunk => { process.stdout.write(chunk); });
    },
    sessionPeers: async (sessionId, options) => { process.stdout.write(await runSessionPeers(sessionId, options)); },
    sessionSend: async (targetId, message, options) => { process.stdout.write(await runSessionSend(targetId, message, options)); },
    sessionInterrupt: async (targetId, options) => { process.stdout.write(await runSessionInterrupt(targetId, options)); },
    sessionCancel: async (targetId, taskId, options) => { process.stdout.write(await runSessionCancel(targetId, taskId, options)); },
    devUp: async options => { process.stdout.write(await devUp({ ...(options.repo ? { repo: options.repo } : {}), ...(options.port ? { port: Number(options.port) } : {}) })); },
    devRun: args => { process.exitCode = devRun(args); },
    devEnv: options => { process.stdout.write(devEnv(options.repo ? { repo: options.repo } : {})); },
    devDown: options => { process.stdout.write(devDown({ ...(options.repo ? { repo: options.repo } : {}), ...(options.keepData ? { keepData: true } : {}) })); },
    passwordSet: async options => { process.stdout.write(await runPasswordSet(options)); },
    passwordClear: () => { process.stdout.write(runPasswordClear()); },
    passwordStatus: () => { process.stdout.write(runPasswordStatus()); },
    scheduleAdd: async (prompt, options) => { process.stdout.write(await runScheduleAdd(prompt, options)); },
    scheduleList: async options => { process.stdout.write(await runScheduleList(options)); },
    scheduleShow: async (id, options) => { process.stdout.write(await runScheduleShow(id, options)); },
    schedulePause: async (id, options) => { process.stdout.write(await runSchedulePause(id, options)); },
    scheduleResume: async (id, options) => { process.stdout.write(await runScheduleResume(id, options)); },
    scheduleRun: async (id, options) => { process.stdout.write(await runScheduleRun(id, options)); },
    scheduleRemove: async (id, options) => { process.stdout.write(await runScheduleRemove(id, options)); }
  });
  await program.parseAsync();
}

// 输出被管道截断（`session show | head`、`| grep -q`）时 stdout 会抛 EPIPE。这不是错误，
// 是下游主动不看了——按 node 的默认行为会打一整段堆栈并以非零码退出，让人以为命令失败了。
process.stdout.on('error', error => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
  throw error;
});

try {
  await main();
} catch (error) {
  if (error instanceof AgentGroupToolCliError) process.stderr.write(`${JSON.stringify({ ok: false, error: error.error })}\n`);
  else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
