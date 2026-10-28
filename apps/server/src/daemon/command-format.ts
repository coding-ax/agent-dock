import type { DaemonCommandResult, DaemonStatusInfo } from './command.js';
import type { AccessUrl } from '../access-urls.js';

const kindLabels: Record<AccessUrl['kind'], string> = {
  local: '本机',
  hostname: '主机名（跨网段稳定）',
  'lan-v4': '局域网 IPv4',
  'lan-v6': '局域网 IPv6'
};

export interface TerminalFormatOptions {
  interactive?: boolean;
}

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyanUnderline: '\x1b[36;4m'
};

function terminalLink(url: string, interactive: boolean): string {
  if (!interactive) return url;
  // OSC 8 makes the URL clickable in supporting terminals; the visible URL
  // remains available for terminals that only detect plain HTTP links.
  const safeUrl = url.replace(/[\x00-\x1f\x7f]/g, '');
  return `\x1b]8;;${safeUrl}\x1b\\${ansi.cyanUnderline}${safeUrl}${ansi.reset}\x1b]8;;\x1b\\`;
}

/** 终端里 CJK 占两列，用字符数补空格会对不齐。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[ᄀ-ᅟ⺀-꓏ꥠ-꥿가-퟿豈-﫿︐-︙︰-﹯＀-｠￠-￦]/.test(char) ? 2 : 1;
  return width;
}

export function padToWidth(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * 访问入口分条回显：本机（含 IPv6 回环）+ 局域网 IPv4 / IPv6 各一行。
 *
 * 绑定局域网时只打印 `127.0.0.1` 等于让用户自己去猜 IP、自己给 IPv6 补方括号；
 * 局域网入口必须带凭证——它的源地址不是回环，没有本机直连的免凭证通道。
 */
export function formatAccessUrls(result: Pick<DaemonCommandResult, 'webAccessUrls' | 'webConsoleUrl'>, options: TerminalFormatOptions = {}): string[] {
  const urls: AccessUrl[] = result.webAccessUrls?.length
    ? result.webAccessUrls
    : result.webConsoleUrl ? [{ kind: 'local', url: result.webConsoleUrl }] : [];
  if (!urls.length) return [];
  const labels = urls.map(entry => kindLabels[entry.kind]);
  const width = Math.max(...labels.map(displayWidth));
  return [
    '控制台（含访问凭证，请勿外传）：',
    ...urls.map((entry, index) => `  ${padToWidth(labels[index]!, width)}  ${options.interactive ? '↗ ' : ''}${terminalLink(entry.url, options.interactive ?? false)}`)
  ];
}

/** `status` 默认给人看；需要稳定字段的调用方使用 `--json`。 */
export function formatDaemonStatus(status: DaemonStatusInfo, options: TerminalFormatOptions = {}): string {
  if (!status.running) return 'AgentDock 未运行。\n启动：agent-dock start';

  const state = status.ready ? '运行中' : '启动中';
  const lines = [
    options.interactive
      ? `${ansi.bold}AgentDock${ansi.reset} ${status.ready ? ansi.green : ansi.yellow}${state}${ansi.reset}（pid ${status.pid ?? '未知'}）`
      : `AgentDock ${state}（pid ${status.pid ?? '未知'}）`,
    ...(status.address ? [`监听：${options.interactive ? '↗ ' : ''}${terminalLink(status.address, options.interactive ?? false)}`] : []),
    ...(status.startedAt ? [`启动时间：${new Date(status.startedAt).toLocaleString('zh-CN')}`] : []),
    ...(status.logFile ? [`日志：${status.logFile}`] : [])
  ];
  const accessLines = formatAccessUrls(status, options);
  if (accessLines.length) lines.push('', ...accessLines);
  return lines.join('\n');
}

/**
 * start/restart 的终端回显（纯函数，便于单测）。要求：启动后必须打印点东西——
 * pid、监听地址、凭证链接、日志路径，并回显 daemon 本次启动写入的日志。
 */
export function formatDaemonCommandResult(result: DaemonCommandResult, options: TerminalFormatOptions = {}): string {
  const actionLabel = result.action === 'restart' ? '重启' : '启动';
  const lines: string[] = [];

  if (result.state === 'already-running') {
    lines.push(`AgentDock 已在运行（pid ${result.pid ?? '未知'}），无需重复${actionLabel}。`);
    if (result.address) lines.push(`监听：${result.address}`);
    lines.push(...formatAccessUrls(result, options));
    if (result.error) lines.push(result.error);
    return lines.join('\n');
  }

  if (!result.running) {
    lines.push(`AgentDock ${actionLabel}失败。`);
    if (result.error) lines.push(result.error);
    if (result.logFile) lines.push(`日志文件：${result.logFile}`);
    if (result.startupLog) lines.push('', '── 启动日志 ──', result.startupLog);
    return lines.join('\n');
  }

  lines.push(`AgentDock 已${actionLabel}（pid ${result.pid ?? '未知'}）。`);
  if (result.address) lines.push(`监听：${result.address}`);
  lines.push(...formatAccessUrls(result, options));
  if (result.logFile) lines.push(`日志：${result.logFile}（tail -f 可实时查看）`);
  if (result.error) lines.push(`注意：${result.error}`);
  if (result.startupLog) lines.push('', '── 启动日志 ──', result.startupLog);
  return lines.join('\n');
}
