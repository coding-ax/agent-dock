import { useCallback, useEffect, useState } from 'react';

/**
 * 桌面壳通过 preload 暴露的更新接口。
 *
 * 浏览器里访问同一个 Web UI 时 window.agentdockDesktop 不存在，SelfUpdateNotice
 * 会继续走服务端的 npm / daemon 流程；侧边栏的更新红点也按这里的状态判断。
 */

export type DesktopUpdatePhase = 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';

export type DesktopUpdateState = {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  releaseNotes?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  error?: string;
  checkedAt?: number;
};

export type DesktopUpdateApi = {
  getState(): Promise<DesktopUpdateState>;
  check(): Promise<DesktopUpdateState>;
  download(): Promise<DesktopUpdateState>;
  install(): Promise<DesktopUpdateState>;
  subscribe(listener: (state: DesktopUpdateState) => void): number;
  unsubscribe(id: number): void;
};

export function desktopUpdateApi(): DesktopUpdateApi | undefined {
  return typeof window === 'undefined' ? undefined : window.agentdockDesktop?.update;
}

export function useDesktopUpdate() {
  const api = desktopUpdateApi();
  const [state, setState] = useState<DesktopUpdateState>();
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const id = api.subscribe(next => { if (alive) setState(next); });
    void api.getState().then(next => { if (alive) setState(next); }).catch(() => { /* shell 未就绪时忽略 */ });
    return () => {
      alive = false;
      api.unsubscribe(id);
    };
    // window.agentdockDesktop.update 在页面生命周期内不会换引用。
  }, [api]);
  const run = useCallback(async (action: 'check' | 'download' | 'install') => {
    if (!api) return undefined;
    const next = await api[action]();
    setState(next);
    return next;
  }, [api]);
  return {
    api,
    state,
    check: () => run('check'),
    download: () => run('download'),
    install: () => run('install')
  };
}

export function isDesktopUpdatePhase(state: DesktopUpdateState | undefined): boolean {
  return Boolean(state && ['available', 'downloading', 'downloaded', 'installing'].includes(state.phase));
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatSpeed(bytesPerSecond?: number): string {
  return bytesPerSecond && bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '';
}

/** “12.3 MB / 45.6 MB · 2.1 MB/s” 里的体积部分；未知总大小时返回空串。 */
export function formatTransferred(state: DesktopUpdateState): string {
  if (!state.total) return '';
  return `${formatBytes(state.transferred)} / ${formatBytes(state.total)}`;
}

export function downloadPercent(state: DesktopUpdateState): number {
  const value = Number(state.percent);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}
