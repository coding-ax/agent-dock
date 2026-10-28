import * as pty from 'node-pty';

/**
 * Session 内可交互终端：每个会话一个长期存活的登录 shell（node-pty），
 * 多个 WebSocket 客户端共享同一个 pty——副屏 / 重连看到的是同一个现场。
 *
 * 生命周期：
 * - 首个客户端连接时 spawn（$SHELL -l，cwd 固定为会话 cwd，macOS 缺省 zsh）
 * - 最后一个客户端断开后保留 idleTtlMs（默认 10 分钟），期间重连不丢现场
 * - pty 退出后立刻清理；closeAll() 供 daemon preClose 统一回收
 */

export interface TerminalFrame {
  type: 'input' | 'resize' | 'output' | 'exit';
  data?: string;
  cols?: number;
  rows?: number;
  exitCode?: number;
}

/** 解析客户端帧；非法帧返回 null（不是抛异常——坏帧只杀连接，不杀 pty）。 */
export function parseTerminalFrame(raw: string): TerminalFrame | null {
  let frame: unknown;
  try { frame = JSON.parse(raw); } catch { return null; }
  if (!frame || typeof frame !== 'object') return null;
  const { type, data, cols, rows } = frame as Record<string, unknown>;
  if (type === 'input') {
    if (typeof data !== 'string' || !data.length) return null;
    return { type: 'input', data };
  }
  if (type === 'resize') {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
    const normalizedCols = Math.max(1, Math.min(1000, Math.floor(cols as number)));
    const normalizedRows = Math.max(1, Math.min(1000, Math.floor(rows as number)));
    return { type: 'resize', cols: normalizedCols, rows: normalizedRows };
  }
  return null;
}

export function encodeFrame(frame: TerminalFrame): string {
  return JSON.stringify(frame);
}

/** 选登录 shell：显式 $SHELL 优先；macOS 缺省 zsh，其他平台 bash。 */
export function resolveLoginShell(env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  if (env.SHELL) return { file: env.SHELL, args: ['-l'] };
  if (process.platform === 'darwin') return { file: '/bin/zsh', args: ['-l'] };
  return { file: '/bin/bash', args: ['-l'] };
}

interface TerminalEntry {
  ptyProcess: pty.IPty;
  clients: Set<{ send(frame: TerminalFrame): void; alive: boolean }>;
  cwd: string;
  shell: string;
  lastClientAt?: ReturnType<typeof setTimeout>;
  exited: boolean;
  broadcast(frame: TerminalFrame): void;
}

export interface TerminalManagerOptions {
  idleTtlMs?: number;
  spawn?: typeof pty.spawn;
  now?: () => number;
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalEntry>();
  private readonly idleTtlMs: number;
  private readonly spawnPty: typeof pty.spawn;

  constructor(options: TerminalManagerOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? 10 * 60_000;
    this.spawnPty = options.spawn ?? pty.spawn;
  }

  has(sessionId: string): boolean {
    const entry = this.terminals.get(sessionId);
    return Boolean(entry && !entry.exited);
  }

  getInfo(sessionId: string): { shell: string; cwd: string } | undefined {
    const entry = this.terminals.get(sessionId);
    if (!entry || entry.exited) return undefined;
    return { shell: entry.shell, cwd: entry.cwd };
  }

  /**
   * 接入会话终端：不存在则按需 spawn。client.send 用于向该客户端推帧，
   * 返回的句柄含 write/resize/close。
   */
  attach(sessionId: string, cwd: string, client: { send(frame: TerminalFrame): void; alive: boolean }): {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    /** 关闭后给新连接的清屏序列提示（调用方决定何时发）。 */
    close(): void;
  } {
    let entry = this.terminals.get(sessionId);
    if (!entry || entry.exited) {
      entry = this.spawnTerminal(sessionId, cwd);
      this.terminals.set(sessionId, entry);
    }
    if (entry.lastClientAt) { clearTimeout(entry.lastClientAt); entry.lastClientAt = undefined; }
    entry.clients.add(client);
    return {
      write: data => { if (!entry || entry.exited) return; entry.ptyProcess.write(data); },
      resize: (cols, rows) => {
        if (!entry || entry.exited) return;
        try { entry.ptyProcess.resize(Math.max(1, cols), Math.max(1, rows)); } catch { /* pty 已死时 resize 会抛，忽略。 */ }
      },
      close: () => {
        if (!entry) return;
        entry.clients.delete(client);
        if (!entry.exited && entry.clients.size === 0 && !entry.lastClientAt) {
          entry.lastClientAt = setTimeout(() => {
            const current = this.terminals.get(sessionId);
            if (current && current.clients.size === 0 && !current.exited) this.dispose(sessionId);
          }, this.idleTtlMs);
          entry.lastClientAt.unref?.();
        }
      }
    };
  }

  /** 给后加入的客户端一个重置序列（RIS），让终端从干净屏幕开始；不回补历史。 */
  resetSequence(): string {
    return '\x1bc';
  }

  dispose(sessionId: string): void {
    const entry = this.terminals.get(sessionId);
    if (!entry) return;
    this.terminals.delete(sessionId);
    entry.exited = true;
    if (entry.lastClientAt) clearTimeout(entry.lastClientAt);
    try { entry.ptyProcess.kill(); } catch { /* best-effort */ }
  }

  closeAll(): void {
    for (const sessionId of [...this.terminals.keys()]) this.dispose(sessionId);
  }

  private spawnTerminal(sessionId: string, cwd: string): TerminalEntry {
    const { file, args } = resolveLoginShell();
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    // node-pty 在 env 里遇到 undefined 值会直接抛，过滤掉（与 PtyTransport 一致）。
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const ptyProcess = this.spawnPty(file, args, { name: 'xterm-256color', cwd, env, cols: 80, rows: 24 });
    const broadcast = (frame: TerminalFrame) => {
      for (const client of entry!.clients) {
        if (client.alive) {
          try { client.send(frame); } catch { /* 单个客户端写失败不影响其他客户端。 */ }
        }
      }
    };
    const entry: TerminalEntry = {
      ptyProcess,
      clients: new Set(),
      cwd,
      shell: file,
      exited: false,
      broadcast
    };
    ptyProcess.onData(data => broadcast({ type: 'output', data }));
    ptyProcess.onExit(({ exitCode }) => {
      entry.exited = true;
      entry.broadcast({ type: 'exit', exitCode });
      if (entry.lastClientAt) clearTimeout(entry.lastClientAt);
      this.terminals.delete(sessionId);
    });
    return entry;
  }
}
