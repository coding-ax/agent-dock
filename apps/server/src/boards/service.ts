import type { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import {
  boardColumnColors,
  boardDensities,
  boardDropActions,
  boardTemplates,
  boardViewModes,
  compareOrderKeys,
  generateKeyBetween,
  generateNKeysBetween,
  makeId,
  now,
  RuntimeError,
  type BoardActor,
  type BoardColumnColor,
  type BoardColumnRecord,
  type BoardColumnRule,
  type BoardDensity,
  type BoardDropAction,
  type BoardEntityKind,
  type BoardFilter,
  type BoardItemLiveDigest,
  type BoardItemRecord,
  type BoardRecord,
  type BoardTemplate,
  type BoardTemplatePayload,
  type BoardViewMode,
  type HydratedBoard,
  type HydratedBoardColumn,
  type HydratedBoardItem,
  type RepositoryBundle,
  type Session
} from '@agent-dock/agent-dock-shared';
import type { AssistantService } from '../assistant/service.js';
import { isUserStopped } from '../assistant/service.js';
import type { AssistantTask, TaskReviewRecord } from '../assistant/types.js';
import { BoardLiveHub } from './live-hub.js';
import {
  buildProjectTemplateColumns,
  DEFAULT_BLANK_COLUMNS,
  DEFAULT_STATUS_COLUMNS,
  isInternalSession,
  matchesColumnRule,
  parseVirtualItemId,
  sessionStateFallbackActivity,
  virtualItemId,
  type ColumnSeedSpec
} from './rules.js';

export interface BoardServiceOptions {
  repos: RepositoryBundle;
  runtime: AgentDockRuntime;
  assistant?: AssistantService;
  throttleMs?: number;
}

export interface CreateBoardInput {
  name: string;
  description?: string;
  icon?: string;
  template?: BoardTemplate;
  viewMode?: BoardViewMode;
  density?: BoardDensity;
  filter?: BoardFilter;
  isDefault?: boolean;
  actor?: BoardActor;
  clientMutationId?: string;
}

export interface UpdateBoardInput {
  name?: string;
  description?: string;
  icon?: string | null;
  viewMode?: BoardViewMode;
  density?: BoardDensity;
  filter?: BoardFilter;
  isDefault?: boolean;
  archived?: boolean;
  actor?: BoardActor;
  clientMutationId?: string;
}

export interface AddColumnInput {
  name: string;
  color?: BoardColumnColor;
  wipLimit?: number | null;
  collapsed?: boolean;
  rule?: BoardColumnRule | null;
  onDropAction?: BoardDropAction;
  beforeColumnId?: string;
  afterColumnId?: string;
  actor?: BoardActor;
  clientMutationId?: string;
}

export interface UpdateColumnInput {
  name?: string;
  color?: BoardColumnColor;
  wipLimit?: number | null;
  collapsed?: boolean;
  rule?: BoardColumnRule | null;
  onDropAction?: BoardDropAction;
  actor?: BoardActor;
  clientMutationId?: string;
}

export interface AddItemInput {
  columnId: string;
  entityKind: BoardEntityKind;
  entityId?: string;
  title?: string;
  pinned?: boolean;
  tags?: string[];
  userNote?: string;
  kittenNote?: string;
  beforeItemId?: string;
  afterItemId?: string;
  placement?: 'top' | 'bottom';
  actor?: BoardActor;
  clientMutationId?: string;
}

export interface MoveItemInput {
  toColumnId: string;
  beforeItemId?: string;
  afterItemId?: string;
  placement?: 'top' | 'bottom';
  applyAction?: boolean;
  expectedRevision?: number;
  actor?: BoardActor;
  clientMutationId?: string;
}

export interface UpdateItemInput {
  pinned?: boolean;
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
  userNote?: string | null;
  kittenNote?: string | null;
  manualOverride?: boolean;
  actor?: BoardActor;
  clientMutationId?: string;
}

const bad = (message: string) => new RuntimeError('INVALID_BOARD_INPUT', message, 400);
const notFound = (code: string, message: string) => new RuntimeError(code, message, 404);

function assertColor(color: string | undefined): BoardColumnColor {
  if (!color) return 'zinc';
  if (!(boardColumnColors as readonly string[]).includes(color)) {
    throw bad(`列色标必须是 ${boardColumnColors.join(' / ')}`);
  }
  return color as BoardColumnColor;
}

function assertViewMode(mode: string | undefined): BoardViewMode {
  if (!mode) return 'lanes';
  if (!(boardViewModes as readonly string[]).includes(mode)) {
    throw bad(`视图模式必须是 ${boardViewModes.join(' / ')}`);
  }
  return mode as BoardViewMode;
}

function assertDensity(density: string | undefined): BoardDensity {
  if (!density) return 'compact';
  if (!(boardDensities as readonly string[]).includes(density)) {
    throw bad(`密度必须是 ${boardDensities.join(' / ')}`);
  }
  return density as BoardDensity;
}

function assertDropAction(action: string | undefined): BoardDropAction {
  if (!action) return 'none';
  if (!(boardDropActions as readonly string[]).includes(action)) {
    throw bad(`落入动作必须是 ${boardDropActions.join(' / ')}`);
  }
  return action as BoardDropAction;
}

function assertTemplate(template: string | undefined): BoardTemplate {
  if (!template) return 'status';
  if (!(boardTemplates as readonly string[]).includes(template)) {
    throw bad(`看板模板必须是 ${boardTemplates.join(' / ')}`);
  }
  return template as BoardTemplate;
}

function normalizeTags(tags?: string[]): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(t => String(t).trim()).filter(Boolean))].slice(0, 12);
}

/** 根据邻居 ID 在有序键数组中安全计算中间排序键（遇到边界倒挂时自动退回兜底计算，确保永不报错）。 */
function computePositionBetween(
  ordered: Array<{ id: string; position: string }>,
  options: { beforeId?: string; afterId?: string; placement?: 'top' | 'bottom' }
): string {
  if (!ordered.length) return generateKeyBetween(null, null);

  if (options.beforeId) {
    const idx = ordered.findIndex(item => item.id === options.beforeId);
    if (idx >= 0) {
      const prev = idx > 0 ? ordered[idx - 1]!.position : null;
      const next = ordered[idx]!.position;
      if (prev === null || prev < next) return generateKeyBetween(prev, next);
    }
  }
  if (options.afterId) {
    const idx = ordered.findIndex(item => item.id === options.afterId);
    if (idx >= 0) {
      const prev = ordered[idx]!.position;
      const next = idx + 1 < ordered.length ? ordered[idx + 1]!.position : null;
      if (next === null || prev < next) return generateKeyBetween(prev, next);
    }
  }
  if (options.placement === 'top') {
    return generateKeyBetween(null, ordered[0]!.position);
  }
  return generateKeyBetween(ordered.at(-1)!.position, null);
}

export class BoardService {
  readonly hub: BoardLiveHub;
  private readonly repos: RepositoryBundle;
  private readonly runtime: AgentDockRuntime;
  private readonly assistant?: AssistantService;

  constructor(options: BoardServiceOptions) {
    this.repos = options.repos;
    this.runtime = options.runtime;
    this.assistant = options.assistant;
    this.hub = new BoardLiveHub(options.runtime, options.throttleMs ?? 300);
  }

  start(): void {
    this.ensureDefaultBoard();
    this.hub.start();
  }

  close(): void {
    this.hub.close();
  }

  /** 首次启动幂等初始化开箱默认「运行状态」看板。 */
  ensureDefaultBoard(): BoardRecord {
    const existing = this.repos.boards.getDefaultBoard();
    if (existing) return existing;
    const stamp = now();
    const board: BoardRecord = {
      id: 'brd_status_default',
      name: '运行状态',
      description: '默认按实时运行状态排布，自由拖出卡片后自动记忆自定义位置',
      icon: 'activity',
      isDefault: true,
      viewMode: 'lanes',
      density: 'compact',
      filter: {},
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null
    };
    this.repos.boards.transaction(() => {
      this.repos.boards.saveBoard(board);
      this.seedColumns(board.id, DEFAULT_STATUS_COLUMNS, stamp);
    });
    return board;
  }

  private seedColumns(boardId: string, specs: readonly ColumnSeedSpec[], stamp = now()): BoardColumnRecord[] {
    const keys = generateNKeysBetween(null, null, specs.length);
    return specs.map((spec, index) => {
      const col: BoardColumnRecord = {
        id: makeId('bcol'),
        boardId,
        name: spec.name,
        color: spec.color,
        position: keys[index]!,
        collapsed: spec.collapsed === true,
        wipLimit: spec.wipLimit ?? null,
        rule: spec.rule ?? null,
        onDropAction: spec.onDropAction ?? 'none',
        createdAt: stamp,
        updatedAt: stamp
      };
      this.repos.boards.saveColumn(col);
      return col;
    });
  }

  private emitMutation(
    boardId: string,
    op: string,
    payload: Record<string, unknown>,
    actor: BoardActor = 'web',
    clientMutationId?: string
  ) {
    const revision = this.repos.boards.bumpRevision(boardId);
    const event = this.repos.boards.appendEvent({
      boardId,
      eventType: 'board.mutated',
      actor,
      clientMutationId: clientMutationId ?? null,
      payload: { op, revision, ...payload },
      createdAt: now()
    });
    this.hub.emitBoardEvent(event);
    return revision;
  }

  listBoards(includeArchived = false): BoardRecord[] {
    this.ensureDefaultBoard();
    return this.repos.boards.listBoards(includeArchived);
  }

  listEventsSince(afterSeq: number, boardId?: string, limit = 100) {
    return this.repos.boards.listEventsSince(afterSeq, boardId, limit);
  }

  resolveBoardId(boardId?: string): string {
    if (boardId?.trim()) return boardId.trim();
    return this.ensureDefaultBoard().id;
  }

  private requireBoard(boardId?: string): BoardRecord {
    const id = this.resolveBoardId(boardId);
    const board = this.repos.boards.getBoard(id);
    if (!board) throw notFound('BOARD_NOT_FOUND', `看板不存在：${id}`);
    return board;
  }

  async createBoard(input: CreateBoardInput): Promise<HydratedBoard> {
    const name = input.name?.trim();
    if (!name) throw bad('看板名称不能为空');
    const template = assertTemplate(input.template);
    const viewMode = assertViewMode(input.viewMode);
    const density = assertDensity(input.density);
    this.ensureDefaultBoard();

    let columnSpecs: readonly ColumnSeedSpec[];
    if (template === 'status') {
      columnSpecs = DEFAULT_STATUS_COLUMNS;
    } else if (template === 'project') {
      const projects = await this.runtime.listProjects();
      const sessions = await this.runtime.listSessions();
      const cwds = [...projects.map(p => p.cwd), ...sessions.map(s => s.cwd)];
      columnSpecs = buildProjectTemplateColumns(cwds);
    } else {
      columnSpecs = DEFAULT_BLANK_COLUMNS;
    }

    const stamp = now();
    const board: BoardRecord = {
      id: makeId('brd'),
      name: name.slice(0, 48),
      description: (input.description ?? '').trim().slice(0, 200),
      icon: input.icon?.trim() || null,
      isDefault: false,
      viewMode,
      density,
      filter: input.filter ?? {},
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null
    };

    this.repos.boards.transaction(() => {
      this.repos.boards.saveBoard(board);
      this.seedColumns(board.id, columnSpecs, stamp);
      if (input.isDefault) this.repos.boards.setDefaultBoard(board.id);
    });

    this.emitMutation(board.id, 'board.created', { name: board.name }, input.actor ?? 'web', input.clientMutationId);
    return this.getHydratedBoard(board.id);
  }

  async updateBoard(boardId: string, input: UpdateBoardInput): Promise<HydratedBoard> {
    const board = this.requireBoard(boardId);
    const updated: BoardRecord = {
      ...board,
      ...(input.name !== undefined ? { name: input.name.trim().slice(0, 48) || board.name } : {}),
      ...(input.description !== undefined ? { description: input.description.trim().slice(0, 200) } : {}),
      ...(input.icon !== undefined ? { icon: input.icon ? input.icon.trim() : null } : {}),
      ...(input.viewMode !== undefined ? { viewMode: assertViewMode(input.viewMode) } : {}),
      ...(input.density !== undefined ? { density: assertDensity(input.density) } : {}),
      ...(input.filter !== undefined ? { filter: input.filter } : {}),
      ...(input.archived !== undefined ? { archivedAt: input.archived ? now() : null } : {}),
      updatedAt: now()
    };
    this.repos.boards.transaction(() => {
      this.repos.boards.saveBoard(updated);
      if (input.isDefault === true) this.repos.boards.setDefaultBoard(updated.id);
    });
    this.emitMutation(updated.id, 'board.updated', { board: updated }, input.actor ?? 'web', input.clientMutationId);
    return this.getHydratedBoard(updated.id);
  }

  async useBoard(boardId: string, actor: BoardActor = 'web', clientMutationId?: string): Promise<HydratedBoard> {
    const board = this.requireBoard(boardId);
    if (board.archivedAt) throw bad('已归档的看板不能设为当前默认看板');
    this.repos.boards.setDefaultBoard(board.id);
    this.emitMutation(board.id, 'board.selected', { defaultBoardId: board.id }, actor, clientMutationId);
    return this.getHydratedBoard(board.id);
  }

  deleteBoard(boardId: string, options: { archive?: boolean; actor?: BoardActor; clientMutationId?: string } = {}): { deleted: boolean; archived?: boolean; id: string } {
    const board = this.requireBoard(boardId);
    const activeBoards = this.repos.boards.listBoards(false);
    if (activeBoards.length <= 1 && activeBoards[0]?.id === board.id) {
      throw new RuntimeError('LAST_BOARD_PROTECTED', '至少需要保留一个活跃看板，无法删除最后一个看板', 409);
    }
    if (options.archive) {
      const updated = { ...board, isDefault: false, archivedAt: now(), updatedAt: now() };
      this.repos.boards.saveBoard(updated);
      if (board.isDefault) {
        const fallback = this.repos.boards.listBoards(false)[0];
        if (fallback) this.repos.boards.setDefaultBoard(fallback.id);
      }
      this.emitMutation(board.id, 'board.archived', { id: board.id }, options.actor ?? 'web', options.clientMutationId);
      return { deleted: false, archived: true, id: board.id };
    }
    const wasDefault = board.isDefault;
    const deleted = this.repos.boards.deleteBoard(board.id);
    if (wasDefault) {
      const fallback = this.repos.boards.listBoards(false)[0];
      if (fallback) this.repos.boards.setDefaultBoard(fallback.id);
    }
    this.hub.broadcast({
      event: 'board.mutated',
      data: { boardId: board.id, op: 'board.deleted', actor: options.actor ?? 'web', timestamp: now() }
    });
    return { deleted, id: board.id };
  }

  // ---- 列 CRUD ----

  async addColumn(boardId: string, input: AddColumnInput): Promise<{ column: BoardColumnRecord; board: HydratedBoard }> {
    const board = this.requireBoard(boardId);
    const name = input.name?.trim();
    if (!name) throw bad('列名称不能为空');
    const color = assertColor(input.color);
    const onDropAction = assertDropAction(input.onDropAction);
    const columns = this.repos.boards.listColumns(board.id);
    const position = computePositionBetween(columns, {
      beforeId: input.beforeColumnId,
      afterId: input.afterColumnId,
      placement: 'bottom'
    });
    const stamp = now();
    const column: BoardColumnRecord = {
      id: makeId('bcol'),
      boardId: board.id,
      name: name.slice(0, 36),
      color,
      position,
      collapsed: input.collapsed === true,
      wipLimit: input.wipLimit === undefined ? null : (input.wipLimit !== null && input.wipLimit > 0 ? Math.floor(input.wipLimit) : null),
      rule: input.rule ?? null,
      onDropAction,
      createdAt: stamp,
      updatedAt: stamp
    };
    this.repos.boards.saveColumn(column);
    this.emitMutation(board.id, 'column.created', { columnId: column.id, name: column.name }, input.actor ?? 'web', input.clientMutationId);
    if (input.actor === 'kitten') {
      this.hub.emitKittenState({ boardId: board.id, mood: 'tidying', text: `新建了一列「${column.name}」` });
    }
    return { column, board: await this.getHydratedBoard(board.id) };
  }

  async updateColumn(columnId: string, input: UpdateColumnInput): Promise<{ column: BoardColumnRecord; board: HydratedBoard }> {
    const existing = this.repos.boards.getColumn(columnId);
    if (!existing) throw notFound('COLUMN_NOT_FOUND', `列不存在：${columnId}`);
    const updated: BoardColumnRecord = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name.trim().slice(0, 36) || existing.name } : {}),
      ...(input.color !== undefined ? { color: assertColor(input.color) } : {}),
      ...(input.collapsed !== undefined ? { collapsed: Boolean(input.collapsed) } : {}),
      ...(input.wipLimit !== undefined ? { wipLimit: input.wipLimit !== null && input.wipLimit > 0 ? Math.floor(input.wipLimit) : null } : {}),
      ...(input.rule !== undefined ? { rule: input.rule } : {}),
      ...(input.onDropAction !== undefined ? { onDropAction: assertDropAction(input.onDropAction) } : {}),
      updatedAt: now()
    };
    this.repos.boards.saveColumn(updated);
    this.emitMutation(updated.boardId, 'column.updated', { columnId: updated.id }, input.actor ?? 'web', input.clientMutationId);
    return { column: updated, board: await this.getHydratedBoard(updated.boardId) };
  }

  async moveColumn(
    columnId: string,
    input: { beforeColumnId?: string; afterColumnId?: string; index?: number; actor?: BoardActor; clientMutationId?: string }
  ): Promise<{ column: BoardColumnRecord; board: HydratedBoard }> {
    const existing = this.repos.boards.getColumn(columnId);
    if (!existing) throw notFound('COLUMN_NOT_FOUND', `列不存在：${columnId}`);
    const siblings = this.repos.boards.listColumns(existing.boardId).filter(col => col.id !== existing.id);
    let position: string;
    if (input.index !== undefined && Number.isInteger(input.index)) {
      const clamped = Math.max(0, Math.min(siblings.length, input.index));
      const before = clamped > 0 ? siblings[clamped - 1]!.position : null;
      const after = clamped < siblings.length ? siblings[clamped]!.position : null;
      position = generateKeyBetween(before, after);
    } else {
      position = computePositionBetween(siblings, {
        beforeId: input.beforeColumnId,
        afterId: input.afterColumnId
      });
    }
    const updated: BoardColumnRecord = { ...existing, position, updatedAt: now() };
    this.repos.boards.saveColumn(updated);
    this.emitMutation(updated.boardId, 'column.moved', { columnId: updated.id, position }, input.actor ?? 'web', input.clientMutationId);
    return { column: updated, board: await this.getHydratedBoard(updated.boardId) };
  }

  async deleteColumn(
    columnId: string,
    options: { moveCardsTo?: string; actor?: BoardActor; clientMutationId?: string } = {}
  ): Promise<{ deleted: boolean; board: HydratedBoard }> {
    const existing = this.repos.boards.getColumn(columnId);
    if (!existing) throw notFound('COLUMN_NOT_FOUND', `列不存在：${columnId}`);
    const columns = this.repos.boards.listColumns(existing.boardId);
    if (columns.length <= 1) {
      throw new RuntimeError('LAST_COLUMN_PROTECTED', '看板至少需要保留一列', 409);
    }
    const targetColId = options.moveCardsTo?.trim();
    if (targetColId) {
      const target = this.repos.boards.getColumn(targetColId);
      if (!target || target.boardId !== existing.boardId || target.id === existing.id) {
        throw bad(`目标迁移列不合法：${targetColId}`);
      }
    }

    this.repos.boards.transaction(() => {
      if (targetColId) {
        const itemsInSource = this.repos.boards.listItems(existing.boardId).filter(item => item.columnId === existing.id);
        const targetItems = this.repos.boards.listItems(existing.boardId).filter(item => item.columnId === targetColId);
        let tailPos = targetItems.at(-1)?.position ?? null;
        for (const item of itemsInSource) {
          tailPos = generateKeyBetween(tailPos, null);
          this.repos.boards.saveItem({ ...item, columnId: targetColId, position: tailPos, updatedAt: now() });
        }
      }
      this.repos.boards.deleteColumn(existing.id);
    });
    this.emitMutation(existing.boardId, 'column.deleted', { columnId: existing.id, moveCardsTo: targetColId ?? null }, options.actor ?? 'web', options.clientMutationId);
    return { deleted: true, board: await this.getHydratedBoard(existing.boardId) };
  }

  // ---- 卡片 CRUD 与拖拽移动 ----

  private async ensureEntityExists(entityKind: BoardEntityKind, entityId: string): Promise<void> {
    if (entityKind === 'note') return;
    if (entityKind === 'task') {
      const task = this.assistant?.getTask(entityId);
      if (!task) throw notFound('TASK_NOT_FOUND', `便签事项不存在：${entityId}`);
      return;
    }
    const session = await this.runtime.getSession(entityId);
    if (!session) throw notFound('SESSION_NOT_FOUND', `会话不存在：${entityId}`);
  }

  async addItem(boardId: string, input: AddItemInput): Promise<{ item: BoardItemRecord; board: HydratedBoard }> {
    const board = this.requireBoard(boardId);
    const column = this.repos.boards.getColumn(input.columnId);
    if (!column || column.boardId !== board.id) throw notFound('COLUMN_NOT_FOUND', `列不存在：${input.columnId}`);

    const entityKind = input.entityKind;
    if (entityKind !== 'task' && entityKind !== 'session' && entityKind !== 'note') {
      throw bad('entityKind 必须是 task、session 或 note');
    }

    let entityId = input.entityId?.trim() || '';
    let userNote = input.userNote?.trim() || null;
    if (entityKind === 'note') {
      if (!entityId) entityId = makeId('bnote');
      if (!userNote && input.title?.trim()) userNote = input.title.trim();
      if (!userNote) throw bad('纯文字卡片必须提供 title 或 userNote');
    } else {
      if (!entityId) throw bad(`entityKind=${entityKind} 时必须提供 entityId`);
      await this.ensureEntityExists(entityKind, entityId);
    }

    const colItems = this.repos.boards.listItems(board.id).filter(item => item.columnId === column.id);
    const position = computePositionBetween(colItems, {
      beforeId: input.beforeItemId,
      afterId: input.afterItemId,
      placement: input.placement ?? (input.pinned ? 'top' : 'bottom')
    });

    const existing = this.repos.boards.findItemByEntity(board.id, entityKind, entityId);
    const stamp = now();
    const item: BoardItemRecord = existing
      ? {
          ...existing,
          columnId: column.id,
          position,
          pinned: input.pinned ?? existing.pinned,
          manualOverride: true,
          tags: input.tags ? normalizeTags(input.tags) : existing.tags,
          ...(userNote !== null ? { userNote } : {}),
          ...(input.kittenNote !== undefined ? { kittenNote: input.kittenNote.trim() || null, kittenNoteAt: stamp } : {}),
          updatedAt: stamp
        }
      : {
          id: makeId('bitem'),
          boardId: board.id,
          columnId: column.id,
          entityKind,
          entityId,
          position,
          pinned: input.pinned === true,
          manualOverride: true,
          tags: normalizeTags(input.tags),
          userNote,
          kittenNote: input.kittenNote?.trim() || null,
          kittenNoteAt: input.kittenNote?.trim() ? stamp : null,
          addedBy: input.actor ?? 'web',
          createdAt: stamp,
          updatedAt: stamp
        };

    this.repos.boards.saveItem(item);
    this.emitMutation(board.id, 'item.added', { itemId: item.id, columnId: item.columnId, entityKind, entityId }, input.actor ?? 'web', input.clientMutationId);
    return { item, board: await this.getHydratedBoard(board.id) };
  }

  /** 将虚拟规则卡片或已持久化卡片统一解析为持久化行。 */
  private resolveOrMaterializeItem(boardId: string, itemId: string, fallbackColumnId: string, actor: BoardActor): BoardItemRecord {
    const existing = this.repos.boards.getItem(itemId);
    if (existing) {
      if (existing.boardId !== boardId) throw notFound('ITEM_NOT_FOUND', `卡片不属于该看板：${itemId}`);
      return existing;
    }
    const virtual = parseVirtualItemId(itemId);
    if (virtual && virtual.boardId === boardId) {
      const persisted = this.repos.boards.findItemByEntity(boardId, virtual.entityKind, virtual.entityId);
      if (persisted) return persisted;
      const stamp = now();
      const created: BoardItemRecord = {
        id: makeId('bitem'),
        boardId,
        columnId: fallbackColumnId,
        entityKind: virtual.entityKind,
        entityId: virtual.entityId,
        position: generateKeyBetween(null, null),
        pinned: false,
        manualOverride: false,
        tags: [],
        userNote: null,
        kittenNote: null,
        kittenNoteAt: null,
        addedBy: actor,
        createdAt: stamp,
        updatedAt: stamp
      };
      this.repos.boards.saveItem(created);
      return created;
    }
    throw notFound('ITEM_NOT_FOUND', `卡片不存在：${itemId}`);
  }

  async moveItem(boardId: string, itemId: string, input: MoveItemInput): Promise<{ item: BoardItemRecord; actionApplied?: string; board: HydratedBoard }> {
    const board = this.requireBoard(boardId);
    const targetCol = this.repos.boards.getColumn(input.toColumnId);
    if (!targetCol || targetCol.boardId !== board.id) {
      throw notFound('COLUMN_NOT_FOUND', `目标列不存在：${input.toColumnId}`);
    }

    const actor = input.actor ?? 'web';
    // 先取当前 hydrated 视图作为同列相邻排序基准，确保拖入虚拟卡片之间也能精准落位！
    const hydratedBefore = await this.getHydratedBoard(board.id);
    const targetHydratedCol = hydratedBefore.columns.find(col => col.id === targetCol.id);
    const item = this.resolveOrMaterializeItem(board.id, itemId, targetCol.id, actor);

    // 物化相邻参考点，避免 beforeItemId / afterItemId 指向尚未落库的虚拟卡片。
    const colOrdered: Array<{ id: string; position: string }> = [];
    for (const entry of targetHydratedCol?.items ?? []) {
      if (entry.id === item.id || entry.id === itemId) continue;
      if (entry.virtual) {
        const mat = this.resolveOrMaterializeItem(board.id, entry.id, targetCol.id, 'rule');
        const nextPos = colOrdered.length ? generateKeyBetween(colOrdered.at(-1)!.position, null) : generateKeyBetween(null, null);
        const saved = { ...mat, columnId: targetCol.id, position: nextPos, updatedAt: now() };
        this.repos.boards.saveItem(saved);
        colOrdered.push({ id: entry.id, position: saved.position });
      } else {
        colOrdered.push({ id: entry.id, position: entry.position });
      }
    }

    const position = computePositionBetween(colOrdered, {
      beforeId: input.beforeItemId,
      afterId: input.afterItemId,
      placement: input.placement
    });

    // 判断目标列规则是否本来就匹配当前卡片：若跨到其他列，则打 manualOverride=true 防止被规则列吸回！
    const movedIntoRuleMatchingCol = targetCol.rule ? await this.doesEntityMatchRule(item.entityKind, item.entityId, targetCol.rule) : false;
    const manualOverride = !movedIntoRuleMatchingCol;

    const updated: BoardItemRecord = {
      ...item,
      columnId: targetCol.id,
      position,
      manualOverride,
      updatedAt: now()
    };
    this.repos.boards.saveItem(updated);

    let actionApplied: string | undefined;
    if (input.applyAction !== false && targetCol.onDropAction !== 'none') {
      actionApplied = await this.maybeRunDropAction(targetCol.onDropAction, updated, input.applyAction === true);
    }

    this.emitMutation(
      board.id,
      'item.moved',
      { itemId: updated.id, toColumnId: updated.columnId, position: updated.position, ...(actionApplied ? { actionApplied } : {}) },
      actor,
      input.clientMutationId
    );
    if (actor === 'kitten') {
      this.hub.emitKittenState({ boardId: board.id, mood: 'tidying', text: `已将卡片整理到「${targetCol.name}」`, cardIds: [updated.id] });
    }
    return { item: updated, ...(actionApplied ? { actionApplied } : {}), board: await this.getHydratedBoard(board.id) };
  }

  private async maybeRunDropAction(action: BoardDropAction, item: BoardItemRecord, explicitForce: boolean): Promise<string | undefined> {
    if (action === 'start_plan' && item.entityKind === 'task' && this.assistant) {
      const task = this.assistant.getTask(item.entityId);
      if (task?.plan && task.state !== 'closed') {
        await this.assistant.startPlannedTask(task.id);
        return 'start_plan';
      }
    }
    if (action === 'archive_session' && explicitForce && item.entityKind === 'session') {
      await this.assistant?.assertSessionArchivable(item.entityId);
      await this.runtime.archive(item.entityId);
      return 'archive_session';
    }
    return undefined;
  }

  private async doesEntityMatchRule(kind: BoardEntityKind, entityId: string, rule: BoardColumnRule): Promise<boolean> {
    if (kind === 'note') return false;
    if (kind === 'task') {
      const task = this.assistant?.getTask(entityId);
      if (!task) return false;
      const session = task.sessionId ? await this.runtime.getSession(task.sessionId) : undefined;
      return matchesColumnRule(rule, { entityKind: 'task', task, session });
    }
    const session = await this.runtime.getSession(entityId);
    if (!session) return false;
    return matchesColumnRule(rule, { entityKind: 'session', session });
  }

  async batchMoveItems(
    boardId: string,
    input: { itemIds: string[]; toColumnId: string; pin?: boolean; applyAction?: boolean; actor?: BoardActor; clientMutationId?: string }
  ): Promise<{ moved: BoardItemRecord[]; board: HydratedBoard }> {
    if (!input.itemIds?.length) throw bad('itemIds 不能为空');
    const moved: BoardItemRecord[] = [];
    for (const id of input.itemIds) {
      const result = await this.moveItem(boardId, id, {
        toColumnId: input.toColumnId,
        applyAction: input.applyAction,
        actor: input.actor,
        clientMutationId: input.clientMutationId
      });
      if (input.pin !== undefined && result.item.pinned !== input.pin) {
        const pinnedItem = { ...result.item, pinned: input.pin, updatedAt: now() };
        this.repos.boards.saveItem(pinnedItem);
        moved.push(pinnedItem);
      } else {
        moved.push(result.item);
      }
    }
    return { moved, board: await this.getHydratedBoard(boardId) };
  }

  async updateItem(boardId: string, itemId: string, input: UpdateItemInput): Promise<{ item: BoardItemRecord; board: HydratedBoard }> {
    const board = this.requireBoard(boardId);
    const hydrated = await this.getHydratedBoard(board.id);
    const currentColId = hydrated.columns.find(col => col.items.some(i => i.id === itemId))?.id ?? hydrated.columns[0]?.id;
    if (!currentColId) throw notFound('COLUMN_NOT_FOUND', '看板没有可用列');

    const existing = this.resolveOrMaterializeItem(board.id, itemId, currentColId, input.actor ?? 'web');
    let nextTags = input.tags !== undefined ? normalizeTags(input.tags) : [...existing.tags];
    if (input.addTags?.length) nextTags = normalizeTags([...nextTags, ...input.addTags]);
    if (input.removeTags?.length) {
      const removeSet = new Set(input.removeTags.map(t => t.trim()));
      nextTags = nextTags.filter(t => !removeSet.has(t));
    }

    const stamp = now();
    const updated: BoardItemRecord = {
      ...existing,
      ...(input.pinned !== undefined ? { pinned: Boolean(input.pinned) } : {}),
      ...(input.manualOverride !== undefined ? { manualOverride: Boolean(input.manualOverride) } : {}),
      tags: nextTags,
      ...(input.userNote !== undefined ? { userNote: input.userNote ? input.userNote.trim() : null } : {}),
      ...(input.kittenNote !== undefined ? { kittenNote: input.kittenNote ? input.kittenNote.trim() : null, kittenNoteAt: input.kittenNote?.trim() ? stamp : null } : {}),
      updatedAt: stamp
    };
    this.repos.boards.saveItem(updated);
    this.emitMutation(board.id, 'item.updated', { itemId: updated.id }, input.actor ?? 'web', input.clientMutationId);
    return { item: updated, board: await this.getHydratedBoard(board.id) };
  }

  async removeItem(boardId: string, itemId: string, actor: BoardActor = 'web', clientMutationId?: string): Promise<{ removed: boolean; board: HydratedBoard }> {
    const board = this.requireBoard(boardId);
    const removed = this.repos.boards.deleteItem(itemId);
    this.emitMutation(board.id, 'item.removed', { itemId }, actor, clientMutationId);
    return { removed, board: await this.getHydratedBoard(board.id) };
  }

  // ---- 导出 / 导入模板 ----

  async exportBoard(boardId?: string, includeItems = false): Promise<BoardTemplatePayload> {
    const hydrated = await this.getHydratedBoard(boardId);
    const payload: BoardTemplatePayload = {
      version: 1,
      name: hydrated.board.name,
      ...(hydrated.board.description ? { description: hydrated.board.description } : {}),
      ...(hydrated.board.icon ? { icon: hydrated.board.icon } : {}),
      viewMode: hydrated.board.viewMode,
      density: hydrated.board.density,
      ...(Object.keys(hydrated.board.filter).length ? { filter: hydrated.board.filter } : {}),
      columns: hydrated.columns.map(col => ({
        name: col.name,
        color: col.color,
        ...(col.collapsed ? { collapsed: true } : {}),
        ...(col.wipLimit ? { wipLimit: col.wipLimit } : {}),
        ...(col.rule ? { rule: col.rule } : {}),
        ...(col.onDropAction !== 'none' ? { onDropAction: col.onDropAction } : {})
      }))
    };
    if (includeItems) {
      payload.items = hydrated.columns.flatMap(col =>
        col.items.filter(item => !item.virtual).map(item => ({
          columnName: col.name,
          entityKind: item.entityKind,
          entityId: item.entityId,
          ...(item.pinned ? { pinned: true } : {}),
          ...(item.tags.length ? { tags: item.tags } : {}),
          ...(item.userNote ? { userNote: item.userNote } : {})
        }))
      );
    }
    return payload;
  }

  async importBoard(raw: unknown, options: { nameOverride?: string; isDefault?: boolean; actor?: BoardActor } = {}): Promise<HydratedBoard> {
    if (!raw || typeof raw !== 'object') throw bad('导入模板必须是 JSON 对象');
    const tpl = raw as Partial<BoardTemplatePayload>;
    const name = (options.nameOverride ?? tpl.name ?? '').trim();
    if (!name) throw bad('模板缺少看板名称 name');
    if (!Array.isArray(tpl.columns) || !tpl.columns.length) throw bad('模板至少需要定义一列 columns');

    const specs: ColumnSeedSpec[] = tpl.columns.map(col => ({
      name: String(col?.name ?? '').trim() || '未命名列',
      color: assertColor(col?.color),
      collapsed: col?.collapsed === true,
      wipLimit: typeof col?.wipLimit === 'number' && col.wipLimit > 0 ? Math.floor(col.wipLimit) : null,
      rule: col?.rule ?? null,
      onDropAction: assertDropAction(col?.onDropAction)
    }));

    const stamp = now();
    const board: BoardRecord = {
      id: makeId('brd'),
      name: name.slice(0, 48),
      description: String(tpl.description ?? '').trim().slice(0, 200),
      icon: typeof tpl.icon === 'string' && tpl.icon.trim() ? tpl.icon.trim() : null,
      isDefault: false,
      viewMode: assertViewMode(tpl.viewMode),
      density: assertDensity(tpl.density),
      filter: (tpl.filter && typeof tpl.filter === 'object') ? tpl.filter : {},
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null
    };

    const createdCols = this.repos.boards.transaction(() => {
      this.repos.boards.saveBoard(board);
      const cols = this.seedColumns(board.id, specs, stamp);
      if (options.isDefault) this.repos.boards.setDefaultBoard(board.id);
      return cols;
    });

    if (Array.isArray(tpl.items) && tpl.items.length) {
      const colByName = new Map(createdCols.map(c => [c.name, c.id]));
      const fallbackColId = createdCols[0]!.id;
      for (const item of tpl.items) {
        const colId = colByName.get(item.columnName) ?? fallbackColId;
        try {
          await this.addItem(board.id, {
            columnId: colId,
            entityKind: item.entityKind,
            entityId: item.entityId,
            pinned: item.pinned,
            tags: item.tags,
            userNote: item.userNote ?? undefined,
            actor: options.actor ?? 'cli'
          });
        } catch {
          /* 导入的外部任务/会话若在当前实例不存在则优雅跳过 */
        }
      }
    }

    this.emitMutation(board.id, 'board.imported', { name: board.name }, options.actor ?? 'cli');
    return this.getHydratedBoard(board.id);
  }

  // ---- 主小猫联动：拖卡/多选 @小猫 ----

  async askKitten(
    boardId: string | undefined,
    input: { itemIds?: string[]; prompt: string; actor?: BoardActor }
  ): Promise<{ dispatched: true; mainSessionId: string; taskId: string; referencedCards: number }> {
    const prompt = input.prompt?.trim();
    if (!prompt) throw bad('指令内容 prompt 不能为空');
    const mainId = this.assistant?.mainSessionId;
    if (!mainId) throw new RuntimeError('NO_MAIN_SESSION', '还没有认领主小猫，请先认领一只主会话小猫', 409);

    const hydrated = await this.getHydratedBoard(boardId);
    const allItems = hydrated.columns.flatMap(col => col.items.map(item => ({ col, item })));
    const selectedIds = new Set((input.itemIds ?? []).map(id => id.trim()).filter(Boolean));
    const matched = selectedIds.size
      ? allItems.filter(entry => selectedIds.has(entry.item.id) || selectedIds.has(entry.item.entityId))
      : [];

    const cardContextLines = matched.map(({ col, item }) => {
      const ref = item.entityKind === 'task'
        ? `${item.entityId}${item.live.sessionId ? ` / ${item.live.sessionId}` : ''}`
        : item.entityKind === 'session'
          ? item.entityId
          : item.id;
      const activity = item.live.activity ? ` · 当前：${item.live.activity}` : '';
      return `- [${ref}]「${item.live.title}」（看板「${hydrated.board.name}」/ 列「${col.name}」/ 状态：${item.live.visualState}${activity}）`;
    });

    const visiblePrompt = matched.length
      ? `${matched.map(({ item }) => `@[${item.live.title}]`).join(' ')}\n${prompt}`
      : `[看板：${hydrated.board.name}] ${prompt}`;

    const agentPrompt = [
      `<agentdock-board-action boardId="${hydrated.board.id}" boardName="${hydrated.board.name}">`,
      matched.length
        ? `用户在看板「${hydrated.board.name}」（${hydrated.board.id}）中选中/拖入了 ${matched.length} 张卡片交给你处理：`
        : `用户在看板「${hydrated.board.name}」（${hydrated.board.id}）底部指令框向你发出了指令：`,
      ...cardContextLines,
      '提示：你可以用 `agent-dock board` 系列命令帮用户建列、挪卡、置顶、写批注（`card update --kitten-note`），也可以对便签执行 `task review` / `task append` / `task start`。',
      '</agentdock-board-action>',
      '',
      prompt
    ].join('\n');

    const task = await this.runtime.dispatch(mainId, visiblePrompt, 'queue', agentPrompt, undefined, 'board-mention');
    this.hub.emitKittenState({
      boardId: hydrated.board.id,
      mood: 'thinking',
      text: matched.length ? `收到！正在看这 ${matched.length} 张卡片…` : '收到看板指令，马上处理！',
      cardIds: matched.map(({ item }) => item.id)
    });
    return { dispatched: true, mainSessionId: mainId, taskId: task.id, referencedCards: matched.length };
  }

  // ---- 看板水合投影（Hydration） ----

  async getHydratedBoard(boardId?: string): Promise<HydratedBoard> {
    const board = this.requireBoard(boardId);
    const columns = this.repos.boards.listColumns(board.id);
    const persistedItems = this.repos.boards.listItems(board.id);

    const [sessions, agents] = await Promise.all([
      this.runtime.listSessions(),
      this.runtime.listAgents(true)
    ]);
    const agentNames = new Map(agents.map(a => [a.id, a.name]));
    const sessionById = new Map(sessions.map(s => [s.id, s]));
    const tasks = this.assistant?.listTasks() ?? [];
    const taskById = new Map(tasks.map(t => [t.id, t]));
    const taskSessionIds = new Set(tasks.map(t => t.sessionId).filter((id): id is string => Boolean(id)));
    const mainSessionId = this.assistant?.mainSessionId;

    // 批量查最近验收记录与累计 token（内存轻聚合，避免重 IO）
    const latestReviewByTask = new Map<string, TaskReviewRecord>();
    if (this.assistant) {
      for (const task of tasks) {
        if (task.archivedAt) continue;
        const reviews = this.assistant.listReviews(task.id);
        if (reviews.length) latestReviewByTask.set(task.id, reviews.at(-1)!);
      }
    }

    const buildLiveDigest = (
      entityKind: BoardEntityKind,
      entityId: string,
      userNote?: string | null
    ): BoardItemLiveDigest | undefined => {
      if (entityKind === 'note') {
        const text = (userNote ?? '').trim() || '便签卡片';
        const firstLine = text.split('\n')[0]!.slice(0, 80);
        return {
          title: firstLine,
          visualState: 'note',
          activity: text.includes('\n') ? text.split('\n').slice(1).join(' ').trim().slice(0, 96) : undefined,
          updatedAt: now()
        };
      }
      if (entityKind === 'task') {
        const task = taskById.get(entityId);
        if (!task) return undefined;
        const session = task.sessionId ? sessionById.get(task.sessionId) : undefined;
        const liveSnap = task.sessionId ? this.hub.getSnapshot(task.sessionId) : undefined;
        const review = latestReviewByTask.get(task.id);
        const userStopped = isUserStopped(task);
        const visualState = resolveTaskVisualState(task, session, userStopped);
        const activity = liveSnap?.activity
          ?? (task.plan && task.state !== 'closed'
            ? '计划卡等待你点头开工'
            : userStopped
              ? `用户已停止（${task.stopCount ?? 1} 次）`
              : task.state === 'review'
                ? '已汇报完成，等待主小猫验收'
                : task.state === 'closed'
                  ? (task.outcome === 'cancelled' ? '已取消' : (review?.note?.slice(0, 76) || '已验收通过'))
                  : session
                    ? sessionStateFallbackActivity(session.state, session.error)
                    : task.notes.trim().slice(0, 76) || '进行中');

        const doneWhenMet = review
          ? review.checks.filter(c => c.met).length
          : (task.state === 'closed' && task.outcome === 'accepted' ? task.doneWhen.length : 0);

        return {
          title: task.title,
          visualState,
          ...(task.sessionId ? { sessionId: task.sessionId } : {}),
          ...(session ? { sessionState: session.state, interruptIntent: session.interruptIntent ?? null } : {}),
          taskId: task.id,
          taskState: task.state,
          plan: task.plan,
          ...(task.outcome ? { outcome: task.outcome } : {}),
          round: task.round,
          isUserStopped: userStopped,
          stopCount: task.stopCount ?? 0,
          agentId: task.agentId ?? session?.agentId,
          agentName: agentNames.get(task.agentId ?? session?.agentId ?? '') ?? (task.agentId ?? session?.agentId),
          model: task.model ?? session?.model ?? null,
          cwd: task.cwd ?? session?.cwd,
          source: session?.source ?? 'assistant-task',
          activity,
          ...(liveSnap?.activeToolName ? { activeToolName: liveSnap.activeToolName } : {}),
          ...(liveSnap?.activeToolInput !== undefined ? { activeToolInput: liveSnap.activeToolInput } : {}),
          ...(liveSnap?.pendingPermissionTitle ? { pendingPermissionTitle: liveSnap.pendingPermissionTitle } : {}),
          ...(task.startedAt ? { startedAt: task.startedAt } : {}),
          ...(task.runStartedAt ? { runStartedAt: task.runStartedAt } : {}),
          ...(task.completedAt ? { completedAt: task.completedAt } : {}),
          ...(task.activeMs !== undefined ? { activeMs: task.activeMs } : {}),
          updatedAt: session && session.updatedAt > task.updatedAt ? session.updatedAt : task.updatedAt,
          doneWhenTotal: task.doneWhen.length,
          doneWhenMet,
          ...(review?.note ? { latestReviewNote: review.note } : {}),
          ...(review?.verdict ? { latestReviewVerdict: review.verdict } : {}),
          archived: Boolean(task.archivedAt)
        };
      }

      const session = sessionById.get(entityId);
      if (!session) return undefined;
      const liveSnap = this.hub.getSnapshot(session.id);
      const visualState = resolveSessionVisualState(session);
      const activity = liveSnap?.activity ?? sessionStateFallbackActivity(session.state, session.error);
      return {
        title: session.title?.trim() || session.customTitle?.trim() || session.agentTitle?.trim() || `${agentNames.get(session.agentId) ?? session.agentId} 会话`,
        visualState,
        sessionId: session.id,
        sessionState: session.state,
        interruptIntent: session.interruptIntent ?? null,
        agentId: session.agentId,
        agentName: agentNames.get(session.agentId) ?? session.agentId,
        model: session.model ?? null,
        cwd: session.cwd,
        source: session.source ?? 'local',
        activity,
        ...(liveSnap?.activeToolName ? { activeToolName: liveSnap.activeToolName } : {}),
        ...(liveSnap?.activeToolInput !== undefined ? { activeToolInput: liveSnap.activeToolInput } : {}),
        ...(liveSnap?.pendingPermissionTitle ? { pendingPermissionTitle: liveSnap.pendingPermissionTitle } : {}),
        startedAt: session.createdAt,
        updatedAt: session.lastMessageAt ?? session.updatedAt,
        archived: Boolean(session.archivedAt)
      };
    };

    const columnBuckets = new Map<string, HydratedBoardItem[]>(columns.map(col => [col.id, []]));
    const placedEntities = new Set<string>();
    const persistedByEntity = new Map<string, BoardItemRecord>();
    for (const item of persistedItems) {
      persistedByEntity.set(`${item.entityKind}:${item.entityId}`, item);
    }

    // 第一步：放置「用户手动固定（manualOverride=true）」以及处于纯手动列中的持久化卡片。
    const colById = new Map(columns.map(c => [c.id, c]));
    for (const item of persistedItems) {
      const col = colById.get(item.columnId);
      if (!col) continue;
      // 若卡片留在某规则列且未手动覆盖（manualOverride=false），则让规则引擎按最新实时状态重新归列（但保留 pinned/tags/kittenNote）。
      if (col.rule && !item.manualOverride) continue;
      const live = buildLiveDigest(item.entityKind, item.entityId, item.userNote);
      if (!live) continue;
      columnBuckets.get(col.id)!.push({ ...item, live });
      placedEntities.add(`${item.entityKind}:${item.entityId}`);
    }

    // 第二步：为带智能规则的列自动收入未手动覆盖的候选便签与普通会话。
    const ruleColumns = columns.filter(col => Boolean(col.rule));
    if (ruleColumns.length) {
      const candidates: Array<{
        entityKind: 'task' | 'session';
        entityId: string;
        task?: AssistantTask;
        session?: Session;
        sortKey: string;
      }> = [];

      for (const task of tasks) {
        if (placedEntities.has(`task:${task.id}`)) continue;
        const session = task.sessionId ? sessionById.get(task.sessionId) : undefined;
        candidates.push({
          entityKind: 'task',
          entityId: task.id,
          task,
          session,
          sortKey: session && session.updatedAt > task.updatedAt ? session.updatedAt : task.updatedAt
        });
      }

      for (const session of sessions) {
        if (session.id === mainSessionId) continue;
        if (taskSessionIds.has(session.id)) continue;
        if (isInternalSession(session)) continue;
        if (placedEntities.has(`session:${session.id}`)) continue;
        candidates.push({
          entityKind: 'session',
          entityId: session.id,
          session,
          sortKey: session.lastMessageAt ?? session.updatedAt
        });
      }

      // 最近活跃在前
      candidates.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

      const ruleAddedCount = new Map<string, number>();
      for (const candidate of candidates) {
        const entityKey = `${candidate.entityKind}:${candidate.entityId}`;
        if (placedEntities.has(entityKey)) continue;
        for (const col of ruleColumns) {
          if (!col.rule || !matchesColumnRule(col.rule, candidate)) continue;
          const count = ruleAddedCount.get(col.id) ?? 0;
          if (col.rule.maxItems && count >= col.rule.maxItems) continue;
          const live = buildLiveDigest(candidate.entityKind, candidate.entityId);
          if (!live) continue;
          const savedMeta = persistedByEntity.get(entityKey);
          const hydratedItem: HydratedBoardItem = savedMeta
            ? { ...savedMeta, columnId: col.id, live }
            : {
                id: virtualItemId(board.id, candidate.entityKind, candidate.entityId),
                boardId: board.id,
                columnId: col.id,
                entityKind: candidate.entityKind,
                entityId: candidate.entityId,
                position: `z${String(999999 - count).padStart(6, '0')}`,
                pinned: Boolean(candidate.session?.pinnedAt),
                manualOverride: false,
                tags: [],
                userNote: null,
                kittenNote: live.latestReviewNote ?? null,
                kittenNoteAt: null,
                addedBy: 'rule',
                createdAt: candidate.task?.createdAt ?? candidate.session?.createdAt ?? now(),
                updatedAt: live.updatedAt,
                virtual: true,
                live
              };
          columnBuckets.get(col.id)!.push(hydratedItem);
          ruleAddedCount.set(col.id, count + 1);
          placedEntities.add(entityKey);
          break;
        }
      }
    }

    // 排序规则：置顶优先；手动物化卡按 Fractional Indexing 顺序，规则投影卡按最近活动倒序。
    const hydratedColumns: HydratedBoardColumn[] = columns.map(col => {
      const items = columnBuckets.get(col.id) ?? [];
      items.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (!a.virtual && !b.virtual) return compareOrderKeys(a.position, b.position);
        if (!a.virtual && b.virtual) return -1;
        if (a.virtual && !b.virtual) return 1;
        return b.live.updatedAt.localeCompare(a.live.updatedAt);
      });
      return { ...col, items };
    });

    let totalItems = 0;
    let running = 0;
    let needsAttention = 0;
    let review = 0;
    let done = 0;
    for (const col of hydratedColumns) {
      for (const item of col.items) {
        totalItems += 1;
        if (item.live.visualState === 'running' || item.live.visualState === 'thinking') running += 1;
        else if (item.live.visualState === 'waiting_approval' || item.live.visualState === 'needs_user' || item.live.visualState === 'failed' || item.live.visualState === 'plan') needsAttention += 1;
        else if (item.live.visualState === 'review') review += 1;
        else if (item.live.visualState === 'done') done += 1;
      }
    }

    return {
      board,
      columns: hydratedColumns,
      summary: { totalItems, running, needsAttention, review, done }
    };
  }

  /** 为主小猫 <agentdock-context> 生成紧凑看板摘要，使其天然知晓看板结构并能用 CLI 编排。 */
  async snapshotForMainSession(): Promise<string> {
    try {
      const boards = this.listBoards(false);
      const active = await this.getHydratedBoard(boards[0]?.id);
      const colSummary = active.columns.map(col => `${col.name}(${col.items.length}${col.rule ? ',规则' : ',手动'})`).join(' | ');
      return `看板：当前默认「${active.board.name}」（${active.board.id}，共 ${boards.length} 个看板，视图 ${active.board.viewMode}）· 列：${colSummary}`;
    } catch {
      return '';
    }
  }
}

function resolveTaskVisualState(
  task: AssistantTask,
  session: Session | undefined,
  userStopped: boolean
): BoardItemLiveDigest['visualState'] {
  if (task.state === 'closed') return task.outcome === 'cancelled' ? 'user_stopped' : 'done';
  if (task.plan) return 'plan';
  if (session?.state === 'waiting_for_permission') return 'waiting_approval';
  if (userStopped) return 'user_stopped';
  if (task.state === 'needs_user') {
    return task.lastStopReason === 'failed' || task.lastStopReason === 'timeout' ? 'failed' : 'needs_user';
  }
  if (task.state === 'review') return 'review';
  if (session?.state === 'thinking') return 'thinking';
  return 'running';
}

function resolveSessionVisualState(session: Session): BoardItemLiveDigest['visualState'] {
  switch (session.state) {
    case 'waiting_for_permission': return 'waiting_approval';
    case 'running_tool':
    case 'starting':
    case 'interrupting': return 'running';
    case 'thinking': return 'thinking';
    case 'failed': return 'failed';
    case 'interrupted': return session.interruptIntent === 'user' ? 'user_stopped' : 'failed';
    case 'completed': return 'done';
    case 'idle': return session.error ? 'failed' : 'idle';
    default: return 'idle';
  }
}
