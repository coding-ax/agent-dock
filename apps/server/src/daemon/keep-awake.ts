import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ConfigRepository } from '@agent-dock/agent-dock-shared';

/**
 * 「运行时永不休眠」：macOS 上用 caffeinate 阻止机器空闲休眠。
 *
 * - 默认 `-imsu`：阻止空闲睡眠 / 磁盘睡眠 / 系统睡眠，并把显示器唤醒一次；
 * - 子开关「保持屏幕常亮」额外加 `-d`：阻止显示器空闲休眠；
 * - `-w <daemon pid>` 把断言的寿命绑在 daemon 上：daemon 正常退出或被强杀后 caffeinate
 *   都会自己退出，不会留下一个把整台 Mac 永远钉醒的孤儿进程。
 *
 * 偏好存 configs 表，daemon 重启后按上次的选择恢复；如果启动失败，就当没开启，不让
 * 一个辅助功能拖垮整个 daemon。
 */
export const keepAwakeConfigKey = 'system.keepAwake';
export const defaultCaffeinatePath = '/usr/bin/caffeinate';

export interface KeepAwakeStatus {
  supported: boolean;
  enabled: boolean;
  /** 保持屏幕常亮（caffeinate -d）。主开关关闭时保留上次的选择。 */
  keepDisplay: boolean;
  reason?: string;
}

interface StoredKeepAwake {
  enabled: boolean;
  keepDisplay: boolean;
}

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform;
  caffeinatePath?: string;
  config?: ConfigRepository;
  /** 绑定的 daemon 进程；测试里可覆盖。 */
  daemonPid?: number;
  spawn?: typeof spawn;
  exists?: (path: string) => boolean;
}

export class KeepAwakeService {
  private child: ChildProcess | undefined;
  private enabled = false;
  private keepDisplay = false;
  /** 串行化开关操作：连点两个开关时不能同时拉起两个 caffeinate。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: KeepAwakeOptions = {}) {}

  private get platform() { return this.options.platform ?? process.platform; }

  get caffeinatePath() { return this.options.caffeinatePath ?? defaultCaffeinatePath; }

  private unsupportedReason(): string | undefined {
    if (this.platform !== 'darwin') return '目前只支持 macOS';
    if (!(this.options.exists ?? existsSync)(this.caffeinatePath)) return '系统未提供 caffeinate';
    return undefined;
  }

  status(): KeepAwakeStatus {
    const reason = this.unsupportedReason();
    if (reason) return { supported: false, enabled: false, keepDisplay: false, reason };
    return { supported: true, enabled: this.enabled && this.child !== undefined, keepDisplay: this.keepDisplay };
  }

  /** daemon 启动时恢复上次的选择。失败只影响这个功能，不阻断启动。 */
  async restore(): Promise<void> {
    if (this.unsupportedReason() || !this.options.config) return;
    const stored = await this.readStored();
    this.keepDisplay = stored.keepDisplay;
    if (!stored.enabled) return;
    try {
      await this.start();
      this.enabled = true;
    } catch (error) {
      console.warn(`[keep-awake] 恢复永不休眠失败：${error instanceof Error ? error.message : String(error)}`);
      await this.persist({ enabled: false, keepDisplay: this.keepDisplay }).catch(() => undefined);
    }
  }

  async set(input: { enabled?: boolean; keepDisplay?: boolean }): Promise<KeepAwakeStatus> {
    const run = this.queue.then(() => this.apply(input));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async apply(input: { enabled?: boolean; keepDisplay?: boolean }): Promise<KeepAwakeStatus> {
    const reason = this.unsupportedReason();
    if (reason) throw new Error(reason);
    const enabled = input.enabled ?? this.enabled;
    const keepDisplay = input.keepDisplay ?? this.keepDisplay;
    if (!enabled) {
      this.stop();
      this.enabled = false;
      this.keepDisplay = keepDisplay;
    } else if (this.child === undefined || keepDisplay !== this.keepDisplay) {
      // 改「屏幕常亮」要换参数，只能重启这个进程；先停旧的，失败时状态如实反映为关闭。
      this.stop();
      this.enabled = false;
      this.keepDisplay = keepDisplay;
      try {
        await this.start();
        this.enabled = true;
      } catch (error) {
        await this.persist({ enabled: false, keepDisplay }).catch(() => undefined);
        throw new Error(`无法启动 caffeinate：${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      this.keepDisplay = keepDisplay;
    }
    await this.persist({ enabled: this.enabled, keepDisplay: this.keepDisplay });
    return this.status();
  }

  /** daemon 退出时释放断言；保留偏好，下次启动恢复。 */
  close(): void {
    this.stop();
    this.enabled = false;
  }

  private args(): string[] {
    return ['-imsu', ...(this.keepDisplay ? ['-d'] : []), '-w', String(this.options.daemonPid ?? process.pid)];
  }

  private async start(): Promise<void> {
    const child = (this.options.spawn ?? spawn)(this.caffeinatePath, this.args(), { stdio: 'ignore' });
    this.child = child;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      this.child = undefined;
      throw error;
    }
    // 正常关闭走 stop()，会先摘掉这个监听；能走到这里说明 caffeinate 被外部杀掉了。
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.enabled = false;
      void this.persist({ enabled: false, keepDisplay: this.keepDisplay });
    });
  }

  private stop(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.removeAllListeners('exit');
    if (child.exitCode === null && !child.killed) {
      try { child.kill('SIGTERM'); } catch { /* 已经退出 */ }
    }
  }

  private async readStored(): Promise<StoredKeepAwake> {
    try {
      const raw = await this.options.config?.get(keepAwakeConfigKey);
      if (!raw) return { enabled: false, keepDisplay: false };
      const parsed = JSON.parse(raw) as Partial<StoredKeepAwake> | null;
      return { enabled: parsed?.enabled === true, keepDisplay: parsed?.keepDisplay === true };
    } catch {
      return { enabled: false, keepDisplay: false };
    }
  }

  private async persist(value: StoredKeepAwake): Promise<void> {
    await this.options.config?.set(keepAwakeConfigKey, JSON.stringify(value));
  }
}
