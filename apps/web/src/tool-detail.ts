import { toolCommand } from './timeline';
import { toolPresentation, type ToolKind } from './tool-presentation';

/**
 * 工具调用详情的数据视图。UI 只负责渲染，不直接碰原始 JSON：
 * - command：命令 + 退出码 + 输出
 * - diff：编辑前后的差异（优先用 patch，其次 old/new 文本）
 * - paths：读文件 / 搜索 / 网页的路径或关键词列表
 * - json：其他工具，才回退成格式化 JSON
 */
export type DiffLineKind = 'add' | 'remove' | 'context' | 'meta';
export type DiffLine = { kind: DiffLineKind; text: string };

export type ToolDetailView =
  | { kind: 'command'; command: string; exitCode?: number; output?: string }
  | { kind: 'diff'; path?: string; lines: DiffLine[]; note?: string }
  | { kind: 'paths'; mode: 'read' | 'search' | 'web'; items: string[]; output?: string }
  | { kind: 'json'; input?: unknown; output?: unknown };

type ToolData = { name?: unknown; input?: unknown; output?: unknown };

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstString(source: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) if (typeof source?.[key] === 'string' && source[key].trim()) return source[key] as string;
  return undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.flatMap(item => typeof item === 'string' && item.trim() ? [item.trim()] : []);
  return [];
}

/** 工具输出在不同 Agent 里形状不同：字符串、{output/stdout/...}、或 content 数组。 */
export function toolOutputText(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  const record = recordOf(output);
  if (!record) return undefined;
  for (const key of ['formatted_output', 'output', 'stdout', 'stderr', 'content', 'text', 'result']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  if (Array.isArray(record.content)) {
    const parts = record.content.flatMap(item => typeof item === 'string' ? [item] : typeof recordOf(item)?.text === 'string' ? [recordOf(item)!.text as string] : []);
    if (parts.length) return parts.join('\n');
  }
  return undefined;
}

function exitCodeOf(output: unknown): number | undefined {
  const record = recordOf(output);
  const value = record?.exit_code ?? record?.exitCode;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 工具标题里常带带引号的路径 / 命令（如 Read file '/a/b.ts'），解析不到 input 时用它兜底。 */
function quotedItems(name: string): string[] {
  return [...name.matchAll(/['"`]([^'"`\n]{2,})['"`]/g)].map(match => match[1]!.trim()).filter(Boolean);
}

const pathKeys = ['path', 'file_path', 'filePath', 'filename', 'file', 'notebook_path'];
const queryKeys = ['query', 'pattern', 'glob', 'search', 'url', 'q'];

function pathItems(data: ToolData, mode: 'read' | 'search' | 'web') {
  const input = recordOf(data.input);
  const items: string[] = [];
  for (const key of [...pathKeys, ...(mode === 'search' || mode === 'web' ? queryKeys : [])]) items.push(...stringList(input?.[key]));
  items.push(...stringList(input?.paths), ...stringList(input?.files));
  items.push(...quotedItems(String(data.name ?? '')));
  return [...new Set(items)];
}

function patchText(input: unknown): string | undefined {
  const record = recordOf(input);
  const value = firstString(record, ['patch', 'diff', 'unified_diff', 'unifiedDiff']);
  if (value) return value;
  if (typeof input === 'string' && /^(?:@@|---|\+\+\+)/m.test(input)) return input;
  return undefined;
}

function oldNewText(input: unknown): { oldText: string; newText: string } | undefined {
  const record = recordOf(input);
  const oldText = firstString(record, ['old_string', 'oldText', 'old_str', 'before', 'old']);
  const newText = firstString(record, ['new_string', 'newText', 'new_str', 'after', 'new']);
  if (oldText === undefined && newText === undefined) return undefined;
  return { oldText: oldText ?? '', newText: newText ?? '' };
}

function parsePatch(patch: string): DiffLine[] {
  return patch.split('\n').map(line => {
    if (/^(?:@@|\+\+\+|---|diff |index |\\ No newline)/.test(line)) return { kind: 'meta', text: line };
    if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
    if (line.startsWith('-')) return { kind: 'remove', text: line.slice(1) };
    if (line.startsWith(' ')) return { kind: 'context', text: line.slice(1) };
    return { kind: 'context', text: line };
  });
}

/** 只比较公共前后缀，中间整段标成删除/新增；对 Agent 的小范围编辑足够，也避免了引入 diff 库。 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const before = oldText.split('\n');
  const after = newText.split('\n');
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length - 1;
  let endAfter = after.length - 1;
  while (endBefore >= start && endAfter >= start && before[endBefore] === after[endAfter]) { endBefore--; endAfter--; }
  const lines: DiffLine[] = [];
  for (let index = 0; index < start; index++) lines.push({ kind: 'context', text: before[index]! });
  for (let index = start; index <= endBefore; index++) lines.push({ kind: 'remove', text: before[index]! });
  for (let index = start; index <= endAfter; index++) lines.push({ kind: 'add', text: after[index]! });
  for (let index = endBefore + 1; index < before.length; index++) lines.push({ kind: 'context', text: before[index]! });
  return lines;
}

export function toolDetailView(data: ToolData): ToolDetailView {
  const input = recordOf(data.input);
  const presentation = toolPresentation(data);
  const kind: ToolKind = presentation.kind;
  const output = toolOutputText(data.output);
  const command = toolCommand(data.input);

  if (kind === 'terminal' || command) {
    return { kind: 'command', command: command ?? presentation.detail ?? presentation.label, ...(exitCodeOf(data.output) !== undefined ? { exitCode: exitCodeOf(data.output) } : {}), ...(output ? { output } : {}) };
  }

  const patch = patchText(data.input);
  const oldNew = patch ? undefined : oldNewText(data.input);
  if (kind === 'edit' || patch || oldNew) {
    const path = firstString(input, pathKeys) ?? quotedItems(String(data.name ?? ''))[0];
    const lines = patch ? parsePatch(patch) : oldNew ? lineDiff(oldNew.oldText, oldNew.newText) : [];
    return { kind: 'diff', ...(path ? { path } : {}), lines, ...(lines.length ? {} : { note: path ? `${path} · 已修改` : '已修改' }) };
  }

  if (kind === 'read' || kind === 'search' || kind === 'web') {
    return { kind: 'paths', mode: kind, items: pathItems(data, kind), ...(output ? { output } : {}) };
  }

  return { kind: 'json', ...(data.input !== undefined ? { input: data.input } : {}), ...(data.output !== undefined ? { output: data.output } : {}) };
}
