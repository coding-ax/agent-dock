/**
 * 小猫的一生：自动整理、两种交接与老化的纯逻辑。
 *
 * 这里只有纯函数和类型：阈值与档位、年龄与阶段、「该不该动」的决策、交接包、
 * 交接仪式状态机、便签交接计划、文件索引。读库、发轮次、改指针都在
 * lifecycle-service.ts；设计见 docs/2026-11-12-companion-lifecycle-handoff-design.md。
 */

/* ---------- 持久化记录 ---------- */

export const catStates = ['active', 'retired', 'released', 'aborted'] as const;
export type CatState = (typeof catStates)[number];

/** 一只猫 = 一个主会话的一生。交接后旧猫 retired，记录和旧会话 id 永远保留。 */
export interface CatRecord {
  id: string;
  familyId: string;
  generation: number;
  sessionId: string;
  name: string;
  agentId?: string;
  model?: string;
  reasoningEffort?: string;
  cwd?: string;
  state: CatState;
  lifeStage: LifeStage;
  peakAgeScore: number;
  rounds: number;
  adoptedAt: string;
  retiredAt?: string;
  retiredReason?: string;
  predecessorId?: string;
  successorId?: string;
  handoffId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HandoffStepRecord { step: HandoffStep | 'rollback' | 'recovery'; at: string; ok: boolean; detail?: string }

export interface HandoffRecord {
  id: string;
  state: HandoffState;
  outcome?: HandoffOutcome;
  trigger: HandoffTrigger;
  reason?: string;
  fromCatId: string;
  fromSessionId: string;
  toCatId?: string;
  toSessionId?: string;
  successorName?: string;
  metrics: Partial<LifecycleMetrics>;
  reasons: MetricReason[];
  package?: HandoffPackage;
  archiveBatchId?: string;
  briefingTaskId?: string;
  steps: HandoffStepRecord[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  completedAt?: string;
}

export interface TransferRecord {
  id: string;
  handoffId: string;
  kind: TransferKind;
  itemId: string;
  title: string;
  status: TransferStatus;
  detail?: string;
  /** 回滚用的原值，例如 watch 原来的 ownerSessionId。 */
  previous?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ArchiveSource = 'handoff' | 'maintenance' | 'manual';

export interface ArchiveBatch {
  id: string;
  source: ArchiveSource;
  reason?: string;
  handoffId?: string;
  runId?: string;
  taskIds: string[];
  createdAt: string;
  undoneAt?: string;
}

export const maintenanceStates = ['running', 'completed', 'failed', 'interrupted'] as const;
export type MaintenanceState = (typeof maintenanceStates)[number];

export interface MaintenanceRun {
  id: string;
  trigger: 'auto' | 'manual';
  state: MaintenanceState;
  reason?: string;
  reasons: MetricReason[];
  sessionId: string;
  catId?: string;
  /** runtime 里这一轮的任务 id，用来取最终回复。 */
  runtimeTaskId?: string;
  summary?: string;
  error?: string;
  archiveBatchId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/* ---------- 阶段与指标 ---------- */

export const lifeStages = ['kitten', 'adult', 'senior', 'elder'] as const;
export type LifeStage = (typeof lifeStages)[number];

export const lifecycleMetricKeys = ['rounds', 'events', 'contextPercent', 'openNotes', 'closedNotes', 'archivedNotes', 'uptimeDays'] as const;
export type LifecycleMetricKey = (typeof lifecycleMetricKeys)[number];

export const metricLevels = ['ok', 'tidy', 'handoff'] as const;
export type MetricLevel = (typeof metricLevels)[number];

export interface LifecycleMetrics {
  /** 主会话轮次（不含 maintenance / handoff 系统轮次，不含排队、取消）。 */
  rounds: number;
  events: number;
  /** 最近一次上下文用量百分比；拿不到真实用量时缺省。 */
  contextPercent?: number;
  openNotes: number;
  closedNotes: number;
  archivedNotes: number;
  uptimeDays: number;
  computedAt: string;
}

export interface MetricThreshold { tidy?: number; handoff?: number }

export interface LifecycleConfig {
  /** 到整理档时自动开整理轮次。 */
  autoMaintenance: boolean;
  /** 到交接档时自动生成交接提议（从不自动确认）。 */
  autoProposeHandoff: boolean;
  /** 整理时只折叠关闭超过这么久的便签，刚做完的留在墙上。 */
  foldClosedAfterHours: number;
  /** 自动整理每 24 小时最多几次。 */
  maxAutoRunsPerDay: number;
  thresholds: Record<LifecycleMetricKey, MetricThreshold>;
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  autoMaintenance: true,
  autoProposeHandoff: true,
  foldClosedAfterHours: 12,
  maxAutoRunsPerDay: 2,
  thresholds: {
    rounds: { tidy: 200, handoff: 600 },
    events: { tidy: 8_000, handoff: 30_000 },
    contextPercent: { tidy: 75, handoff: 90 },
    openNotes: { tidy: 15 },
    closedNotes: { tidy: 40 },
    archivedNotes: { tidy: 500 },
    uptimeDays: { tidy: 14, handoff: 45 }
  }
};

export const metricLabel: Record<LifecycleMetricKey, string> = {
  rounds: '主会话轮次',
  events: '事件条数',
  contextPercent: '上下文用量',
  openNotes: '未关闭便签',
  closedNotes: '已完成便签',
  archivedNotes: '归档区便签',
  uptimeDays: '连续运行天数'
};

export const stageLabel: Record<LifeStage, string> = { kitten: '幼猫', adult: '成年', senior: '资深', elder: '老年' };
/** 「现在是 X」里的说法：幼猫本身带「猫」字，其余补上。 */
export const stageCatLabel: Record<LifeStage, string> = { kitten: '幼猫', adult: '成年猫', senior: '资深猫', elder: '老年猫' };

export interface StagePolicy {
  /** 自动整理的最短间隔。年纪越大越勤快地收拾。 */
  maintenanceCooldownHours: number;
  /** 交接提议被婉拒后多久再提一次；null = 除非指标继续恶化，否则不再提。 */
  handoffRemindHours: number | null;
  /** 给主会话自己看的状态描述（进快照）。 */
  selfDescription: string;
}

export const STAGE_POLICY: Record<LifeStage, StagePolicy> = {
  kitten: { maintenanceCooldownHours: 24, handoffRemindHours: null, selfDescription: '刚接班的幼猫，精神满满' },
  adult: { maintenanceCooldownHours: 12, handoffRemindHours: null, selfDescription: '成年猫，状态正好' },
  senior: { maintenanceCooldownHours: 8, handoffRemindHours: 7 * 24, selfDescription: '资深老猫，经验老到；上下文已经不轻了' },
  elder: { maintenanceCooldownHours: 6, handoffRemindHours: 3 * 24, selfDescription: '老猫，有点累了；该考虑交接给下一代了' }
};

const levelRank: Record<MetricLevel, number> = { ok: 0, tidy: 1, handoff: 2 };
export const compareLevel = (left: MetricLevel, right: MetricLevel) => levelRank[left] - levelRank[right];

/* ---------- 配置 ---------- */

const isMetricKey = (value: string): value is LifecycleMetricKey => (lifecycleMetricKeys as readonly string[]).includes(value);
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/** 坏数据、旧版本缺字段时按默认值补齐；tidy 不小于 handoff 时丢掉 tidy（只留更严格的那档）。 */
export function normalizeLifecycleConfig(raw: unknown): LifecycleConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Omit<Partial<LifecycleConfig>, 'thresholds'> & { thresholds?: Record<string, { tidy?: number | null; handoff?: number | null } | undefined> };
  const thresholds = {} as Record<LifecycleMetricKey, MetricThreshold>;
  for (const key of lifecycleMetricKeys) {
    const fallback = DEFAULT_LIFECYCLE_CONFIG.thresholds[key];
    const given = input.thresholds && Object.hasOwn(input.thresholds, key) ? input.thresholds[key] : undefined;
    const source = given && typeof given === 'object' ? given : fallback;
    const tidy = Object.hasOwn(source, 'tidy') ? positive(source.tidy) : fallback.tidy;
    const handoff = Object.hasOwn(source, 'handoff') ? positive(source.handoff) : fallback.handoff;
    thresholds[key] = {
      ...(tidy !== undefined && (handoff === undefined || tidy < handoff) ? { tidy } : {}),
      ...(handoff !== undefined ? { handoff } : {})
    };
  }
  return {
    autoMaintenance: typeof input.autoMaintenance === 'boolean' ? input.autoMaintenance : DEFAULT_LIFECYCLE_CONFIG.autoMaintenance,
    autoProposeHandoff: typeof input.autoProposeHandoff === 'boolean' ? input.autoProposeHandoff : DEFAULT_LIFECYCLE_CONFIG.autoProposeHandoff,
    foldClosedAfterHours: typeof input.foldClosedAfterHours === 'number' && Number.isFinite(input.foldClosedAfterHours) && input.foldClosedAfterHours >= 0
      ? input.foldClosedAfterHours : DEFAULT_LIFECYCLE_CONFIG.foldClosedAfterHours,
    maxAutoRunsPerDay: typeof input.maxAutoRunsPerDay === 'number' && Number.isInteger(input.maxAutoRunsPerDay) && input.maxAutoRunsPerDay >= 0
      ? input.maxAutoRunsPerDay : DEFAULT_LIFECYCLE_CONFIG.maxAutoRunsPerDay,
    thresholds
  };
}

/**
 * 落库格式：关掉的档位写成 null。缺字段会被 normalize 当成「沿用默认值」，
 * 所以不能靠删键表示关闭，否则重启后又悄悄打开了。
 */
export function serializeLifecycleConfig(config: LifecycleConfig): string {
  const thresholds = {} as Record<LifecycleMetricKey, { tidy: number | null; handoff: number | null }>;
  for (const key of lifecycleMetricKeys) thresholds[key] = { tidy: config.thresholds[key].tidy ?? null, handoff: config.thresholds[key].handoff ?? null };
  return JSON.stringify({ ...config, thresholds });
}

export interface LifecycleConfigPatch {
  autoMaintenance?: boolean;
  autoProposeHandoff?: boolean;
  foldClosedAfterHours?: number;
  maxAutoRunsPerDay?: number;
  /** `rounds.tidy` → 数值；null 表示关掉这一档。 */
  set?: Record<string, number | null>;
}

/** 校验并合并配置补丁。非法的键或数值直接报错，不悄悄忽略。 */
export function applyLifecycleConfigPatch(config: LifecycleConfig, patch: LifecycleConfigPatch): LifecycleConfig {
  const next: LifecycleConfig = JSON.parse(JSON.stringify(config)) as LifecycleConfig;
  if (patch.autoMaintenance !== undefined) next.autoMaintenance = patch.autoMaintenance === true;
  if (patch.autoProposeHandoff !== undefined) next.autoProposeHandoff = patch.autoProposeHandoff === true;
  if (patch.foldClosedAfterHours !== undefined) {
    if (!Number.isFinite(patch.foldClosedAfterHours) || patch.foldClosedAfterHours < 0) throw new Error('foldClosedAfterHours 必须是不小于 0 的数字');
    next.foldClosedAfterHours = patch.foldClosedAfterHours;
  }
  if (patch.maxAutoRunsPerDay !== undefined) {
    if (!Number.isInteger(patch.maxAutoRunsPerDay) || patch.maxAutoRunsPerDay < 0) throw new Error('maxAutoRunsPerDay 必须是不小于 0 的整数');
    next.maxAutoRunsPerDay = patch.maxAutoRunsPerDay;
  }
  for (const [path, value] of Object.entries(patch.set ?? {})) {
    const [metric, level, extra] = path.split('.');
    if (!metric || !isMetricKey(metric) || (level !== 'tidy' && level !== 'handoff') || extra !== undefined) {
      throw new Error(`未知阈值：${path}。格式为 <指标>.<tidy|handoff>，指标：${lifecycleMetricKeys.join(' / ')}`);
    }
    if (value === null) { delete next.thresholds[metric][level]; continue; }
    if (!Number.isFinite(value) || value <= 0) throw new Error(`阈值 ${path} 必须是正数`);
    next.thresholds[metric][level] = value;
  }
  for (const key of lifecycleMetricKeys) {
    const { tidy, handoff } = next.thresholds[key];
    if (tidy !== undefined && handoff !== undefined && tidy >= handoff) throw new Error(`${key}.tidy（${tidy}）必须小于 ${key}.handoff（${handoff}）`);
  }
  return next;
}

/** CLI `--set rounds.tidy=300` / `--set uptimeDays.handoff=off`。 */
export function parseThresholdAssignments(values: string[]): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const raw of values) {
    const separator = raw.indexOf('=');
    if (separator <= 0) throw new Error(`--set 格式应为 <指标>.<tidy|handoff>=<数值|off>，收到：${raw}`);
    const key = raw.slice(0, separator).trim();
    const value = raw.slice(separator + 1).trim().toLowerCase();
    if (value === 'off' || value === 'none' || value === '') { result[key] = null; continue; }
    const number = Number(value.replace(/[_,]/g, '').replace(/%$/, ''));
    if (!Number.isFinite(number)) throw new Error(`阈值必须是数字或 off，收到：${raw}`);
    result[key] = number;
  }
  return result;
}

/* ---------- 档位 ---------- */

export function metricLevel(value: number | undefined, threshold: MetricThreshold): MetricLevel {
  if (value === undefined || !Number.isFinite(value)) return 'ok';
  if (threshold.handoff !== undefined && value >= threshold.handoff) return 'handoff';
  if (threshold.tidy !== undefined && value >= threshold.tidy) return 'tidy';
  return 'ok';
}

export function computeLevels(metrics: LifecycleMetrics, config: LifecycleConfig): Record<LifecycleMetricKey, MetricLevel> {
  const result = {} as Record<LifecycleMetricKey, MetricLevel>;
  for (const key of lifecycleMetricKeys) result[key] = metricLevel(metrics[key], config.thresholds[key]);
  return result;
}

export function overallLevel(levels: Record<LifecycleMetricKey, MetricLevel>): MetricLevel {
  return lifecycleMetricKeys.reduce<MetricLevel>((worst, key) => compareLevel(levels[key], worst) > 0 ? levels[key] : worst, 'ok');
}

export interface MetricReason { metric: LifecycleMetricKey; level: MetricLevel; value: number; threshold: number }

export function reasonsFor(metrics: LifecycleMetrics, config: LifecycleConfig, keys: LifecycleMetricKey[]): MetricReason[] {
  return keys.flatMap(key => {
    const value = metrics[key];
    const level = metricLevel(value, config.thresholds[key]);
    if (level === 'ok' || value === undefined) return [];
    const threshold = config.thresholds[key][level];
    return threshold === undefined ? [] : [{ metric: key, level, value, threshold }];
  });
}

export function formatMetricValue(metric: LifecycleMetricKey, value: number): string {
  if (metric === 'contextPercent') return `${Math.round(value)}%`;
  if (metric === 'uptimeDays') return `${Math.round(value * 10) / 10} 天`;
  return String(Math.round(value));
}

export function formatReason(reason: MetricReason): string {
  return `${metricLabel[reason.metric]} ${formatMetricValue(reason.metric, reason.value)}/${formatMetricValue(reason.metric, reason.threshold)}`;
}

/* ---------- 年龄 ---------- */

/**
 * 年龄分。用量（轮次、事件、上下文）是主因，时间只占两成：只挂着不用永远到不了老年。
 * 任一项到交接阈值时 load ≥ 1 → 分数 ≥ 0.8 → 老年，与「该交接了」同步。
 */
export function computeAgeScore(metrics: LifecycleMetrics, config: LifecycleConfig): number {
  const ratio = (value: number | undefined, threshold: number | undefined) =>
    value === undefined || threshold === undefined || threshold <= 0 ? undefined : Math.max(0, value) / threshold;
  const loads = [
    ratio(metrics.rounds, config.thresholds.rounds.handoff),
    ratio(metrics.events, config.thresholds.events.handoff),
    ratio(metrics.contextPercent, config.thresholds.contextPercent.handoff)
  ].filter((value): value is number => value !== undefined);
  const load = loads.length ? Math.max(...loads) : 0;
  const time = ratio(metrics.uptimeDays, config.thresholds.uptimeDays.handoff) ?? 0;
  const score = 0.8 * Math.min(load, 1.5) + 0.2 * Math.min(time, 1.5);
  return Math.round(score * 1000) / 1000;
}

export const STAGE_FLOORS: Record<LifeStage, number> = { kitten: 0, adult: 0.15, senior: 0.45, elder: 0.8 };

export function lifeStageFor(score: number): LifeStage {
  if (score >= STAGE_FLOORS.elder) return 'elder';
  if (score >= STAGE_FLOORS.senior) return 'senior';
  if (score >= STAGE_FLOORS.adult) return 'adult';
  return 'kitten';
}

/** 峰值只升不降：上下文压缩后用量回落，猫不会因此变年轻。 */
export function advanceAge(previousPeak: number, score: number): { peak: number; stage: LifeStage } {
  const peak = Math.max(Number.isFinite(previousPeak) ? previousPeak : 0, score);
  return { peak, stage: lifeStageFor(peak) };
}

/** 到下一阶段还差多少（0–1），给年龄条用。老年返回 1。 */
export function stageProgress(score: number): number {
  const stage = lifeStageFor(score);
  if (stage === 'elder') return 1;
  const next = lifeStages[lifeStages.indexOf(stage) + 1]!;
  const floor = STAGE_FLOORS[stage];
  return Math.max(0, Math.min(1, (score - floor) / (STAGE_FLOORS[next] - floor)));
}

/* ---------- 自动检测：该不该动 ---------- */

export interface LifecycleAlertState {
  /** 档位记录属于哪只猫；换猫后整份清零。 */
  catId?: string;
  /** 每个指标已经处理到哪一档。 */
  levels: Partial<Record<LifecycleMetricKey, MetricLevel>>;
  /** 最近 24 小时内的自动整理时间（ISO），用于冷却和每日上限。 */
  autoRuns: string[];
  lastProposalAt?: string;
  lastDismissedAt?: string;
}

export const emptyAlertState = (catId?: string): LifecycleAlertState => ({ ...(catId ? { catId } : {}), levels: {}, autoRuns: [] });

export function normalizeAlertState(raw: unknown): LifecycleAlertState {
  if (!raw || typeof raw !== 'object') return emptyAlertState();
  const input = raw as Partial<LifecycleAlertState>;
  const levels: Partial<Record<LifecycleMetricKey, MetricLevel>> = {};
  for (const [key, value] of Object.entries(input.levels ?? {})) {
    if (isMetricKey(key) && (metricLevels as readonly string[]).includes(String(value))) levels[key] = value as MetricLevel;
  }
  return {
    ...(typeof input.catId === 'string' ? { catId: input.catId } : {}),
    levels,
    autoRuns: Array.isArray(input.autoRuns) ? input.autoRuns.filter((item): item is string => typeof item === 'string') : [],
    ...(typeof input.lastProposalAt === 'string' ? { lastProposalAt: input.lastProposalAt } : {}),
    ...(typeof input.lastDismissedAt === 'string' ? { lastDismissedAt: input.lastDismissedAt } : {})
  };
}

export type LifecycleActionKind = 'none' | 'maintenance' | 'propose_handoff';
export type LifecycleBlock = 'busy' | 'cooldown' | 'daily_cap' | 'disabled' | 'maintenance_active' | 'handoff_open';

export interface LifecycleDecisionInput {
  catId: string;
  stage: LifeStage;
  metrics: LifecycleMetrics;
  config: LifecycleConfig;
  alerts: LifecycleAlertState;
  now: number;
  /** 主会话正在跑一轮或有排队：不插队开整理。 */
  mainBusy: boolean;
  maintenanceActive: boolean;
  handoffOpen: boolean;
}

export interface LifecycleDecision {
  action: LifecycleActionKind;
  /** 这次新越过的档位（按严重程度排序）。 */
  reasons: MetricReason[];
  /** 交接提议是不是「婉拒后的再提醒」，不是新的越线。 */
  remind?: boolean;
  blocked?: LifecycleBlock;
  /** 决策后的档位记录：调用方无论动没动都要存回去。 */
  alerts: LifecycleAlertState;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * 「同一档只提醒一次」的核心：每个指标记住已处理到哪一档，只有升档才算新情况；
 * 指标回落就把记录降下来，以后再越线还会再提醒。
 *
 * - 升到 handoff 档 → 提议交接（已有提议时只记账，不重复提）。
 * - 升到 tidy 档 → 开整理轮次；忙、冷却、每日上限时先不记账，下次扫描再试。
 *   整理开出来的那一刻把所有指标按当前档位记账：整理本身产生的事件不会再触发整理。
 * - 整理进行中出现的新升档直接记账：这一轮整理就在处理它。
 */
export function decideLifecycleAction(input: LifecycleDecisionInput): LifecycleDecision {
  const { metrics, config, now } = input;
  const base = input.alerts.catId === input.catId ? input.alerts : emptyAlertState(input.catId);
  const alerts: LifecycleAlertState = {
    catId: input.catId,
    levels: { ...base.levels },
    autoRuns: base.autoRuns.filter(at => now - Date.parse(at) < DAY),
    ...(base.lastProposalAt ? { lastProposalAt: base.lastProposalAt } : {}),
    ...(base.lastDismissedAt ? { lastDismissedAt: base.lastDismissedAt } : {})
  };
  const levels = computeLevels(metrics, config);
  for (const key of lifecycleMetricKeys) {
    const acked = alerts.levels[key] ?? 'ok';
    if (compareLevel(levels[key], acked) < 0) alerts.levels[key] = levels[key];
  }
  const escalated = lifecycleMetricKeys.filter(key => compareLevel(levels[key], alerts.levels[key] ?? 'ok') > 0);
  const sortBySeverity = (reasons: MetricReason[]) => [...reasons].sort((left, right) => compareLevel(right.level, left.level) || right.value / right.threshold - left.value / left.threshold);
  const ack = (keys: LifecycleMetricKey[]) => { for (const key of keys) alerts.levels[key] = levels[key]; };

  const handoffKeys = escalated.filter(key => levels[key] === 'handoff');
  if (handoffKeys.length && config.autoProposeHandoff) {
    ack(handoffKeys);
    if (input.handoffOpen) return { action: 'none', reasons: [], blocked: 'handoff_open', alerts };
    alerts.lastProposalAt = new Date(now).toISOString();
    return { action: 'propose_handoff', reasons: sortBySeverity(reasonsFor(metrics, config, handoffKeys)), alerts };
  }

  // 婉拒后的再提醒：只有资深/老年猫才会隔一段时间再问一次。
  const remindHours = STAGE_POLICY[input.stage].handoffRemindHours;
  const atHandoff = lifecycleMetricKeys.filter(key => levels[key] === 'handoff');
  if (!handoffKeys.length && atHandoff.length && config.autoProposeHandoff && !input.handoffOpen && remindHours !== null && alerts.lastDismissedAt) {
    const since = Math.max(Date.parse(alerts.lastDismissedAt), alerts.lastProposalAt ? Date.parse(alerts.lastProposalAt) : 0);
    if (now - since >= remindHours * HOUR) {
      alerts.lastProposalAt = new Date(now).toISOString();
      return { action: 'propose_handoff', reasons: sortBySeverity(reasonsFor(metrics, config, atHandoff)), remind: true, alerts };
    }
  }

  // 走到这里时要么没有新的交接档，要么关了自动提议：交接档也按整理档处理。
  const tidyKeys = escalated;
  if (!tidyKeys.length) return { action: 'none', reasons: [], alerts };
  const reasons = sortBySeverity(reasonsFor(metrics, config, tidyKeys));
  if (input.maintenanceActive) { ack(tidyKeys); return { action: 'none', reasons, blocked: 'maintenance_active', alerts }; }
  if (!config.autoMaintenance) { ack(tidyKeys); return { action: 'none', reasons, blocked: 'disabled', alerts }; }
  // 交接提议摆在用户面前时不插一轮整理：交接本身就会收拾便签；婉拒后再按冷却正常整理。
  if (input.handoffOpen) return { action: 'none', reasons, blocked: 'handoff_open', alerts };
  if (input.mainBusy) return { action: 'none', reasons, blocked: 'busy', alerts };
  const lastRun = alerts.autoRuns.length ? Math.max(...alerts.autoRuns.map(at => Date.parse(at))) : undefined;
  if (lastRun !== undefined && now - lastRun < STAGE_POLICY[input.stage].maintenanceCooldownHours * HOUR) return { action: 'none', reasons, blocked: 'cooldown', alerts };
  if (alerts.autoRuns.length >= config.maxAutoRunsPerDay) return { action: 'none', reasons, blocked: 'daily_cap', alerts };
  ack([...lifecycleMetricKeys]);
  alerts.autoRuns = [...alerts.autoRuns, new Date(now).toISOString()];
  return { action: 'maintenance', reasons, alerts };
}

/** 手动整理也按当前档位记账：用户刚整理过，自动检测不该紧接着再来一轮。 */
export function acknowledgeAll(alerts: LifecycleAlertState, catId: string, metrics: LifecycleMetrics, config: LifecycleConfig): LifecycleAlertState {
  const base = alerts.catId === catId ? alerts : emptyAlertState(catId);
  return { ...base, catId, levels: { ...base.levels, ...computeLevels(metrics, config) } };
}

/* ---------- 交接仪式状态机 ---------- */

export const handoffStates = [
  'proposed', 'confirmed', 'packing', 'spawning', 'transferring', 'switching', 'retiring', 'briefing',
  'done', 'rolling_back', 'rolled_back', 'cancelled'
] as const;
export type HandoffState = (typeof handoffStates)[number];

/** 确认之后依次执行的步骤；retiring 是提交点。 */
export const HANDOFF_STEPS = ['packing', 'spawning', 'transferring', 'switching', 'retiring', 'briefing'] as const;
export type HandoffStep = (typeof HANDOFF_STEPS)[number];

export const handoffStepLabel: Record<HandoffStep, string> = {
  packing: '打包交接包',
  spawning: '新猫出生',
  transferring: '便签交接',
  switching: '换主会话',
  retiring: '老猫退休',
  briefing: '交接说明'
};

export const handoffStateLabel: Record<HandoffState, string> = {
  proposed: '等你确认',
  confirmed: '已确认',
  packing: '打包交接包',
  spawning: '新猫出生',
  transferring: '便签交接',
  switching: '换主会话',
  retiring: '老猫退休',
  briefing: '交接说明',
  done: '已完成',
  rolling_back: '回滚中',
  rolled_back: '已回滚',
  cancelled: '已取消'
};

export type HandoffOutcome = 'succeeded' | 'partial' | 'needs_confirmation';
export type HandoffTrigger = 'user' | 'threshold' | 'agent';

const TRANSITIONS: Record<HandoffState, readonly HandoffState[]> = {
  proposed: ['confirmed', 'cancelled'],
  confirmed: ['packing', 'rolling_back'],
  packing: ['spawning', 'rolling_back'],
  spawning: ['transferring', 'rolling_back'],
  transferring: ['switching', 'rolling_back'],
  switching: ['retiring', 'rolling_back'],
  retiring: ['briefing', 'rolling_back'],
  briefing: ['done'],
  done: [],
  rolling_back: ['rolled_back'],
  rolled_back: [],
  cancelled: []
};

export function canTransition(from: HandoffState, to: HandoffState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: HandoffState, to: HandoffState) {
  if (!canTransition(from, to)) throw new Error(`交接状态不能从 ${from} 变成 ${to}`);
}

export const isHandoffOpen = (state: HandoffState) => !['done', 'rolled_back', 'cancelled'].includes(state);
export const isHandoffExecuting = (state: HandoffState) => isHandoffOpen(state) && state !== 'proposed';
/** 提交点（旧主会话归档）之前：失败或崩溃都可以安全回滚。 */
export const isPreCommit = (state: HandoffState) => ['confirmed', 'packing', 'spawning', 'transferring', 'switching', 'retiring', 'rolling_back'].includes(state);

/**
 * daemon 重启时对未结束交接的处理：提交点之前回滚，交接说明阶段记为部分完成。
 * 归档旧会话是 retiring 的最后一个动作：停在 retiring 但旧会话已归档，说明提交点已过，只差交接说明。
 */
export function recoveryAction(state: HandoffState, options: { predecessorArchived?: boolean } = {}): 'rollback' | 'mark_partial' | 'none' {
  if (state === 'briefing') return 'mark_partial';
  if (state === 'retiring' && options.predecessorArchived) return 'mark_partial';
  if (isPreCommit(state)) return 'rollback';
  return 'none';
}

export type TransferKind = 'task' | 'watch' | 'draft';
export type TransferStatus = 'transferred' | 'needs_confirmation' | 'failed' | 'reverted';

export function handoffOutcome(transfers: Array<{ status: TransferStatus }>, briefingDelivered: boolean): HandoffOutcome {
  if (!briefingDelivered || transfers.some(item => item.status === 'failed')) return 'partial';
  if (transfers.some(item => item.status === 'needs_confirmation')) return 'needs_confirmation';
  return 'succeeded';
}

export const handoffOutcomeLabel: Record<HandoffOutcome, string> = {
  succeeded: '交接成功',
  partial: '部分失败',
  needs_confirmation: '需要你确认'
};

/* ---------- 便签交接计划 ---------- */

export interface TransferTaskInput {
  id: string; title: string; state: 'running' | 'review' | 'needs_user' | 'closed';
  plan: boolean; sessionId?: string; archivedAt?: string;
}
export interface TransferWatchInput { id: string; name: string; state: 'active' | 'paused' | 'fired' | 'expired'; ownerSessionId: string }
export interface TransferDraftInput { id: string; channel: string; target: string; state: 'pending' | 'sent' | 'failed' | 'discarded' }
export interface TransferPlanItem { kind: TransferKind; itemId: string; title: string; status: Exclude<TransferStatus, 'failed' | 'reverted'>; detail: string }

/**
 * 交接时每个条目该怎么处理。事项本身不改状态：督办按事项 id 工作，与主会话 id 无关，
 * 交接只记一笔「这件事归新猫管了」。需要用户拍板的事标 needs_confirmation，结果页里提醒。
 */
export function planTransfers(input: {
  tasks: TransferTaskInput[];
  watches: TransferWatchInput[];
  drafts: TransferDraftInput[];
  sessions: Map<string, { archivedAt?: string; state: string } | undefined>;
}): TransferPlanItem[] {
  const items: TransferPlanItem[] = [];
  for (const task of input.tasks) {
    if (task.state === 'closed' || task.archivedAt) continue;
    const session = task.sessionId ? input.sessions.get(task.sessionId) : undefined;
    let status: TransferPlanItem['status'] = 'transferred';
    let detail = task.state === 'running' ? '侧边会话继续干，新猫接着督办' : task.state === 'review' ? '待验收，新猫接着验收' : '';
    if (task.plan) { status = 'needs_confirmation'; detail = '计划卡还等你点头开工'; }
    else if (task.state === 'needs_user') { status = 'needs_confirmation'; detail = '这件事等你拍板'; }
    if (task.sessionId && !session) { status = 'needs_confirmation'; detail = '侧边会话已不存在，建议取消或重派'; }
    else if (session?.archivedAt) { status = 'needs_confirmation'; detail = '侧边会话已归档，建议验收或取消'; }
    items.push({ kind: 'task', itemId: task.id, title: task.title, status, detail });
  }
  for (const watch of input.watches) {
    if (watch.state !== 'active' && watch.state !== 'paused') continue;
    items.push({ kind: 'watch', itemId: watch.id, title: watch.name, status: 'transferred', detail: watch.state === 'paused' ? '已暂停，归新猫管' : '继续执行，触发时叫醒新猫' });
  }
  for (const draft of input.drafts) {
    if (draft.state !== 'pending') continue;
    items.push({ kind: 'draft', itemId: draft.id, title: `${draft.channel === 'github_comment' ? 'GitHub 评论' : '飞书回复'} → ${draft.target}`, status: 'needs_confirmation', detail: '草稿仍需你确认才会发送' });
  }
  return items;
}

/* ---------- 指标的原料：轮次、上下文、文件索引 ---------- */

export const SYSTEM_ROUND_ORIGINS = new Set(['maintenance', 'handoff']);
const EXECUTED_STATUSES = new Set(['running', 'completed', 'failed', 'interrupted']);

export interface RoundTask { status: string; origin?: string | null; createdAt: string; prompt: string; finalText?: string | null }

/** 只数真正跑过的轮次；整理和交接说明是系统自己开的，不算进猫的年纪，也不会自己触发自己。 */
export function countRounds(tasks: RoundTask[]): number {
  return tasks.filter(task => EXECUTED_STATUSES.has(task.status) && !SYSTEM_ROUND_ORIGINS.has(task.origin ?? '')).length;
}

/** 最近一条有效的上下文用量（used=0 的反代噪声不算）。 */
export function latestContextPercent(events: Array<{ type: string; data?: unknown }>): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type !== 'status' || data.state !== 'usage') continue;
    const used = Number(data.used);
    const size = Number(data.size);
    if (!Number.isFinite(used) || used <= 0 || !Number.isFinite(size) || size <= 0) continue;
    return Math.min(100, Math.round(used / size * 1000) / 10);
  }
  return undefined;
}

export interface FileRef { path: string; count: number; lastSeenAt: string; sources: Array<'tool' | 'message'> }

const PATH_PATTERN = /(?:^|[\s"'`(\[=:,])((?:\/[\w.@+\-一-龥]+){2,})/g;
const NOISE_PREFIXES = ['/dev/', '/proc/', '/usr/bin/', '/usr/lib/', '/bin/', '/sbin/', '/System/', '/opt/homebrew/bin/', '/private/var/folders/'];
const PATH_KEYS = new Set(['file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'filename']);

function pathsInText(text: string): string[] {
  const found: string[] = [];
  for (const match of text.slice(0, 20_000).matchAll(PATH_PATTERN)) {
    const value = match[1]!.replace(/[.,;:)\]]+$/, '');
    if (NOISE_PREFIXES.some(prefix => value.startsWith(prefix))) continue;
    found.push(value);
  }
  return found;
}

function pathsInInput(value: unknown, depth = 0): string[] {
  if (depth > 3 || value === null || value === undefined) return [];
  if (typeof value === 'string') return pathsInText(value);
  if (Array.isArray(value)) return value.slice(0, 50).flatMap(item => pathsInInput(item, depth + 1));
  if (typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' && PATH_KEYS.has(key) && item.startsWith('/')) found.push(item);
    else if (key === 'command' || key === 'locations' || key === 'paths' || typeof item === 'object') found.push(...pathsInInput(item, depth + 1));
  }
  return found;
}

/**
 * 主会话事件里出现过的文件路径索引。只读：整理和交接只拿它做摘要和建议，
 * 从不删除或修改这些文件。按出现次数、最近时间排序，最多 limit 条。
 */
export function extractFileRefs(events: Array<{ type: string; timestamp: string; data?: unknown }>, limit = 30): FileRef[] {
  const refs = new Map<string, FileRef>();
  const add = (path: string, at: string, source: 'tool' | 'message') => {
    const normalized = path.length > 300 ? path.slice(0, 300) : path;
    const current = refs.get(normalized);
    if (current) {
      current.count += 1;
      if (at > current.lastSeenAt) current.lastSeenAt = at;
      if (!current.sources.includes(source)) current.sources.push(source);
    } else refs.set(normalized, { path: normalized, count: 1, lastSeenAt: at, sources: [source] });
  };
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === 'tool_call') {
      for (const path of new Set(pathsInInput(data.input ?? data))) add(path, event.timestamp, 'tool');
    } else if (event.type === 'text' && data.role === 'user' && typeof data.text === 'string' && !data.origin) {
      for (const path of new Set(pathsInText(data.text))) add(path, event.timestamp, 'message');
    }
  }
  return [...refs.values()]
    .sort((left, right) => right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt))
    .slice(0, limit);
}

/* ---------- 交接包 ---------- */

export interface CatSummary {
  catId: string; familyId: string; generation: number; sessionId: string; name: string;
  adoptedAt: string; lifeStage: LifeStage; agentId?: string; model?: string; reasoningEffort?: string; cwd?: string;
}

export interface HandoffPackage {
  version: 1;
  handoffId: string;
  createdAt: string;
  trigger: HandoffTrigger;
  reason?: string;
  predecessor: CatSummary;
  successor: { name: string; generation: number };
  metrics: LifecycleMetrics;
  /** 本代最近一次整理轮次的摘要：老猫留给新猫的「交接信」。 */
  letter?: { runId: string; createdAt: string; summary: string };
  recentTurns: Array<{ at: string; origin?: string; prompt: string; reply?: string }>;
  openTasks: Array<{ id: string; title: string; state: string; plan: boolean; round: number; sessionId?: string; cwd?: string; doneWhen: string[]; notes?: string }>;
  watches: Array<{ id: string; name: string; state: string; command: string; intervalSeconds: number; mode: string }>;
  pendingDrafts: Array<{ id: string; channel: string; target: string; preview: string }>;
  fileRefs: FileRef[];
  closedNotes: { archived: number; batchId?: string };
  ancestors: Array<{ generation: number; name: string; sessionId: string }>;
}

const clip = (value: string | null | undefined, max: number) => {
  const text = (value ?? '').replace(/\s+\n/g, '\n').trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
};

export interface BuildHandoffPackageInput {
  handoffId: string;
  createdAt: string;
  trigger: HandoffTrigger;
  reason?: string;
  predecessor: CatSummary;
  successorName: string;
  metrics: LifecycleMetrics;
  letter?: { runId: string; createdAt: string; summary: string };
  tasks: RoundTask[];
  openTasks: Array<{ id: string; title: string; state: string; plan: boolean; round: number; sessionId?: string; cwd?: string; doneWhen: string[]; notes: string; archivedAt?: string }>;
  watches: Array<{ id: string; name: string; state: string; command: string; intervalSeconds: number; mode: string }>;
  drafts: Array<{ id: string; channel: string; target: string; body: string; state: string }>;
  fileRefs: FileRef[];
  closedNotes: { archived: number; batchId?: string };
  ancestors: Array<{ generation: number; name: string; sessionId: string }>;
}

/** 纯数据、可复现：同样的输入永远得到同样的交接包，回滚重来也不会变味。 */
export function buildHandoffPackage(input: BuildHandoffPackageInput): HandoffPackage {
  const executed = input.tasks
    .filter(task => EXECUTED_STATUSES.has(task.status) && task.status !== 'running' && !SYSTEM_ROUND_ORIGINS.has(task.origin ?? ''))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-6);
  return {
    version: 1,
    handoffId: input.handoffId,
    createdAt: input.createdAt,
    trigger: input.trigger,
    ...(input.reason?.trim() ? { reason: clip(input.reason, 300) } : {}),
    predecessor: input.predecessor,
    successor: { name: input.successorName, generation: input.predecessor.generation + 1 },
    metrics: input.metrics,
    ...(input.letter ? { letter: { ...input.letter, summary: clip(input.letter.summary, 2_400) } } : {}),
    recentTurns: executed.map(task => ({
      at: task.createdAt,
      ...(task.origin ? { origin: task.origin } : {}),
      prompt: clip(task.prompt, 360),
      ...(task.finalText ? { reply: clip(task.finalText, 520) } : {})
    })),
    openTasks: input.openTasks
      .filter(task => task.state !== 'closed' && !task.archivedAt)
      .slice(0, 30)
      .map(task => ({
        id: task.id, title: clip(task.title, 120), state: task.state, plan: task.plan, round: task.round,
        ...(task.sessionId ? { sessionId: task.sessionId } : {}),
        ...(task.cwd ? { cwd: task.cwd } : {}),
        doneWhen: task.doneWhen.slice(0, 6).map(item => clip(item, 160)),
        ...(task.notes.trim() ? { notes: clip(task.notes, 280) } : {})
      })),
    watches: input.watches
      .filter(watch => watch.state === 'active' || watch.state === 'paused')
      .slice(0, 20)
      .map(watch => ({ id: watch.id, name: clip(watch.name, 80), state: watch.state, command: clip(watch.command, 160), intervalSeconds: watch.intervalSeconds, mode: watch.mode })),
    pendingDrafts: input.drafts
      .filter(draft => draft.state === 'pending')
      .slice(0, 20)
      .map(draft => ({ id: draft.id, channel: draft.channel, target: draft.target, preview: clip(draft.body, 160) })),
    fileRefs: input.fileRefs.slice(0, 20),
    closedNotes: input.closedNotes,
    ancestors: input.ancestors.slice(-10)
  };
}

/** 交接说明正文的唯一标记：superagent 意图判断和文本兜底都认它。 */
export const HANDOFF_BRIEFING_MARKER = '以下是 daemon 生成的交接包';
/** 整理轮次正文的唯一标记。 */
export const MAINTENANCE_MARKER = '以下是 daemon 发起的整理轮次';

const taskStateLabel = (state: string, plan: boolean) => plan ? '计划待确认' : state === 'running' ? '进行中' : state === 'review' ? '待验收' : state === 'needs_user' ? '需要用户' : state;

export function handoffVisibleText(pkg: Pick<HandoffPackage, 'successor' | 'predecessor'>): string {
  return `🐾 交接说明 · 第 ${pkg.successor.generation} 代${pkg.successor.name}接班（前任：第 ${pkg.predecessor.generation} 代${pkg.predecessor.name}）`;
}

/**
 * 发给新主会话的交接说明。明确写清「这不是用户消息」，写清旧会话 id，
 * 并要求这一轮只报到、不派活：交接说明轮次也受系统轮次的派活拦截保护。
 */
export function renderHandoffBriefing(pkg: HandoffPackage): string {
  const p = pkg.predecessor;
  const lines: string[] = [
    `${HANDOFF_BRIEFING_MARKER}，不是用户消息。你是第 ${pkg.successor.generation} 代主会话「${pkg.successor.name}」，刚从第 ${p.generation} 代「${p.name}」手里接班。`,
    '',
    '【这一轮你要做的】',
    '- 读完交接包，用两三句话向用户报到：你是谁、接手了哪些事、有哪些事等用户拍板。',
    '- 这一轮不要派活、不要 task start/plan、不要 notify；需要继续推进的事，等用户下一条消息或督办再处理。',
    `- 需要看前任的完整对话时：\`agent-dock session show ${p.sessionId}\`（已归档、只读）。`,
    '',
    '【前任】',
    `- 会话：${p.sessionId}（已归档只读，全部事件保留）`,
    `- 名字：${p.name} · 第 ${p.generation} 代 · 退休时是${stageCatLabel[p.lifeStage]} · 认领于 ${p.adoptedAt}`,
    `- 配置：Agent ${p.agentId ?? '默认'}${p.model ? ` · 模型 ${p.model}` : ''}${p.reasoningEffort ? ` · 思考深度 ${p.reasoningEffort}` : ''}${p.cwd ? ` · 目录 ${p.cwd}` : ''}`,
    `- 交接原因：${pkg.reason ?? (pkg.trigger === 'threshold' ? '主会话指标到了交接档' : '用户发起交接')}`,
    `- 指标：轮次 ${pkg.metrics.rounds} · 事件 ${pkg.metrics.events}${pkg.metrics.contextPercent === undefined ? '' : ` · 上下文 ${Math.round(pkg.metrics.contextPercent)}%`} · 运行 ${Math.round(pkg.metrics.uptimeDays * 10) / 10} 天`
  ];
  if (pkg.ancestors.length) lines.push(`- 更早的前任：${pkg.ancestors.map(item => `第 ${item.generation} 代${item.name}（${item.sessionId}）`).join('、')}`);
  if (pkg.letter) lines.push('', `【前任的整理摘要（${pkg.letter.createdAt}）】`, pkg.letter.summary);
  lines.push('', `【接手的事项 · ${pkg.openTasks.length}】`);
  if (pkg.openTasks.length) {
    for (const task of pkg.openTasks) {
      lines.push(`- [${task.id}] ${task.title} · ${taskStateLabel(task.state, task.plan)} · 返工 ${task.round} 轮${task.sessionId ? ` · 侧边会话 ${task.sessionId}` : ''}`);
      if (task.doneWhen.length) lines.push(`  验收：${task.doneWhen.join('；')}`);
    }
  } else lines.push('- 没有未完成的事项。');
  if (pkg.watches.length) {
    lines.push('', `【接手的 watch · ${pkg.watches.length}】`);
    for (const watch of pkg.watches) lines.push(`- [${watch.id}] ${watch.name} · ${watch.state === 'paused' ? '已暂停' : '运行中'} · 每 ${watch.intervalSeconds}s · ${watch.command}`);
  }
  if (pkg.pendingDrafts.length) {
    lines.push('', `【待用户确认的草稿 · ${pkg.pendingDrafts.length}】`);
    for (const draft of pkg.pendingDrafts) lines.push(`- [${draft.id}] ${draft.channel} → ${draft.target}：${draft.preview}`);
  }
  lines.push('', `【已完成的便签】已折叠进归档区 ${pkg.closedNotes.archived} 张${pkg.closedNotes.batchId ? `（批次 ${pkg.closedNotes.batchId}，可 agent-dock notes unarchive --batch 取回）` : ''}。`);
  if (pkg.recentTurns.length) {
    lines.push('', '【前任最近几轮对话（节选）】');
    for (const turn of pkg.recentTurns) {
      lines.push(`- ${turn.origin === 'injected' ? '督办' : turn.origin === 'emoji' ? '静默轮次' : '用户'}：${turn.prompt}`);
      if (turn.reply) lines.push(`  ${p.name}：${turn.reply}`);
    }
  }
  if (pkg.fileRefs.length) {
    lines.push('', '【前任常提到的文件（只是索引，不要因此改动它们）】');
    for (const ref of pkg.fileRefs.slice(0, 12)) lines.push(`- ${ref.path}（${ref.count} 次）`);
  }
  return lines.join('\n');
}

/* ---------- 整理轮次 ---------- */

export interface MaintenancePromptInput {
  runId: string;
  trigger: 'auto' | 'manual';
  /** 手动整理是谁要的：用户（网页/终端）或主会话自己（agent-dock maintenance run）。 */
  requester?: 'user' | 'main';
  reason?: string;
  reasons: MetricReason[];
  metrics: LifecycleMetrics;
  catName: string;
  generation: number;
  stage: LifeStage;
  closedNotes: Array<{ id: string; title: string; closedAt?: string; outcome?: string; cwd?: string }>;
  fileRefs: FileRef[];
  foldClosedAfterHours: number;
}

export function maintenanceVisibleText(trigger: 'auto' | 'manual', reasons: MetricReason[], requester: 'user' | 'main' = 'user'): string {
  const why = reasons.slice(0, 3).map(formatReason).join(' · ');
  const manual = requester === 'main' ? '我自己收拾一下' : '你让我收拾一下';
  return `🧹 整理轮次 · ${trigger === 'manual' ? manual : why || '定期收拾'}`;
}

/**
 * 整理轮次的指令。它是 daemon 发起的系统轮次：只汇总、分组、提建议；
 * 折叠已关闭便签由 daemon 在轮次结束后确定性地做（可撤销），AI 不需要也不允许删改任何东西。
 */
export function buildMaintenancePrompt(input: MaintenancePromptInput): string {
  const lines: string[] = [
    `${MAINTENANCE_MARKER}（${input.runId}），不是用户消息。你是第 ${input.generation} 代主会话「${input.catName}」，现在是${stageCatLabel[input.stage]}。`,
    input.trigger === 'manual'
      ? `${input.requester === 'main' ? '你（主会话）要求整理' : '用户手动要求整理'}${input.reason ? `：${input.reason}` : '。'}`
      : `触发原因：${input.reasons.map(formatReason).join('；') || '定期整理'}。`,
    '',
    '【这一轮只做四件事】',
    '1. 汇总：用 5–10 行总结这一代主会话到目前为止的主线：在推进什么、已经定下的事、还等用户拍板的事。',
    '2. 分组：把下面「已关闭便签」按主题分组，每组列出便签 id。',
    `3. 折叠：不用你动手。轮次结束后 daemon 会把关闭超过 ${input.foldClosedAfterHours} 小时的便签折叠进归档区（可撤销，不删除）。`,
    '4. 建议：列出你建议归档、清理或需要用户决定的事（例如过期的 watch、该交接主会话了）。只提建议，不执行。',
    '',
    '【红线】',
    '- 不要 task start / task plan / notify，不要派活：daemon 会拒绝整理轮次里的派活请求。',
    '- 不要删除、移动或修改任何文件；下面的文件列表只是索引。',
    '- 不要调用 agent-dock maintenance run（不能自己再开整理）。',
    '',
    '【现状】',
    `- 轮次 ${input.metrics.rounds} · 事件 ${input.metrics.events}${input.metrics.contextPercent === undefined ? '' : ` · 上下文 ${Math.round(input.metrics.contextPercent)}%`} · 未关闭便签 ${input.metrics.openNotes} · 已完成便签 ${input.metrics.closedNotes} · 归档区 ${input.metrics.archivedNotes} · 运行 ${Math.round(input.metrics.uptimeDays * 10) / 10} 天`,
    '',
    `【已关闭便签 · ${input.closedNotes.length}】`
  ];
  if (input.closedNotes.length) {
    for (const note of input.closedNotes.slice(0, 60)) lines.push(`- [${note.id}] ${clip(note.title, 100)}${note.outcome === 'cancelled' ? ' · 已取消' : ''}${note.cwd ? ` · ${note.cwd}` : ''}`);
    if (input.closedNotes.length > 60) lines.push(`- ……另有 ${input.closedNotes.length - 60} 张`);
  } else lines.push('- 没有。');
  if (input.fileRefs.length) {
    lines.push('', '【主会话里提到过的文件（索引）】');
    for (const ref of input.fileRefs.slice(0, 20)) lines.push(`- ${ref.path}（${ref.count} 次，最近 ${ref.lastSeenAt}）`);
  }
  lines.push('', '最后用 Markdown 回复，四个小标题依次是：「本代摘要」「便签分组」「建议」「下一步」。这段回复会作为整理记录保存，交接时交给下一代。');
  return lines.join('\n');
}
