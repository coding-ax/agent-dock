import { callDaemon, requireDaemon } from '../session-cli.js';
import {
  formatMetricValue, formatReason, handoffOutcomeLabel, handoffStateLabel, handoffStepLabel, lifecycleMetricKeys,
  metricLabel, parseThresholdAssignments, stageLabel,
  type HandoffOutcome, type HandoffState, type HandoffStep, type LifeStage, type LifecycleMetricKey, type MetricReason
} from './lifecycle.js';

export interface LifecycleCliOptions { json?: boolean; from?: string }
export interface HandoffCliOptions extends LifecycleCliOptions { yes?: boolean; name?: string; reason?: string; wait?: string }
export interface MaintenanceRunCliOptions extends LifecycleCliOptions { reason?: string }
export interface MaintenanceConfigCliOptions extends LifecycleCliOptions {
  auto?: boolean; autoHandoff?: boolean; foldAfterHours?: string; maxRunsPerDay?: string; set?: string[];
}
export interface NotesListCliOptions extends LifecycleCliOptions { archived?: boolean }
export interface NotesArchiveCliOptions extends LifecycleCliOptions { task?: string[]; closedBeforeHours?: string; reason?: string }
export interface NotesUnarchiveCliOptions extends LifecycleCliOptions { batch?: string; task?: string[] }

type Json = Record<string, unknown>;

const daemon = () => requireDaemon();
/** 只有 Agent 环境里才带 from；用户在普通终端跑时不带，服务端据此区分「提议」和「确认」。 */
const fromFields = (from?: string) => {
  const value = from ?? process.env.agentdock_session_id?.trim();
  return value ? { from: value } : {};
};
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const text = (value: unknown) => typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
const pad = (value: number) => String(value).padStart(2, '0');
/** 本机时区的「YYYY-MM-DD HH:mm」，和 schedule 等命令一样按用户所在时区显示。 */
const time = (value: unknown) => {
  if (typeof value !== 'string' || !value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const FINAL_STATES = new Set<HandoffState>(['done', 'rolled_back', 'cancelled']);

const triggerLabel: Record<string, string> = { user: '用户发起', threshold: '指标到交接档', agent: '主会话提议' };
const transferStatusLabel: Record<string, string> = { transferred: '已转交', needs_confirmation: '待你确认', failed: '失败', reverted: '已回滚' };
const transferKindLabel: Record<string, string> = { task: '事项', watch: 'watch', draft: '草稿' };
const catStateLabel: Record<string, string> = { active: '在岗', retired: '已退休', released: '已休息', aborted: '交接回滚' };

function stepLabel(step: string): string {
  if (step === 'rollback') return '回滚';
  if (step === 'recovery') return '恢复';
  return handoffStepLabel[step as HandoffStep] ?? step;
}

function stateLine(handoff: Json): string {
  const state = handoff.state as HandoffState;
  const outcome = handoff.outcome as HandoffOutcome | null;
  return `${handoffStateLabel[state] ?? state}${outcome ? ` · ${handoffOutcomeLabel[outcome]}` : ''}`;
}

function reasonsLine(reasons: unknown): string {
  return Array.isArray(reasons) && reasons.length ? (reasons as MetricReason[]).map(formatReason).join('，') : '';
}

export function formatHandoff(handoff: Json): string {
  const fromCat = handoff.fromCat as Json | null | undefined;
  const toCat = handoff.toCat as Json | null | undefined;
  const lines = [
    `交接 ${text(handoff.id)}  [${stateLine(handoff)}]`,
    `发起：${triggerLabel[text(handoff.trigger)] ?? text(handoff.trigger)}${handoff.reason ? `  原因：${text(handoff.reason)}` : ''}`,
    reasonsLine(handoff.reasons) ? `越线：${reasonsLine(handoff.reasons)}` : '',
    `前任：${fromCat ? `第 ${text(fromCat.generation)} 代${text(fromCat.name)}  ` : ''}${text(handoff.fromSessionId)}${handoff.state === 'done' ? '（已归档，只读）' : ''}`,
    `继任：${toCat ? `第 ${text(toCat.generation)} 代` : ''}${text(handoff.successorName) || '（沿用名字）'}${handoff.toSessionId ? `  ${text(handoff.toSessionId)}` : ''}`
  ];
  const steps = Array.isArray(handoff.steps) ? handoff.steps as Json[] : [];
  if (steps.length) {
    lines.push('步骤：');
    for (const step of steps) lines.push(`  ${step.ok ? '✓' : '✗'} ${stepLabel(text(step.step))}${step.detail ? ` · ${text(step.detail)}` : ''}`);
  }
  const transfers = Array.isArray(handoff.transfers) ? handoff.transfers as Json[] : [];
  if (transfers.length) {
    lines.push('便签交接：');
    for (const item of transfers) {
      lines.push(`  [${transferStatusLabel[text(item.status)] ?? text(item.status)}] ${transferKindLabel[text(item.kind)] ?? text(item.kind)} ${text(item.title)}（${text(item.itemId)}）${item.detail ? ` · ${text(item.detail)}` : ''}`);
    }
  }
  if (handoff.archiveBatchId) lines.push(`归档批次：${text(handoff.archiveBatchId)}（可用 agent-dock notes unarchive --batch ${text(handoff.archiveBatchId)} 取出）`);
  if (handoff.error) lines.push(`说明：${text(handoff.error)}`);
  if (handoff.state === 'proposed') lines.push('确认：在网页小猫上点「开始交接」，或由用户本人在终端运行 agent-dock main handoff --yes');
  return lines.filter(Boolean).join('\n');
}

export function formatLineage(cats: Json[]): string {
  if (!cats.length) return '还没有血缘记录（先认领一只小猫：agent-dock main set）。';
  return cats.map(cat => {
    const stage = stageLabel[cat.lifeStage as LifeStage] ?? text(cat.lifeStage);
    return [
      `第 ${text(cat.generation)} 代  ${text(cat.name)}  [${catStateLabel[text(cat.state)] ?? text(cat.state)} · ${stage}]  ${text(cat.sessionId)}`,
      `  认领 ${time(cat.adoptedAt)}${cat.retiredAt ? `  退休 ${time(cat.retiredAt)}` : ''}  轮次 ${text(cat.rounds)}${cat.retiredReason ? `  ${text(cat.retiredReason)}` : ''}`
    ].join('\n');
  }).join('\n');
}

export function formatMaintenanceStatus(status: Json): string {
  const metrics = (status.metrics ?? {}) as Partial<Record<LifecycleMetricKey, number>>;
  const levels = (status.levels ?? {}) as Partial<Record<LifecycleMetricKey, string>>;
  const config = (status.config ?? {}) as Json;
  const thresholds = (config.thresholds ?? {}) as Partial<Record<LifecycleMetricKey, { tidy?: number; handoff?: number }>>;
  const levelLabel: Record<string, string> = { ok: '正常', tidy: '该整理', handoff: '该交接' };
  const cell = (key: LifecycleMetricKey, value: number | undefined) => value === undefined ? '—' : formatMetricValue(key, value);
  const rows = lifecycleMetricKeys.map(key => {
    const threshold = thresholds[key] ?? {};
    return `  ${metricLabel[key].padEnd(7, '　')}  ${cell(key, metrics[key]).padStart(8)}  ${cell(key, threshold.tidy).padStart(8)}  ${cell(key, threshold.handoff).padStart(8)}  ${levelLabel[levels[key] ?? 'ok'] ?? ''}`;
  });
  const active = status.active as Json | null | undefined;
  const runs = Array.isArray(status.runs) ? status.runs as Json[] : [];
  const runStateLabel: Record<string, string> = { running: '进行中', completed: '已完成', failed: '失败', interrupted: '被打断' };
  return [
    `总体档位：${levelLabel[text(status.level)] ?? text(status.level)}${reasonsLine(status.reasons) ? `（${reasonsLine(status.reasons)}）` : ''}`,
    `  指标　　　　       当前    整理档    交接档`,
    ...rows,
    configLine(config),
    active ? `进行中：${text(active.id)}（${active.trigger === 'auto' ? '自动' : '手动'}，${time(active.createdAt)} 开始）` : '',
    runs.length ? '最近整理：' : '还没有整理过。',
    ...runs.slice(0, 5).map(run => `  ${text(run.id)}  [${runStateLabel[text(run.state)] ?? text(run.state)}]  ${run.trigger === 'auto' ? '自动' : '手动'}  ${time(run.createdAt)}${run.archiveBatchId ? `  折叠批次 ${text(run.archiveBatchId)}` : ''}${run.error ? `  ${text(run.error)}` : ''}`)
  ].filter(Boolean).join('\n');
}

function configLine(config: Json): string {
  return `自动整理：${config.autoMaintenance ? '开' : '关'}  自动提议交接：${config.autoProposeHandoff ? '开' : '关'}  只折叠关闭超过 ${text(config.foldClosedAfterHours)} 小时的便签  自动整理每天最多 ${text(config.maxAutoRunsPerDay)} 次`;
}

export function formatConfig(config: Json): string {
  const thresholds = (config.thresholds ?? {}) as Partial<Record<LifecycleMetricKey, { tidy?: number; handoff?: number }>>;
  const cell = (key: LifecycleMetricKey, value: number | undefined) => value === undefined ? '—' : formatMetricValue(key, value);
  return [
    configLine(config),
    '  指标　　　　      整理档    交接档  键名（--set <键名>.<tidy|handoff>=<数值|off>）',
    ...lifecycleMetricKeys.map(key => `  ${metricLabel[key].padEnd(7, '　')}  ${cell(key, thresholds[key]?.tidy).padStart(8)}  ${cell(key, thresholds[key]?.handoff).padStart(8)}  ${key}`)
  ].join('\n');
}

function formatRun(run: Json): string {
  return [
    `整理轮次 ${text(run.id)}  [${run.state === 'running' ? '进行中' : text(run.state)}]  ${run.trigger === 'auto' ? '自动' : '手动'}发起`,
    reasonsLine(run.reasons) ? `越线：${reasonsLine(run.reasons)}` : '',
    run.reason ? `原因：${text(run.reason)}` : '',
    run.state === 'running' ? '主会话时间线里会出现「🧹 整理轮次」卡片；结束后已关闭够久的便签折叠进归档区（可撤销）。' : '',
    run.summary ? `摘要：\n${text(run.summary)}` : ''
  ].filter(Boolean).join('\n');
}

function formatArchive(view: Json): string {
  const batches = Array.isArray(view.batches) ? view.batches as Json[] : [];
  const tasks = Array.isArray(view.tasks) ? view.tasks as Json[] : [];
  if (!batches.length) return '归档区是空的。';
  const sourceLabel: Record<string, string> = { handoff: '交接', maintenance: '整理轮次', manual: '手动' };
  return batches.map(batch => {
    const ids = Array.isArray(batch.taskIds) ? batch.taskIds as string[] : [];
    const inside = tasks.filter(task => task.archiveBatchId === batch.id);
    return [
      `${text(batch.id)}  [${sourceLabel[text(batch.source)] ?? text(batch.source)}]  ${time(batch.createdAt)}  ${ids.length} 张${batch.undoneAt ? `  已取出 ${time(batch.undoneAt)}` : ''}${batch.reason ? `  ${text(batch.reason)}` : ''}`,
      ...inside.map(task => `  ${text(task.id)}  ${text(task.title)}  ${text(task.outcome) || ''}`.trimEnd())
    ].join('\n');
  }).join('\n');
}

function formatNotes(tasks: Json[]): string {
  const visible = tasks.filter(task => !task.archivedAt);
  if (!visible.length) return '墙上没有便签。';
  const archived = tasks.length - visible.length;
  return [
    ...visible.map(task => `${text(task.id)}  [${task.plan ? 'plan' : text(task.state)}]  ${text(task.title)}${task.sessionId ? `  ${text(task.sessionId)}` : ''}`),
    archived ? `（另有 ${archived} 张在归档区：agent-dock notes list --archived）` : ''
  ].filter(Boolean).join('\n');
}

// ------------------------------------------------------------------ 主会话交接

async function currentHandoffId(kind: 'open' | 'latest'): Promise<string | undefined> {
  const overview = await callDaemon<{ handoff?: Json | null; handoffs?: Json[] }>(daemon(), '/api/assistant/lifecycle', 'GET');
  if (overview.handoff?.id) return text(overview.handoff.id);
  return kind === 'latest' ? (overview.handoffs?.[0]?.id ? text(overview.handoffs[0].id) : undefined) : undefined;
}

async function waitForHandoff(id: string, options: HandoffCliOptions): Promise<Json> {
  const limit = Math.max(10, Number(options.wait ?? 180) || 180) * 1000;
  const started = Date.now();
  let printed = 0;
  for (;;) {
    const { handoff } = await callDaemon<{ handoff: Json }>(daemon(), `/api/assistant/handoff/${encodeURIComponent(id)}`, 'GET');
    const steps = Array.isArray(handoff.steps) ? handoff.steps as Json[] : [];
    if (!options.json) {
      for (const step of steps.slice(printed)) process.stderr.write(`  ${step.ok ? '✓' : '✗'} ${stepLabel(text(step.step))}${step.detail ? ` · ${text(step.detail)}` : ''}\n`);
    }
    printed = steps.length;
    if (FINAL_STATES.has(handoff.state as HandoffState)) return handoff;
    if (Date.now() - started > limit) {
      throw new Error(`交接 ${id} 还在进行（${handoffStateLabel[handoff.state as HandoffState] ?? text(handoff.state)}）。稍后用 agent-dock main handoff show ${id} 查看；失败会自动回滚。`);
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}

/**
 * `main handoff`：不带 --yes 只提议（主会话、用户都可以）；带 --yes 由用户本人确认并执行仪式，
 * 逐步打印进度直到完成或回滚。Agent 环境里带 --yes 会被服务端拒绝：确认只能由用户做。
 */
export async function runMainHandoff(options: HandoffCliOptions): Promise<string> {
  const from = fromFields(options.from);
  const proposed = await callDaemon<{ handoff: Json }>(daemon(), '/api/assistant/handoff', 'POST', {
    ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
    ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    ...from
  });
  let handoff = proposed.handoff;
  if (!options.yes) {
    return options.json ? json({ handoff }) : `${formatHandoff(handoff)}\n`;
  }
  const id = text(handoff.id);
  if (handoff.state === 'proposed') {
    try {
      handoff = (await callDaemon<{ handoff: Json }>(daemon(), `/api/assistant/handoff/${encodeURIComponent(id)}/confirm`, 'POST', {
        ...(options.name?.trim() ? { name: options.name.trim() } : {}),
        ...from
      })).handoff;
    } catch (error) {
      throw new Error(`已生成交接提议 ${id}，但没有开始执行：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!options.json) process.stderr.write(`交接仪式开始：${id}\n`);
  const final = FINAL_STATES.has(handoff.state as HandoffState) ? handoff : await waitForHandoff(id, options);
  return options.json ? json({ handoff: final }) : `${formatHandoff(final)}\n`;
}

export async function runMainHandoffShow(id: string | undefined, options: LifecycleCliOptions): Promise<string> {
  const target = id ?? await currentHandoffId('latest');
  if (!target) return options.json ? json({ handoff: null }) : '还没有交接记录。\n';
  const { handoff } = await callDaemon<{ handoff: Json }>(daemon(), `/api/assistant/handoff/${encodeURIComponent(target)}`, 'GET');
  return options.json ? json({ handoff }) : `${formatHandoff(handoff)}\n`;
}

export async function runMainHandoffCancel(id: string | undefined, options: LifecycleCliOptions): Promise<string> {
  const target = id ?? await currentHandoffId('open');
  if (!target) throw new Error('没有待确认的交接提议');
  const { handoff } = await callDaemon<{ handoff: Json }>(daemon(), `/api/assistant/handoff/${encodeURIComponent(target)}/cancel`, 'POST', { ...fromFields(options.from) });
  return options.json ? json({ handoff }) : `${formatHandoff(handoff)}\n`;
}

export async function runMainHandoffResend(id: string, options: LifecycleCliOptions): Promise<string> {
  const { handoff } = await callDaemon<{ handoff: Json }>(daemon(), `/api/assistant/handoff/${encodeURIComponent(id)}/resend`, 'POST', { ...fromFields(options.from) });
  return options.json ? json({ handoff }) : `${formatHandoff(handoff)}\n`;
}

export async function runMainLineage(options: LifecycleCliOptions): Promise<string> {
  const { lineage } = await callDaemon<{ lineage: Json[] }>(daemon(), '/api/assistant/lineage', 'GET');
  return options.json ? json({ lineage }) : `${formatLineage(lineage)}\n`;
}

// ------------------------------------------------------------------ 整理轮次

export async function runMaintenanceStatus(options: LifecycleCliOptions): Promise<string> {
  const status = await callDaemon<Json>(daemon(), '/api/assistant/maintenance', 'GET');
  return options.json ? json(status) : `${formatMaintenanceStatus(status)}\n`;
}

export async function runMaintenanceRun(options: MaintenanceRunCliOptions): Promise<string> {
  const { run } = await callDaemon<{ run: Json }>(daemon(), '/api/assistant/maintenance/run', 'POST', {
    ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
    ...fromFields(options.from)
  });
  return options.json ? json({ run }) : `${formatRun(run)}\n`;
}

export async function runMaintenanceConfig(options: MaintenanceConfigCliOptions): Promise<string> {
  const numberOption = (value: string | undefined, flag: string) => {
    if (value === undefined) return undefined;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${flag} 必须是数字`);
    return number;
  };
  const foldClosedAfterHours = numberOption(options.foldAfterHours, '--fold-after-hours');
  const maxAutoRunsPerDay = numberOption(options.maxRunsPerDay, '--max-runs-per-day');
  const set = options.set?.length ? parseThresholdAssignments(options.set) : undefined;
  const patch = {
    ...(options.auto !== undefined ? { autoMaintenance: options.auto } : {}),
    ...(options.autoHandoff !== undefined ? { autoProposeHandoff: options.autoHandoff } : {}),
    ...(foldClosedAfterHours !== undefined ? { foldClosedAfterHours } : {}),
    ...(maxAutoRunsPerDay !== undefined ? { maxAutoRunsPerDay } : {}),
    ...(set ? { set } : {})
  };
  if (!Object.keys(patch).length) {
    const status = await callDaemon<{ config: Json }>(daemon(), '/api/assistant/maintenance', 'GET');
    return options.json ? json({ config: status.config }) : `${formatConfig(status.config)}\n`;
  }
  const { config } = await callDaemon<{ config: Json }>(daemon(), '/api/assistant/maintenance/config', 'PUT', { ...patch, ...fromFields(options.from) });
  return options.json ? json({ config }) : `已更新。\n${formatConfig(config)}\n`;
}

// ------------------------------------------------------------------ 便签与归档区

export async function runNotesList(options: NotesListCliOptions): Promise<string> {
  if (options.archived) {
    const view = await callDaemon<Json>(daemon(), '/api/assistant/notes/archive', 'GET');
    return options.json ? json(view) : `${formatArchive(view)}\n`;
  }
  const { tasks } = await callDaemon<{ tasks: Json[] }>(daemon(), '/api/assistant/tasks', 'GET');
  return options.json ? json({ tasks }) : `${formatNotes(tasks)}\n`;
}

export async function runNotesArchive(options: NotesArchiveCliOptions): Promise<string> {
  const taskIds = (options.task ?? []).map(item => item.trim()).filter(Boolean);
  const hours = options.closedBeforeHours === undefined ? undefined : Number(options.closedBeforeHours);
  if (hours !== undefined && (!Number.isFinite(hours) || hours < 0)) throw new Error('--closed-before-hours 必须是不小于 0 的数字');
  if (!taskIds.length && hours === undefined) throw new Error('用 --task <id> 指定便签，或用 --closed-before-hours <小时> 折叠关闭够久的便签');
  const result = await callDaemon<{ batch: Json | null; archived: number }>(daemon(), '/api/assistant/notes/archive', 'POST', {
    ...(taskIds.length ? { taskIds } : {}),
    ...(hours !== undefined ? { closedBeforeHours: hours } : {}),
    ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
    ...fromFields(options.from)
  });
  if (options.json) return json(result);
  return result.batch
    ? `已折叠 ${result.archived} 张便签进归档区，批次 ${text(result.batch.id)}（可用 agent-dock notes unarchive --batch ${text(result.batch.id)} 取出）。\n`
    : '没有可折叠的已关闭便签。\n';
}

export async function runNotesUnarchive(options: NotesUnarchiveCliOptions): Promise<string> {
  const taskIds = (options.task ?? []).map(item => item.trim()).filter(Boolean);
  if (!options.batch && !taskIds.length) throw new Error('用 --batch <id> 取出一整批，或用 --task <id> 取出单张');
  const result = await callDaemon<{ restored: string[] }>(daemon(), '/api/assistant/notes/unarchive', 'POST', {
    ...(options.batch ? { batchId: options.batch } : {}),
    ...(taskIds.length ? { taskIds } : {}),
    ...fromFields(options.from)
  });
  return options.json ? json(result) : `已从归档区取出 ${result.restored.length} 张便签。\n`;
}
