import type { TimelineEvent } from './timeline';
import { toolCommand, toolDescription, toolDisplayName } from './timeline';
import { bi, getCurrentLocale, localizedRecord } from './i18n';
export { toolDescription } from './timeline';

export type ToolKind =
  | 'terminal'
  | 'read'
  | 'edit'
  | 'list'
  | 'search'
  | 'web'
  | 'browser'
  | 'git'
  | 'test'
  | 'database'
  | 'agent'
  | 'workflow'
  | 'question'
  | 'plan'
  | 'task'
  | 'skill'
  | 'image'
  | 'mcp'
  | 'note'
  | 'tool';

export type ToolPresentation = { kind: ToolKind; label: string; detail?: string };

export type ToolActivityRow =
  | { kind: 'event'; event: TimelineEvent }
  | { kind: 'batch'; id: string; description: string; events: TimelineEvent[] };

const GENERIC_TOOL_NAMES = new Set(['', 'tool', 'tool call', 'unknown tool']);

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(input: unknown, keys: string[]): string | undefined {
  const record = recordOf(input);
  if (!record) return;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
}

function hasAnyKey(record: Record<string, unknown> | undefined, keys: string[]): boolean {
  if (!record) return false;
  return keys.some(key => record[key] !== undefined && record[key] !== null);
}

function unquote(text: string | undefined): string | undefined {
  if (!text) return;
  const trimmed = text.trim();
  if (trimmed.length >= 2 && (
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('`') && trimmed.endsWith('`'))
  )) {
    return trimmed.slice(1, -1).trim() || undefined;
  }
  return trimmed || undefined;
}

function cleanSingleLine(text: string | undefined): string | undefined {
  if (!text) return;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed || undefined;
}

function joinZh(prefix: string, tail: string): string {
  if (!tail) return prefix;
  return /^[A-Za-z0-9]/.test(tail) ? `${prefix} ${tail}` : `${prefix}${tail}`;
}

function withCount(count: number, unit: string): string {
  return count > 1 ? ` ${count} ${unit}` : '';
}

function rawToolCommand(input: unknown): string | undefined {
  const record = recordOf(input);
  if (!record) return;
  for (const key of ['command', 'cmd', 'CommandLine']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.every(part => ['string', 'number', 'boolean'].includes(typeof part))) {
      const joined = value.map(String).join(' ').trim();
      if (joined) return joined;
    }
  }
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

const reviewLabels: Record<string, string> = localizedRecord(
  { accepted: '验收通过', rework: '打回返工', needs_user: '请你拍板', cancelled: '撕掉便签' },
  { accepted: 'Approved Note', rework: 'Sent for Rework', needs_user: 'Needs Your Input', cancelled: 'Cancelled Note' }
);
const reportLabels: Record<string, string> = localizedRecord(
  { done: '汇报完成', question: '提出疑问', blocked: '汇报受阻' },
  { done: 'Reported Done', question: 'Asked Question', blocked: 'Reported Blocked' }
);

/**
 * 主会话（小猫）和侧边会话操作便签的 CLI：执行面板里说人话（「派出便签：梳理仓库」），
 * 而不是露出一长串 `agent-dock task start --title … --done-when …`。
 * 必须排在通用分类前面：标题里的「edit」「test」之类的词会被误判成编辑文件 / 跑测试。
 */
export function noteCommandPresentation(command: string | undefined): { label: string; detail?: string } | undefined {
  if (!command) return;
  if (/(?:^|\s)(?:--help|-h)(?:\s|$)/.test(command)) return;
  const match = command.match(/(?:^|[\s;&|(])agent-dock\s+(task|watch|notify|draft)\b(?:\s+([a-z][\w-]*))?/);
  if (!match) return;
  const [, group, sub] = match;
  const rest = command.slice((match.index ?? 0) + match[0].length);
  const positional = rest.match(/^\s+(?:"([^"]+)"|'([^']+)'|([^\s-][^\s]*))/);
  const argument = positional?.[1] ?? positional?.[2] ?? positional?.[3];
  if (group === 'task') {
    const title = flagValue(command, 'title');
    if (sub === 'start') return { label: title ? bi('派出便签', 'Dispatched Note') : bi('便签开工', 'Started Note'), detail: title ?? argument };
    if (sub === 'plan') return { label: bi('写计划便签', 'Planned Note'), detail: title };
    if (sub === 'review') return { label: reviewLabels[flagValue(command, 'verdict') ?? ''] ?? bi('验收便签', 'Reviewed Note'), detail: argument };
    if (sub === 'cancel') return { label: bi('撕掉便签', 'Cancelled Note'), detail: argument };
    if (sub === 'report') return { label: reportLabels[flagValue(command, 'kind') ?? ''] ?? bi('汇报进度', 'Reported Progress'), detail: flagValue(command, 'text') };
    return { label: bi('翻看便签', 'Checked Notes'), detail: argument };
  }
  if (group === 'notify') return { label: /\s--ask\b/.test(command) ? bi('请你拍板', 'Needs Your Input') : bi('通知你', 'Notified You'), detail: sub ? undefined : argument };
  if (group === 'watch') return { label: sub === 'add' ? bi('布置盯梢', 'Added Watch') : bi('查看盯梢', 'Checked Watch'), detail: flagValue(command, 'name') ?? argument };
  return { label: sub === 'create' ? bi('起草回复', 'Drafted Reply') : sub === 'send' ? bi('发送草稿', 'Sent Draft') : bi('处理草稿', 'Updated Draft'), detail: flagValue(command, 'target') };
}

/**
 * 剥离 heredoc 正文，避免内联脚本里的变量名（如 `const task = await taskSpace(42)`、
 * `import sqlite3`）干扰外层 shell 命令分类。
 */
function stripShellHeredocs(raw: string): string {
  const lines = raw.split('\n');
  const kept: string[] = [];
  let heredocEnd: { marker: string; stripTabs: boolean } | undefined;

  for (const line of lines) {
    if (heredocEnd) {
      const candidate = heredocEnd.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate.trim() === heredocEnd.marker) heredocEnd = undefined;
      continue;
    }
    let quote: '"' | "'" | null = null;
    let cutAt = -1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote === "'") {
        if (ch === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (ch === '\\') { i++; continue; }
        if (ch === '"') quote = null;
        continue;
      }
      if (ch === '\\') { i++; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
        const rest = line.slice(i + 2);
        const stripTabs = rest.startsWith('-');
        const markerMatch = rest.slice(stripTabs ? 1 : 0).match(/^\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z0-9_.-]+))/);
        if (markerMatch) {
          const marker = markerMatch[1] ?? markerMatch[2] ?? markerMatch[3];
          if (marker) heredocEnd = { marker, stripTabs };
        }
        cutAt = i;
        break;
      }
    }
    kept.push(cutAt >= 0 ? line.slice(0, cutAt) : line);
  }
  return kept.join('\n');
}

type ShellToken = { value: string; quoted: boolean };

function tokenizeShellSegment(segment: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = '';
  let hasToken = false;
  let quoted = false;
  let quote: '"' | "'" | null = null;

  const push = () => {
    if (hasToken) tokens.push({ value: current, quoted });
    current = '';
    hasToken = false;
    quoted = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < segment.length) { current += segment[++i]!; continue; }
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) {
      hasToken = true;
      current += segment[++i]!;
      continue;
    }
    if (ch === "'" || ch === '"') {
      hasToken = true;
      quoted = true;
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    hasToken = true;
    current += ch;
  }
  push();
  return tokens;
}

function splitShellStatements(cleaned: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  let parenDepth = 0;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(') { parenDepth++; continue; }
    if (ch === ')' && parenDepth > 0) { parenDepth--; continue; }
    if (parenDepth > 0) continue;

    if (ch === ';' || ch === '\n') {
      statements.push(cleaned.slice(start, i));
      start = i + 1;
    } else if ((ch === '&' && cleaned[i + 1] === '&') || (ch === '|' && cleaned[i + 1] === '|')) {
      statements.push(cleaned.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  statements.push(cleaned.slice(start));
  return statements.map(s => s.trim()).filter(Boolean);
}

function pipelineHead(statement: string): string {
  let quote: '"' | "'" | null = null;
  let parenDepth = 0;
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(') { parenDepth++; continue; }
    if (ch === ')' && parenDepth > 0) { parenDepth--; continue; }
    if (parenDepth === 0 && ch === '|' && statement[i + 1] !== '|') {
      return statement.slice(0, i).trim();
    }
  }
  return statement.trim();
}

type ParsedShellHead = {
  program: string;
  args: string[];
  hasFileWriteRedirect: boolean;
};

const SHELL_ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_BOILERPLATE_PROGRAMS = new Set([
  'cd', 'pushd', 'popd', 'export', 'set', 'unset', 'umask',
  'echo', 'printf', 'date', 'sleep', 'true', 'mkdir', 'pwd'
]);

function executableBasename(token: string): string {
  const cleaned = token.replace(/^[(\s]+/, '');
  const parts = cleaned.split('/');
  return (parts.at(-1) ?? cleaned).toLowerCase();
}

function parseShellHead(statement: string): ParsedShellHead | undefined {
  const head = pipelineHead(statement);
  if (!head) return;
  const rawTokens = tokenizeShellSegment(head);
  if (!rawTokens.length) return;

  let hasFileWriteRedirect = false;
  const cleanedTokens: ShellToken[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const token = rawTokens[i]!;
    if (!token.quoted) {
      // 标准错误重定向或丢弃到 /dev/null 不算写文件。
      if (/^(?:2?>&[0-9]+|2>>?|&>>?)$/.test(token.value)) {
        if (/^(?:2>>?|&>>?)$/.test(token.value) && i + 1 < rawTokens.length) i++;
        continue;
      }
      if (/^(?:1?>>?)$/.test(token.value)) {
        const target = rawTokens[i + 1]?.value;
        if (target && target !== '/dev/null') hasFileWriteRedirect = true;
        if (i + 1 < rawTokens.length) i++;
        continue;
      }
      if (/^1?>>?.+/.test(token.value)) {
        const target = token.value.replace(/^1?>>?/, '');
        if (target && target !== '/dev/null') hasFileWriteRedirect = true;
        continue;
      }
    }
    cleanedTokens.push(token);
  }

  let index = 0;
  while (index < cleanedTokens.length) {
    const token = cleanedTokens[index]!;
    if (!token.quoted && SHELL_ENV_ASSIGNMENT.test(token.value)) { index++; continue; }
    const base = executableBasename(token.value);
    if (base === 'env') {
      index++;
      while (index < cleanedTokens.length) {
        const next = cleanedTokens[index]!;
        if (!next.quoted && (next.value.startsWith('-') || SHELL_ENV_ASSIGNMENT.test(next.value))) {
          if (next.value === '-u' || next.value === '-C') index += 2;
          else index++;
          continue;
        }
        break;
      }
      continue;
    }
    if (base === 'time' || base === 'nohup' || base === 'exec' || base === 'builtin') { index++; continue; }
    if (base === 'sudo') {
      index++;
      while (index < cleanedTokens.length && !cleanedTokens[index]!.quoted && cleanedTokens[index]!.value.startsWith('-')) index++;
      continue;
    }
    if (base === 'nice') {
      index++;
      if (cleanedTokens[index]?.value === '-n') index += 2;
      continue;
    }
    if (base === 'timeout') {
      index++;
      while (index < cleanedTokens.length && !cleanedTokens[index]!.quoted && cleanedTokens[index]!.value.startsWith('-')) index++;
      if (index < cleanedTokens.length) index++; // duration
      continue;
    }
    if (base === 'command') {
      const next = cleanedTokens[index + 1]?.value;
      if (next && /^-.*[vV]/.test(next)) break; // `command -v foo` 是检查命令存在性，不是执行 foo
      index++;
      continue;
    }
    break;
  }

  const headToken = cleanedTokens[index];
  if (!headToken) return;
  return {
    program: executableBasename(headToken.value),
    args: cleanedTokens.slice(index + 1).map(t => t.value),
    hasFileWriteRedirect
  };
}

const GROUP_SUBCOMMANDS = new Set(['self', 'peers', 'messages', 'send', 'wait']);
const TEST_RUNNER_PROGRAMS = new Set(['vitest', 'jest', 'pytest', 'mocha', 'ava']);
const JS_PACKAGE_RUNNERS = new Set(['npx', 'pnpm', 'npm', 'yarn', 'bun', 'bunx']);
const PYTHON_PROGRAMS = new Set(['python', 'python3', 'uv']);
const DB_PROGRAMS = new Set(['sqlite', 'sqlite3', 'psql', 'mysql', 'mariadb', 'duckdb', 'mongosh', 'clickhouse-client']);
const WEB_FETCH_PROGRAMS = new Set(['curl', 'wget', 'http', 'httpie']);
const BROWSER_PROGRAMS = new Set(['ego-browser', 'ego-lite', 'playwright', 'puppeteer']);
const LIST_DIR_PROGRAMS = new Set(['ls', 'll', 'tree', 'exa', 'eza', 'lsd']);
const FIND_FILE_PROGRAMS = new Set(['find', 'fd', 'fdfind', 'locate']);
const SEARCH_CONTENT_PROGRAMS = new Set(['rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'ugrep']);
const READ_FILE_PROGRAMS = new Set(['cat', 'head', 'tail', 'nl', 'bat', 'less', 'more']);

function isAgentGroupCommand(head: ParsedShellHead): boolean {
  if (head.args.includes('-h') || head.args.includes('--help')) return false;
  if (head.program === 'agent-dock' && head.args[0] === 'group' && head.args[1] && GROUP_SUBCOMMANDS.has(head.args[1])) return true;
  if (head.program === 'group' && head.args[0] && GROUP_SUBCOMMANDS.has(head.args[0])) return true;
  return false;
}

function firstNonFlagArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') return args[i + 1];
    if (arg === '--filter' || arg === '-F' || arg === '-C' || arg === '--dir' || arg === '-p' || arg === '--prefix') { i++; continue; }
    if (arg.startsWith('-')) continue;
    return arg;
  }
}

function isTestCommand(head: ParsedShellHead): boolean {
  if (TEST_RUNNER_PROGRAMS.has(head.program)) return true;
  if (JS_PACKAGE_RUNNERS.has(head.program)) {
    const sub = firstNonFlagArg(head.args)?.toLowerCase();
    if (!sub) return false;
    if (sub === 'test' || TEST_RUNNER_PROGRAMS.has(sub)) return true;
    if (sub === 'run' || sub === 'exec') {
      const next = head.args[head.args.indexOf(sub) + 1]?.toLowerCase();
      if (next && (next === 'test' || next.startsWith('test:') || TEST_RUNNER_PROGRAMS.has(next))) return true;
    }
  }
  if (head.program === 'go' && head.args[0] === 'test') return true;
  if (head.program === 'cargo' && head.args[0] === 'test') return true;
  if (PYTHON_PROGRAMS.has(head.program)) {
    const mIdx = head.args.indexOf('-m');
    if (mIdx >= 0 && ['pytest', 'unittest'].includes(head.args[mIdx + 1]?.toLowerCase() ?? '')) return true;
    if (head.program === 'uv' && head.args[0] === 'run' && TEST_RUNNER_PROGRAMS.has(head.args[1]?.toLowerCase() ?? '')) return true;
  }
  return false;
}

function isBrowserCommand(head: ParsedShellHead): boolean {
  if (BROWSER_PROGRAMS.has(head.program)) return true;
  if (JS_PACKAGE_RUNNERS.has(head.program)) {
    const sub = firstNonFlagArg(head.args)?.toLowerCase();
    if (sub && BROWSER_PROGRAMS.has(sub)) return true;
  }
  if (head.program === 'uv' && head.args[0] === 'run' && BROWSER_PROGRAMS.has(head.args[1]?.toLowerCase() ?? '')) return true;
  return false;
}

function isSedReadOnly(args: string[]): boolean {
  let hasQuiet = false;
  for (const arg of args) {
    if (!arg.startsWith('-') || arg === '--') break;
    if (/^-[a-zA-Z]*i/.test(arg) || arg === '--in-place') return false;
    if (/^-[a-zA-Z]*n/.test(arg) || arg === '--quiet' || arg === '--silent') hasQuiet = true;
  }
  return hasQuiet;
}

function classifyShellCommand(rawCommand: string, displayCommand: string): ToolPresentation {
  const cleaned = stripShellHeredocs(rawCommand);
  const statements = splitShellStatements(cleaned);
  const parsed = statements.map(parseShellHead).filter((item): item is ParsedShellHead => Boolean(item));

  if (parsed.some(isAgentGroupCommand)) {
    return { kind: 'agent', label: 'Agent 群协作', detail: displayCommand };
  }

  const primary = parsed.find(item => !SHELL_BOILERPLATE_PROGRAMS.has(item.program)) ?? parsed[0];
  if (!primary) return { kind: 'terminal', label: '执行命令', detail: displayCommand };

  if (isBrowserCommand(primary)) return { kind: 'browser', label: '操作浏览器', detail: displayCommand };
  if (isTestCommand(primary)) return { kind: 'test', label: '运行测试', detail: displayCommand };
  if (primary.program === 'apply_patch' || primary.program === 'patch') return { kind: 'edit', label: '应用补丁', detail: displayCommand };
  if (primary.program === 'git') return { kind: 'git', label: 'Git 操作', detail: displayCommand };
  if (DB_PROGRAMS.has(primary.program)) return { kind: 'database', label: '查询数据', detail: displayCommand };
  if (WEB_FETCH_PROGRAMS.has(primary.program)) return { kind: 'web', label: '读取网页', detail: displayCommand };
  if (LIST_DIR_PROGRAMS.has(primary.program)) return { kind: 'list', label: '查看目录', detail: displayCommand };
  if (FIND_FILE_PROGRAMS.has(primary.program)) return { kind: 'search', label: '查找文件', detail: displayCommand };
  if (primary.program === 'rg' && primary.args.includes('--files')) return { kind: 'search', label: '查找文件', detail: displayCommand };
  if (SEARCH_CONTENT_PROGRAMS.has(primary.program)) return { kind: 'search', label: '搜索内容', detail: displayCommand };
  if (!primary.hasFileWriteRedirect) {
    if (READ_FILE_PROGRAMS.has(primary.program)) return { kind: 'read', label: '读取文件', detail: displayCommand };
    if (primary.program === 'sed' && isSedReadOnly(primary.args)) return { kind: 'read', label: '读取文件', detail: displayCommand };
  }

  return { kind: 'terminal', label: '执行命令', detail: displayCommand };
}

function stripToolNameWrapper(rawName: string): string {
  const trimmed = rawName.trim();
  const runMatch = trimmed.match(/^Run\s+([A-Za-z0-9_.:-]+)$/);
  if (runMatch) return runMatch[1]!;
  const apiPrefix = trimmed.match(/^default_api:([A-Za-z0-9_.:-]+)$/);
  if (apiPrefix) return apiPrefix[1]!;
  return trimmed;
}

function parseMcpTool(rawName: string, strippedName: string, input: Record<string, unknown> | undefined): { server?: string; tool?: string } | undefined {
  const inputServer = stringField(input, ['server', 'mcp_server']);
  const inputTool = stringField(input, ['tool', 'mcp_tool']);
  if (inputServer && inputTool) return { server: inputServer, tool: inputTool };

  for (const candidate of [strippedName, rawName]) {
    const dunder = candidate.match(/^mcp__([^_](?:.*?)?)__(.+)$/i);
    if (dunder) return { server: dunder[1]!, tool: dunder[2]! };
    const dotted = candidate.match(/^mcp[.:]([^.:/\s]+)[.:](.+)$/i);
    if (dotted) return { server: dotted[1]!, tool: dotted[2]! };
    const single = candidate.match(/^mcp__([A-Za-z0-9_-]+)$/i);
    if (single) return { server: single[1]! };
  }
}

function isBrowserMcp(server: string | undefined, tool: string | undefined): boolean {
  if (server && /^(?:playwright|puppeteer|chrome[-_]?devtools|browser|ego[-_]?browser|stagehand)/i.test(server)) return true;
  if (tool && /^(?:browser_|playwright_)/i.test(tool)) return true;
  return false;
}

function firstQuestionText(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return;
  if (Array.isArray(input.questions)) {
    for (const item of input.questions) {
      const text = stringField(item, ['question', 'prompt', 'title', 'text']);
      if (text) return cleanSingleLine(text);
    }
  }
  return cleanSingleLine(stringField(input, ['question', 'prompt', 'message']));
}

function listSummary(items: unknown, keys: string[]): string | undefined {
  if (!Array.isArray(items) || !items.length) return;
  const labels = items
    .map(item => typeof item === 'string' ? item.trim() : stringField(item, keys))
    .filter((value): value is string => Boolean(value));
  if (!labels.length) return;
  const shown = labels.slice(0, 3).join(bi('、', ', '));
  return labels.length > 3 ? bi(`${shown} 等 ${labels.length} 项`, `${shown} (+${labels.length - 3} more)`) : shown;
}

function formatSearchDetail(primary: string | undefined, path: string | undefined, fallback?: string): string | undefined {
  const cleanPrimary = cleanSingleLine(primary);
  const cleanPath = cleanSingleLine(path);
  if (cleanPrimary && cleanPath && cleanPrimary !== cleanPath) return `${cleanPrimary} · ${cleanPath}`;
  return cleanPrimary ?? cleanPath ?? cleanSingleLine(fallback);
}

function formatManageTaskDetail(input: Record<string, unknown> | undefined): string | undefined {
  const action = stringField(input, ['Action', 'action']);
  const taskId = stringField(input, ['TaskId', 'task_id', 'id']);
  if (action && taskId) return `${action} ${taskId}`;
  return action ?? taskId;
}

function formatScheduleDetail(input: Record<string, unknown> | undefined): string | undefined {
  const cron = stringField(input, ['CronExpression', 'cron', 'schedule']);
  const seconds = typeof input?.DurationSeconds === 'number' && Number.isFinite(input.DurationSeconds)
    ? `${input.DurationSeconds}s`
    : undefined;
  const prompt = cleanSingleLine(stringField(input, ['Prompt', 'prompt', 'description']));
  const timing = cron ?? seconds;
  if (timing && prompt) return `${timing} · ${prompt}`;
  return timing ?? prompt;
}

function formatSwarmDetail(input: Record<string, unknown> | undefined): string | undefined {
  const action = stringField(input, ['action', 'Action']);
  const name = stringField(input, ['name', 'Name', 'title', 'Title']);
  if (action && name) return `${action} ${name}`;
  return action ?? name;
}

function formatSubagentDetail(rawName: string, strippedName: string, input: Record<string, unknown> | undefined): string | undefined {
  const fromInput = cleanSingleLine(stringField(input, ['Role', 'role', 'description', 'Description', 'subagent_type', 'agent_type', 'TypeName', 'type_name', 'subagent', 'name', 'Name']));
  if (fromInput) return fromInput;
  const colonMatch = rawName.match(/^(?:agent|subagent|task)\s*:\s*(.+)$/i);
  if (colonMatch) return cleanSingleLine(colonMatch[1]);
  const lowered = strippedName.toLowerCase();
  if (SUBAGENT_INVOKE_NAMES.has(lowered) || /^task(?:\s+\((?:low|medium|high|max)\s+effort\))?$/i.test(rawName)) return undefined;
  return cleanSingleLine(rawName);
}

function extractPatchTarget(input: Record<string, unknown> | undefined): string | undefined {
  const patch = stringField(input, ['patch', 'diff', 'unified_diff', 'unifiedDiff', 'input']);
  if (!patch) return;
  const updateMatch = patch.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/m);
  if (updateMatch) return updateMatch[1]!.trim();
  const unifiedMatch = patch.match(/^\+\+\+\s+(?:b\/)?(.+)$/m);
  if (unifiedMatch && unifiedMatch[1]!.trim() !== '/dev/null') return unifiedMatch[1]!.trim();
}

function sanitizeDetail(label: string, detail: string | undefined): string | undefined {
  const clean = cleanSingleLine(detail);
  if (!clean) return undefined;
  if (clean === label) return undefined;
  if (GENERIC_TOOL_NAMES.has(clean.toLowerCase())) return undefined;
  return clean;
}

const FILE_EDIT_INPUT_KEYS = ['Target', 'Replacement', 'TargetContent', 'ReplacementContent', 'ReplacementChunks', 'old_string', 'new_string', 'oldText', 'newText', 'old_str', 'new_str', 'edits'];
const FILE_PATCH_INPUT_KEYS = ['patch', 'diff', 'unified_diff', 'unifiedDiff'];
const FILE_WRITE_INPUT_KEYS = ['Content', 'content', 'CodeContent', 'file_text', 'file_content', 'Overwrite', 'Append'];
const FILE_PATH_KEYS = ['file_path', 'filePath', 'path', 'Path', 'TargetFile', 'AbsolutePath', 'File', 'notebook_path', 'notebookPath', 'filename', 'file'];
const DIR_PATH_KEYS = ['DirectoryPath', 'directory_path', 'directory', 'dir', 'SearchDirectory', 'SearchPath', 'path', 'Path'];
const QUERY_KEYS = ['query', 'Query', 'pattern', 'Pattern', 'glob', 'Glob', 'search', 'q'];
const URL_KEYS = ['url', 'Url', 'URL', 'href'];

const CODE_OUTLINE_TOOLS = new Set(['view_file_outline', 'view_code_item', 'get_outline', 'file_outline', 'document_symbols']);
const IMAGE_VIEW_TOOLS = new Set(['view_image', 'read_image']);
const IMAGE_GEN_TOOLS = new Set(['generate_image', 'image-generator', 'image_generator', 'edit_image', 'create_image']);
const FILE_READ_TOOLS = new Set(['read_file', 'read', 'view_file', 'open_file', 'read_file_content', 'readfile', 'cat_file', 'get_file']);
const FILE_PATCH_TOOLS = new Set(['apply_patch', 'patch', 'apply_diff', 'patch_file']);
const FILE_WRITE_TOOLS = new Set(['write_file', 'write', 'write_to_file', 'create_file', 'writefile', 'save_file']);
const FILE_EDIT_TOOLS = new Set(['edit_file', 'edit', 'multiedit', 'multi_edit', 'strreplace', 'str_replace', 'str_replace_editor', 'replace_file_content', 'multi_replace_file_content', 'notebookedit', 'notebook_edit', 'update_file']);
const FILE_DELETE_TOOLS = new Set(['delete_file', 'delete', 'remove_file', 'rm_file']);
const FILE_MOVE_TOOLS = new Set(['move_file', 'rename_file', 'mv_file']);
const LIST_DIR_TOOLS = new Set(['list_dir', 'ls', 'list', 'list_directory', 'list_files', 'listdir', 'read_dir']);
const FIND_FILE_TOOLS = new Set(['glob', 'find_by_name', 'file_search', 'glob_file_search', 'find_files', 'find']);
const SEARCH_CONTENT_TOOLS = new Set(['grep', 'grep_search', 'search', 'search_content', 'codebase_search', 'semantic_search', 'ripgrep', 'rg', 'codesearch', 'text_search', 'search_files']);
const TOOL_SEARCH_TOOLS = new Set(['toolsearch', 'tool_search']);
const LINT_TOOLS = new Set(['read_lints', 'get_diagnostics']);
const WEB_SEARCH_TOOLS = new Set(['search_web', 'websearch', 'web_search', 'search_query', 'google_search', 'internet_search']);
const WEB_FETCH_TOOLS = new Set(['webfetch', 'web_fetch', 'read_url_content', 'fetch_url', 'open_url', 'fetch', 'get_url', 'http_fetch']);
const COMMAND_STATUS_TOOLS = new Set(['command_status', 'bash_output', 'bashoutput', 'read_terminal', 'get_command_output']);
const COMMAND_INPUT_TOOLS = new Set(['write_stdin', 'send_command_input', 'terminal_input']);
const SHELL_TOOL_NAMES = new Set(['run_command', 'bash', 'shell', 'powershell', 'terminal', 'exec_command', 'run_terminal_cmd', 'execute_command']);
const BROWSER_TOOL_NAMES = new Set(['ego-browser', 'browser', 'browser_subagent', 'playwright', 'open_browser_url', 'read_browser_page']);
const SUBAGENT_INVOKE_NAMES = new Set(['invoke_subagent', 'agent', 'task', 'subagent', 'spawn_agent', 'spawn_subagent', 'resume_agent', 'delegate_task', 'delegate_agent', 'call_subagent', 'run_subagent', 'create_subagent']);
const SUBAGENT_DEFINE_NAMES = new Set(['define_subagent', 'register_subagent']);
const SUBAGENT_MANAGE_NAMES = new Set(['manage_subagents', 'listagents', 'list_agents', 'close_agent', 'wait_agent']);
const MESSAGE_TOOL_NAMES = new Set(['send_message', 'sendmessage']);
const WORKFLOW_TOOL_NAMES = new Set(['run_workflow', 'execute_workflow']);
const QUESTION_TOOL_NAMES = new Set(['ask_question', 'askuserquestion', 'askquestion', 'question']);
const TODO_TOOL_NAMES = new Set(['todowrite', 'todo_write', 'todoread', 'todo_read']);
const PLAN_TOOL_NAMES = new Set(['update_plan', 'plan', 'create_plan', 'taskcreate', 'taskupdate', 'tasklist', 'taskget']);
const PLAN_MODE_TOOLS = new Set(['enterplanmode', 'exitplanmode', 'enter_plan_mode', 'exit_plan_mode']);
const TASK_STOP_TOOLS = new Set(['taskstop', 'stop_task', 'kill_shell', 'killshell']);
const TASK_MANAGE_TOOLS = new Set(['manage_task', 'monitor', 'task_output', 'taskoutput']);
const SCHEDULE_TOOLS = new Set(['schedule', 'cron', 'set_timer']);
const SKILL_TOOLS = new Set(['skill', 'load_skill', 'use_skill']);
const COMPACT_TOOLS = new Set(['compact', 'compact_conversation']);
const DB_DIRECT_TOOLS = new Set(['query_database', 'execute_sql', 'run_sql', 'sql_query', 'sqlite_query']);

function makePresentation(kind: ToolKind, label: string, detail?: string): ToolPresentation {
  const phrase = ACTION_PHRASES[label];
  const displayLabel = phrase ? bi(label, phrase.enLabel) : label;
  const clean = sanitizeDetail(displayLabel, detail);
  return clean !== undefined ? { kind, label: displayLabel, detail: clean } : { kind, label: displayLabel };
}

export function toolPresentation(data: TimelineEvent['data']): ToolPresentation {
  const input = recordOf(data.input);
  const rawCommand = rawToolCommand(data.input);
  const command = toolCommand(data.input);
  const rawName = typeof data.name === 'string' ? data.name.trim() : '';
  const strippedName = stripToolNameWrapper(rawName);
  const toolKey = strippedName.toLowerCase();
  const acpKind = typeof data.kind === 'string' ? data.kind.trim().toLowerCase() : undefined;

  // 1. AgentDock 便签命令优先于一切通用分类（标题里可能含 edit / test / agent 等词）。
  const note = noteCommandPresentation(command);
  if (note) return makePresentation('note', note.label, note.detail ?? command);

  // 2. 带显式命令行参数（command / cmd / CommandLine）的调用一律走 shell 命令解析，
  //    绝不对路径或命令文本里的 agent / task 子串做宽泛匹配。
  if (command && rawCommand) {
    return classifyShellCommand(rawCommand, command);
  }
  // 兼容少数把命令直接作为字符串放在 input 里的 shell 工具。
  if (typeof data.input === 'string' && data.input.trim() && SHELL_TOOL_NAMES.has(toolKey)) {
    const inlineCmd = cleanSingleLine(data.input)!;
    const inlineNote = noteCommandPresentation(inlineCmd);
    if (inlineNote) return makePresentation('note', inlineNote.label, inlineNote.detail ?? inlineCmd);
    return classifyShellCommand(data.input.trim(), inlineCmd);
  }

  const filePath = stringField(data.input, FILE_PATH_KEYS);
  const dirPath = stringField(data.input, DIR_PATH_KEYS);
  const query = stringField(data.input, QUERY_KEYS);
  const url = stringField(data.input, URL_KEYS);

  // 3. MCP 工具 & 浏览器 MCP 工具。
  const mcp = parseMcpTool(rawName, strippedName, input);
  if (mcp) {
    const detail = mcp.server && mcp.tool ? `${mcp.server} / ${mcp.tool}` : (mcp.tool ?? mcp.server);
    if (isBrowserMcp(mcp.server, mcp.tool)) return makePresentation('browser', '操作浏览器', detail);
    return makePresentation('mcp', '调用 MCP', detail);
  }

  // 4. 直接浏览器操作工具（含 browser_subagent、browser_*、playwright_*、ego-browser）。
  if (BROWSER_TOOL_NAMES.has(toolKey) || /^(?:browser|playwright)_[a-z0-9_]+$/.test(toolKey)) {
    const detail = url ?? stringField(input, ['TaskName', 'Task', 'action', 'Action']) ?? (toolKey !== 'browser' && toolKey !== 'ego-browser' && toolKey !== 'browser_subagent' ? strippedName : undefined);
    return makePresentation('browser', '操作浏览器', detail);
  }

  // 5. Antigravity 文件标题 `File <path>`（覆盖 read_file / edit_file / write_file，
  //    绝不能让路径中的 agent-dock / agent-runtime / task 误落入子 Agent 分类）。
  const agyFileMatch = rawName.match(/^File\s+(.+)$/);
  if (agyFileMatch) {
    const displayPath = agyFileMatch[1]!.trim() || filePath;
    if (hasAnyKey(input, FILE_EDIT_INPUT_KEYS)) return makePresentation('edit', '修改文件', displayPath);
    if (hasAnyKey(input, FILE_PATCH_INPUT_KEYS)) return makePresentation('edit', '应用补丁', displayPath);
    if (hasAnyKey(input, FILE_WRITE_INPUT_KEYS)) return makePresentation('edit', '写入文件', displayPath);
    if (acpKind === 'delete') return makePresentation('edit', '删除文件', displayPath);
    if (acpKind === 'move') return makePresentation('edit', '移动文件', displayPath);
    if (acpKind === 'edit') return makePresentation('edit', '修改文件', displayPath);
    return makePresentation('read', '读取文件', displayPath);
  }

  // 6. 文件查看 / 代码结构 / 查看图片。
  if (CODE_OUTLINE_TOOLS.has(toolKey)) {
    const item = stringField(input, ['NodePaths', 'symbol', 'name']) ?? listSummary(input?.NodePaths, ['name']);
    return makePresentation('read', '查看代码结构', formatSearchDetail(filePath, item));
  }
  if (IMAGE_VIEW_TOOLS.has(toolKey) || /^View\s+Image(?:\s+(.+))?$/i.test(rawName)) {
    const imgMatch = rawName.match(/^View\s+Image\s+(.+)$/i);
    return makePresentation('image', '查看图片', unquote(imgMatch?.[1]) ?? filePath);
  }
  if (FILE_READ_TOOLS.has(toolKey) || /^Read\s+File$/i.test(rawName)) {
    return makePresentation('read', '读取文件', filePath);
  }
  const readFilePrefix = rawName.match(/^Read\s+file\s+(.+)$/i);
  if (readFilePrefix) {
    return makePresentation('read', '读取文件', unquote(readFilePrefix[1]) ?? filePath);
  }
  const readPrefix = rawName.match(/^Read\s+(.+)$/i);
  if (readPrefix) {
    return makePresentation('read', '读取文件', unquote(readPrefix[1]) ?? filePath);
  }

  // 7. 文件修改 / 写入 / 补丁 / 删除 / 移动。
  if (FILE_PATCH_TOOLS.has(toolKey)) {
    return makePresentation('edit', '应用补丁', filePath ?? extractPatchTarget(input));
  }
  if (FILE_WRITE_TOOLS.has(toolKey) || /^Preparing file…$/i.test(rawName)) {
    return makePresentation('edit', '写入文件', filePath);
  }
  const writePrefix = rawName.match(/^Write\s+(.+)$/i);
  if (writePrefix) {
    return makePresentation('edit', '写入文件', unquote(writePrefix[1]) ?? filePath);
  }
  if (FILE_EDIT_TOOLS.has(toolKey) || /^Editing files?$/i.test(rawName)) {
    return makePresentation('edit', '修改文件', filePath);
  }
  const editPrefix = rawName.match(/^Edit\s+(.+)$/i);
  if (editPrefix) {
    return makePresentation('edit', '修改文件', unquote(editPrefix[1]) ?? filePath);
  }
  if (FILE_DELETE_TOOLS.has(toolKey)) {
    return makePresentation('edit', '删除文件', filePath);
  }
  const deletePrefix = rawName.match(/^Delete\s+(.+)$/i);
  if (deletePrefix) {
    return makePresentation('edit', '删除文件', unquote(deletePrefix[1]) ?? filePath);
  }
  if (FILE_MOVE_TOOLS.has(toolKey)) {
    const src = stringField(input, ['source', 'from', 'old_path', 'src']);
    const dst = stringField(input, ['destination', 'to', 'new_path', 'dest']);
    return makePresentation('edit', '移动文件', src && dst ? `${src} → ${dst}` : (filePath ?? dst ?? src));
  }

  // 8. 目录查看 / 文件查找 / 内容检索 / 工具搜索 / 诊断检查。
  if (LIST_DIR_TOOLS.has(toolKey)) {
    return makePresentation('list', '查看目录', dirPath);
  }
  const listFilesMatch = rawName.match(/^List\s+files(?:\s+in\s+(.+))?$/i);
  if (listFilesMatch) {
    return makePresentation('list', '查看目录', unquote(listFilesMatch[1]) ?? dirPath);
  }
  if (FIND_FILE_TOOLS.has(toolKey)) {
    const pattern = stringField(input, ['pattern', 'Pattern', 'glob', 'Glob', 'query']);
    return makePresentation('search', '查找文件', formatSearchDetail(pattern, dirPath));
  }
  const findPrefix = rawName.match(/^Find(?:\s+(.+))?$/i);
  if (findPrefix) {
    const pattern = stringField(input, ['pattern', 'Pattern', 'glob', 'Glob']);
    const fallback = findPrefix[1]?.replace(/`/g, '').trim();
    return makePresentation('search', '查找文件', formatSearchDetail(pattern, dirPath, fallback));
  }
  if (SEARCH_CONTENT_TOOLS.has(toolKey)) {
    return makePresentation('search', '搜索内容', formatSearchDetail(query, dirPath));
  }
  const grepPrefix = rawName.match(/^grep(?:\s+(.+))?$/i);
  if (grepPrefix) {
    return makePresentation('search', '搜索内容', formatSearchDetail(query, dirPath, grepPrefix[1]));
  }
  const codexSearchMatch = rawName.match(/^Search\s+for\s+(['"`])(.+?)\1(?:\s+in\s+(.+))?$/i);
  if (codexSearchMatch) {
    return makePresentation('search', '搜索内容', formatSearchDetail(codexSearchMatch[2], unquote(codexSearchMatch[3]) ?? dirPath));
  }
  if (TOOL_SEARCH_TOOLS.has(toolKey)) {
    return makePresentation('search', '搜索工具', query);
  }
  if (LINT_TOOLS.has(toolKey)) {
    return makePresentation('search', '检查诊断', filePath ?? dirPath);
  }

  // 9. 联网搜索 & 读取网页。
  if (WEB_SEARCH_TOOLS.has(toolKey)) {
    return makePresentation('web', '搜索网页', query);
  }
  const webSearchPrefix = rawName.match(/^Web\s+search(?::\s*(.+))?$/i);
  if (webSearchPrefix) {
    return makePresentation('web', '搜索网页', query ?? unquote(webSearchPrefix[1]));
  }
  const onWebMatch = rawName.match(/^(.+?)\s+on\s+Web$/i);
  if (onWebMatch) {
    return makePresentation('web', '搜索网页', query ?? unquote(onWebMatch[1]));
  }
  const quotedSearchMatch = rawName.match(/^Search\s+"(.+)"$/i);
  if (quotedSearchMatch) {
    return makePresentation('web', '搜索网页', query ?? quotedSearchMatch[1]);
  }
  if (WEB_FETCH_TOOLS.has(toolKey)) {
    return makePresentation('web', '读取网页', url);
  }
  const fetchPrefix = rawName.match(/^Fetch(?:\s+(.+))?$/i);
  if (fetchPrefix) {
    return makePresentation('web', '读取网页', url ?? fetchPrefix[1]);
  }

  // 10. 终端命令 I/O 工具与无参数流式 Terminal 占位。
  if (COMMAND_STATUS_TOOLS.has(toolKey)) {
    return makePresentation('terminal', '查看命令输出', stringField(input, ['CommandId', 'command_id', 'shell_id', 'session_id', 'id']));
  }
  if (COMMAND_INPUT_TOOLS.has(toolKey)) {
    return makePresentation('terminal', '向命令发送输入', stringField(input, ['CommandId', 'command_id', 'session_id', 'Input', 'chars']));
  }
  if (SHELL_TOOL_NAMES.has(toolKey)) {
    return makePresentation('terminal', '执行命令');
  }

  // 11. 图片生成（含直接工具及 image-generator 子 Agent）。
  const subagentType = stringField(input, ['TypeName', 'type_name', 'subagent_type', 'agent_type'])?.toLowerCase();
  if (IMAGE_GEN_TOOLS.has(toolKey) || subagentType === 'image-generator' || subagentType === 'image_generator') {
    return makePresentation('image', '生成图片', stringField(input, ['Prompt', 'prompt', 'ImageName', 'Role', 'description']));
  }

  // 12. 严格的子 Agent 与多 Agent 协作工具判定：
  //     只认显式工具名或结构化 subagent 字段，绝不对普通文本/路径/命令做宽泛 agent/task 子串匹配。
  if (/^group\s+(?:self|peers|messages|send|wait)\b/i.test(rawName)) {
    return makePresentation('agent', 'Agent 群协作', rawName);
  }
  if (SUBAGENT_DEFINE_NAMES.has(toolKey)) {
    return makePresentation('agent', '定义子 Agent', stringField(input, ['Name', 'name', 'Description', 'description']));
  }
  if (SUBAGENT_MANAGE_NAMES.has(toolKey)) {
    const action = stringField(input, ['Action', 'action']);
    return makePresentation('agent', '管理子 Agent', action);
  }
  if (MESSAGE_TOOL_NAMES.has(toolKey)) {
    return makePresentation('agent', '发送消息', stringField(input, ['Recipient', 'recipient', 'to', 'target']));
  }
  if (toolKey === 'swarm') {
    return makePresentation('agent', '多 Agent 协作', formatSwarmDetail(input));
  }
  if (WORKFLOW_TOOL_NAMES.has(toolKey)) {
    return makePresentation('workflow', '运行工作流', stringField(input, ['Description', 'description', 'ScriptPath', 'name']));
  }

  const hasStructuredSubagentInput = Boolean(
    stringField(input, ['subagent_type', 'agent_type', 'subagent'])
    || (stringField(input, ['TypeName']) && stringField(input, ['Role']) && stringField(input, ['Prompt']))
  );
  const isExplicitSubagentTitle =
    SUBAGENT_INVOKE_NAMES.has(toolKey)
    || /^Task\s+\((?:low|medium|high|max)\s+effort\)$/i.test(rawName)
    || acpKind === 'subagent'
    || (/^(?:agent|subagent|task)\s*:\s*\S/i.test(rawName) && !filePath && !url);

  if (isExplicitSubagentTitle || hasStructuredSubagentInput) {
    return makePresentation('agent', '调用子 Agent', formatSubagentDetail(rawName, strippedName, input));
  }

  // 13. 交互提问 / 计划待办 / 后台任务 / 定时任务 / 技能 / 压缩 / 数据库直连工具。
  if (QUESTION_TOOL_NAMES.has(toolKey) || /^Asking for your input$/i.test(rawName) || (Array.isArray(input?.questions) && input.questions.length > 0)) {
    const fallbackTitle = !QUESTION_TOOL_NAMES.has(toolKey) && !/^Asking for your input$/i.test(rawName) && !GENERIC_TOOL_NAMES.has(rawName.toLowerCase())
      ? rawName
      : undefined;
    return makePresentation('question', '发起提问', firstQuestionText(input) ?? fallbackTitle);
  }
  if (TODO_TOOL_NAMES.has(toolKey) || /^Update TODOs(?::\s*(.+))?$/i.test(rawName) || Array.isArray(input?.todos)) {
    const todoMatch = rawName.match(/^Update TODOs:\s*(.+)$/i);
    return makePresentation('plan', '更新待办', listSummary(input?.todos, ['content', 'title', 'text']) ?? todoMatch?.[1]);
  }
  if (PLAN_TOOL_NAMES.has(toolKey) || /^(?:Create|Update|List|Get)\s+tasks?(?::\s*(.+))?$/i.test(rawName)) {
    const taskTitleMatch = rawName.match(/^(?:Create|Update)\s+task:\s*(.+)$/i);
    const detail = stringField(input, ['subject', 'title', 'explanation'])
      ?? listSummary(input?.plan ?? input?.steps, ['step', 'content', 'title'])
      ?? taskTitleMatch?.[1];
    return makePresentation('plan', '更新计划', detail);
  }
  if (PLAN_MODE_TOOLS.has(toolKey) || /^(?:Approve Plan|Exited Plan Mode)$/i.test(rawName) || acpKind === 'switch_mode') {
    return makePresentation('plan', '切换规划模式');
  }
  if (toolKey === 'reportfindings' || toolKey === 'report_findings' || /^Report\s+(?:\d+\s+findings?|findings:)/i.test(rawName)) {
    return makePresentation('plan', '汇报检查结果');
  }
  if (TASK_STOP_TOOLS.has(toolKey)) {
    return makePresentation('task', '停止后台任务', stringField(input, ['task_id', 'TaskId', 'shell_id', 'id']));
  }
  if (TASK_MANAGE_TOOLS.has(toolKey)) {
    return makePresentation('task', '管理后台任务', formatManageTaskDetail(input));
  }
  if (SCHEDULE_TOOLS.has(toolKey)) {
    return makePresentation('task', '设置定时任务', formatScheduleDetail(input));
  }
  if (SKILL_TOOLS.has(toolKey) || /^Load skill(?::\s*(.+))?$/i.test(rawName) || Boolean(stringField(input, ['skill']))) {
    const skillMatch = rawName.match(/^Load skill:\s*(.+)$/i);
    return makePresentation('skill', '加载技能', stringField(input, ['skill', 'name']) ?? skillMatch?.[1]);
  }
  if (COMPACT_TOOLS.has(toolKey) || /^Compact conversation$/i.test(rawName)) {
    return makePresentation('plan', '压缩上下文');
  }
  if (DB_DIRECT_TOOLS.has(toolKey)) {
    return makePresentation('database', '查询数据', stringField(input, ['query', 'sql', 'database']));
  }

  // 14. 通用 `tool` / `tool call` 占位名：借助结构化输入字段精准识别（如 Claude Code 流式更新阶段）。
  const isGeneric = GENERIC_TOOL_NAMES.has(rawName.toLowerCase());
  if (isGeneric) {
    if (hasAnyKey(input, FILE_EDIT_INPUT_KEYS)) return makePresentation('edit', '修改文件', filePath);
    if (hasAnyKey(input, FILE_PATCH_INPUT_KEYS)) return makePresentation('edit', '应用补丁', filePath ?? extractPatchTarget(input));
    if (hasAnyKey(input, FILE_WRITE_INPUT_KEYS)) return makePresentation('edit', '写入文件', filePath);
    if (filePath) return makePresentation('read', '读取文件', filePath);
    if (url) return makePresentation('web', '读取网页', url);
    if (stringField(input, ['pattern', 'Pattern', 'glob', 'Glob'])) return makePresentation('search', '搜索内容', formatSearchDetail(query, dirPath));
    if (query && input?.max_results !== undefined) return makePresentation('search', '搜索工具', query);
    if (query) return makePresentation(acpKind === 'search' ? 'search' : 'web', acpKind === 'search' ? '搜索内容' : '搜索网页', query);
    if (stringField(input, ['task_id', 'TaskId'])) return makePresentation('task', '管理后台任务', stringField(input, ['task_id', 'TaskId']));
  }

  // 15. ACP 结构化 kind 兜底（用于未知或第三方 ACP Agent 工具）。
  const nonGenericName = isGeneric ? undefined : strippedName;
  if (acpKind === 'read') return makePresentation('read', '读取文件', filePath ?? nonGenericName);
  if (acpKind === 'edit') return makePresentation('edit', '修改文件', filePath ?? nonGenericName);
  if (acpKind === 'delete') return makePresentation('edit', '删除文件', filePath ?? nonGenericName);
  if (acpKind === 'move') return makePresentation('edit', '移动文件', filePath ?? nonGenericName);
  if (acpKind === 'search') return makePresentation('search', '搜索内容', formatSearchDetail(query, dirPath, nonGenericName));
  if (acpKind === 'fetch') return makePresentation('web', '读取网页', url ?? query ?? nonGenericName);
  if (acpKind === 'execute') {
    if (nonGenericName) {
      const execNote = noteCommandPresentation(nonGenericName);
      if (execNote) return makePresentation('note', execNote.label, execNote.detail ?? nonGenericName);
      return classifyShellCommand(nonGenericName, nonGenericName);
    }
    return makePresentation('terminal', '执行命令');
  }

  // 16. 最终安全兜底：不重复 label 与 detail，不暴露生硬的 `tool call`。
  if (isGeneric) return { kind: 'tool', label: bi('工具调用', 'Tool Call') };
  const label = strippedName || toolDisplayName(data);
  return makePresentation('tool', label, filePath ?? url ?? query);
}

type ActionPhrase = {
  enLabel: string;
  running: string;
  completed: string;
  summary: (count: number) => string;
  enRunning: string;
  enCompleted: string;
  enSummary: (count: number) => string;
};

const plural = (c: number, one: string, many: string) => (c > 1 ? `${c} ${many}` : one);

const ACTION_PHRASES: Record<string, ActionPhrase> = {
  '读取文件': { enLabel: 'Read File', running: '正在读取文件', completed: '已读取文件', summary: c => `读取了${withCount(c, '个')}文件`, enRunning: 'Reading file', enCompleted: 'Read file', enSummary: c => `Read ${plural(c, 'file', 'files')}` },
  '查看代码结构': { enLabel: 'View Outline', running: '正在查看代码结构', completed: '已查看代码结构', summary: c => `查看了${withCount(c, '次')}代码结构`, enRunning: 'Viewing code outline', enCompleted: 'Viewed code outline', enSummary: c => `Viewed outline ${c > 1 ? `${c}x` : ''}`.trim() },
  '修改文件': { enLabel: 'Edit File', running: '正在修改文件', completed: '已修改文件', summary: c => `修改了${withCount(c, '个')}文件`, enRunning: 'Editing file', enCompleted: 'Edited file', enSummary: c => `Edited ${plural(c, 'file', 'files')}` },
  '写入文件': { enLabel: 'Write File', running: '正在写入文件', completed: '已写入文件', summary: c => `写入了${withCount(c, '个')}文件`, enRunning: 'Writing file', enCompleted: 'Wrote file', enSummary: c => `Wrote ${plural(c, 'file', 'files')}` },
  '应用补丁': { enLabel: 'Apply Patch', running: '正在应用补丁', completed: '已应用补丁', summary: c => `应用了${withCount(c, '次')}补丁`, enRunning: 'Applying patch', enCompleted: 'Applied patch', enSummary: c => `Applied ${plural(c, 'patch', 'patches')}` },
  '删除文件': { enLabel: 'Delete File', running: '正在删除文件', completed: '已删除文件', summary: c => `删除了${withCount(c, '个')}文件`, enRunning: 'Deleting file', enCompleted: 'Deleted file', enSummary: c => `Deleted ${plural(c, 'file', 'files')}` },
  '移动文件': { enLabel: 'Move File', running: '正在移动文件', completed: '已移动文件', summary: c => `移动了${withCount(c, '个')}文件`, enRunning: 'Moving file', enCompleted: 'Moved file', enSummary: c => `Moved ${plural(c, 'file', 'files')}` },
  '查看目录': { enLabel: 'List Directory', running: '正在查看目录', completed: '已查看目录', summary: c => `查看了${withCount(c, '个')}目录`, enRunning: 'Listing directory', enCompleted: 'Listed directory', enSummary: c => `Listed ${plural(c, 'directory', 'directories')}` },
  '查找文件': { enLabel: 'Find Files', running: '正在查找文件', completed: '已查找文件', summary: c => `查找了${withCount(c, '次')}文件`, enRunning: 'Finding files', enCompleted: 'Found files', enSummary: c => c > 1 ? `Found files ${c}x` : 'Found files' },
  '搜索内容': { enLabel: 'Search Code', running: '正在搜索内容', completed: '已搜索内容', summary: c => `搜索了${withCount(c, '次')}内容`, enRunning: 'Searching code', enCompleted: 'Searched code', enSummary: c => c > 1 ? `Searched ${c}x` : 'Searched code' },
  '搜索工具': { enLabel: 'Search Tools', running: '正在搜索工具', completed: '已搜索工具', summary: c => `搜索了${withCount(c, '次')}工具`, enRunning: 'Searching tools', enCompleted: 'Searched tools', enSummary: c => c > 1 ? `Searched tools ${c}x` : 'Searched tools' },
  '检查诊断': { enLabel: 'Check Diagnostics', running: '正在检查诊断', completed: '已检查诊断', summary: c => `检查了${withCount(c, '次')}诊断`, enRunning: 'Checking diagnostics', enCompleted: 'Checked diagnostics', enSummary: c => c > 1 ? `Checked diagnostics ${c}x` : 'Checked diagnostics' },
  '执行命令': { enLabel: 'Run Command', running: '正在执行命令', completed: '已执行命令', summary: c => `执行了${withCount(c, '条')}命令`, enRunning: 'Running command', enCompleted: 'Ran command', enSummary: c => `Ran ${plural(c, 'command', 'commands')}` },
  '查看命令输出': { enLabel: 'Read Output', running: '正在查看命令输出', completed: '已查看命令输出', summary: c => `查看了${withCount(c, '次')}命令输出`, enRunning: 'Reading command output', enCompleted: 'Read command output', enSummary: c => c > 1 ? `Read output ${c}x` : 'Read output' },
  '向命令发送输入': { enLabel: 'Send Input', running: '正在向命令发送输入', completed: '已向命令发送输入', summary: c => `向命令发送了${withCount(c, '次')}输入`, enRunning: 'Sending input', enCompleted: 'Sent input', enSummary: c => c > 1 ? `Sent input ${c}x` : 'Sent input' },
  '搜索网页': { enLabel: 'Web Search', running: '正在搜索网页', completed: '已搜索网页', summary: c => `搜索了${withCount(c, '次')}网页`, enRunning: 'Searching web', enCompleted: 'Searched web', enSummary: c => c > 1 ? `Web search ${c}x` : 'Searched web' },
  '读取网页': { enLabel: 'Fetch Page', running: '正在读取网页', completed: '已读取网页', summary: c => `读取了${withCount(c, '个')}网页`, enRunning: 'Fetching web page', enCompleted: 'Fetched web page', enSummary: c => `Fetched ${plural(c, 'page', 'pages')}` },
  '操作浏览器': { enLabel: 'Browser Action', running: '正在操作浏览器', completed: '已操作浏览器', summary: c => `操作了${withCount(c, '次')}浏览器`, enRunning: 'Operating browser', enCompleted: 'Used browser', enSummary: c => c > 1 ? `Browser ${c}x` : 'Used browser' },
  'Git 操作': { enLabel: 'Git Command', running: '正在执行 Git 操作', completed: '已执行 Git 操作', summary: c => `执行了${withCount(c, '次')} Git 操作`, enRunning: 'Running Git command', enCompleted: 'Ran Git command', enSummary: c => c > 1 ? `Ran ${c} Git commands` : 'Ran Git command' },
  '运行测试': { enLabel: 'Run Tests', running: '正在运行测试', completed: '已运行测试', summary: c => `运行了${withCount(c, '次')}测试`, enRunning: 'Running tests', enCompleted: 'Ran tests', enSummary: c => c > 1 ? `Ran tests ${c}x` : 'Ran tests' },
  '查询数据': { enLabel: 'Query Data', running: '正在查询数据', completed: '已查询数据', summary: c => `查询了${withCount(c, '次')}数据`, enRunning: 'Querying data', enCompleted: 'Queried data', enSummary: c => c > 1 ? `Ran ${c} queries` : 'Queried data' },
  '调用子 Agent': { enLabel: 'Invoke Subagent', running: '正在调用子 Agent', completed: '已调用子 Agent', summary: c => `调用了${withCount(c, '个')}子 Agent`, enRunning: 'Running subagent', enCompleted: 'Ran subagent', enSummary: c => `Ran ${plural(c, 'subagent', 'subagents')}` },
  '定义子 Agent': { enLabel: 'Define Subagent', running: '正在定义子 Agent', completed: '已定义子 Agent', summary: c => `定义了${withCount(c, '个')}子 Agent`, enRunning: 'Defining subagent', enCompleted: 'Defined subagent', enSummary: c => `Defined ${plural(c, 'subagent', 'subagents')}` },
  '管理子 Agent': { enLabel: 'Manage Subagents', running: '正在管理子 Agent', completed: '已管理子 Agent', summary: c => `管理了${withCount(c, '次')}子 Agent`, enRunning: 'Managing subagents', enCompleted: 'Managed subagents', enSummary: c => c > 1 ? `Managed subagents ${c}x` : 'Managed subagents' },
  '发送消息': { enLabel: 'Send Message', running: '正在发送消息', completed: '已发送消息', summary: c => `发送了${withCount(c, '条')}消息`, enRunning: 'Sending message', enCompleted: 'Sent message', enSummary: c => `Sent ${plural(c, 'message', 'messages')}` },
  '多 Agent 协作': { enLabel: 'Agent Swarm', running: '正在进行多 Agent 协作', completed: '已完成多 Agent 协作', summary: c => `进行了${withCount(c, '次')}多 Agent 协作`, enRunning: 'Coordinating swarm', enCompleted: 'Swarm updated', enSummary: c => c > 1 ? `Swarm ${c}x` : 'Swarm action' },
  'Agent 群协作': { enLabel: 'Group Collaboration', running: '正在进行 Agent 群协作', completed: '已完成 Agent 群协作', summary: c => `进行了${withCount(c, '次')} Agent 群协作`, enRunning: 'Collaborating in group', enCompleted: 'Group action done', enSummary: c => c > 1 ? `Group action ${c}x` : 'Group action' },
  '运行工作流': { enLabel: 'Run Workflow', running: '正在运行工作流', completed: '已运行工作流', summary: c => `运行了${withCount(c, '个')}工作流`, enRunning: 'Running workflow', enCompleted: 'Ran workflow', enSummary: c => `Ran ${plural(c, 'workflow', 'workflows')}` },
  '发起提问': { enLabel: 'Ask Question', running: '正在发起提问', completed: '已发起提问', summary: c => `发起了${withCount(c, '次')}提问`, enRunning: 'Asking question', enCompleted: 'Asked question', enSummary: c => `Asked ${plural(c, 'question', 'questions')}` },
  '更新待办': { enLabel: 'Update TODOs', running: '正在更新待办', completed: '已更新待办', summary: c => `更新了${withCount(c, '次')}待办`, enRunning: 'Updating TODOs', enCompleted: 'Updated TODOs', enSummary: c => c > 1 ? `Updated TODOs ${c}x` : 'Updated TODOs' },
  '更新计划': { enLabel: 'Update Plan', running: '正在更新计划', completed: '已更新计划', summary: c => `更新了${withCount(c, '次')}计划`, enRunning: 'Updating plan', enCompleted: 'Updated plan', enSummary: c => c > 1 ? `Updated plan ${c}x` : 'Updated plan' },
  '切换规划模式': { enLabel: 'Switch Plan Mode', running: '正在切换规划模式', completed: '已切换规划模式', summary: c => `切换了${withCount(c, '次')}规划模式`, enRunning: 'Switching plan mode', enCompleted: 'Switched plan mode', enSummary: c => c > 1 ? `Switched mode ${c}x` : 'Switched plan mode' },
  '汇报检查结果': { enLabel: 'Report Findings', running: '正在汇报检查结果', completed: '已汇报检查结果', summary: c => `汇报了${withCount(c, '次')}检查结果`, enRunning: 'Reporting findings', enCompleted: 'Reported findings', enSummary: c => c > 1 ? `Reported findings ${c}x` : 'Reported findings' },
  '管理后台任务': { enLabel: 'Manage Task', running: '正在管理后台任务', completed: '已管理后台任务', summary: c => `管理了${withCount(c, '次')}后台任务`, enRunning: 'Managing task', enCompleted: 'Managed task', enSummary: c => c > 1 ? `Managed tasks ${c}x` : 'Managed task' },
  '停止后台任务': { enLabel: 'Stop Task', running: '正在停止后台任务', completed: '已停止后台任务', summary: c => `停止了${withCount(c, '个')}后台任务`, enRunning: 'Stopping task', enCompleted: 'Stopped task', enSummary: c => `Stopped ${plural(c, 'task', 'tasks')}` },
  '设置定时任务': { enLabel: 'Schedule Task', running: '正在设置定时任务', completed: '已设置定时任务', summary: c => `设置了${withCount(c, '个')}定时任务`, enRunning: 'Scheduling task', enCompleted: 'Scheduled task', enSummary: c => `Scheduled ${plural(c, 'task', 'tasks')}` },
  '加载技能': { enLabel: 'Load Skill', running: '正在加载技能', completed: '已加载技能', summary: c => `加载了${withCount(c, '个')}技能`, enRunning: 'Loading skill', enCompleted: 'Loaded skill', enSummary: c => `Loaded ${plural(c, 'skill', 'skills')}` },
  '生成图片': { enLabel: 'Generate Image', running: '正在生成图片', completed: '已生成图片', summary: c => `生成了${withCount(c, '张')}图片`, enRunning: 'Generating image', enCompleted: 'Generated image', enSummary: c => `Generated ${plural(c, 'image', 'images')}` },
  '查看图片': { enLabel: 'View Image', running: '正在查看图片', completed: '已查看图片', summary: c => `查看了${withCount(c, '张')}图片`, enRunning: 'Viewing image', enCompleted: 'Viewed image', enSummary: c => `Viewed ${plural(c, 'image', 'images')}` },
  '调用 MCP': { enLabel: 'Call MCP', running: '正在调用 MCP 工具', completed: '已调用 MCP 工具', summary: c => `调用了${withCount(c, '次')} MCP 工具`, enRunning: 'Calling MCP tool', enCompleted: 'Called MCP tool', enSummary: c => c > 1 ? `Called MCP ${c}x` : 'Called MCP tool' },
  '压缩上下文': { enLabel: 'Compact Context', running: '正在压缩上下文', completed: '已压缩上下文', summary: c => `压缩了${withCount(c, '次')}上下文`, enRunning: 'Compacting context', enCompleted: 'Compacted context', enSummary: c => c > 1 ? `Compacted ${c}x` : 'Compacted context' },
  '工具调用': { enLabel: 'Tool Call', running: '正在执行工具', completed: '已执行工具', summary: c => `调用了${withCount(c, '次')}工具`, enRunning: 'Running tool', enCompleted: 'Ran tool', enSummary: c => `Ran ${plural(c, 'tool', 'tools')}` }
};

const ACTION_PHRASES_BY_EN: Record<string, ActionPhrase> = Object.fromEntries(
  Object.values(ACTION_PHRASES).map(phrase => [phrase.enLabel, phrase])
);

function findActionPhrase(label: string): ActionPhrase | undefined {
  return ACTION_PHRASES[label] ?? ACTION_PHRASES_BY_EN[label];
}

export function summarizeTools(events: TimelineEvent[]) {
  const isEn = getCurrentLocale() === 'en-US';
  const counts = new Map<string, { kind: ToolKind; label: string; count: number }>();
  for (const event of events) {
    if (event.type !== 'tool_call' && event.type !== 'tool_result') continue;
    const presentation = toolPresentation(event.data);
    const key = presentation.kind === 'note'
      ? 'note'
      : presentation.kind === 'mcp'
        ? 'mcp'
        : `action:${presentation.label}`;
    const current = counts.get(key);
    counts.set(key, { kind: presentation.kind, label: presentation.label, count: (current?.count ?? 0) + 1 });
  }
  return [...counts.values()].map(({ kind, label, count }) => {
    if (kind === 'note') return count > 1 ? (isEn ? `Handled ${count} notes` : `处理了 ${count} 次便签`) : label;
    const phrase = findActionPhrase(label);
    if (phrase) return isEn ? phrase.enSummary(count) : phrase.summary(count);
    return isEn ? `Used ${label}${count > 1 ? ` ${count}x` : ''}` : joinZh(`使用了${withCount(count, '次')}`, label);
  }).join(' · ');
}

export function toolActionLabel(presentation: ToolPresentation, terminal: boolean) {
  const isEn = getCurrentLocale() === 'en-US';
  const phrase = findActionPhrase(presentation.label);
  if (phrase) return isEn ? (terminal ? phrase.enCompleted : phrase.enRunning) : (terminal ? phrase.completed : phrase.running);
  if (isEn) {
    if (presentation.kind === 'note') return presentation.label;
    return terminal ? `Ran ${presentation.label}` : `Running ${presentation.label}`;
  }
  const prefix = terminal ? '已' : '正在';
  if (presentation.kind === 'note') return `${prefix}${presentation.label}`;
  return joinZh(`${prefix}调用`, presentation.label);
}

// 耗时计算与格式化统一放在 elapsed.ts；这里保留旧导出，避免时间线调用点大改。
export { elapsedMilliseconds, formatElapsed } from './elapsed';
