import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type AssistantCompanion, type AssistantState, type AssistantTask, type Session } from '../api';
import { companionStatus, countNotes, deriveMood, isMainBusy, type KittenMood, type NoteCounts } from './companion-model';
import { useCompanionStore } from './companion-store';

/** 与服务端 DEFAULT_COMPANION_NAME 一致：旧服务端没有 companion 字段时的兜底。 */
export const DEFAULT_KITTEN_NAME = '小A同学';
const EMPTY_TASKS: AssistantTask[] = [];

/**
 * 主会话状态的唯一查询。所有用到它的地方（侧栏、右缘、首页、抽屉、设置）共用一个缓存键，
 * 轮询频率按忙闲自适应：主会话在想事情、或者还有便签在跑时 2.5 秒一次，否则 5 秒。
 * session 级访问令牌（飞书卡片链接）没有 /api/assistant 权限，api 层对它静默拒绝，不会整页报错。
 */
export function useAssistantState(enabled = true) {
  return useQuery({
    queryKey: ['assistant-state'],
    queryFn: api.assistantState,
    enabled,
    retry: false,
    refetchInterval: query => {
      const data = query.state.data as AssistantState | undefined;
      if (query.state.error) return 30_000;
      if (!data?.mainSessionId) return 8_000;
      const busy = isMainBusy(data.mainSession?.state) || data.tasks.some(task => task.state === 'running');
      return busy ? 2_500 : 5_000;
    }
  });
}

/**
 * 心情里有两个时间窗（刚发生的事 6 秒、没动静 3 分钟犯困）。不用每秒 tick：
 * 只在下一个窗口边界到来时刷新一次「现在」。
 */
function useMoodClock(recentAt: number | undefined, lastActiveAt: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const current = Date.now();
    const boundaries = [recentAt === undefined ? 0 : recentAt + 6_000, lastActiveAt + 3 * 60_000].filter(boundary => boundary > current);
    if (!boundaries.length) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(...boundaries) - current + 60);
    return () => window.clearTimeout(timer);
  }, [recentAt, lastActiveAt, now]);
  return now;
}

export type CompanionInfo = {
  loaded: boolean;
  adopted: boolean;
  mainId?: string;
  mainSession?: Session;
  companion?: AssistantCompanion;
  name: string;
  tasks: AssistantTask[];
  counts: NoteCounts;
  /** 等用户确认发送的草稿（GitHub 评论、飞书回复）。 */
  pendingDrafts: number;
  mood: KittenMood;
  status: string;
  busy: boolean;
};

/** 小猫此刻的样子：名字、心情、状态文案、便签计数。纯派生，不发请求以外的副作用。 */
export function useCompanion(): CompanionInfo {
  const state = useAssistantState();
  const data = state.data;
  const mainId = data?.mainSessionId ?? undefined;
  // 主会话的实时状态以会话列表为准（2 秒轮询 + 打开时 SSE 直写），比 assistant-state 更快。
  const select = useCallback((sessions: Session[]) => sessions.find(session => session.id === mainId), [mainId]);
  const live = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: 2_000, refetchIntervalInBackground: true, enabled: Boolean(mainId), select }).data;
  const mainSession = mainId ? live ?? data?.mainSession ?? undefined : undefined;
  const tasks = data?.tasks ?? EMPTY_TASKS;
  const recent = useCompanionStore(store => store.recent);
  const lastActiveAt = useCompanionStore(store => store.lastActiveAt);
  const now = useMoodClock(recent?.at, lastActiveAt);
  const companion = data?.companion ?? undefined;
  const drafts = data?.drafts;
  return useMemo(() => {
    const counts = countNotes(tasks);
    const mainState = mainSession?.state;
    const mood = deriveMood({ mainState, tasks, recent, lastActiveAt, now });
    const name = companion?.name ?? (mainSession?.customTitle?.trim() || DEFAULT_KITTEN_NAME);
    return {
      loaded: state.isSuccess,
      adopted: Boolean(mainId),
      mainId,
      mainSession,
      companion,
      name,
      tasks,
      counts,
      pendingDrafts: (drafts ?? []).filter(draft => draft.state === 'pending').length,
      mood,
      status: companionStatus({ mainState, counts, mood, ...(recent ? { recent: recent.kind } : {}) }),
      busy: isMainBusy(mainState)
    };
  }, [state.isSuccess, mainId, mainSession, companion, tasks, drafts, recent, lastActiveAt, now]);
}

/* ---------- 导航：小猫的各处入口都要能「去主会话 / 打开便签对应的会话 / 去认领」 ---------- */

export type CompanionNav = {
  /** 打开主会话（小猫从当前位置形变过去）。没认领时转去认领；刚认领还没轮询到时可以直接给 id。 */
  openMain(sessionId?: string): void;
  /** 打开便签对应的侧边会话：正在看主会话时放进副屏并排看，否则直接切过去。 */
  openTask(task: AssistantTask, where?: 'auto' | 'primary' | 'pane'): void;
  /** 回首页并展开认领卡片。 */
  goAdopt(): void;
  openSettings(): void;
};

const noop = () => undefined;
const fallbackNav: CompanionNav = { openMain: noop, openTask: noop, goAdopt: noop, openSettings: noop };
const CompanionNavContext = createContext<CompanionNav>(fallbackNav);
export const CompanionNavProvider = CompanionNavContext.Provider;
export const useCompanionNav = () => useContext(CompanionNavContext);
