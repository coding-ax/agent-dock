import { readFileSync } from 'node:fs';
import { callDaemon, requireDaemon, sourceSessionId } from '../session-cli.js';
import type { QuietHours, TaskCheck } from './types.js';

export interface AssistantCliOptions { json?: boolean; from?: string }
export interface TaskStartCliOptions extends AssistantCliOptions {
  title?: string; notes?: string; notesFile?: string; doneWhen?: string[];
  expectMinutes?: string; agent?: string; cwd?: string; model?: string; reasoningEffort?: string; plan?: boolean;
}
export interface TaskReviewCliOptions extends AssistantCliOptions {
  verdict?: string; check?: string[]; note?: string;
}
export interface TaskReportCliOptions extends AssistantCliOptions {
  kind?: string; text?: string; evidence?: string;
}
export interface WatchAddCliOptions extends AssistantCliOptions {
  name?: string; command?: string; cwd?: string; every?: string; timeout?: string;
  repeat?: boolean; cooldown?: string; expires?: string;
}
export interface NotifyCliOptions extends AssistantCliOptions { ask?: boolean; urgent?: boolean }
export interface MainCliOptions extends AssistantCliOptions { agent?: string; cwd?: string; model?: string; reasoningEffort?: string; name?: string }
export interface SettingsCliOptions extends AssistantCliOptions { enabled?: boolean; off?: boolean; start?: string; end?: string }
export interface DraftCreateCliOptions extends AssistantCliOptions {
  channel?: string; target?: string; bodyFile?: string; task?: string;
}

const daemon = () => requireDaemon();
const currentSessionId = () => process.env.agentdock_session_id?.trim() || undefined;
/** 主会话命令也可以在普通终端里跑；只有 Agent 环境里才带 from。 */
const fromFields = (from?: string) => {
  const value = from ?? currentSessionId();
  return value ? { from: value } : {};
};

const print = (value: unknown, json?: boolean) => json
  ? `${JSON.stringify(value, null, 2)}\n`
  : `${formatHuman(value)}\n`;

function formatHuman(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.tasks)) return formatTasks(record.tasks as Array<Record<string, unknown>>);
  if (Array.isArray(record.watches)) return formatWatches(record.watches as Array<Record<string, unknown>>);
  if (Array.isArray(record.drafts)) return formatDrafts(record.drafts as Array<Record<string, unknown>>);
  if (record.task && typeof record.task === 'object') return formatTask(record.task as Record<string, unknown>);
  if (record.watch && typeof record.watch === 'object') return formatWatch(record.watch as Record<string, unknown>);
  if (record.draft && typeof record.draft === 'object') return formatDraft(record.draft as Record<string, unknown>);
  if (record.session && typeof record.session === 'object') return `主会话：${String((record.session as Record<string, unknown>).id ?? '')}`;
  if (record.ok === true) return 'ok';
  return JSON.stringify(value, null, 2);
}

function formatTask(task: Record<string, unknown>): string {
  const execution = [
    `Agent：${task.agentId ?? '开工时继承主会话'}`,
    `目录：${task.cwd ?? '开工时继承主会话'}`,
    ...(task.model ? [`模型：${task.model}`] : []),
    ...(task.reasoningEffort ? [`思考深度：${task.reasoningEffort}`] : [])
  ].join('  ');
  const lines = [
    `${task.id}  ${task.title}`,
    `状态：${task.plan ? '计划待确认' : task.state}  返工：${task.round} 轮${task.sessionId ? `  会话：${task.sessionId}` : ''}`,
    execution,
    `验收标准：${Array.isArray(task.doneWhen) ? (task.doneWhen as string[]).map((item, index) => `\n  ${index + 1}. ${item}`).join('') : ''}`,
    task.notes ? `说明：${task.notes}` : ''
  ];
  return lines.filter(Boolean).join('\n');
}

function formatTasks(tasks: Array<Record<string, unknown>>): string {
  if (!tasks.length) return '没有事项。';
  return tasks.map(task => `${task.id}  [${task.plan ? 'plan' : task.state}]  ${task.title}${task.sessionId ? `  ${task.sessionId}` : ''}`).join('\n');
}

function formatWatch(watch: Record<string, unknown>): string {
  return [
    `${watch.id}  ${watch.name}  [${watch.state}]`,
    `命令：${watch.command}`,
    `间隔：${watch.intervalSeconds}s  超时：${watch.timeoutSeconds}s  模式：${watch.mode}  冷却：${watch.cooldownSeconds}s`,
    `最近：${watch.lastRunAt ?? '未运行'}  退出码：${watch.lastExitCode ?? '-'}  连续失败：${watch.failCount}`,
    watch.lastOutput ? `输出：${String(watch.lastOutput)}` : ''
  ].filter(Boolean).join('\n');
}

function formatWatches(watches: Array<Record<string, unknown>>): string {
  if (!watches.length) return '没有 watch。';
  return watches.map(watch => `${watch.id}  [${watch.state}]  ${watch.name}  every ${watch.intervalSeconds}s  ${watch.command}`).join('\n');
}

function formatDraft(draft: Record<string, unknown>): string {
  return [
    `${draft.id}  [${draft.state}]  ${draft.channel}`,
    `目标：${draft.target}`,
    `正文：${String(draft.body).slice(0, 500)}${String(draft.body).length > 500 ? '…' : ''}`
  ].join('\n');
}

function formatDrafts(drafts: Array<Record<string, unknown>>): string {
  if (!drafts.length) return '没有草稿。';
  return drafts.map(draft => `${draft.id}  [${draft.state}]  ${draft.channel}  ${draft.target}`).join('\n');
}

function readBody(options: DraftCreateCliOptions): string {
  if (options.bodyFile === '-') return readFileSync(0, 'utf8');
  if (options.bodyFile) return readFileSync(options.bodyFile, 'utf8');
  throw new Error('请用 --body-file - 从标准输入读取，或 --body-file <file>');
}

function parseCheck(value: string): TaskCheck {
  const separator = value.indexOf('=');
  if (separator < 0) throw new Error(`--check 格式应为 '<标准>=met:<证据>'，收到：${value}`);
  const criterion = value.slice(0, separator).trim();
  const rest = value.slice(separator + 1).trim();
  const colon = rest.indexOf(':');
  const status = (colon < 0 ? rest : rest.slice(0, colon)).trim();
  const evidence = colon < 0 ? undefined : rest.slice(colon + 1).trim();
  if (!criterion) throw new Error('--check 的标准不能为空');
  if (status !== 'met' && status !== 'unmet') throw new Error(`--check 状态只能是 met 或 unmet，收到：${status}`);
  return { criterion, met: status === 'met', ...(evidence ? { evidence } : {}) };
}

export async function runTaskStart(taskId: string | undefined, options: TaskStartCliOptions): Promise<string> {
  if (taskId) {
    const result = await callDaemon(daemon(), `/api/assistant/tasks/${encodeURIComponent(taskId)}/start`, 'POST', { ...fromFields(options.from) });
    return print(result, options.json);
  }
  const title = options.title?.trim();
  if (!title) throw new Error('--title 必填');
  const doneWhen = (options.doneWhen ?? []).map(item => item.trim()).filter(Boolean);
  if (!doneWhen.length) throw new Error('至少用 --done-when 写一条验收标准');
  const notes = options.notesFile === '-' ? readFileSync(0, 'utf8') : options.notes;
  const result = await callDaemon(daemon(), '/api/assistant/tasks', 'POST', {
    title, ...(notes ? { notes } : {}), doneWhen,
    ...(options.expectMinutes ? { expectMinutes: Number(options.expectMinutes) } : {}),
    ...(options.agent ? { agentId: options.agent } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    plan: options.plan === true,
    ...fromFields(options.from)
  });
  return print(result, options.json);
}

export async function runTaskPlan(options: TaskStartCliOptions): Promise<string> {
  return runTaskStart(undefined, { ...options, plan: true });
}

export async function runTaskList(options: AssistantCliOptions): Promise<string> {
  return print(await callDaemon(daemon(), '/api/assistant/tasks', 'GET'), options.json);
}

export async function runTaskShow(id: string, options: AssistantCliOptions): Promise<string> {
  return print(await callDaemon(daemon(), `/api/assistant/tasks/${encodeURIComponent(id)}`, 'GET'), options.json);
}

export async function runTaskReview(id: string, options: TaskReviewCliOptions): Promise<string> {
  const verdict = options.verdict;
  if (verdict !== 'accepted' && verdict !== 'rework' && verdict !== 'needs_user' && verdict !== 'cancelled') {
    throw new Error('--verdict 必须是 accepted / rework / needs_user / cancelled');
  }
  const checks = (options.check ?? []).map(parseCheck);
  const result = await callDaemon(daemon(), `/api/assistant/tasks/${encodeURIComponent(id)}/review`, 'POST', {
    verdict, checks, ...(options.note ? { note: options.note } : {}),
    ...fromFields(options.from)
  });
  return print(result, options.json);
}

export async function runTaskReport(options: TaskReportCliOptions): Promise<string> {
  const kind = options.kind;
  if (kind !== 'done' && kind !== 'question' && kind !== 'blocked') throw new Error('--kind 必须是 done / question / blocked');
  const text = options.text?.trim();
  if (!text) throw new Error('--text 必填');
  const result = await callDaemon(daemon(), '/api/assistant/report', 'POST', {
    from: options.from ?? sourceSessionId(), kind, text,
    ...(options.evidence ? { evidence: options.evidence } : {})
  });
  return print(result, options.json);
}

export async function runTaskCancel(id: string, options: AssistantCliOptions & { reason?: string }): Promise<string> {
  return print(await callDaemon(daemon(), `/api/assistant/tasks/${encodeURIComponent(id)}/cancel`, 'POST', {
    ...(options.reason ? { reason: options.reason } : {}),
    ...fromFields(options.from)
  }), options.json);
}

export async function runWatchAdd(options: WatchAddCliOptions): Promise<string> {
  const name = options.name?.trim();
  const command = options.command?.trim();
  if (!name) throw new Error('--name 必填');
  if (!command) throw new Error('--command 必填');
  const result = await callDaemon(daemon(), '/api/assistant/watches', 'POST', {
    name, command,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    every: options.every ?? '60s',
    ...(options.timeout ? { timeout: options.timeout } : {}),
    mode: options.repeat ? 'repeat' : 'once',
    ...(options.cooldown ? { cooldown: options.cooldown } : {}),
    ...(options.expires ? { expires: options.expires } : {}),
    ...fromFields(options.from)
  });
  return print(result, options.json);
}

export async function runWatchList(options: AssistantCliOptions): Promise<string> {
  return print(await callDaemon(daemon(), '/api/assistant/watches', 'GET'), options.json);
}

export async function runWatchShow(id: string, options: AssistantCliOptions): Promise<string> {
  const result = await callDaemon<{ watches: Array<Record<string, unknown>> }>(daemon(), '/api/assistant/watches', 'GET');
  const watch = result.watches.find(item => item.id === id);
  if (!watch) throw new Error(`watch 不存在：${id}`);
  return print({ watch }, options.json);
}

export async function runWatchControl(id: string, action: 'pause' | 'resume' | 'run', options: AssistantCliOptions): Promise<string> {
  return print(await callDaemon(daemon(), `/api/assistant/watches/${encodeURIComponent(id)}/${action}`, 'POST', {
    ...fromFields(options.from)
  }), options.json);
}

export async function runWatchRemove(id: string, options: AssistantCliOptions): Promise<string> {
  return print(await callDaemon(daemon(), `/api/assistant/watches/${encodeURIComponent(id)}`, 'DELETE', {
    ...fromFields(options.from)
  }), options.json);
}

export async function runNotify(text: string, options: NotifyCliOptions): Promise<string> {
  const result = await callDaemon(daemon(), '/api/assistant/notify', 'POST', {
    text, ask: options.ask === true, urgent: options.urgent === true,
    ...fromFields(options.from)
  });
  return print(result, options.json);
}

export async function runMainGet(options: AssistantCliOptions): Promise<string> {
  return print(await callDaemon(daemon(), '/api/assistant/main', 'GET'), options.json);
}

export async function runMainSet(sessionId: string | undefined, options: MainCliOptions): Promise<string> {
  const name = options.name?.trim() ? { name: options.name.trim() } : {};
  const body = sessionId
    ? { sessionId, ...name, ...fromFields(options.from) }
    : { agentId: options.agent ?? 'claude', ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.model ? { model: options.model } : {}), ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}), ...name, ...fromFields(options.from) };
  return print(await callDaemon(daemon(), '/api/assistant/main', 'PUT', body), options.json);
}

export async function runMainClear(options: AssistantCliOptions): Promise<string> {
  return print(await callDaemon(daemon(), '/api/assistant/main', 'DELETE', { ...fromFields(options.from) }), options.json);
}

export async function runSettingsGet(options: AssistantCliOptions): Promise<string> {
  return print(await callDaemon(daemon(), '/api/assistant/settings', 'GET'), options.json);
}

export async function runSettingsQuietHours(options: SettingsCliOptions): Promise<string> {
  const current = await callDaemon<{ quietHours: QuietHours }>(daemon(), '/api/assistant/settings', 'GET');
  const quiet: QuietHours = {
    enabled: options.off === true ? false : options.enabled === true,
    start: options.start ?? current.quietHours.start,
    end: options.end ?? current.quietHours.end
  };
  return print(await callDaemon(daemon(), '/api/assistant/settings', 'PUT', { quietHours: quiet, ...fromFields(options.from) }), options.json);
}

export async function runDraftCreate(options: DraftCreateCliOptions): Promise<string> {
  const channel = options.channel;
  if (channel !== 'github_comment' && channel !== 'lark_reply') throw new Error('--channel 必须是 github_comment 或 lark_reply');
  const target = options.target?.trim();
  if (!target) throw new Error('--target 必填');
  const body = readBody(options);
  return print(await callDaemon(daemon(), '/api/assistant/drafts', 'POST', {
    channel, target, body,
    ...(options.task ? { taskId: options.task } : {}),
    ...fromFields(options.from)
  }), options.json);
}

export async function runDraftList(options: AssistantCliOptions): Promise<string> {
  return print(await callDaemon(daemon(), '/api/assistant/drafts', 'GET'), options.json);
}

export async function runDraftSend(id: string, options: AssistantCliOptions): Promise<string> {
  return print(await callDaemon(daemon(), `/api/assistant/drafts/${encodeURIComponent(id)}/send`, 'POST', {
    ...fromFields(options.from)
  }), options.json);
}

export async function runDraftDiscard(id: string, options: AssistantCliOptions): Promise<string> {
  return print(await callDaemon(daemon(), `/api/assistant/drafts/${encodeURIComponent(id)}/discard`, 'POST', {
    ...fromFields(options.from)
  }), options.json);
}
