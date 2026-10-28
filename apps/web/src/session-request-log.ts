import type { DockEvent, SessionRecord, Task, TurnRange } from './api';
import { buildTimeline, buildTimelineSections, type TimelineActivityGroup, type TimelineEvent, type TimelineSection } from './timeline';

/** 一轮实际下发给 Agent 的文本，以及它与用户可见文本的关系。 */
export type RequestPayload =
  | { state: 'sent'; text: string; form: 'identical' }
  | { state: 'sent'; text: string; form: 'injected'; prefix: string }
  /** 保存下来的实际请求与可见文本毫无包含关系，无法把差异归因成注入。 */
  | { state: 'sent'; text: string; form: 'unrelated' }
  /** 排队中或被取消：从未交给 Agent。 */
  | { state: 'not-sent' }
  /** 本次改动之前落库的任务只存了可见文本，实际请求没有保存。 */
  | { state: 'unavailable' };

export type RequestRound = {
  id: string;
  /** 从 1 开始的轮次序号，只用于展示。 */
  index: number;
  createdAt: string;
  updatedAt: string;
  status: string;
  visiblePrompt: string;
  payload: RequestPayload;
  /** 本轮最终输出，runtime 判轮次终态时落库的那段文本；旧任务或未跑完判定流程的轮次为 null。 */
  finalText: string | null;
  /**
   * 本轮锚点之后的事件条数（未压缩）。0 表示这一轮没有过程可展开；
   * 大于 0 只是「有东西」，真正的内容要按需再取（见 buildRoundActivity）。
   */
  processEvents: number;
  /**
   * 面板打开时是否替用户把这一轮的过程拉回来。只在「记录里没有最终输出、又便宜到不值得让你点一下」
   * 时为真——旧任务（final_text 之前落库的）没有存最终输出，而那段文本只有读了过程才知道。
   * 上限见 AUTO_LOAD_ROUNDS / AUTO_LOAD_MAX_ROWS：一个几十轮的旧会话若每轮都自动拉，
   * 面板一打开就是几十个请求，正是要避开的事。
   */
  autoLoadProcess: boolean;
};

export type RequestScope = { systemPrompt: string | null; modelLabel: string };

export type RequestTrajectory = { scope: RequestScope; rounds: RequestRound[]; sentRounds: number };

/** 拿不到过程事件的三种原因。分开说，是因为处理方式不同：没保存 / 认不出轮次 / 这一轮本来就空。 */
export type RoundActivityGap = 'no-events-saved' | 'no-anchor' | 'no-events-this-round';

/**
 * 一轮的过程视图。`groups` / `final` / `hasAnswer` / `taskStatus` / `startedAt` / `completedAt`
 * 刻意与 ActivityPanel 的 props 同形，渲染层直传，不做二次映射——否则两边各写一套判定，
 * 同一个轮次会在主时间线和轨迹面板里显示成两个样子。
 */
export type RequestRoundActivity =
  /** 排队中或被取消：从未交给 Agent，本就没有过程。 */
  | { state: 'not-sent' }
  | { state: 'unavailable'; reason: RoundActivityGap }
  | { state: 'available'; groups: TimelineActivityGroup[]; final: TimelineEvent | null; hasAnswer: boolean; taskStatus: string; startedAt: string; completedAt?: string };

/** 这一轮的事件从哪来。三种缺失要分开说，不然「为什么没有过程」就没法回答。 */
export type RoundActivitySource =
  /** 事件不在手里：会话没保存过事件、认不出锚点，或这一轮本来就没有过程。 */
  | { state: 'missing'; reason: RoundActivityGap }
  /** 已经按需取回来了；空数组表示这一轮确实什么都没产生。 */
  | { state: 'events'; events: DockEvent[] };

const NOT_SENT_STATUSES = new Set(['queued', 'cancelled']);

/** 打开面板时最多自动恢复最近这么多轮的最终输出。 */
export const AUTO_LOAD_ROUNDS = 5;
/**
 * 自动恢复只做「便宜到不值得让你点一下」的轮次（原始事件条数上限）。
 * 条数只是近似：真正的体积还得看单条多大，所以这里宁可保守——超了就让用户自己展开，
 * 展开是明确的动作，拉多大他都知情。
 */
export const AUTO_LOAD_MAX_ROWS = 2_000;

/**
 * 把实际请求拆成「注入前缀 + 可见文本」。飞书会话会在可见文本前拼一段群协作说明，
 * 用 `\n\n` 分隔；拼接方式变了就退化成 unrelated，不要猜一个假的差异出来。
 */
export function splitInjectedPrefix(visible: string, sent: string): RequestPayload {
  if (sent === visible) return { state: 'sent', text: sent, form: 'identical' };
  if (visible && sent.endsWith(visible)) return { state: 'sent', text: sent, form: 'injected', prefix: sent.slice(0, sent.length - visible.length) };
  return { state: 'sent', text: sent, form: 'unrelated' };
}

export function buildRequestTrajectory(record: SessionRecord, turns: TurnRange[] = []): RequestTrajectory {
  const tasks = [...record.tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const ranges = new Map(turns.map(turn => [turn.taskId, turn]));
  const rounds = tasks.map((task, index) => ({
    id: task.id,
    index: index + 1,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    status: task.status,
    visiblePrompt: task.prompt,
    payload: payloadFor(task),
    finalText: task.finalText ?? null,
    processEvents: ranges.get(task.id)?.segments ?? 0
  }));
  const autoLoadFrom = rounds.length - AUTO_LOAD_ROUNDS;
  return {
    scope: { systemPrompt: record.session.systemPrompt?.trim() || null, modelLabel: record.session.model ?? record.session.agentId },
    rounds: rounds.map((round, index) => ({
      ...round,
      // 没交给 Agent 的轮次不用拉（拉了也只报未发送）；有落库最终输出的轮次根本不用恢复。
      autoLoadProcess: round.finalText === null
        && !NOT_SENT_STATUSES.has(round.status)
        && round.processEvents > 0 && round.processEvents <= AUTO_LOAD_MAX_ROWS
        && index >= autoLoadFrom
    })),
    sentRounds: rounds.filter(round => round.payload.state === 'sent').length
  };
}

/**
 * 一轮的过程视图。喂进来的是**这一轮**的事件（按轮接口取回、已合并分片），不是整个会话的。
 *
 * 判定全部交给 timeline.ts 的同一套实现：切轮、配对工具调用、挑最终输出、区分阶段组。
 * 这里只做「把结果摆成渲染层要的形状」和「什么时候该承认没有」。
 *
 * 不伪造内容的硬规则：最终输出只取该轮 `final: true` 的那条，`hasAnswer` 为假时恒为 null；
 * 用户提问不当过程（上面已经展示过「用户可见」）；组内的 assistant 文本是阶段标题，不重复当正文。
 */
/**
 * 「思考与工具调用」标题上的计数。
 *
 * 不能直接用轮次的原始事件行数：那里面大半是 status / task / completed / raw_terminal
 * 这类状态事件，再加上 token 级的思考和正文分片——一句话的回答也能数出 26 条。
 * 拉到过程后按合并过的思考段与工具调用算；没拉到时不显示数字，而不是给一个夸大的行数。
 */
export function processSummary(activity: RequestRoundActivity): string | undefined {
  if (activity.state !== 'available') return undefined;
  const events = activity.groups.flatMap(group => group.events);
  const thinking = events.filter(event => event.type === 'thinking').length;
  const tools = events.filter(event => event.type === 'tool_call' || event.type === 'tool_result').length;
  return [thinking ? `${thinking} 段思考` : '', tools ? `${tools} 次工具调用` : ''].filter(Boolean).join(' · ') || undefined;
}

export function buildRoundActivity(task: Task, source: RoundActivitySource): RequestRoundActivity {
  // 没交给 Agent 的轮次即使有事件也只报 not-sent：说它有过程是假的。
  if (NOT_SENT_STATUSES.has(task.status)) return { state: 'not-sent' };
  if (source.state === 'missing') return { state: 'unavailable', reason: source.reason };
  const timeline = buildTimeline(source.events, [task]);
  const sections = buildTimelineSections(timeline, [task]);
  const activity = sections.find((section): section is Extract<TimelineSection, { kind: 'activity' }> => section.kind === 'activity');
  const finalEntry = sections.find((section): section is Extract<TimelineSection, { kind: 'event' }> => section.kind === 'event' && section.final)?.event ?? null;
  const hasAnswer = activity?.hasAnswer ?? false;
  const groups = activity?.groups ?? [];
  const final = hasAnswer ? finalEntry : null;
  // 过程和最终输出都没有，就直说这一轮是空的，别渲染一个「等待模型输出」的假面板。
  if (!groups.length && !final) return { state: 'unavailable', reason: 'no-events-this-round' };
  // 认不出轮次的组会把状态兜底成 running（buildTimelineSections 找不到 task 时的规则）；
  // 历史面板恒 ongoing=false，照抄就会把早已结束的轮次显示成还在跑。任务自己有终态时以任务为准。
  const sectionStatus = activity?.taskStatus;
  const taskStatus = sectionStatus && sectionStatus !== 'running' ? sectionStatus : task.status;
  return {
    state: 'available',
    groups,
    final,
    hasAnswer,
    taskStatus,
    startedAt: activity?.startedAt ?? task.createdAt,
    ...(activity?.completedAt ? { completedAt: activity.completedAt } : {})
  };
}

function payloadFor(task: Task): RequestPayload {
  if (task.sentPrompt) return splitInjectedPrefix(task.prompt, task.sentPrompt);
  return NOT_SENT_STATUSES.has(task.status) ? { state: 'not-sent' } : { state: 'unavailable' };
}
