import { useCallback, useEffect, useState } from 'react';
import type { DesktopUpdateApi } from './desktop-update';

/**
 * 桌面壳的局域网访问开关。
 *
 * 桌面客户端默认只监听 127.0.0.1。扫码链接要能被手机访问，必须让本地服务绑到
 * 局域网；这需要重启子进程，所以做成显式开关，不在启动时默默改变用户机器的监听面。
 * Web 访问防护始终开启，切换只改变绑定地址，不改变鉴权。
 */

export type DesktopNetworkState = { lanAccess: boolean; port?: number };

type DesktopNetworkApi = {
  getState(): Promise<DesktopNetworkState>;
  setLanAccess(enabled: boolean): Promise<DesktopNetworkState>;
};

declare global {
  interface Window {
    agentdockDesktop?: { update?: DesktopUpdateApi; network?: DesktopNetworkApi };
  }
}

export function desktopNetworkApi(): DesktopNetworkApi | undefined {
  return typeof window === 'undefined' ? undefined : window.agentdockDesktop?.network;
}

export function useDesktopNetwork() {
  const api = desktopNetworkApi();
  const [state, setState] = useState<DesktopNetworkState>();
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.getState().then(next => { if (alive) setState(next); }).catch(() => { /* 旧版壳没有这个接口 */ });
    return () => { alive = false; };
  }, [api]);
  const setLanAccess = useCallback(async (enabled: boolean) => {
    if (!api) return undefined;
    const next = await api.setLanAccess(enabled);
    setState(next);
    return next;
  }, [api]);
  return { api, state, setLanAccess };
}

/** 二维码只展示不含凭证的地址，避免截图时把 `?t=` 令牌一起留在画面上。 */
export function displayShareUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.searchParams.delete('t');
    return url.toString();
  } catch { return raw; }
}

export function shareUrlHost(raw: string): string {
  try { return new URL(raw).host; } catch { return raw; }
}

/** 默认选最可能被手机打通的地址：局域网 IPv4 > 主机名 > 公网 > IPv6。 */
export function defaultShareUrl<T extends { kind: string }>(urls: T[]): T | undefined {
  const order = ['lan-v4', 'hostname', 'public', 'lan-v6'];
  for (const kind of order) {
    const match = urls.find(url => url.kind === kind);
    if (match) return match;
  }
  return urls[0];
}
