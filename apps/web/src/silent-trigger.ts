import { toolDescription, toolDisplayName, type TimelineEvent } from './timeline';

/** 静默轮次在 runtime 里的 task.origin；前端据此不把它渲染成用户气泡。 */
export const SILENT_TRIGGER_ORIGIN = 'emoji';

/** 已触发过的「消息 + 表情」账本。跨刷新保留，避免重渲染、轮询或刷新后重复开轮次。 */
export const SILENT_TRIGGER_LEDGER_KEY = 'agentdock:silent-trigger-ledger';

export type SilentTriggerTarget = 'main' | 'tab' | 'here';

const DEFAULT_CONTEXT_RADIUS = 4;
const LEDGER_LIMIT = 800;

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
  : undefined;

/**
 * 只接受一个 emoji：空串表示关闭；包含文字、多个字符或非 emoji 时返回 undefined。
 * 用 grapheme 切分，家庭/肤色/ZWJ 表情也算一个。
 */
export function normalizeSilentEmoji(input: unknown): string | undefined {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') return undefined;
  const value = input.trim();
  if (!value) return '';
  const graphemes = segmenter
    ? [...segmenter.segment(value)].map(part => part.segment)
    : Array.from(value);
  if (graphemes.length !== 1) return undefined;
  const emojiLike = /\p{Extended_Pictographic}/u.test(value)
    || /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(value)
    || /\u20E3/u.test(value);
  return emojiLike ? value : undefined;
}

/** 没有小猫时直接在当前会话开一轮；有小猫时给三个去处。 */
export function silentTriggerTargets(hasMainSession: boolean): SilentTriggerTarget[] {
  return hasMainSession ? ['main', 'tab', 'here'] : ['here'];
}

/**
 * 同一轮用户消息会以 task 补出的临时行、真实 user 事件两种身份出现；
 * 用 taskId + role 归一化，避免任务刚开始时点一次、真实事件到达后又被当成新消息。
 * 助手行没有这种双身份，直接用事件 id（同一条消息可能有多次正文事件，不能用 taskId）。
 */
export function silentTriggerMessageKey(event: TimelineEvent): string {
  const taskId = typeof event.data.taskId === 'string' ? event.data.taskId : undefined;
  if (taskId && event.data.role === 'user') return `task:${taskId}:user`;
  return `event:${event.id}:${event.data.role === 'user' ? 'user' : 'assistant'}`;
}

export function silentTriggerKey(input: { sessionId: string; event: TimelineEvent; emoji: string }): string {
  return `${input.sessionId}\u0000${silentTriggerMessageKey(input.event)}\u0000${input.emoji}`;
}

export function parseSilentTriggerLedger(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0));
  } catch {
    return new Set();
  }
}

/** 账本追加是纯函数：重复 key 返回 added=false，调用方据此拦住第二次触发。 */
export function addSilentTriggerKey(raw: string | null | undefined, key: string, limit = LEDGER_LIMIT): { value: string; added: boolean } {
  const keys = parseSilentTriggerLedger(raw);
  if (keys.has(key)) return { value: raw ?? JSON.stringify([...keys]), added: false };
  keys.add(key);
  const trimmed = [...keys].slice(-Math.max(1, limit));
  return { value: JSON.stringify(trimmed), added: true };
}

/** 发送失败时回滚一次领取，让同一消息 + 表情可以重试。 */
export function removeSilentTriggerKey(raw: string | null | undefined, key: string): { value: string; removed: boolean } {
  const keys = parseSilentTriggerLedger(raw);
  if (!keys.delete(key)) return { value: raw ?? JSON.stringify([...keys]), removed: false };
  return { value: JSON.stringify([...keys]), removed: true };
}

const claimedInMemory = new Set<string>();
let cachedLedgerRaw: string | null | undefined;
let cachedLedger = new Set<string>();

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function readLedger(store: Storage | undefined): Set<string> {
  const raw = store?.getItem(SILENT_TRIGGER_LEDGER_KEY) ?? null;
  if (raw !== cachedLedgerRaw) {
    cachedLedgerRaw = raw;
    cachedLedger = parseSilentTriggerLedger(raw);
  }
  return cachedLedger;
}

function rememberLedger(raw: string) {
  cachedLedgerRaw = raw;
  cachedLedger = parseSilentTriggerLedger(raw);
}

/** 同步领取一次触发权：同一消息 + 表情只有第一次返回 true，后续点击/重挂载都返回 false。 */
export function claimSilentTrigger(input: { sessionId: string; event: TimelineEvent; emoji: string }): boolean {
  const key = silentTriggerKey(input);
  if (claimedInMemory.has(key)) return false;
  const store = storage();
  const current = readLedger(store);
  const next = addSilentTriggerKey(cachedLedgerRaw ?? null, key);
  if (!next.added) {
    claimedInMemory.add(key);
    current.add(key);
    return false;
  }
  claimedInMemory.add(key);
  rememberLedger(next.value);
  try { store?.setItem(SILENT_TRIGGER_LEDGER_KEY, next.value); } catch { /* 隐私模式/配额满：本次会话内仍靠内存去重 */ }
  return true;
}

export function wasSilentTriggered(input: { sessionId: string; event: TimelineEvent; emoji: string }): boolean {
  const key = silentTriggerKey(input);
  if (claimedInMemory.has(key)) return true;
  return readLedger(storage()).has(key);
}

/** 只有发送失败才回滚；成功接受（task 已入队）后重试会真的重复开轮。 */
export function releaseSilentTrigger(input: { sessionId: string; event: TimelineEvent; emoji: string }) {
  const key = silentTriggerKey(input);
  claimedInMemory.delete(key);
  const store = storage();
  const next = removeSilentTriggerKey(cachedLedgerRaw ?? readLedgerRaw(store), key);
  if (!next.removed) return;
  rememberLedger(next.value);
  try { store?.setItem(SILENT_TRIGGER_LEDGER_KEY, next.value); } catch { /* 内存已经释放，至少本次会话可重试 */ }
}

function readLedgerRaw(store: Storage | undefined): string | null {
  return store?.getItem(SILENT_TRIGGER_LEDGER_KEY) ?? null;
}

/** 时间统一用 ISO 的字面量截断，测试与不同时区下都稳定。 */
function timeLabel(timestamp: string): string {
  if (timestamp.length >= 19) return `${timestamp.slice(0, 10)} ${timestamp.slice(11, 19)}`;
  return timestamp;
}

function compactText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function contextLine(event: TimelineEvent, isTarget: boolean, maxChars: number): string | undefined {
  const prefix = isTarget ? '→ [目标消息] ' : '';
  const stamp = timeLabel(event.timestamp);
  const data = event.data;
  if (event.type === 'text') {
    const text = compactText(data.text);
    if (!text) return undefined;
    const role = data.role === 'user' ? '用户' : 'Agent';
    return `${prefix}[${role} · ${stamp}] ${clip(text, maxChars)}`;
  }
  if (event.type === 'thinking') {
    const text = compactText(data.text);
    return text ? `${prefix}[Agent 思考 · ${stamp}] ${clip(text, Math.min(maxChars, 480))}` : undefined;
  }
  if (event.type === 'tool_call' || event.type === 'tool_result') {
    const name = toolDescription(data) ?? toolDisplayName(data);
    const status = typeof data.status === 'string' ? `（${data.status}）` : '';
    return `${prefix}[工具 · ${stamp}] ${clip(name, Math.min(maxChars, 480))}${status}`;
  }
  if (event.type === 'warning') {
    const text = compactText(data.text);
    return text ? `${prefix}[系统提示 · ${stamp}] ${clip(text, Math.min(maxChars, 480))}` : undefined;
  }
  if (event.type === 'error') {
    const text = compactText(data.message);
    return text ? `${prefix}[错误 · ${stamp}] ${clip(text, Math.min(maxChars, 480))}` : undefined;
  }
  if (event.type === 'permission_request') {
    const text = compactText(data.title);
    return text ? `${prefix}[授权请求 · ${stamp}] ${clip(text, Math.min(maxChars, 480))}` : undefined;
  }
  return undefined;
}

function isContextVisible(event: TimelineEvent): boolean {
  return event.data.origin !== SILENT_TRIGGER_ORIGIN && event.data.origin !== 'injected' && event.data.origin !== 'maintenance' && event.data.origin !== 'handoff';
}

/**
 * 用被回应的消息和前后若干条时间线构造静默轮次 prompt。
 * 目标消息用 `→ [目标消息]` 明确标出；工具行只保留摘要，避免把大段输出塞进下一轮。
 */
export function buildSilentPrompt(
  timeline: TimelineEvent[],
  target: TimelineEvent,
  emoji: string,
  contextRadius = DEFAULT_CONTEXT_RADIUS
): string {
  const index = timeline.findIndex(event => event === target || (event.id === target.id && event.timestamp === target.timestamp));
  const radius = Math.max(0, Math.floor(contextRadius));
  const window = index >= 0
    ? timeline.slice(Math.max(0, index - radius), index + radius + 1)
    : [target];
  const lines: string[] = [];
  for (const event of window) {
    if (event !== target && !isContextVisible(event)) continue;
    const line = contextLine(event, event === target, event === target ? 2_000 : 800);
    if (line) lines.push(line);
  }
  if (!lines.some(line => line.startsWith('→ [目标消息]'))) {
    const fallback = contextLine(target, true, 2_000);
    if (fallback) lines.push(fallback);
  }
  return [
    `用户给一条消息新增了「${emoji}」表情。这是静默触发：没有新的文字输入，请直接结合上下文继续处理目标消息指向的事。`,
    '不要复述这段说明，也不要等待用户重新描述。',
    '',
    '上下文（按时间顺序；→ 标记目标消息）：',
    ...lines
  ].join('\n');
}
