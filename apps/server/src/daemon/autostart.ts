import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveDaemonDir } from './daemon.js';

const execFileAsync = promisify(execFile);

/** LaunchAgent 标识；plist 文件名与 launchctl 的服务名都用它。 */
export const AUTOSTART_LABEL = 'com.agent-dock.daemon';

export interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  /** 不支持时的原因，给界面和命令行直接展示。 */
  reason?: string;
  plistPath?: string;
  /** 开机时会运行的 CLI 入口（当前进程所用的那一份）。 */
  entrypoint?: string;
}

export interface LaunchAgentInput {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  logFile: string;
  env: Record<string, string>;
}

const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * 登录时执行一次 `agent-dock start`，不开 KeepAlive：`start` 把服务派生成脱离的后台进程后自己就退出了，
 * KeepAlive 会把这次正常退出当成崩溃反复拉起；而且 launchd 一旦接管进程，`agent-dock stop` / `restart` /
 * `update` 就管不住它。这样开机自启和现有的守护进程命令互不冲突。
 */
export function renderLaunchAgentPlist(input: LaunchAgentInput): string {
  const item = (value: string) => `    <string>${xmlEscape(value)}</string>`;
  const envEntries = Object.entries(input.env).map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${input.programArguments.map(item).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.logFile)}</string>
</dict>
</plist>
`;
}

export interface AutostartOptions {
  /** 开机时要运行的 CLI 入口（`dist/cli.js` 的绝对路径）。 */
  entrypoint: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** 系统账户的真实 home；与 env.HOME 不同说明在沙箱里（`agent-dock dev`），不能碰真实的 launchd。 */
  realHome?: string;
  nodePath?: string;
  uid?: number;
  /** 默认：当前 daemon 根目录（`~/.agentdock/last-daemon-dir` 记录的那个），保证开机后复用同一个数据库。 */
  workingDirectory?: () => string;
  launchctl?: (args: string[]) => Promise<void>;
}

const defaultLaunchctl = async (args: string[]) => { await execFileAsync('/bin/launchctl', args, { timeout: 15_000 }); };

/** macOS 开机自启：往 `~/Library/LaunchAgents` 写一个登录时运行 `agent-dock start` 的 LaunchAgent。 */
export class AutostartService {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly realHome: string;

  constructor(private readonly options: AutostartOptions) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.home = this.env.HOME ?? homedir();
    this.realHome = options.realHome ?? userInfo().homedir;
  }

  private unsupportedReason(): string | undefined {
    if (this.platform !== 'darwin') return '目前只支持 macOS（launchd）';
    if (this.home !== this.realHome) return '当前是隔离沙箱，不能修改系统的开机启动项';
    return undefined;
  }

  get plistPath() { return join(this.home, 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`); }

  status(): AutostartStatus {
    const reason = this.unsupportedReason();
    if (reason) return { supported: false, enabled: false, reason };
    return { supported: true, enabled: existsSync(this.plistPath), plistPath: this.plistPath, entrypoint: this.options.entrypoint };
  }

  async enable(): Promise<AutostartStatus> {
    const reason = this.unsupportedReason();
    if (reason) throw new Error(reason);
    if (!existsSync(this.options.entrypoint)) throw new Error(`找不到 CLI 入口：${this.options.entrypoint}`);
    const root = this.options.workingDirectory?.() ?? dirname(dirname(resolveDaemonDir(undefined, this.home)));
    const logFile = join(root, '.agentdock', 'daemon', 'autostart.log');
    mkdirSync(dirname(logFile), { recursive: true });
    mkdirSync(dirname(this.plistPath), { recursive: true });
    // launchd 给登录项的 PATH 很短，找不到 nvm / homebrew 里的 node、codex、claude 等；沿用启用时这个进程的 PATH。
    const env: Record<string, string> = { HOME: this.home, ...(this.env.PATH ? { PATH: this.env.PATH } : {}) };
    writeFileSync(this.plistPath, renderLaunchAgentPlist({
      label: AUTOSTART_LABEL,
      programArguments: [this.options.nodePath ?? process.execPath, this.options.entrypoint, 'start'],
      workingDirectory: root,
      logFile,
      env
    }), { mode: 0o644 });
    const launchctl = this.options.launchctl ?? defaultLaunchctl;
    const domain = `gui/${this.options.uid ?? process.getuid?.() ?? userInfo().uid}`;
    await launchctl(['bootout', `${domain}/${AUTOSTART_LABEL}`]).catch(() => undefined);
    try {
      await launchctl(['bootstrap', domain, this.plistPath]);
    } catch (error) {
      // plist 已写好，下次登录照样生效；只是这一刻没能立即加载。
      throw new Error(`已写入 ${this.plistPath}，但 launchctl 加载失败（下次登录时仍会生效）：${error instanceof Error ? error.message : String(error)}`);
    }
    return this.status();
  }

  async disable(): Promise<AutostartStatus> {
    const reason = this.unsupportedReason();
    if (reason) throw new Error(reason);
    const launchctl = this.options.launchctl ?? defaultLaunchctl;
    const domain = `gui/${this.options.uid ?? process.getuid?.() ?? userInfo().uid}`;
    await launchctl(['bootout', `${domain}/${AUTOSTART_LABEL}`]).catch(() => undefined);
    rmSync(this.plistPath, { force: true });
    return this.status();
  }
}
