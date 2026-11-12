import type {
  AssistantLifecycleLight, HandoffOutcome, HandoffState, HandoffStepRecord, HandoffTransfer, LifeStage, LifecycleLevel,
  LifecycleMetricKey, LifecycleReason
} from '../api';
import type { BubbleTone } from './companion-model';

/**
 * 小猫的一生在网页这一侧的纯逻辑：阶段文案、仪式画面阶段、步骤进度、生命周期变化 → 气泡。
 * 与服务端 apps/server/src/assistant/lifecycle.ts 的口径一致（网页不能直接引用服务端代码）。
 */

export const LIFE_STAGES: LifeStage[] = ['kitten', 'adult', 'senior', 'elder'];
export const stageLabel: Record<LifeStage, string> = { kitten: '幼猫', adult: '成年', senior: '资深', elder: '老年' };
/** 「现在是 X」里的说法：幼猫本身带「猫」字，其余补上。 */
export const stageCatLabel: Record<LifeStage, string> = { kitten: '幼猫', adult: '成年猫', senior: '资深猫', elder: '老年猫' };
export const stageBlurb: Record<LifeStage, string> = {
  kitten: '刚接班，精神满满，什么都想试试',
  adult: '状态正好，派活验收都利索',
  senior: '经验老到，就是记忆有点沉了',
  elder: '有点累了，该考虑交接给下一代'
};
/** 与服务端 STAGE_FLOORS 一致：年龄分到这里就进入该阶段（峰值只升不降）。 */
export const STAGE_FLOORS: Record<LifeStage, number> = { kitten: 0, adult: 0.15, senior: 0.45, elder: 0.8 };

export const generationLabel = (generation?: number) => generation ? `第 ${generation} 代` : '';

export function stageBadge(cat?: { generation: number; lifeStage: LifeStage } | null): string {
  return cat ? `${generationLabel(cat.generation)} · ${stageLabel[cat.lifeStage]}` : '';
}

/** 年龄条：0–100，老年起点 0.8 之后封顶。 */
export function agePercent(peakAgeScore: number | undefined): number {
  if (!peakAgeScore || !Number.isFinite(peakAgeScore)) return 0;
  return Math.round(Math.min(1, Math.max(0, peakAgeScore)) * 100);
}

export function nextStage(stage: LifeStage): LifeStage | undefined {
  return LIFE_STAGES[LIFE_STAGES.indexOf(stage) + 1];
}

/* ---------- 指标 ---------- */

export const METRIC_KEYS: LifecycleMetricKey[] = ['rounds', 'compactions', 'events', 'contextPercent', 'openNotes', 'closedNotes', 'archivedNotes', 'uptimeDays'];
export const metricLabel: Record<LifecycleMetricKey, string> = {
  rounds: '主会话轮次', compactions: '上下文压缩', events: '事件段数', contextPercent: '上下文用量', openNotes: '未关闭便签',
  closedNotes: '已完成便签', archivedNotes: '归档区便签', uptimeDays: '连续运行天数'
};

export function formatMetricValue(metric: LifecycleMetricKey, value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (metric === 'contextPercent') return `${Math.round(value)}%`;
  if (metric === 'uptimeDays') return `${Math.round(value * 10) / 10} 天`;
  if (metric === 'compactions') return `${Math.round(value)} 次`;
  return String(Math.round(value));
}

export function formatReason(reason: LifecycleReason): string {
  return `${metricLabel[reason.metric]} ${formatMetricValue(reason.metric, reason.value)}/${formatMetricValue(reason.metric, reason.threshold)}`;
}

export const levelLabel: Record<LifecycleLevel, string> = { ok: '正常', tidy: '该整理', handoff: '该交接' };

/* ---------- 交接仪式 ---------- */

/**
 * 画面跟着服务端状态机走：
 * 邀请（为什么 + 确认 + 起名）→ 老猫告别、打包 → 新猫出生 → 便签飞过去 → 老猫退休、交接说明 → 完成。
 * 失败时服务端自动回滚，画面只负责如实说「旧主会话完好」。
 */
export type CeremonyPhase = 'invite' | 'farewell' | 'newborn' | 'transfer' | 'closing' | 'done' | 'rolled_back' | 'cancelled';

export function ceremonyPhase(state: HandoffState | undefined): CeremonyPhase {
  switch (state) {
    case undefined:
    case 'proposed': return 'invite';
    case 'confirmed':
    case 'packing': return 'farewell';
    case 'spawning': return 'newborn';
    case 'transferring':
    case 'switching': return 'transfer';
    case 'retiring':
    case 'briefing': return 'closing';
    case 'done': return 'done';
    case 'rolling_back':
    case 'rolled_back': return 'rolled_back';
    case 'cancelled': return 'cancelled';
  }
}

export const ceremonyPhaseTitle: Record<CeremonyPhase, string> = {
  invite: '交接仪式',
  farewell: '老猫在收拾行李',
  newborn: '新猫来了',
  transfer: '便签交到新猫手里',
  closing: '老猫退休',
  done: '交接完成',
  rolled_back: '已回滚，旧主会话完好',
  cancelled: '这次先不交接'
};

export const CEREMONY_STEPS = ['packing', 'spawning', 'transferring', 'switching', 'retiring', 'briefing'] as const;
export type CeremonyStep = (typeof CEREMONY_STEPS)[number];
export const ceremonyStepLabel: Record<CeremonyStep, string> = {
  packing: '打包交接包', spawning: '新猫出生', transferring: '便签交接', switching: '换主会话', retiring: '老猫退休', briefing: '交接说明'
};

export type StepStatus = 'done' | 'active' | 'pending' | 'failed';

/** 步骤条：服务端每完成一步记一条 ok；失败记一条不 ok，随后回滚。 */
export function ceremonySteps(handoff: { state: HandoffState; steps: HandoffStepRecord[] } | undefined): Array<{ key: CeremonyStep; label: string; status: StepStatus; detail?: string }> {
  return CEREMONY_STEPS.map(key => {
    const records = (handoff?.steps ?? []).filter(step => step.step === key).reverse();
    const ok = records.find(step => step.ok);
    const failed = records.find(step => !step.ok);
    const status: StepStatus = ok ? 'done' : failed ? 'failed' : handoff?.state === key ? 'active' : 'pending';
    const detail = (ok ?? failed)?.detail;
    return { key, label: ceremonyStepLabel[key], status, ...(detail ? { detail } : {}) };
  });
}

const RUNNING_STATES = new Set<HandoffState>(['confirmed', 'packing', 'spawning', 'transferring', 'switching', 'retiring', 'briefing', 'rolling_back']);
export const isCeremonyRunning = (state: HandoffState | undefined) => Boolean(state && RUNNING_STATES.has(state));
export const isCeremonyFinal = (state: HandoffState | undefined) => state === 'done' || state === 'rolled_back' || state === 'cancelled';

export const outcomeLabel: Record<HandoffOutcome, string> = { succeeded: '交接成功', partial: '部分失败', needs_confirmation: '需要你确认' };
export const outcomeTone: Record<HandoffOutcome, 'ok' | 'warn' | 'bad'> = { succeeded: 'ok', partial: 'bad', needs_confirmation: 'warn' };
export const triggerLabel: Record<'user' | 'threshold' | 'agent', string> = { user: '你发起的', threshold: '指标到了交接档', agent: '主会话提议' };

export const transferStatusLabel: Record<HandoffTransfer['status'], string> = { transferred: '已转交', needs_confirmation: '待你确认', failed: '失败', reverted: '已回滚' };
export const transferKindLabel: Record<HandoffTransfer['kind'], string> = { task: '事项', watch: 'watch', draft: '草稿' };

export function transferSummary(transfers: HandoffTransfer[]) {
  const count = (status: HandoffTransfer['status']) => transfers.filter(item => item.status === status).length;
  return { total: transfers.length, transferred: count('transferred'), needsConfirmation: count('needs_confirmation'), failed: count('failed'), reverted: count('reverted') };
}

export const archiveSourceLabel: Record<'handoff' | 'maintenance' | 'manual', string> = { handoff: '交接时折叠', maintenance: '整理轮次折叠', manual: '手动收起' };

/** 交接邀请的冒泡：年纪越大说得越直接。 */
export function handoffInvite(stage: LifeStage | undefined, name: string): string {
  if (stage === 'elder') return `${name}有点累了，要不要交接给下一代？`;
  if (stage === 'senior') return `${name}的记忆有点沉了，要不要交接？`;
  return `${name}觉得该交接一下了，看看？`;
}

/* ---------- 系统轮次（整理 / 交接说明）在时间线上的样子 ---------- */

export type SystemRoundOrigin = 'maintenance' | 'handoff';
export const isSystemRoundOrigin = (origin: unknown): origin is SystemRoundOrigin => origin === 'maintenance' || origin === 'handoff';

/** 可见文本形如「🧹 整理轮次 · 已完成便签 45/40」「🐾 交接说明 · 第 2 代豆豆接班（…）」：拆出副标题。 */
export function systemRoundCopy(origin: SystemRoundOrigin, text: string | undefined): { title: string; subtitle: string } {
  const raw = (text ?? '').trim();
  const separator = raw.indexOf('·');
  const subtitle = separator >= 0 ? raw.slice(separator + 1).trim() : raw.replace(/^[🧹🐾]\s*/u, '');
  return { title: origin === 'maintenance' ? '整理轮次' : '交接说明', subtitle };
}

/** 前几代小猫派出的侧边会话，交接后仍然是这只猫家的便签。 */
export function isLineageSource(sourceId: string | undefined, mainId: string | undefined, ancestors: string[] = []): boolean {
  if (!sourceId) return false;
  return sourceId === mainId || ancestors.includes(sourceId);
}

/* ---------- 生命周期变化 → 小猫的反应 ---------- */

export type LifecycleEvent =
  | { kind: 'handoff_proposed'; handoffId: string }
  | { kind: 'maintenance_started'; trigger: 'auto' | 'manual' }
  | { kind: 'maintenance_finished' }
  | { kind: 'handoff_done'; handoffId: string; outcome: HandoffOutcome | null }
  | { kind: 'handoff_rolled_back'; handoffId: string }
  | { kind: 'aged'; from: LifeStage; to: LifeStage };

/** 对比两次轮询。第一次拿到数据时不算变化：刷新页面不该把旧事重播一遍。 */
export function diffLifecycle(previous: AssistantLifecycleLight | null | undefined, next: AssistantLifecycleLight | null | undefined): LifecycleEvent[] {
  if (!previous || !next) return [];
  const events: LifecycleEvent[] = [];
  if (next.handoff?.state === 'proposed' && previous.handoff?.id !== next.handoff.id) events.push({ kind: 'handoff_proposed', handoffId: next.handoff.id });
  if (!previous.maintenance && next.maintenance) events.push({ kind: 'maintenance_started', trigger: next.maintenance.trigger });
  if (previous.maintenance && !next.maintenance) events.push({ kind: 'maintenance_finished' });
  const last = next.lastHandoff;
  if (last && last.id !== previous.lastHandoff?.id && (previous.handoff?.id === last.id || !previous.lastHandoff || Date.parse(last.completedAt ?? last.createdAt) > Date.parse(previous.lastHandoff.completedAt ?? previous.lastHandoff.createdAt))) {
    if (last.state === 'done') events.push({ kind: 'handoff_done', handoffId: last.id, outcome: last.outcome });
    else if (last.state === 'rolled_back') events.push({ kind: 'handoff_rolled_back', handoffId: last.id });
  }
  if (previous.cat && next.cat && previous.cat.id === next.cat.id && LIFE_STAGES.indexOf(next.cat.lifeStage) > LIFE_STAGES.indexOf(previous.cat.lifeStage)) {
    events.push({ kind: 'aged', from: previous.cat.lifeStage, to: next.cat.lifeStage });
  }
  return events;
}

export function lifecycleBubble(event: LifecycleEvent, name: string, stage?: LifeStage): { text: string; tone: BubbleTone } {
  switch (event.kind) {
    case 'handoff_proposed': return { text: handoffInvite(stage, name), tone: 'alert' };
    case 'maintenance_started': return { text: event.trigger === 'manual' ? `${name}开始收拾便签和记忆～` : `${name}自己收拾一下便签和记忆，马上好`, tone: 'muted' };
    case 'maintenance_finished': return { text: `${name}收拾好了，摘要在主会话里`, tone: 'success' };
    case 'handoff_done': return { text: event.outcome === 'succeeded' ? `新猫${name}接班啦，喵！` : `新猫${name}接班了，有几件事等你看看`, tone: event.outcome === 'partial' ? 'alert' : 'success' };
    case 'handoff_rolled_back': return { text: '交接没成功，已经回滚，旧主会话完好', tone: 'alert' };
    case 'aged': return { text: `${name}长大了：现在是${stageCatLabel[event.to]}`, tone: 'info' };
  }
}
