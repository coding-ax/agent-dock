import { readFileSync, writeFileSync } from 'node:fs';
import type {
  BoardActor,
  BoardColumnColor,
  BoardColumnRule,
  BoardDensity,
  BoardDropAction,
  BoardRecord,
  BoardTemplate,
  BoardViewMode,
  HydratedBoard
} from '@agent-dock/agent-dock-shared';
import { callDaemon, requireDaemon } from '../session-cli.js';

export interface BoardCommonOptions {
  json?: boolean;
  quiet?: boolean;
  from?: string;
  daemonDir?: string;
}

export interface BoardCreateOptions extends BoardCommonOptions {
  template?: string;
  desc?: string;
  view?: string;
  density?: string;
  default?: boolean;
}

export interface BoardShowOptions extends BoardCommonOptions {
  column?: string;
  state?: string;
  watch?: boolean;
}

export interface BoardUpdateOptions extends BoardCommonOptions {
  name?: string;
  desc?: string;
  view?: string;
  density?: string;
  default?: boolean;
}

export interface BoardDeleteOptions extends BoardCommonOptions {
  archive?: boolean;
}

export interface BoardExportOptions extends BoardCommonOptions {
  file?: string;
  includeItems?: boolean;
}

export interface BoardImportOptions extends BoardCommonOptions {
  name?: string;
  default?: boolean;
}

export interface BoardAskKittenOptions extends BoardCommonOptions {
  cards?: string;
  prompt?: string;
  promptFile?: string;
}

export interface BoardColumnAddOptions extends BoardCommonOptions {
  name?: string;
  color?: string;
  wip?: string;
  collapsed?: boolean;
  rule?: string;
  onDrop?: string;
  before?: string;
  after?: string;
}

export interface BoardColumnUpdateOptions extends BoardCommonOptions {
  name?: string;
  color?: string;
  wip?: string;
  collapsed?: boolean;
  expanded?: boolean;
  rule?: string;
  onDrop?: string;
}

export interface BoardColumnMoveOptions extends BoardCommonOptions {
  before?: string;
  after?: string;
  index?: string;
}

export interface BoardColumnDeleteOptions extends BoardCommonOptions {
  moveCardsTo?: string;
}

export interface BoardCardListOptions extends BoardCommonOptions {
  column?: string;
  kind?: string;
  state?: string;
  agent?: string;
  tag?: string;
  pinned?: boolean;
}

export interface BoardCardAddOptions extends BoardCommonOptions {
  column?: string;
  task?: string;
  session?: string;
  title?: string;
  note?: string;
  kittenNote?: string;
  tag?: string[];
  pin?: boolean;
  top?: boolean;
  bottom?: boolean;
}

export interface BoardCardMoveOptions extends BoardCommonOptions {
  board?: string;
  toColumn?: string;
  before?: string;
  after?: string;
  top?: boolean;
  bottom?: boolean;
  applyAction?: boolean;
}

export interface BoardCardUpdateOptions extends BoardCommonOptions {
  board?: string;
  note?: string;
  kittenNote?: string;
  addTag?: string[];
  removeTag?: string[];
  pin?: boolean;
  unpin?: boolean;
  resetRuleOverride?: boolean;
}

export interface BoardCardRemoveOptions extends BoardCommonOptions {
  board?: string;
}

function detectActor(from?: string): BoardActor {
  return (from?.trim() || process.env.agentdock_session_id?.trim()) ? 'kitten' : 'cli';
}

function parseRuleOption(raw?: string): BoardColumnRule | null | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'clear' || trimmed === 'null' || trimmed === 'none') return null;
  try {
    const parsed = JSON.parse(trimmed) as BoardColumnRule;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--rule 必须是合法 JSON 对象或 clear');
    }
    return parsed;
  } catch (error) {
    throw new Error(`解析 --rule JSON 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseOptionalWip(raw?: string): number | null | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw new Error('--wip 必须是非负整数（0 表示不限制）');
  return n === 0 ? null : n;
}

const STATE_BADGE: Record<string, string> = {
  running: '● 运行中',
  thinking: '◐ 思考中',
  waiting_approval: '✋ 等授权',
  needs_user: '⚡ 需要你',
  review: '🔍 待验收',
  plan: '✎ 计划待开工',
  done: '✓ 已完成',
  failed: '✗ 异常',
  user_stopped: '■ 已停止',
  idle: '○ 就绪',
  note: '▪ 便签'
};

export function formatBoardHuman(hydrated: HydratedBoard, filter?: { column?: string; state?: string }): string {
  const { board, columns, summary } = hydrated;
  const lines = [
    `看板：${board.name}（${board.id}）${board.isDefault ? ' [当前默认]' : ''}  视图=${board.viewMode}  密度=${board.density}  rev=${board.revision}`,
    `总览：共 ${summary.totalItems} 张卡 · 运行中 ${summary.running} · 需关注 ${summary.needsAttention} · 待验收 ${summary.review} · 已完成 ${summary.done}`
  ];

  const colFilter = filter?.column?.trim().toLowerCase();
  const stateFilter = filter?.state?.trim().toLowerCase();

  for (const col of columns) {
    if (colFilter && col.id.toLowerCase() !== colFilter && !col.name.toLowerCase().includes(colFilter)) continue;
    const items = stateFilter
      ? col.items.filter(item => item.live.visualState.toLowerCase() === stateFilter || item.live.taskState?.toLowerCase() === stateFilter)
      : col.items;
    const tag = col.rule ? '规则列' : '手动列';
    const wip = col.wipLimit ? `/${col.wipLimit}` : '';
    lines.push('', `▸ ${col.name} (${items.length}${wip})  [${col.id} · ${tag} · ${col.color}]${col.collapsed ? ' (已折叠)' : ''}`);
    if (!items.length) {
      lines.push('    （空）');
      continue;
    }
    for (const item of items) {
      const badge = STATE_BADGE[item.live.visualState] ?? item.live.visualState;
      const pin = item.pinned ? '📌 ' : '';
      const agent = item.live.agentName ?? item.live.agentId ?? '';
      const ref = item.entityKind === 'note' ? item.id : `${item.entityId}`;
      const tags = item.tags.length ? `  #${item.tags.join(' #')}` : '';
      lines.push(`    ${pin}[${badge}] ${item.live.title}  (${item.id} → ${ref}${agent ? ` · ${agent}` : ''})${tags}`);
      if (item.live.activity) lines.push(`       ↳ ${item.live.activity}`);
      if (item.kittenNote) lines.push(`       🐱 ${item.kittenNote}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function runBoardList(options: BoardCommonOptions & { archived?: boolean } = {}): Promise<string> {
  const qs = options.archived ? '?includeArchived=1' : '';
  const data = await callDaemon<{ boards: BoardRecord[]; defaultBoardId: string | null }>(requireDaemon(options.daemonDir), `/api/boards${qs}`, 'GET');
  if (options.json) return `${JSON.stringify({ ok: true, ...data }, null, 2)}\n`;
  if (options.quiet) return data.boards.map(b => b.id).join('\n') + (data.boards.length ? '\n' : '');
  if (!data.boards.length) return '暂无看板。\n';
  return data.boards.map(b =>
    `${b.isDefault ? '* ' : '  '}${b.id}  ${b.name}  [视图:${b.viewMode} · 密度:${b.density} · rev:${b.revision}]${b.archivedAt ? '  [已归档]' : ''}`
  ).join('\n') + '\n';
}

export async function runBoardCreate(name: string, options: BoardCreateOptions = {}): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('看板名称不能为空');
  const hydrated = await callDaemon<HydratedBoard>(requireDaemon(options.daemonDir), '/api/boards', 'POST', {
    name: trimmed,
    ...(options.desc !== undefined ? { description: options.desc } : {}),
    ...(options.template ? { template: options.template as BoardTemplate } : {}),
    ...(options.view ? { viewMode: options.view as BoardViewMode } : {}),
    ...(options.density ? { density: options.density as BoardDensity } : {}),
    ...(options.default ? { isDefault: true } : {}),
    actor: detectActor(options.from)
  });
  if (options.json) return `${JSON.stringify({ ok: true, ...hydrated }, null, 2)}\n`;
  if (options.quiet) return `${hydrated.board.id}\n`;
  return formatBoardHuman(hydrated);
}

export async function runBoardShow(boardId?: string, options: BoardShowOptions = {}): Promise<string> {
  const target = boardId?.trim() || 'default';
  const state = requireDaemon(options.daemonDir);
  const fetchSnapshot = () => callDaemon<HydratedBoard>(state, `/api/boards/${encodeURIComponent(target)}`, 'GET');

  if (!options.watch) {
    const hydrated = await fetchSnapshot();
    if (options.json) return `${JSON.stringify({ ok: true, ...hydrated }, null, 2)}\n`;
    if (options.quiet) return `${hydrated.board.id}\n`;
    return formatBoardHuman(hydrated, { column: options.column, state: options.state });
  }

  // --watch：订阅 /api/boards/stream 实时刷新终端视图
  const entry = state.webConsoleUrl ?? state.address;
  if (!entry) throw new Error('daemon 未提供本地 API 地址');
  const base = new URL(entry);
  const token = base.searchParams.get('t');
  const initial = await fetchSnapshot();
  const render = (hydrated: HydratedBoard) => {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...hydrated })}\n`);
      return;
    }
    if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(formatBoardHuman(hydrated, { column: options.column, state: options.state }));
    process.stdout.write(`\n[实时盯盘中 · 按 Ctrl-C 退出 · ${new Date().toLocaleTimeString()}]\n`);
  };
  render(initial);

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const streamUrl = new URL(`/api/boards/stream?boardId=${encodeURIComponent(initial.board.id)}`, base.origin);
    const res = await fetch(streamUrl, {
      headers: { ...(token ? { cookie: `agentdock_web=${encodeURIComponent(token)}` } : {}), accept: 'text/event-stream' },
      signal: controller.signal
    });
    if (!res.ok || !res.body) throw new Error(`看板实时流连接失败：HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      let shouldRefresh = false;
      for (const block of blocks) {
        if (block.includes('event: board.mutated') || block.includes('event: card.progress') || block.includes('event: task.updated')) {
          shouldRefresh = true;
        }
      }
      if (shouldRefresh) {
        const next = await fetchSnapshot().catch(() => undefined);
        if (next) render(next);
      }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  return '';
}

export async function runBoardUpdate(boardId: string, options: BoardUpdateOptions = {}): Promise<string> {
  const hydrated = await callDaemon<HydratedBoard>(requireDaemon(options.daemonDir), `/api/boards/${encodeURIComponent(boardId)}`, 'PATCH', {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.desc !== undefined ? { description: options.desc } : {}),
    ...(options.view !== undefined ? { viewMode: options.view as BoardViewMode } : {}),
    ...(options.density !== undefined ? { density: options.density as BoardDensity } : {}),
    ...(options.default ? { isDefault: true } : {}),
    actor: detectActor(options.from)
  });
  if (options.json) return `${JSON.stringify({ ok: true, ...hydrated }, null, 2)}\n`;
  if (options.quiet) return `${hydrated.board.id}\n`;
  return formatBoardHuman(hydrated);
}

export async function runBoardUse(boardId: string, options: BoardCommonOptions = {}): Promise<string> {
  const hydrated = await callDaemon<HydratedBoard>(requireDaemon(options.daemonDir), `/api/boards/${encodeURIComponent(boardId)}/use`, 'POST', {
    actor: detectActor(options.from)
  });
  if (options.json) return `${JSON.stringify({ ok: true, ...hydrated }, null, 2)}\n`;
  if (options.quiet) return `${hydrated.board.id}\n`;
  return `已将「${hydrated.board.name}」（${hydrated.board.id}）设为默认活跃看板。\n`;
}

export async function runBoardDelete(boardId: string, options: BoardDeleteOptions = {}): Promise<string> {
  const qs = options.archive ? '?archive=1' : '';
  const result = await callDaemon<{ deleted: boolean; archived?: boolean; id: string }>(
    requireDaemon(options.daemonDir),
    `/api/boards/${encodeURIComponent(boardId)}${qs}`,
    'DELETE',
    { actor: detectActor(options.from) }
  );
  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  if (options.quiet) return `${result.id}\n`;
  return result.archived ? `已归档看板 ${result.id}\n` : `已删除看板 ${result.id}\n`;
}

export async function runBoardExport(boardId?: string, options: BoardExportOptions = {}): Promise<string> {
  const target = boardId?.trim() || 'default';
  const qs = options.includeItems ? '?includeItems=1' : '';
  const data = await callDaemon<Record<string, unknown>>(requireDaemon(options.daemonDir), `/api/boards/${encodeURIComponent(target)}/export${qs}`, 'GET');
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  if (options.file && options.file !== '-') {
    writeFileSync(options.file, serialized, 'utf8');
    return options.json ? `${JSON.stringify({ ok: true, file: options.file }, null, 2)}\n` : `已导出看板模板到 ${options.file}\n`;
  }
  return serialized;
}

export async function runBoardImport(file: string, options: BoardImportOptions = {}): Promise<string> {
  const raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  let template: unknown;
  try {
    template = JSON.parse(raw);
  } catch (error) {
    throw new Error(`模板 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const hydrated = await callDaemon<HydratedBoard>(requireDaemon(options.daemonDir), '/api/boards/import', 'POST', {
    template,
    ...(options.name ? { name: options.name } : {}),
    ...(options.default ? { isDefault: true } : {}),
    actor: detectActor(options.from)
  });
  if (options.json) return `${JSON.stringify({ ok: true, ...hydrated }, null, 2)}\n`;
  if (options.quiet) return `${hydrated.board.id}\n`;
  return `已导入看板「${hydrated.board.name}」（${hydrated.board.id}），共 ${hydrated.columns.length} 列。\n`;
}

export async function runBoardAskKitten(boardId: string | undefined, options: BoardAskKittenOptions = {}): Promise<string> {
  const target = boardId?.trim() || 'default';
  const prompt = options.promptFile !== undefined
    ? (options.promptFile === '-' ? readFileSync(0, 'utf8') : readFileSync(options.promptFile, 'utf8'))
    : options.prompt;
  if (!prompt?.trim()) throw new Error('请通过 --prompt 或 --prompt-file 提供要交给主小猫的指令');
  const itemIds = (options.cards ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const result = await callDaemon<Record<string, unknown>>(requireDaemon(options.daemonDir), `/api/boards/${encodeURIComponent(target)}/ask-kitten`, 'POST', {
    itemIds,
    prompt: prompt.trim(),
    actor: detectActor(options.from)
  });
  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  return `已将指令派发给主小猫（引用 ${String(result.referencedCards ?? 0)} 张卡片，任务 ${String(result.taskId ?? '')}）。\n`;
}

// ---- 列命令 ----

export async function runBoardColumnList(boardId?: string, options: BoardCommonOptions = {}): Promise<string> {
  const target = boardId?.trim() || 'default';
  const hydrated = await callDaemon<HydratedBoard>(requireDaemon(options.daemonDir), `/api/boards/${encodeURIComponent(target)}`, 'GET');
  if (options.json) return `${JSON.stringify({ ok: true, boardId: hydrated.board.id, columns: hydrated.columns }, null, 2)}\n`;
  if (options.quiet) return hydrated.columns.map(c => c.id).join('\n') + (hydrated.columns.length ? '\n' : '');
  return hydrated.columns.map((c, idx) =>
    `${idx + 1}. ${c.id}  ${c.name}  [${c.color} · ${c.rule ? '规则' : '手动'} · ${c.items.length} 卡${c.wipLimit ? ` / WIP ${c.wipLimit}` : ''}]`
  ).join('\n') + '\n';
}

export async function runBoardColumnAdd(boardId: string | undefined, options: BoardColumnAddOptions = {}): Promise<string> {
  const target = boardId?.trim() || 'default';
  const name = options.name?.trim();
  if (!name) throw new Error('--name 必填');
  const result = await callDaemon<{ column: { id: string; name: string }; board: HydratedBoard }>(
    requireDaemon(options.daemonDir),
    `/api/boards/${encodeURIComponent(target)}/columns`,
    'POST',
    {
      name,
      ...(options.color ? { color: options.color as BoardColumnColor } : {}),
      ...(options.wip !== undefined ? { wipLimit: parseOptionalWip(options.wip) } : {}),
      ...(options.collapsed ? { collapsed: true } : {}),
      ...(options.rule !== undefined ? { rule: parseRuleOption(options.rule) } : {}),
      ...(options.onDrop ? { onDropAction: options.onDrop as BoardDropAction } : {}),
      ...(options.before ? { beforeColumnId: options.before } : {}),
      ...(options.after ? { afterColumnId: options.after } : {}),
      actor: detectActor(options.from)
    }
  );
  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  if (options.quiet) return `${result.column.id}\n`;
  return `已新建列「${result.column.name}」（${result.column.id}）。\n`;
}

export async function runBoardColumnUpdate(colId: string, options: BoardColumnUpdateOptions = {}): Promise<string> {
  const result = await callDaemon<{ column: { id: string; name: string }; board: HydratedBoard }>(
    requireDaemon(options.daemonDir),
    `/api/boards/columns/${encodeURIComponent(colId)}`,
    'PATCH',
    {
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.color !== undefined ? { color: options.color as BoardColumnColor } : {}),
      ...(options.wip !== undefined ? { wipLimit: parseOptionalWip(options.wip) } : {}),
      ...(options.collapsed ? { collapsed: true } : options.expanded ? { collapsed: false } : {}),
      ...(options.rule !== undefined ? { rule: parseRuleOption(options.rule) } : {}),
      ...(options.onDrop !== undefined ? { onDropAction: options.onDrop as BoardDropAction } : {}),
      actor: detectActor(options.from)
    }
  );
  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  if (options.quiet) return `${result.column.id}\n`;
  return `已更新列「${result.column.name}」（${result.column.id}）。\n`;
}

export async function runBoardColumnMove(colId: string, options: BoardColumnMoveOptions = {}): Promise<string> {
  const index = options.index !== undefined ? Number(options.index) : undefined;
  if (index !== undefined && !Number.isInteger(index)) throw new Error('--index 必须是整数');
  const result = await callDaemon<{ column: { id: string; name: string }; board: HydratedBoard }>(
    requireDaemon(options.daemonDir),
    `/api/boards/columns/${encodeURIComponent(colId)}/move`,
    'POST',
    {
      ...(options.before ? { beforeColumnId: options.before } : {}),
      ...(options.after ? { afterColumnId: options.after } : {}),
      ...(index !== undefined ? { index } : {}),
      actor: detectActor(options.from)
    }
  );
  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  return `已调整列「${result.column.name}」位置。\n`;
}

export async function runBoardColumnDelete(colId: string, options: BoardColumnDeleteOptions = {}): Promise<string> {
  const qs = options.moveCardsTo ? `?moveCardsTo=${encodeURIComponent(options.moveCardsTo)}` : '';
  const result = await callDaemon<{ deleted: boolean; board: HydratedBoard }>(
    requireDaemon(options.daemonDir),
    `/api/boards/columns/${encodeURIComponent(colId)}${qs}`,
    'DELETE',
    { actor: detectActor(options.from), ...(options.moveCardsTo ? { moveCardsTo: options.moveCardsTo } : {}) }
  );
  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  return `已删除列 ${colId}。\n`;
}

// ---- 卡片命令 ----

export async function runBoardCardList(boardId?: string, options: BoardCardListOptions = {}): Promise<string> {
  const target = boardId?.trim() || 'default';
  const hydrated = await callDaemon<HydratedBoard>(requireDaemon(options.daemonDir), `/api/boards/${encodeURIComponent(target)}`, 'GET');
  const rows = hydrated.columns.flatMap(col =>
    col.items.map(item => ({ columnId: col.id, columnName: col.name, item }))
  ).filter(({ columnId, columnName, item }) => {
    if (options.column && columnId !== options.column && !columnName.includes(options.column)) return false;
    if (options.kind && item.entityKind !== options.kind) return false;
    if (options.state && item.live.visualState !== options.state && item.live.taskState !== options.state) return false;
    if (options.agent && item.live.agentId !== options.agent) return false;
    if (options.tag && !item.tags.includes(options.tag)) return false;
    if (options.pinned && !item.pinned) return false;
    return true;
  });

  if (options.json) return `${JSON.stringify({ ok: true, boardId: hydrated.board.id, items: rows }, null, 2)}\n`;
  if (options.quiet) return rows.map(r => r.item.id).join('\n') + (rows.length ? '\n' : '');
  if (!rows.length) return '当前筛选条件下没有卡片。\n';
  return rows.map(({ columnName, item }) =>
    `${item.pinned ? '📌 ' : '   '}${item.id}  [${columnName} · ${item.live.visualState}]  ${item.live.title}  (${item.entityKind}:${item.entityId})`
  ).join('\n') + '\n';
}

export async function runBoardCardAdd(boardId: string | undefined, options: BoardCardAddOptions = {}): Promise<string> {
  const target = boardId?.trim() || 'default';
  const columnId = options.column?.trim();
  if (!columnId) throw new Error('--column <col-id> 必填');
  const kindCount = [options.task, options.session, options.title].filter(Boolean).length;
  if (kindCount !== 1) throw new Error('必须且只能指定 --task、--session 或 --title 之一');

  const entityKind = options.task ? 'task' : options.session ? 'session' : 'note';
  const entityId = options.task?.trim() || options.session?.trim() || undefined;
  const result = await callDaemon<{ item: { id: string }; board: HydratedBoard }>(
    requireDaemon(options.daemonDir),
    `/api/boards/${encodeURIComponent(target)}/items`,
    'POST',
    {
      columnId,
      entityKind,
      ...(entityId ? { entityId } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.note ? { userNote: options.note } : {}),
      ...(options.kittenNote ? { kittenNote: options.kittenNote } : {}),
      ...(options.tag?.length ? { tags: options.tag } : {}),
      ...(options.pin ? { pinned: true } : {}),
      ...(options.top ? { placement: 'top' } : options.bottom ? { placement: 'bottom' } : {}),
      actor: detectActor(options.from)
    }
  );
  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  if (options.quiet) return `${result.item.id}\n`;
  return `已添加卡片 ${result.item.id} 到列 ${columnId}。\n`;
}

export async function runBoardCardMove(cardIds: string[], options: BoardCardMoveOptions = {}): Promise<string> {
  if (!cardIds.length) throw new Error('请至少提供一个卡片 ID');
  const toColumnId = options.toColumn?.trim();
  if (!toColumnId) throw new Error('--to-column <col-id> 必填');
  const target = options.board?.trim() || 'default';
  const actor = detectActor(options.from);

  if (cardIds.length === 1) {
    const result = await callDaemon<Record<string, unknown>>(
      requireDaemon(options.daemonDir),
      `/api/boards/${encodeURIComponent(target)}/items/${encodeURIComponent(cardIds[0]!)}/move`,
      'POST',
      {
        toColumnId,
        ...(options.before ? { beforeItemId: options.before } : {}),
        ...(options.after ? { afterItemId: options.after } : {}),
        ...(options.top ? { placement: 'top' } : options.bottom ? { placement: 'bottom' } : {}),
        ...(options.applyAction ? { applyAction: true } : {}),
        actor
      }
    );
    if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
    return `已移动卡片 ${cardIds[0]} 到列 ${toColumnId}。\n`;
  }

  const result = await callDaemon<Record<string, unknown>>(
    requireDaemon(options.daemonDir),
    `/api/boards/${encodeURIComponent(target)}/items/batch`,
    'POST',
    {
      itemIds: cardIds,
      toColumnId,
      ...(options.applyAction ? { applyAction: true } : {}),
      actor
    }
  );
  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  return `已批量移动 ${cardIds.length} 张卡片到列 ${toColumnId}。\n`;
}

export async function runBoardCardUpdate(cardId: string, options: BoardCardUpdateOptions = {}): Promise<string> {
  const target = options.board?.trim() || 'default';
  const result = await callDaemon<{ item: { id: string }; board: HydratedBoard }>(
    requireDaemon(options.daemonDir),
    `/api/boards/${encodeURIComponent(target)}/items/${encodeURIComponent(cardId)}`,
    'PATCH',
    {
      ...(options.pin ? { pinned: true } : options.unpin ? { pinned: false } : {}),
      ...(options.note !== undefined ? { userNote: options.note } : {}),
      ...(options.kittenNote !== undefined ? { kittenNote: options.kittenNote } : {}),
      ...(options.addTag?.length ? { addTags: options.addTag } : {}),
      ...(options.removeTag?.length ? { removeTags: options.removeTag } : {}),
      ...(options.resetRuleOverride ? { manualOverride: false } : {}),
      actor: detectActor(options.from)
    }
  );
  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  if (options.quiet) return `${result.item.id}\n`;
  return `已更新卡片 ${result.item.id}。\n`;
}

export async function runBoardCardRemove(cardIds: string[], options: BoardCardRemoveOptions = {}): Promise<string> {
  if (!cardIds.length) throw new Error('请至少提供一个卡片 ID');
  const target = options.board?.trim() || 'default';
  const state = requireDaemon(options.daemonDir);
  const removed: string[] = [];
  for (const id of cardIds) {
    await callDaemon(state, `/api/boards/${encodeURIComponent(target)}/items/${encodeURIComponent(id)}`, 'DELETE', {
      actor: detectActor(options.from)
    });
    removed.push(id);
  }
  if (options.json) return `${JSON.stringify({ ok: true, removed }, null, 2)}\n`;
  return `已从看板移出 ${removed.length} 张卡片（底层任务与会话保持不变）。\n`;
}
