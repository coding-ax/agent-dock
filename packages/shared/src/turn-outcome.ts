/**
 * 一轮任务（turn）的终态规则。
 *
 * 同一套判断此前散在三处各写了一遍：runtime 决定 task 判 completed 还是 failed、
 * Web 时间线决定把哪条文本作为「最终输出」高亮、飞书卡片决定把哪条文本提升成最终回复区块。
 * 三份实现已经跑偏——飞书那份把 `error` / `status` / `permission_request` 也算作活动，
 * runtime 与 Web 只认 `thinking` / `tool_call` / `tool_result`；工具状态那份还漏了乱序保护，
 * 迟到的 `running` 快照足以把一个已经跑完的轮次判成失败。
 *
 * 这里收敛成唯一实现。输入只要求 `{ type, data }`，所以原生 `AgentEvent`、Web 的
 * `TimelineEvent`、飞书 compact 之后的 `TraceEntry` 都能直接喂进来。
 *
 * 两个判断都必须**看顺序**，不能只看聚合结果，否则会把有完整回答的轮次误判成失败：
 * - 最终输出（`pickFinalAssistantEntry`）：严格取「最后一次活动之后的最后一条文本」，
 *   取不到再退化到末条文本——答案存在就不该报「未返回最终输出」。
 * - 卡住的工具调用（`unresolvedToolCallsAfterAnswer`）：只有落在最终输出**之后**的才算
 *   失败原因；之前没收口的说明 Agent 已越过它继续作答。
 */
export interface TurnOutcomeEntry {
  type: string;
  data: any;
}

/** 工具调用的终态：出现后不应被任何迟到的更新推翻。 */
const isTerminalToolStatus = (status: string) => status === 'completed' || status === 'failed';

/** 明确表示「仍在执行」的状态。未知状态不计入未解决，避免新增状态字面量把正常轮次判失败。 */
const isPendingToolStatus = (status: string) => status === 'running' || status === 'pending' || status === 'started' || status === 'in_progress';

const isAssistantText = (entry: TurnOutcomeEntry) => entry.type === 'text' && entry.data?.role !== 'user';

/**
 * 计入「本轮发生过活动」的事件类型。严格规则里它们之后必须再出现 assistant text 才能算
 * 最终输出——工具调用前的阶段描述不得提升为最终输出。
 */
export function isTurnActivity(entry: TurnOutcomeEntry): boolean {
  return entry.type === 'thinking' || entry.type === 'tool_call' || entry.type === 'tool_result';
}

/**
 * 按 toolCallId 归并出「每条工具调用的最终状态」。
 *
 * 终态（completed / failed）一旦出现就不再回退。ACP 会对同一个 toolCallId 重复推送
 * tool_call_update，迟到的 pending / in_progress / running 只是乱序的旧快照，不代表
 * 工具重新开始执行；只保护字面量 'running' 会让乱序更新把完成轮次判成失败。
 */
function toolCallStatuses(entries: TurnOutcomeEntry[]): Map<string, string> {
  const calls = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== 'tool_call' && entry.type !== 'tool_result') continue;
    const data = (entry.data ?? {}) as Record<string, unknown>;
    const id = String(data.id ?? '');
    if (!id) continue;
    const status = String(data.status ?? (entry.type === 'tool_result' ? 'completed' : 'running')).toLowerCase();
    const previous = calls.get(id);
    if (previous && isTerminalToolStatus(previous) && !isTerminalToolStatus(status)) continue;
    calls.set(id, status);
  }
  return calls;
}

/** 未返回结果的工具调用 id（按首次出现顺序）。 */
export function unresolvedToolCallIds(entries: TurnOutcomeEntry[]): string[] {
  const ids: string[] = [];
  for (const [id, status] of toolCallStatuses(entries)) if (isPendingToolStatus(status)) ids.push(id);
  return ids;
}

/**
 * 本轮是否存在未返回结果的工具调用——不分位置，任何一处没收口都算。
 *
 * 判「这一轮该不该算失败」不要直接用它：最终输出之前就没收口的调用说明 Agent 已经越过它
 * 继续作答（见 `unresolvedToolCallsAfterAnswer`）。需要「这一轮有没有卡在等工具上」时用那个。
 */
export function hasUnresolvedToolCalls(entries: TurnOutcomeEntry[]): boolean {
  return unresolvedToolCallIds(entries).length > 0;
}

/**
 * 卡在「最终输出之后」的未返回结果工具调用 id——只有这些才说明 Agent 停在等工具上。
 *
 * 最终输出**之前**就没收口的调用不构成失败原因：线上实测（Trae / Codex 走网关）Agent
 * 会偶发丢一次 tool_result，随后越过它继续调工具、继续作答，最后给出完整回答并正常
 * end_turn。按「只要有一个没收口就判失败」的老规则，这类轮次会被整轮标红，卡片也报
 * 「存在未返回结果的工具调用」，而答案其实是好的。
 */
export function unresolvedToolCallsAfterAnswer(entries: TurnOutcomeEntry[]): string[] {
  const folded = foldAssistantText(entries);
  const answerIndex = pickFinalAssistantIndex(folded);
  return unresolvedToolCallIds(answerIndex < 0 ? folded : folded.slice(answerIndex + 1));
}

/** 严格规则下的最终输出：最后一次活动（思考 / 工具调用）之后的最后一条 assistant text。 */
function pickStrictAssistantIndex(entries: TurnOutcomeEntry[]): number {
  let lastActivity = -1;
  let lastAssistantText = -1;
  entries.forEach((entry, index) => {
    if (isTurnActivity(entry)) lastActivity = index;
    else if (isAssistantText(entry)) lastAssistantText = index;
  });
  return lastAssistantText > lastActivity ? lastAssistantText : -1;
}

function lastAssistantTextIndex(entries: TurnOutcomeEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) if (isAssistantText(entries[index]!)) return index;
  return -1;
}

/** 本轮答案在（折叠后的）序列里的下标：严格规则优先，取不到再退化到末条文本。 */
function pickFinalAssistantIndex(entries: TurnOutcomeEntry[]): number {
  const strict = pickStrictAssistantIndex(entries);
  if (strict >= 0) return strict;
  const lastText = lastAssistantTextIndex(entries);
  if (lastText < 0) return -1;
  // 退化只在「Agent 已经越过最后一步动作」时才成立：答案之后还卡着没收口的工具调用，说明
  // 它是说到一半去干活、然后没回来——那句话多半是「我先看一下文件」，不是回答。
  return unresolvedToolCallIds(entries.slice(lastText + 1)).length ? -1 : lastText;
}

/**
 * 挑出本轮的最终输出，取不到返回 undefined。两级规则：
 *
 * 1. 严格：最后一次活动（思考 / 工具调用）之后的最后一条 assistant text。工具调用前的
 *    阶段描述（「我先看一下文件」）不得被提升成答案。
 * 2. 退化：严格规则取不到、但本轮确实有 assistant text、且文本之后没有卡住未返回结果的
 *    工具调用时，取最后一条文本。答案是真实存在的——Agent 只是答完之后又做了收尾动作
 *    （飞书群里答完再 `group send` 一条），末尾没有新文本。此时整轮判「未返回最终输出」
 *    是误报：Web 会把回答标红、卡片会丢掉回答，而用户明明看到了答案。文本之后还卡着工具
 *    的轮次不适用退化：那是 Agent 说到一半去干活没回来，那句话不是回答。
 */
export function pickFinalAssistantEntry<T extends TurnOutcomeEntry>(entries: T[]): T | undefined {
  const folded = foldAssistantText(entries);
  const index = pickFinalAssistantIndex(folded);
  if (index < 0) return undefined;
  // 折叠会把连续 chunk 合成一条新对象，调用方（Web 时间线、飞书卡片）还要用它的 id /
  // timestamp / sequence 定位，所以这里必须把「原始条目」还回去。
  const picked = folded[index] as FoldedEntry;
  return (picked.origin ?? picked) as T;
}

/**
 * Agent 自己吐的告警（技能描述被裁剪之类）与正文共用 assistant text 通道，
 * 开头的 `Warning:` 是它唯一的标记。它不是本轮正文，别并进最终输出、也别当正文展示。
 */
export const agentWarningPrefix = /^warning:\s*/i;

export const isAgentWarningText = (text: string) => agentWarningPrefix.test(text.trim());

/**
 * cursor-agent ACP 会把内部瞬时流错误伪装成独立的 agent_message_chunk
 *（"\n\nError: RetriableError: WritableIterable is closed" / "Error: T: ..."），
 * 再以 stopReason=end_turn 报成功。整段都是这种前缀才算，正文里提到不算。
 */
export const agentStreamErrorPrefix = /^\s*Error:\s*(?:RetriableError|T):/i;
const agentStreamErrorSuffix = /(?:\r?\n){1,2}Error:\s*(?:RetriableError|T):[^\n]*\s*$/i;

export const isAgentStreamErrorText = (text: string) => agentStreamErrorPrefix.test(text);

/** 已经拼进正文末尾的那一行内部流错误；没有匹配时原样返回。 */
export function stripAgentStreamErrorSuffix(text: string): string {
  // ACP 的换行可能单独占一个 chunk。普通文本必须原样返回；逐块 trimEnd 会把
  // Markdown 表格的行分隔符和标题前空行吞掉，重建时间线时再也拼不回来。
  return agentStreamErrorSuffix.test(text) ? text.replace(agentStreamErrorSuffix, '').trimEnd() : text;
}

/**
 * 把「连续推送的 assistant 文本」折成一条，并丢掉不承载正文的事件。
 *
 * ACP 按 chunk 推送文本：一句「平台 AI 已就绪。」会拆成六条事件
 * （「平台」「 AI」「 已」「就」「绪」「。」）。只取最后一条，拿到的是一个「。」。
 * 分隔只认活动（思考 / 工具调用）与用户消息——状态、raw_terminal、error 这些
 * 事件可能落在同一条回答的两个 chunk 之间，让它们参与分隔等于把回答截断。
 * 合并时新建 data，不改调用方传进来的事件对象（可能正被别的缓存持有）。
 */
function foldAssistantText(entries: TurnOutcomeEntry[]): FoldedEntry[] {
  const folded: FoldedEntry[] = [];
  for (const entry of entries) {
    if (isTurnActivity(entry) || !isAssistantText(entry)) {
      // 活动与用户消息原样留下当分隔符；其余类型（status / raw_terminal / error …）直接丢掉。
      if (isTurnActivity(entry) || entry.data?.role === 'user') folded.push(entry);
      continue;
    }
    const text = typeof entry.data?.text === 'string' ? entry.data.text : '';
    if (isAgentWarningText(text) || isAgentStreamErrorText(text)) continue;
    const cleaned = stripAgentStreamErrorSuffix(text);
    if (!cleaned) continue;
    const previous = folded.at(-1);
    if (previous && isAssistantText(previous)) {
      previous.data = { ...previous.data, text: stripAgentStreamErrorSuffix(`${typeof previous.data.text === 'string' ? previous.data.text : ''}${cleaned}`) };
      previous.origin = entry;
    } else folded.push({ type: entry.type, data: { ...entry.data, text: cleaned }, origin: entry });
  }
  return folded;
}

/**
 * 折叠产物：合成后的 data 供取文本用，`origin` 指回最后一片原始条目——调用方拿到的
 * 最终输出条目必须还是它们自己的对象（Web 时间线、飞书卡片要用 id / timestamp / sequence）。
 */
interface FoldedEntry extends TurnOutcomeEntry { origin?: TurnOutcomeEntry }

/**
 * 本轮最终输出的纯文本。给「需要拿到 Agent 回答」的调用方用（借 Agent 跑任务、写描述等），
 * Web 时间线与飞书卡片各自在 compact 阶段做了同样的折叠再取最终条目。
 */
export function pickFinalAssistantText(entries: TurnOutcomeEntry[]): string {
  const folded = foldAssistantText(entries);
  const index = pickFinalAssistantIndex(folded);
  const text = index >= 0 ? folded[index]?.data?.text : undefined;
  return typeof text === 'string' ? text : '';
}
