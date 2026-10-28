import { hostname as osHostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export type AccessUrlKind = 'local' | 'hostname' | 'lan-v4' | 'lan-v6';

export interface AccessUrl {
  kind: AccessUrlKind;
  url: string;
}

export interface AccessUrlInput {
  host: string;
  port: number;
  /** master 凭证；带凭证的链接才能被局域网设备使用（本机回环不需要，但给上不出错）。 */
  token?: string;
  /** 便于单测注入。 */
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** 便于单测注入；默认取 os.hostname()。 */
  hostname?: string;
}

function isLoopbackV4(address: string): boolean {
  const parts = address.split('.');
  return parts.length === 4 && parts[0] === '127';
}

function isLoopbackV6(address: string): boolean {
  return address.toLowerCase() === '::1';
}

/**
 * fe80::/10 链路本地地址：浏览器不能直接访问（需要 zone id），
 * 同一台机器上 awdl0 / llw0 / utun* 各会报一条，全列出来只会淹没有用信息。
 */
function isLinkLocalV6(address: string): boolean {
  return /^fe[89ab]/.test(address.toLowerCase().split(':')[0] ?? '');
}

/** `0.0.0.0` / `::` 走双栈监听（见 service.listenOptions），本机 IPv6 入口也真实可用。 */
function bindsDualStack(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

function bindsLan(host: string): boolean {
  return bindsDualStack(host) || (!isLoopbackV4(host) && !isLoopbackV6(host) && host !== 'localhost');
}

/** IPv6 字面量放进 URL 必须加方括号，否则 `http://::1:4310/` 会被解析成非法 host。 */
function origin(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

function withCredential(url: string, token: string | undefined): string {
  return token ? `${url}/?t=${encodeURIComponent(token)}` : `${url}/`;
}

/**
 * 机器主机名（macOS 上就是 `xxx.local` 这种 Bonjour 名）。
 *
 * 为什么要有这一条：局域网 IPv4 字面量会随网段变化（换 WiFi、换工位），而访问凭证
 * 是 cookie，cookie 按「主机名」隔离、不按 IP —— 于是每次换网段都要重新输一次密码，
 * 观感就是「cookie 老是种不住」。换成稳定主机名访问，登录一次之后就与 IP 无关。
 * 所以它排在局域网 IP 前面，作为非回环入口的首选。
 *
 * 只能尽力而为：`.local` 走 mDNS，公司网络或非 Apple 设备可能解析不了，Linux 开发机上
 * `hostname()` 给的短名也不一定在 DNS 里。所以它是补充入口，不能替掉 IP 那一条。
 */
function hostnameEntry(hostname: string | undefined): string | undefined {
  const name = (hostname ?? osHostname()).trim().replace(/\.$/, '');
  if (!name || isLoopbackV4(name) || isLoopbackV6(name) || name.toLowerCase() === 'localhost') return undefined;
  return name;
}

/**
 * 启动时要回显的访问地址：本机入口在前，局域网入口在后。
 *
 * 为什么要列全：绑定局域网时只有 `127.0.0.1` 一个链接，用户拿手机/另一台机器
 * 打开就得自己猜 IP；而 IPv6 还得自己加方括号，基本猜不出来。本机地址始终给
 * `127.0.0.1`，双栈监听时补 `[::1]`（cookie 按源隔离，三个回环名各自一份）。
 */
export function accessUrls(input: AccessUrlInput): AccessUrl[] {
  const { host, port, token } = input;
  const locals: AccessUrl[] = [{ kind: 'local', url: origin('127.0.0.1', port) }];
  if (bindsDualStack(host)) locals.push({ kind: 'local', url: origin('::1', port) });

  const lanV4: string[] = [];
  const lanV6: string[] = [];
  let stableHostname: string | undefined;
  if (bindsLan(host)) {
    stableHostname = hostnameEntry(input.hostname);
    const seen = new Set<string>();
    // 显式 --host 指定的地址优先，且要允许它不在网卡枚举里（如绑到别名地址）。
    // 通配地址是个「监听全部」的占位符而不是可访问地址，不能列出来。
    const candidates = [bindsDualStack(host) ? '' : host, ...Object.values(input.interfaces ?? networkInterfaces()).flat().map(info => info?.address ?? '')];
    for (const address of candidates) {
      if (!address || seen.has(address)) continue;
      seen.add(address);
      if (isLoopbackV4(address) || isLoopbackV6(address)) continue;
      if (address.includes(':')) {
        if (!isLinkLocalV6(address)) lanV6.push(address);
      } else {
        lanV4.push(address);
      }
    }
  }

  return [
    ...locals.map(entry => ({ ...entry, url: withCredential(entry.url, token) })),
    ...(stableHostname ? [{ kind: 'hostname' as const, url: withCredential(origin(stableHostname, port), token) }] : []),
    ...lanV4.map(address => ({ kind: 'lan-v4' as const, url: withCredential(origin(address, port), token) })),
    ...lanV6.map(address => ({ kind: 'lan-v6' as const, url: withCredential(origin(address, port), token) }))
  ];
}
