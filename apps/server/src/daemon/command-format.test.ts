import { describe, expect, it } from 'vitest';
import { formatAccessUrls, formatDaemonCommandResult, formatDaemonStatus, padToWidth } from './command-format.js';

describe('formatDaemonStatus', () => {
  it('shows a scannable status and puts each access URL on its own line', () => {
    const text = formatDaemonStatus({
      running: true,
      ready: true,
      pid: 4242,
      address: 'http://127.0.0.1:4310',
      logFile: '/tmp/agentdock.log',
      webAccessUrls: [
        { kind: 'local', url: 'http://127.0.0.1:4310/?t=secret' },
        { kind: 'lan-v4', url: 'http://192.168.1.2:4310/?t=secret' }
      ]
    });
    expect(text.split('\n')).toEqual([
      'AgentDock 运行中（pid 4242）',
      '监听：http://127.0.0.1:4310',
      '日志：/tmp/agentdock.log',
      '',
      '控制台（含访问凭证，请勿外传）：',
      '  本机         http://127.0.0.1:4310/?t=secret',
      '  局域网 IPv4  http://192.168.1.2:4310/?t=secret'
    ]);
  });

  it('shows stopped and starting states', () => {
    expect(formatDaemonStatus({ running: false })).toBe('AgentDock 未运行。\n启动：agent-dock start');
    expect(formatDaemonStatus({ running: true, ready: false, pid: 42 })).toContain('启动中（pid 42）');
  });

  it('colors an interactive status and exposes an OSC 8 clickable URL', () => {
    const url = 'http://127.0.0.1:4310/?t=secret';
    const status = { running: true, ready: true, pid: 42, address: 'http://127.0.0.1:4310', webConsoleUrl: url };
    const interactive = formatDaemonStatus(status, { interactive: true });
    expect(interactive).toContain('\x1b[32m运行中\x1b[0m');
    expect(interactive).toContain('监听：↗ \x1b]8;;http://127.0.0.1:4310\x1b\\');
    expect(interactive).toContain(`↗ \x1b]8;;${url}\x1b\\\x1b[36;4m${url}\x1b[0m\x1b]8;;\x1b\\`);
    expect(formatDaemonStatus(status)).not.toContain('\x1b');
  });
});

describe('formatDaemonCommandResult', () => {
  it('started：打印 pid、地址、控制台、日志路径与启动日志', () => {
    const text = formatDaemonCommandResult({
      ok: true,
      action: 'start',
      running: true,
      pid: 4242,
      address: 'http://127.0.0.1:4310',
      logFile: '/tmp/.agentdock/daemon/agentdock.log',
      state: 'started',
      webConsoleUrl: 'http://127.0.0.1:4310/?t=secret',
      startupLog: 'AgentDock UI and API listening on http://127.0.0.1:4310'
    });
    expect(text).toContain('已启动（pid 4242）');
    expect(text).toContain('监听：http://127.0.0.1:4310');
    expect(text).toContain('控制台（含访问凭证，请勿外传）：');
    expect(text).toContain('http://127.0.0.1:4310/?t=secret');
    expect(text).toContain('日志：/tmp/.agentdock/daemon/agentdock.log');
    expect(text).toContain('AgentDock UI and API listening');
  });

  it('restart：措辞为已重启', () => {
    const text = formatDaemonCommandResult({ ok: true, action: 'restart', running: true, pid: 1, state: 'restarted' });
    expect(text).toContain('已重启');
  });

  it('already-running：不重复启动，附带链接', () => {
    const text = formatDaemonCommandResult({
      ok: false,
      action: 'start',
      running: true,
      pid: 99,
      state: 'already-running',
      address: 'http://127.0.0.1:4310',
      error: 'AgentDock is already running (pid 99).'
    });
    expect(text).toContain('已在运行（pid 99）');
    expect(text).toContain('监听：http://127.0.0.1:4310');
  });

  it('失败：给出原因、日志文件和启动日志堆栈', () => {
    const text = formatDaemonCommandResult({
      ok: false,
      action: 'restart',
      running: false,
      state: 'not-running',
      logFile: '/tmp/agentdock.log',
      startupLog: 'Error: EADDRINUSE',
      error: 'Daemon failed to start within the timeout. See the startup log below for details.'
    });
    expect(text).toContain('重启失败');
    expect(text).toContain('日志文件：/tmp/agentdock.log');
    expect(text).toContain('Error: EADDRINUSE');
  });

  it('无启动日志时不输出分隔线', () => {
    const text = formatDaemonCommandResult({ ok: true, action: 'start', running: true, pid: 1, state: 'started' });
    expect(text).not.toContain('启动日志');
  });
});

describe('formatAccessUrls', () => {
  it('本机与局域网 v4/v6 分条列出，凭证留在每条链接里', () => {
    const lines = formatAccessUrls({
      webAccessUrls: [
        { kind: 'local', url: 'http://127.0.0.1:4310/?t=secret' },
        { kind: 'local', url: 'http://[::1]:4310/?t=secret' },
        { kind: 'lan-v4', url: 'http://192.168.1.20:4310/?t=secret' },
        { kind: 'lan-v6', url: 'http://[fd12:3456:789a:1::1fd8]:4310/?t=secret' }
      ]
    });
    expect(lines[0]).toBe('控制台（含访问凭证，请勿外传）：');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('本机');
    expect(lines[3]).toContain('局域网 IPv4');
    expect(lines[3]).toContain('http://192.168.1.20:4310/?t=secret');
    expect(lines[4]).toContain('局域网 IPv6');
    expect(lines[4]).toContain('http://[fd12:3456:789a:1::1fd8]:4310/?t=secret');
  });

  it('只剩 webConsoleUrl 时退化为单条本机链接', () => {
    expect(formatAccessUrls({ webConsoleUrl: 'http://127.0.0.1:4310/?t=old' })).toEqual([
      '控制台（含访问凭证，请勿外传）：',
      '  本机  http://127.0.0.1:4310/?t=old'
    ]);
  });

  it('没有任何入口时不输出空标题', () => {
    expect(formatAccessUrls({})).toEqual([]);
  });

  it('按终端显示宽度对齐（CJK 占两列）', () => {
    expect(padToWidth('本机', 11)).toBe('本机       ');
    expect(padToWidth('局域网 IPv6', 11)).toBe('局域网 IPv6');
  });
});
