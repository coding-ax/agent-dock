import type { DockEvent, Task } from './api';
import { busyStates } from './session-states';
import { agentWarningPrefix, isAgentStreamErrorText, isTurnActivity, pickFinalAssistantEntry, stripAgentStreamErrorSuffix } from '@agent-dock/agent-dock-shared';

export type TimelineEvent = DockEvent & { data: DockEvent['data'] & { role?: 'user' | 'assistant' } };
export type OptimisticMessage = { id: string; prompt: string; createdAt: string; taskId?: string };
export type TimelineActivityGroup = { id: string; label: string; labelTitle: string; events: TimelineEvent[]; startedAt: string; completedAt?: string };
export type TimelineSection =
  | { kind: 'event'; event: TimelineEvent; final: boolean }
  | { kind: 'activity'; id: string; turnId: string; groups: TimelineActivityGroup[]; hasAnswer: boolean; taskStatus: string; isLatestTurn: boolean; startedAt: string; completedAt?: string };

/**
 * 单个事件「渲染相关内容」的轻量签名：sequence 覆盖新增/替换，
 * 文本长度覆盖 token 流式增长（同事件原地更新），status/completedAt 覆盖工具卡翻转，
 * JSON 长度兜底 tool input/output 变化。不能直接 JSON.stringify 全量 data：
 * 大 output 会让每次 SSE 批都付出全文序列化成本。
 */
// 每个时间线事件算一次签名就够：memo 比较器每次父级渲染都会对所有历史项重新调用，
// 其中工具事件还要 JSON.stringify 输入输出。算完缓存，后续渲染 O(1)。
// 注意：增量构建会就地改写正在合并的事件（流式文本、工具状态），那些位置必须主动失效。
const renderSignatureCache = new WeakMap<TimelineEvent, string>();

export function eventRenderSignature(event: TimelineEvent): string {
  const cached = renderSignatureCache.get(event);
  if (cached !== undefined) return cached;
  const data = event.data as Record<string, unknown>;
  const text = typeof data.text === 'string' ? data.text.length : 0;
  const optimistic = data.optimistic ? ':optimistic' : '';
  const toolPayload = event.type === 'tool_call' || event.type === 'tool_result'
    ? `:${data.status as string ?? ''}:${typeof data.completedAt === 'string' ? 1 : 0}:${JSON.stringify(data.input ?? '').length + JSON.stringify(data.output ?? '').length}`
    : '';
  const signature = `${event.sequence}.${text}${optimistic}${toolPayload}`;
  renderSignatureCache.set(event, signature);
  return signature;
}

const groupSignatureCache = new WeakMap<TimelineActivityGroup, string>();

/** 阶段组签名：id 稳定身份 + 组内事件的渲染签名序列。 */
export function groupRenderSignature(group: TimelineActivityGroup): string {
  const cached = groupSignatureCache.get(group);
  if (cached !== undefined) return cached;
  const signature = `${group.id}|${group.events.map(eventRenderSignature).join(',')}`;
  groupSignatureCache.set(group, signature);
  return signature;
}

// timestamp 是 ISO-8601，同长同格式，字典序即时间序：直接用 < / > 比而不用
// localeCompare，后者要走 Intl 排序规则，94145 条事件实测 14.4ms vs 8.3ms。
const compareByTimestampThenSequence = (left: DockEvent, right: DockEvent) =>
  (left.timestamp < right.timestamp ? -1 : left.timestamp > right.timestamp ? 1 : 0) || left.sequence - right.sequence;

/**
 * 事件绝大多数时候已经有序（服务端按 sequence 出，SSE 也按序写入），
 * 先线性扫一遍确认，有序就跳过排序：94145 条事件实测 14.4ms → 5.9ms。
 *
 * 不能假定一定有序：tasks 补出来的历史用户消息 sequence 固定为 -1，按 timestamp
 * 插在中间，合并后必然乱序，所以守卫要检查合并后的数组而不是原始 events。
 */
function sortByTimestampThenSequence(source: DockEvent[]): DockEvent[] {
  for (let index = 1; index < source.length; index++) {
    if (compareByTimestampThenSequence(source[index - 1]!, source[index]!) > 0) {
      return source.sort(compareByTimestampThenSequence);
    }
  }
  return source;
}

function compactCommand(value: unknown) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim() || undefined;
  if (Array.isArray(value) && value.every(part => ['string', 'number', 'boolean'].includes(typeof part))) return value.map(String).join(' ').replace(/\s+/g, ' ').trim() || undefined;
}

export function toolCommand(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  return compactCommand(record.command) ?? compactCommand(record.cmd);
}

export function toolDisplayName(data: TimelineEvent['data']) {
  return toolCommand(data.input) ?? (typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '工具调用');
}

export function toolDescription(data: TimelineEvent['data']) {
  const input = data.input && typeof data.input === 'object' && !Array.isArray(data.input) ? data.input as Record<string, unknown> : undefined;
  const value = input?.description ?? data.description;
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() || undefined : undefined;
}

function mergedToolName(previous: unknown, current: unknown) {
  const before = typeof previous === 'string' ? previous.trim() : '';
  const after = typeof current === 'string' ? current.trim() : '';
  const specificity = (name: string) => /^(?:tool(?: call)?)$/i.test(name) ? 0 : /^terminal$/i.test(name) ? 1 : name ? 2 : -1;
  if (!after || specificity(after) < specificity(before)) return before || after || '工具调用';
  return after;
}

function warningText(event: TimelineEvent) {
  if (event.type !== 'text' || event.data.role === 'user' || typeof event.data.text !== 'string') return;
  const text = event.data.text.trim();
  if (!agentWarningPrefix.test(text)) return;
  return text.replace(agentWarningPrefix, '').trim();
}

/**
 * 「等待发送」面板里该列的任务。
 *
 * 服务端对 send 一律返回 status='queued'，即使会话空闲、这条马上就会执行；上一条完成到队首切成
 * running 之间会话也会短暂落到 completed。所以不 busy 时队首算「即将开始」，只列它后面的。
 * 时间线的乐观气泡取补集，两边永远不重复、也没有两边都不显示的空档。
 */
export function waitingQueuedTasks(tasks: Task[] | undefined, sessionBusy: boolean): Task[] {
  const queued = (tasks ?? []).filter(task => task.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return sessionBusy ? queued : queued.slice(1);
}

/**
 * 刚发出的消息会不会马上执行：打断发送，或会话空闲且没有别的排队消息。
 * 马上执行的要回到底部看输出；要排队的只进「等待发送」面板，不打断正在回看历史的人。
 */
export function startsImmediately(sessionState: string, mode: 'queue' | 'interrupt', tasks: Task[] | undefined): boolean {
  if (mode === 'interrupt') return true;
  return !busyStates.has(sessionState) && !(tasks ?? []).some(task => task.status === 'queued');
}

/** 增量构建状态：时间线本体 + 构建过程中跨事件维护的索引。 */
type TimelineBuildState = {
  timeline: TimelineEvent[];
  toolIndexes: Map<string, number>;
  seenWarnings: Set<string>;
};

type TimelineCacheEntry = TimelineBuildState & {
  events: DockEvent[];
  tasks: Task[] | undefined;
  optimistic: OptimisticMessage[] | undefined;
  sessionBusy: boolean;
};

/**
 * 时间线增量缓存。
 *
 * 流式输出时 SSE 每帧合批写一次 events，`buildTimeline` 过去每次都从 0 扫全部事件；
 * 30k 条事件的会话实测单次 38–55ms，等于流式期间每帧都把主线程焊死。
 *
 * 这里按「轮」做增量：事件对象在 mergeEventBatch 里是引用稳定的，新数组的前缀和旧数组
 * 逐项 ===；从第一个变化位置往回找到该轮的用户消息起点，复用起点之前已经构建好的时间线，
 * 只重算这一轮。工具调用/警告去重等跨事件状态一并保留，保证增量结果与全量逐字段一致。
 *
 * 缓存键用数组第一个事件对象（WeakMap）：不同会话的首事件不同，数组被回收后缓存也回收。
 */
const timelineCache = new WeakMap<DockEvent, TimelineCacheEntry>();
const EMPTY_TASKS: Task[] = [];
const EMPTY_OPTIMISTIC: OptimisticMessage[] = [];

function isUserTextEvent(event: DockEvent) {
  return event.type === 'text' && event.data?.role === 'user';
}

/** 与主循环里的合并条件保持一致：相邻同 taskId 的用户消息会拼成一条。 */
function mergeableUserText(previous: TimelineEvent | undefined, current: DockEvent) {
  return previous?.type === 'text' && previous.data.role === 'user'
    && current.type === 'text' && current.data?.role === 'user'
    && previous.data.taskId === current.data.taskId && !current.data?.optimistic;
}

/** 处理单个事件；完整构建与增量构建共用，避免两份规则漂移。 */
function applyTimelineEvent(state: TimelineBuildState, event: DockEvent) {
  const { timeline, toolIndexes, seenWarnings } = state;
  if (event.type === 'status' || event.type === 'task' || event.type === 'completed' || event.type === 'raw_terminal') return;
  const current = { ...event, data: { ...event.data } } as TimelineEvent;
  const warning = warningText(current);
  if (warning) {
    const fingerprint = warning.toLocaleLowerCase();
    if (seenWarnings.has(fingerprint)) return;
    seenWarnings.add(fingerprint);
    current.type = 'warning';
    current.data = { ...current.data, text: warning, warningKind: /\bskills?\b/i.test(warning) ? 'skill' : 'agent' };
  }
  if (current.type === 'text' && current.data.role !== 'user' && typeof current.data.text === 'string') {
    if (isAgentStreamErrorText(current.data.text)) return;
    current.data.text = stripAgentStreamErrorSuffix(current.data.text);
    if (!current.data.text) return;
  }
  const previous = timeline.at(-1);
  const role = current.data.role ?? 'assistant';

  if (current.type === 'text' && current.data.role === 'user') toolIndexes.clear();

  if ((current.type === 'text' || current.type === 'thinking') && previous?.type === current.type && (previous.data.role ?? 'assistant') === role
    && (role !== 'user' || (previous.data.taskId === current.data.taskId && !current.data.optimistic))) {
    previous.data.text = `${previous.data.text ?? ''}${current.data.text ?? ''}`;
    previous.sequence = current.sequence;
    previous.timestamp = current.timestamp;
    renderSignatureCache.delete(previous);
    return;
  }

  if (current.type === 'tool_call' || current.type === 'tool_result') {
    const toolId = typeof current.data.id === 'string' && current.data.id ? current.data.id : undefined;
    const existingIndex = toolId === undefined ? undefined : toolIndexes.get(toolId);
    if (existingIndex !== undefined) {
      const existing = timeline[existingIndex];
      const completed = current.data.status === 'completed' || current.data.status === 'failed';
      existing.type = current.type;
      existing.data = {
        ...existing.data,
        ...current.data,
        name: mergedToolName(existing.data.name, current.data.name),
        input: current.data.input ?? existing.data.input,
        output: current.data.output ?? existing.data.output,
        startedAt: existing.data.startedAt ?? existing.timestamp,
        ...(completed ? { completedAt: current.timestamp } : {})
      };
      existing.sequence = current.sequence;
      renderSignatureCache.delete(existing);
      return;
    }
    current.data.startedAt = current.timestamp;
    if (current.data.status === 'completed' || current.data.status === 'failed') current.data.completedAt = current.timestamp;
    if (toolId) toolIndexes.set(toolId, timeline.length);
  }

  if (current.type === 'permission_request') {
    const existing = timeline.findIndex(item => item.type === 'permission_request' && item.data.id === current.data.id);
    if (existing >= 0) { timeline[existing] = current; return; }
  }
  timeline.push(current);
}

function rememberTimeline(events: DockEvent[], tasks: Task[] | undefined, optimistic: OptimisticMessage[] | undefined, sessionBusy: boolean, state: TimelineBuildState) {
  if (!events.length) return;
  timelineCache.set(events[0]!, { events, tasks, optimistic, sessionBusy, ...state });
}

/**
 * 在变化位置所在的那一轮之前做检查点。返回本轮起点下标；返回 undefined 表示不能增量。
 * 同 taskId 的连续用户消息会被主循环拼成一条，所以要一起回退到这段用户消息的开头。
 */
function incrementalCheckpoint(cached: TimelineCacheEntry, events: DockEvent[]): number | undefined {
  const common = Math.min(cached.events.length, events.length);
  let firstDiff = common;
  for (let index = 0; index < common; index++) {
    if (cached.events[index] !== events[index]) { firstDiff = index; break; }
  }
  let start = -1;
  for (let index = Math.min(firstDiff, events.length - 1); index >= 0; index--) {
    if (isUserTextEvent(events[index]!)) { start = index; break; }
  }
  if (start < 0) return undefined;
  while (start > 0 && mergeableUserText(events[start - 1] as TimelineEvent, events[start]!)) start--;
  // 时间线按 timestamp 排序，增量段必须仍然有序；乱序（极少）时退回全量。
  for (let index = start + 1; index < events.length; index++) {
    if (events[index - 1]!.timestamp > events[index]!.timestamp) return undefined;
  }
  return start;
}

export function buildTimeline(events: DockEvent[] = [], tasks: Task[] = EMPTY_TASKS, optimisticMessages: OptimisticMessage[] = EMPTY_OPTIMISTIC, sessionBusy = false): TimelineEvent[] {
  const cached = events.length ? timelineCache.get(events[0]!) : undefined;
  if (cached && cached.tasks === tasks && cached.optimistic === optimisticMessages && cached.sessionBusy === sessionBusy && events.length >= cached.events.length) {
    const unchanged = events.length === cached.events.length
      && cached.events.every((event, index) => event === events[index]);
    if (unchanged) return cached.timeline;
    const start = incrementalCheckpoint(cached, events);
    if (start !== undefined) {
      const checkpoint = events[start]!;
      const checkpointIndex = cached.timeline.findIndex(item => item.id === checkpoint.id);
      const previous = checkpointIndex > 0 ? cached.timeline[checkpointIndex - 1] : undefined;
      // 检查点前一条如果还能和本轮第一条用户消息合并，说明截断点在合并链中间，全量更安全。
      if (checkpointIndex >= 0 && !mergeableUserText(previous, checkpoint)) {
        const state: TimelineBuildState = {
          timeline: cached.timeline.slice(0, checkpointIndex),
          toolIndexes: new Map([...cached.toolIndexes].filter(([, position]) => position < checkpointIndex)),
          seenWarnings: new Set(cached.timeline.slice(0, checkpointIndex)
            .flatMap(item => item.type === 'warning' && typeof item.data.text === 'string' ? [item.data.text.toLocaleLowerCase()] : []))
        };
        for (let index = start; index < events.length; index++) applyTimelineEvent(state, events[index]!);
        rememberTimeline(events, tasks, optimisticMessages, sessionBusy, state);
        return state.timeline;
      }
    }
  }

  const waitingIds = new Set(waitingQueuedTasks(tasks, sessionBusy).map(task => task.id));
  const state: TimelineBuildState = { timeline: [], toolIndexes: new Map(), seenWarnings: new Set() };
  const eventTaskIds = new Set(events.filter(event => event.data?.role === 'user' && event.data?.taskId).map(event => event.data.taskId));
  const legacyPrompts = new Map<string, number>();
  for (const event of events) if (event.data?.role === 'user' && !event.data?.taskId) legacyPrompts.set(event.data.text, (legacyPrompts.get(event.data.text) ?? 0) + 1);
  const taskEvents: DockEvent[] = [];
  for (const task of tasks) {
    if (task.status === 'queued' || task.status === 'cancelled') continue;
    if (eventTaskIds.has(task.id)) continue;
    const legacyCount = legacyPrompts.get(task.prompt) ?? 0;
    if (legacyCount > 0) { legacyPrompts.set(task.prompt, legacyCount - 1); continue; }
    taskEvents.push({ id: `task-event-${task.id}`, sequence: -1, type: 'text', timestamp: task.createdAt, data: { text: task.prompt, role: 'user', taskId: task.id } });
  }
  for (const optimistic of optimisticMessages) {
    const matchingTask = tasks.find(task => optimistic.taskId
      ? task.id === optimistic.taskId
      : task.prompt === optimistic.prompt && Math.abs(Date.parse(task.createdAt) - Date.parse(optimistic.createdAt)) < 5_000);
    const received = events.some(event => event.type === 'text' && event.data?.role === 'user'
      && ((optimistic.taskId && event.data.taskId === optimistic.taskId) || (event.data.text === optimistic.prompt && event.timestamp >= optimistic.createdAt)));
    // 在「等待发送」面板里的不重复出气泡；剩下的是发送中或即将开始的队首，都算「发送中」。
    if (!received && !(matchingTask && waitingIds.has(matchingTask.id)) && (!matchingTask || matchingTask.status === 'queued')) {
      taskEvents.push({ id: optimistic.id, sequence: -1, type: 'text', timestamp: optimistic.createdAt, data: { text: optimistic.prompt, role: 'user', taskId: optimistic.id, optimistic: true } });
    }
  }
  const source = sortByTimestampThenSequence([...events, ...taskEvents]);
  for (const event of source) applyTimelineEvent(state, event);
  rememberTimeline(events, tasks, optimisticMessages, sessionBusy, state);
  return state.timeline;
}

const terminalTaskStatuses = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

/**
 * 这一轮是否仍在执行。
 *
 * 以任务状态为准，而不是「最后一条用户消息之后有没有 Agent 文本」——Agent 在调工具前
 * 几乎总会先输出一段阶段描述，用「说过话」判定会在工具刚开跑时就把整轮标成已完成，
 * 于是外层显示「已完成」、里面的工具卡还转着「执行中」。
 *
 * 没有对应 task 记录的历史会话（早期数据不带 taskId）退回旧口径：只有最后一轮可能在跑，
 * 且此时确实没有别的信号可用。
 */
/**
 * 这一行正文是否还在流式输出。final 行只在轮次结束后才存在，永远不算：队列里还有消息时会话一直是 busy，
 * 下一轮的用户消息到达前上一轮的 final 行恰好是最后一行，只看 busy 会把它当成正在输出、从头重打一遍。
 */
export function isStreamingSection(section: TimelineSection, sessionBusy: boolean, isLast: boolean): boolean {
  return section.kind === 'event' && !section.final && sessionBusy && isLast
    && section.event.type === 'text' && section.event.data.role !== 'user';
}

export function isTurnOngoing(section: TimelineSection, sessionBusy: boolean): boolean {
  if (section.kind !== 'activity' || !section.isLatestTurn || !sessionBusy) return false;
  return !terminalTaskStatuses.has(section.taskStatus);
}
const assistantDescription = (event: TimelineEvent) => event.type === 'text' && event.data.role !== 'user';
const previewText = (value: unknown, limit = 100) => {
  const text = normalizeLabelText(value);
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
};

// 折叠标题只有一行，必须截断；但 hover 的 title 应当给出完整内容，
// 否则 tooltip 只是把同一句残句再显示一遍（42/117 个分组的原文都超过 100 字符，
// 最长 366）。这里保留归一化——去掉 Markdown 记号和换行——但不做长度裁剪。
const normalizeLabelText = (value: unknown) => typeof value === 'string' ? value
  .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/[*~`>#]+/g, '')
  .replace(/(?<!\w)_+|_+(?!\w)/g, '')
  .replace(/^\s*(?:[-+]|\d+[.)])\s+/gm, '')
  .replace(/\s+/g, ' ').trim() : '';

function activityLabel(events: TimelineEvent[]): { label: string; labelTitle: string } {
  const description = [...events].reverse().find(event => event.type === 'text' && event.data.role !== 'user');
  const descriptionText = previewText(description?.data.text);
  if (descriptionText) return { label: descriptionText, labelTitle: normalizeLabelText(description?.data.text) };
  const tool = events.find(event => event.type === 'tool_call' || event.type === 'tool_result');
  if (tool) { const name = toolDescription(tool.data) ?? toolDisplayName(tool.data); return { label: name, labelTitle: name }; }
  const thinking = [...events].reverse().find(event => event.type === 'thinking');
  const fallback = thinking ? '思考过程' : '执行过程';
  return { label: fallback, labelTitle: fallback };
}

/**
 * 一轮里按 Agent 实际输出顺序排好的「步骤」：思考、连续的工具调用（合并成一行）、Agent 正文。
 * groups 把正文当成分组标题藏起来；步骤则让每种内容各占一行，原样按时间顺序展示。
 */
export type ActivityStep =
  | { kind: 'thinking'; id: string; event: TimelineEvent }
  | { kind: 'tools'; id: string; events: TimelineEvent[] }
  | { kind: 'text'; id: string; event: TimelineEvent };

/**
 * 思考块的描述语句。ACP 的 agent_thought 只有一段文本，没有独立标题字段；
 * 推理摘要习惯以「**标题**」或「# 标题」单独成行开头，这一行就是 Agent 给这段思考起的名字，
 * 进行中取最新的一个（当前正在想什么），结束后取第一个（这段思考的主题）。
 *
 * 标题行是 Claude 的习惯，Codex 的推理是普通英文段落（实测开头是 "The user says ..."），
 * 一个标题都没有。没有标题时退回第一行正文：否则折叠行永远只有一句「已思考」，
 * 用户看不出这段到底在想什么。做进行中也不取最后一行——token 逐字到达时最后一行是半句话，
 * 标题会跟着每个 token 乱跳。
 */
export function thinkingTitle(text: string | undefined, live: boolean): string | undefined {
  if (!text) return;
  const titles: string[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:#{1,6}\s+(.+?)|\*\*(.+?)\*\*|__(.+?)__)\s*:?\s*$/);
    const title = (match?.[1] ?? match?.[2] ?? match?.[3])?.replace(/[*_`]/g, '').trim();
    if (title) titles.push(title);
  }
  if (titles.length) return live ? titles.at(-1) : titles[0];
  const firstLine = text.split('\n').map(line => line.trim()).find(Boolean);
  return firstLine ? previewText(firstLine) || undefined : undefined;
}

export function buildActivitySteps(groups: TimelineActivityGroup[]): ActivityStep[] {
  const steps: ActivityStep[] = [];
  for (const event of groups.flatMap(group => group.events)) {
    if (event.type === 'tool_call' || event.type === 'tool_result') {
      const previous = steps.at(-1);
      if (previous?.kind === 'tools') previous.events.push(event);
      else steps.push({ kind: 'tools', id: `tools-${event.id}`, events: [event] });
    } else if (event.type === 'thinking') steps.push({ kind: 'thinking', id: event.id, event });
    else if (event.type === 'text' && event.data.role !== 'user') steps.push({ kind: 'text', id: event.id, event });
  }
  return steps;
}

export function buildTimelineSections(timeline: TimelineEvent[], tasks: Task[] = []): TimelineSection[] {
  if (!timeline.length) return [];
  const turns: TimelineEvent[][] = [];
  for (const event of timeline) {
    const userMessage = event.type === 'text' && event.data.role === 'user';
    if (userMessage || !turns.length) turns.push([]);
    turns.at(-1)!.push(event);
  }

  return turns.flatMap((turn, turnIndex) => {
    const userMessage = turn.find(event => event.type === 'text' && event.data.role === 'user');
    const task = tasks.find(item => item.id === userMessage?.data.taskId);
    const terminal = task ? terminalTaskStatuses.has(task.status) : turnIndex < turns.length - 1;
    // 终态规则与 runtime、飞书卡片共用同一实现（packages/shared/src/turn-outcome.ts）：
    // 最终输出必须是最后一次活动（思考 / 工具调用）之后的最后一条 assistant 文本。
    const finalEntry = terminal ? pickFinalAssistantEntry(turn) : undefined;
    const hasAnswer = !!finalEntry;
    type Piece = { kind: 'event'; event: TimelineEvent; final: boolean } | { kind: 'group'; group: TimelineActivityGroup };
    const pieces: Piece[] = [];
    let currentEvents: TimelineEvent[] = [];
    let pendingThinking: TimelineEvent[] = [];
    const flushActivity = () => {
      const events = currentEvents;
      if (events.length) pieces.push({ kind: 'group', group: {
        id: `group-${events[0]!.id}`, ...activityLabel(events), events,
        startedAt: events[0]!.timestamp,
        completedAt: typeof events.at(-1)?.data.completedAt === 'string' ? events.at(-1)!.data.completedAt : events.at(-1)?.timestamp
      } });
      currentEvents = [];
    };
    const appendPendingThinking = () => {
      if (pendingThinking.length) currentEvents.push(...pendingThinking);
      pendingThinking = [];
    };
    for (const event of turn) {
      if (event === finalEntry) { appendPendingThinking(); flushActivity(); pieces.push({ kind: 'event', event, final: true }); continue; }
      if (assistantDescription(event)) {
        flushActivity();
        currentEvents = [...pendingThinking, event];
        pendingThinking = [];
        continue;
      }
      if (event.type === 'thinking') { pendingThinking.push(event); continue; }
      if (isTurnActivity(event)) { appendPendingThinking(); currentEvents.push(event); continue; }
      appendPendingThinking();
      flushActivity();
      pieces.push({ kind: 'event', event, final: false });
    }
    appendPendingThinking();
    flushActivity();
    const groups = pieces.flatMap(piece => piece.kind === 'group' ? [piece.group] : []);
    if (!groups.length) return pieces.filter((piece): piece is Extract<Piece, { kind: 'event' }> => piece.kind === 'event');
    const firstGroupIndex = pieces.findIndex(piece => piece.kind === 'group');
    const lastGroup = groups.at(-1)!;
    const completedAt = terminal && task?.updatedAt
      ? task.updatedAt
      : hasAnswer ? finalEntry?.timestamp : lastGroup.completedAt;
    const reportedTaskStatus = task?.status ?? (terminal ? 'completed' : 'running');
    const taskStatus = reportedTaskStatus === 'completed' && !hasAnswer ? 'incomplete' : reportedTaskStatus;
    const activity: TimelineSection = {
      kind: 'activity',
      // turnId 必须在 turn 整个生命周期稳定：进行中插入 assistant text 会重切组、
      // 改变 groups[0] 的首事件 id，拿它当 React key 会让执行面板整块重挂（折叠态丢失+闪屏）。
      turnId: `turn-${userMessage?.id ?? groups[0]!.id}`,
      id: `activity-${groups[0]!.id}`, groups, hasAnswer,
      taskStatus,
      isLatestTurn: turnIndex === turns.length - 1,
      startedAt: userMessage?.timestamp ?? groups[0]!.startedAt,
      ...(completedAt ? { completedAt } : {})
    };
    const sections: TimelineSection[] = [];
    for (const [index, piece] of pieces.entries()) {
      if (index === firstGroupIndex) sections.push(activity);
      if (piece.kind === 'event') sections.push(piece);
    }
    return sections;
  });
}
