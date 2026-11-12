import type { TimelineEvent } from './timeline';
import { toolCommand, toolDescription, toolDisplayName } from './timeline';
export { toolDescription } from './timeline';

export type ToolKind = 'terminal' | 'read' | 'edit' | 'search' | 'web' | 'git' | 'test' | 'database' | 'agent' | 'note' | 'tool';
export type ToolActivityRow =
  | { kind: 'event'; event: TimelineEvent }
  | { kind: 'batch'; id: string; description: string; events: TimelineEvent[] };

const genericNames = new Set(['tool', 'tool call', 'terminal']);

function stringField(input: unknown, keys: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
}

export function groupToolActivityRows(events: TimelineEvent[]): ToolActivityRow[] {
  const rows: ToolActivityRow[] = [];
  for (const event of events) {
    const isTool = event.type === 'tool_call' || event.type === 'tool_result';
    const description = isTool ? toolDescription(event.data) : undefined;
    const previous = rows.at(-1);
    if (description && previous?.kind === 'batch' && previous.description === description) {
      previous.events.push(event);
      continue;
    }
    if (description) {
      rows.push({ kind: 'batch', id: `tool-batch-${event.id}`, description, events: [event] });
      continue;
    }
    rows.push({ kind: 'event', event });
  }
  return rows.flatMap(row => row.kind === 'batch' && row.events.length === 1 ? [{ kind: 'event' as const, event: row.events[0]! }] : [row]);
}

/** 取命令行里某个选项的值：`--title "梳理仓库"`、`--title='x'`、`--verdict accepted` 都认。 */
function flagValue(command: string, name: string): string | undefined {
  const match = command.match(new RegExp(`--${name}(?:=|\\s+)(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)'|([^\\s"']+))`));
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.replace(/\\(["\\])/g, '$1').trim() || undefined;
}

const reviewLabels: Record<string, string> = { accepted: '验收通过', rework: '打回返工', needs_user: '请你拍板', cancelled: '撕掉便签' };
const reportLabels: Record<string, string> = { done: '汇报完成', question: '提出疑问', blocked: '汇报受阻' };

/**
 * 主会话（小猫）和侧边会话操作便签的 CLI：执行面板里说人话（「派出便签：梳理仓库」），
 * 而不是露出一长串 `agent-dock task start --title … --done-when …`。
 * 必须排在通用分类前面：标题里的「edit」「test」之类的词会被误判成编辑文件 / 跑测试。
 */
export function noteCommandPresentation(command: string | undefined): { label: string; detail?: string } | undefined {
  if (!command) return;
  const match = command.match(/(?:^|[\s;&|(])agent-dock\s+(task|watch|notify|draft)\b(?:\s+([a-z][\w-]*))?/);
  if (!match) return;
  const [, group, sub] = match;
  const rest = command.slice((match.index ?? 0) + match[0].length);
  const positional = rest.match(/^\s+(?:"([^"]+)"|'([^']+)'|([^\s-][^\s]*))/);
  const argument = positional?.[1] ?? positional?.[2] ?? positional?.[3];
  if (group === 'task') {
    const title = flagValue(command, 'title');
    if (sub === 'start') return { label: title ? '派出便签' : '便签开工', detail: title ?? argument };
    if (sub === 'plan') return { label: '写计划便签', detail: title };
    if (sub === 'review') return { label: reviewLabels[flagValue(command, 'verdict') ?? ''] ?? '验收便签', detail: argument };
    if (sub === 'cancel') return { label: '撕掉便签', detail: argument };
    if (sub === 'report') return { label: reportLabels[flagValue(command, 'kind') ?? ''] ?? '汇报进度', detail: flagValue(command, 'text') };
    return { label: '翻看便签', detail: argument };
  }
  if (group === 'notify') return { label: /\s--ask\b/.test(command) ? '请你拍板' : '通知你', detail: sub ? undefined : argument };
  if (group === 'watch') return { label: sub === 'add' ? '布置盯梢' : '查看盯梢', detail: flagValue(command, 'name') ?? argument };
  return { label: sub === 'create' ? '起草回复' : sub === 'send' ? '发送草稿' : '处理草稿', detail: flagValue(command, 'target') };
}

export function toolPresentation(data: TimelineEvent['data']): { kind: ToolKind; label: string; detail?: string } {
  const command = toolCommand(data.input);
  const note = noteCommandPresentation(command);
  if (note) return { kind: 'note', label: note.label, detail: note.detail ?? command };
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const haystack = `${name} ${command ?? ''}`.toLowerCase();
  const path = stringField(data.input, ['path', 'file_path', 'filePath', 'filename']);
  const query = stringField(data.input, ['query', 'pattern']);
  const detail = command ?? path ?? query ?? (!genericNames.has(name.toLowerCase()) ? name : undefined);

  if (/\b(?:apply_patch|patch|edit|write|replace|create_file)\b/.test(haystack)) return { kind: 'edit', label: '编辑文件', detail };
  if (/\b(?:read|cat|head|tail|sed\s+-n|open_file)\b/.test(haystack)) return { kind: 'read', label: '读取文件', detail };
  if (/\b(?:rg|grep|find|search|glob)\b/.test(haystack)) return { kind: 'search', label: '搜索内容', detail };
  if (/\b(?:curl|wget|fetch|web|search_query|open_url)\b/.test(haystack)) return { kind: 'web', label: '访问网页', detail };
  if (/\bgit\b/.test(haystack)) return { kind: 'git', label: 'Git 操作', detail };
  if (/\b(?:vitest|jest|pytest|go\s+test|pnpm\s+test|npm\s+test|yarn\s+test)\b/.test(haystack)) return { kind: 'test', label: '运行测试', detail };
  if (/\b(?:sqlite|sql|database|postgres|mysql)\b/.test(haystack)) return { kind: 'database', label: '查询数据', detail };
  if (/\bgroup\s+(?:self|peers|messages|send|wait)\b/.test(haystack)) return { kind: 'agent', label: 'Agent 群协作', detail };
  if (/\b(?:agent|task|spawn|delegate)\b/.test(haystack)) return { kind: 'agent', label: '调用 Agent', detail };
  if (command || /\b(?:terminal|shell|exec|command)\b/.test(haystack)) return { kind: 'terminal', label: '运行命令', detail: command ?? detail };
  return { kind: 'tool', label: toolDisplayName(data), detail };
}

export function summarizeTools(events: TimelineEvent[]) {
  const counts = new Map<ToolKind, { count: number; label: string }>();
  for (const event of events) {
    if (event.type !== 'tool_call' && event.type !== 'tool_result') continue;
    const presentation = toolPresentation(event.data);
    const current = counts.get(presentation.kind);
    counts.set(presentation.kind, { count: (current?.count ?? 0) + 1, label: presentation.label });
  }
  return [...counts].map(([kind, { count, label }]) => {
    if (kind === 'terminal') return `运行了${count > 1 ? ` ${count} 条` : ''}命令`;
    if (kind === 'read') return `读取了${count > 1 ? ` ${count} 个` : ''}文件`;
    if (kind === 'edit') return `编辑了${count > 1 ? ` ${count} 个` : ''}文件`;
    if (kind === 'search') return `搜索了${count > 1 ? ` ${count} 次` : ''}内容`;
    if (kind === 'web') return `访问了${count > 1 ? ` ${count} 个` : ''}网页`;
    if (kind === 'git') return `执行了${count > 1 ? ` ${count} 次` : ''} Git 操作`;
    if (kind === 'test') return `运行了${count > 1 ? ` ${count} 次` : ''}测试`;
    if (kind === 'database') return `查询了${count > 1 ? ` ${count} 次` : ''}数据`;
    if (kind === 'agent') return label === 'Agent 群协作' ? `进行了${count > 1 ? ` ${count} 次` : ''} Agent 群协作` : `调用了${count > 1 ? ` ${count} 个` : ''} Agent`;
    if (kind === 'note') return count > 1 ? `处理了 ${count} 次便签` : label;
    return `使用了${count > 1 ? ` ${count} 次` : ''}${label}`;
  }).join(' · ');
}

export function toolActionLabel(presentation: ReturnType<typeof toolPresentation>, terminal: boolean) {
  const prefix = terminal ? '已' : '正在';
  if (presentation.kind === 'terminal') return `${prefix}运行命令`;
  if (presentation.kind === 'read') return `${prefix}读取文件`;
  if (presentation.kind === 'edit') return `${prefix}编辑文件`;
  if (presentation.kind === 'search') return `${prefix}搜索内容`;
  if (presentation.kind === 'web') return `${prefix}访问网页`;
  if (presentation.kind === 'git') return `${prefix}执行 Git 操作`;
  if (presentation.kind === 'test') return `${prefix}运行测试`;
  if (presentation.kind === 'database') return `${prefix}查询数据`;
  if (presentation.kind === 'agent') return presentation.label === 'Agent 群协作' ? (terminal ? '已完成 Agent 群协作' : '正在进行 Agent 群协作') : `${prefix}调用 Agent`;
  if (presentation.kind === 'note') return `${prefix}${presentation.label}`;
  return `${prefix}调用${presentation.label}`;
}

export function elapsedMilliseconds(startedAt?: string, completedAt?: string, now = Date.now()) {
  if (!startedAt) return;
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
  return end - start;
}

export function formatElapsed(milliseconds?: number) {
  if (milliseconds === undefined) return;
  if (milliseconds < 1_000) return `${Math.max(1, Math.round(milliseconds))} 毫秒`;
  const totalSeconds = Math.round(milliseconds / 1_000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}
