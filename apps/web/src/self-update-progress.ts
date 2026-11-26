import { useSyncExternalStore } from 'react';
import type { SelfUpdateStatus } from './api';

export type UpdateProgress =
  | { phase: 'pending' }
  | { phase: 'done'; version: string }
  | { phase: 'failed'; message: string };

export type SelfUpdateWatch = {
  fromVersion: string;
  targetVersion?: string;
  startedAt: number;
};

export type SelfUpdateClientState = {
  starting: boolean;
  watch?: SelfUpdateWatch;
};

export type UpdateBadgeState = 'none' | 'available' | 'updating';

export const SELF_UPDATE_QUERY_KEY = ['self-update'] as const;
export const SELF_UPDATE_REFETCH_INTERVAL_MS = 5 * 60_000;

/** 升级包含安装 + 重启，慢网下 npm install 可能要一两分钟。 */
export const UPDATE_TIMEOUT_MS = 5 * 60_000;

let clientState: SelfUpdateClientState = { starting: false };
const listeners = new Set<() => void>();

function emitClientState() {
  for (const listener of listeners) listener();
}

export function subscribeSelfUpdateClientState(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSelfUpdateClientState(): SelfUpdateClientState {
  return clientState;
}

export function setSelfUpdateStarting(starting: boolean) {
  if (clientState.starting === starting) return;
  clientState = { ...clientState, starting };
  emitClientState();
}

export function setSelfUpdateWatch(watch: SelfUpdateWatch | undefined) {
  clientState = watch ? { ...clientState, watch } : { starting: clientState.starting };
  emitClientState();
}

export function resetSelfUpdateClientState() {
  clientState = { starting: false };
  emitClientState();
}

/** 共享客户端侧的升级启动/轮询状态，让外层「设置」入口与内部升级横幅保持同步。 */
export function useSelfUpdateClientState(): SelfUpdateClientState {
  return useSyncExternalStore(subscribeSelfUpdateClientState, getSelfUpdateClientState, getSelfUpdateClientState);
}

/** 根据服务端状态和客户端共享状态推导外层入口应展示的徽标形态。 */
export function resolveServerUpdateBadge(
  status: SelfUpdateStatus | undefined,
  client: SelfUpdateClientState
): UpdateBadgeState {
  if (client.starting || client.watch || status?.updating) return 'updating';
  if (status?.updateAvailable) return 'available';
  return 'none';
}

/**
 * 根据轮询到的服务端状态判断一次界面升级走到哪了。
 *
 * 重启期间请求会失败（status 为空），这不是失败，继续等；版本号变了说明新服务已经起来；
 * 旧服务还活着、不再升级且留了 lastError，说明安装或校验阶段就失败了。
 */
export function resolveUpdateProgress(fromVersion: string, status: SelfUpdateStatus | undefined, elapsedMs: number): UpdateProgress {
  if (status && status.currentVersion !== fromVersion) return { phase: 'done', version: status.currentVersion };
  if (status && !status.updating && status.lastError) return { phase: 'failed', message: status.lastError };
  if (elapsedMs > UPDATE_TIMEOUT_MS) return { phase: 'failed', message: '升级超时，请在终端执行 agent-dock status 查看服务状态' };
  return { phase: 'pending' };
}

/** 侧边栏放不下 `0.4.62-beta.20261014.1`：只留版本核心和通道名，完整版本号放进悬浮提示。 */
export function shortVersion(version: string): string {
  const match = /^(\d+\.\d+\.\d+)(?:-([a-zA-Z][\w-]*))?/.exec(version.trim());
  return match ? `${match[1]}${match[2] ? `-${match[2]}` : ''}` : version;
}
