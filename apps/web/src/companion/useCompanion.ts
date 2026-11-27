import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type AssistantCompanion, type AssistantLifecycle, type AssistantLifecycleLight, type AssistantState, type AssistantTask, type LifeStage, type Session } from '../api';
import {
  LATE_NIGHT_END_HOUR, LATE_NIGHT_START_HOUR, RECENT_WINDOW_MS, companionStatus, countNotes, deriveMood,
  hasFailedNeedsUserTask, isMainBusy, kittenMoodMeta, sleepyThresholdMs, stabilizeKittenMood,
  type KittenMood, type KittenMoodMeta, type MoodStabilizerState, type NoteCounts
} from './companion-model';
import { useCompanionStore } from './companion-store';

/** 与服务端 DEFAULT_COMPANION_NAME 一致：旧服务端没有 companion 字段时的兜底。 */
export const DEFAULT_KITTEN_NAME = '小A同学';
const EMPTY_TASKS: AssistantTask[] = [];

/**
 * 小猫档案（指标、阈值、血缘、整理和交接记录）。只在档案或交接仪式打开时查；
 * 整理轮次或交接在跑时 1.5 秒一次，否则 15 秒。旧服务端没有这个接口时静默失败。
 */
export function useLifecycleOverview(enabled = true) {
  return useQuery({
    queryKey: ['assistant-lifecycle'],
    queryFn: api.assistantLifecycle,
    enabled,
    retry: false,
    refetchInterval: query => {
      const data = query.state.data as AssistantLifecycle | undefined;
      if (query.state.error) return false;
      const handoffRunning = Boolean(data?.handoff && data.handoff.state !== 'proposed');
      return data?.maintenance?.state === 'running' || handoffRunning ? 1_500 : 15_000;
    }
  });
}

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

/** 计算下一次昼夜切换边界（23:00 进入深夜陪伴，05:00 回到日间）。 */
function nextNightBoundary(current: number): number {
  const date = new Date(current);
  const hour = date.getHours();
  const target = new Date(current);
  target.setMinutes(0, 0, 0);
  if (hour >= LATE_NIGHT_START_HOUR) {
    target.setDate(target.getDate() + 1);
    target.setHours(LATE_NIGHT_END_HOUR);
  } else if (hour < LATE_NIGHT_END_HOUR) {
    target.setHours(LATE_NIGHT_END_HOUR);
  } else {
    target.setHours(LATE_NIGHT_START_HOUR);
  }
  return target.getTime();
}

/**
 * 心情里有三个时间窗（刚发生的事 6 秒、按年纪缩放的犯困阈值、23:00/05:00 昼夜边界）。
 * 不用每秒 tick：只在下一个窗口边界到来时刷新一次「现在」。
 */
function useMoodClock(recentAt: number | undefined, lastActiveAt: number, stage?: LifeStage) {
  const [now, setNow] = useState(() => Date.now());
  const sleepyMs = sleepyThresholdMs(stage);
  useEffect(() => {
    const current = Date.now();
    const boundaries = [
      recentAt === undefined ? 0 : recentAt + RECENT_WINDOW_MS,
      lastActiveAt + sleepyMs,
      nextNightBoundary(current),
    ].filter(boundary => boundary > current);
    if (!boundaries.length) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(...boundaries) - current + 60);
    return () => window.clearTimeout(timer);
  }, [recentAt, lastActiveAt, sleepyMs, now]);
  return Math.max(now, recentAt ?? 0, lastActiveAt);
}

/**
 * 防抖平滑：紧急/高优态立即响应，同级工作态（thinking ↔ busy）或回落态至少停留 MIN_MOOD_HOLD_MS，
 * 防止 2 秒轮询与流式事件交替导致小猫头像高频闪烁。
 */
function useStableMood(rawMood: KittenMood): KittenMood {
  const [shown, setShown] = useState<MoodStabilizerState>(() => ({ mood: rawMood, changedAt: Date.now() }));
  const pendingTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(pendingTimer.current);
    pendingTimer.current = undefined;
    const decision = stabilizeKittenMood(shown, rawMood, Date.now());
    if (decision.mood !== shown.mood) {
      setShown({ mood: decision.mood, changedAt: decision.changedAt });
      return;
    }
    if (decision.pendingDelayMs && decision.pendingDelayMs > 0) {
      pendingTimer.current = window.setTimeout(() => {
        setShown({ mood: rawMood, changedAt: Date.now() });
      }, decision.pendingDelayMs + 20);
    }
    return () => {
      window.clearTimeout(pendingTimer.current);
      pendingTimer.current = undefined;
    };
  }, [rawMood, shown]);

  return shown.mood;
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
  moodMeta: KittenMoodMeta;
  status: string;
  busy: boolean;
  /** 已折叠进归档区的便签：不上墙、不计数，归档区里只读可取出。 */
  archivedTasks: AssistantTask[];
  /** 小猫的一生：代数、阶段、交接提议、整理轮次。旧服务端为空。 */
  lifecycle?: AssistantLifecycleLight;
  stage?: LifeStage;
  generation?: number;
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
  const allTasks = data?.tasks ?? EMPTY_TASKS;
  // 归档区的便签不上墙：计数、分区、气泡都只看墙上的。
  const tasks = useMemo(() => allTasks.some(task => task.archivedAt) ? allTasks.filter(task => !task.archivedAt) : allTasks, [allTasks]);
  const archivedTasks = useMemo(() => allTasks.some(task => task.archivedAt) ? allTasks.filter(task => task.archivedAt) : EMPTY_TASKS, [allTasks]);
  const lifecycle = data?.lifecycle ?? undefined;
  const stage = lifecycle?.cat?.lifeStage;
  const recent = useCompanionStore(store => store.recent);
  const lastActiveAt = useCompanionStore(store => store.lastActiveAt);
  const now = useMoodClock(recent?.at, lastActiveAt, stage);
  const companion = data?.companion ?? undefined;
  const drafts = data?.drafts;
  const pendingDrafts = useMemo(() => (drafts ?? []).filter(draft => draft.state === 'pending').length, [drafts]);
  const maintenanceRunning = Boolean(lifecycle?.maintenance);
  const mainState = mainSession?.state;
  const mainError = mainSession?.error;
  const archived = Boolean(mainSession?.archivedAt);

  const rawMood = useMemo(() => deriveMood({
    mainState,
    mainError,
    archived,
    tasks,
    pendingDrafts,
    maintenanceRunning,
    stage,
    recent,
    lastActiveAt,
    now,
    localHour: new Date(now).getHours(),
  }), [mainState, mainError, archived, tasks, pendingDrafts, maintenanceRunning, stage, recent, lastActiveAt, now]);

  const mood = useStableMood(rawMood);

  return useMemo(() => {
    const counts = countNotes(tasks);
    const hasFailedNeedsUser = hasFailedNeedsUserTask(tasks);
    const name = companion?.name ?? (mainSession?.customTitle?.trim() || DEFAULT_KITTEN_NAME);
    const moodMeta = kittenMoodMeta(mood);
    return {
      loaded: state.isSuccess,
      adopted: Boolean(mainId),
      mainId,
      mainSession,
      companion,
      name,
      tasks,
      counts,
      pendingDrafts,
      mood,
      moodMeta,
      status: companionStatus({
        mainState,
        mainError,
        archived,
        counts,
        pendingDrafts,
        maintenanceRunning: Boolean(lifecycle?.maintenance) && !isMainBusy(mainState),
        hasFailedNeedsUser,
        mood,
        ...(recent ? { recent: recent.kind } : {}),
      }),
      busy: isMainBusy(mainState) || maintenanceRunning,
      archivedTasks,
      ...(lifecycle ? { lifecycle } : {}),
      ...(lifecycle?.cat ? { stage: lifecycle.cat.lifeStage, generation: lifecycle.cat.generation } : {})
    };
  }, [state.isSuccess, mainId, mainSession, companion, tasks, archivedTasks, lifecycle, pendingDrafts, maintenanceRunning, mainState, mainError, archived, mood, recent]);
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
  /** 打开任意会话（例如已退休小猫的只读旧会话）。 */
  openSession(sessionId: string): void;
  /** 切到自由拖拽看板视图。 */
  openBoard(boardId?: string): void;
};

const noop = () => undefined;
const fallbackNav: CompanionNav = { openMain: noop, openTask: noop, goAdopt: noop, openSettings: noop, openSession: noop, openBoard: noop };
const CompanionNavContext = createContext<CompanionNav>(fallbackNav);
export const CompanionNavProvider = CompanionNavContext.Provider;
export const useCompanionNav = () => useContext(CompanionNavContext);
