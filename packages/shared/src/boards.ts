import type { SessionInterruptIntent, SessionState } from './index.js';

export const boardViewModes = ['lanes', 'grid'] as const;
export type BoardViewMode = (typeof boardViewModes)[number];

export const boardDensities = ['compact', 'comfortable'] as const;
export type BoardDensity = (typeof boardDensities)[number];

/**
 * 列色标严格对齐前端主题已映射暗色模式的色系（zinc / blue / amber / orange / emerald / sky / red），
 * 避免暗色下出现未映射色阶发亮或吞字。
 */
export const boardColumnColors = ['zinc', 'blue', 'amber', 'orange', 'emerald', 'sky', 'red'] as const;
export type BoardColumnColor = (typeof boardColumnColors)[number];

export const boardDropActions = ['none', 'start_plan', 'archive_session', 'prompt_kitten'] as const;
export type BoardDropAction = (typeof boardDropActions)[number];

export const boardEntityKinds = ['task', 'session', 'note'] as const;
export type BoardEntityKind = (typeof boardEntityKinds)[number];

export const boardTaskRuleStates = ['running', 'review', 'needs_user', 'closed', 'plan'] as const;
export type BoardTaskRuleState = (typeof boardTaskRuleStates)[number];

export const boardTemplates = ['status', 'blank', 'project'] as const;
export type BoardTemplate = (typeof boardTemplates)[number];

export const boardActors = ['web', 'cli', 'kitten', 'rule', 'system'] as const;
export type BoardActor = (typeof boardActors)[number];

/**
 * 智能规则列匹配规则（JSON 持久化在 board_columns.rule_json）。
 * - `entityKinds`：限定收入的实体类型（task / session），默认 ['task', 'session']
 * - `taskStates`：便签态过滤（含虚拟态 'plan' 表示 plan=true 且未关闭）
 * - `sessionStates`：会话实时运行态过滤（例如 waiting_for_permission / running_tool / thinking / failed）
 * - `agentIds`：按 Agent ID 过滤
 * - `cwdContains`：按工作目录包含子串过滤（支持按项目聚合）
 * - `source`：按会话来源过滤（如 lark / local / side-chat）
 * - `includeArchived`：是否纳入已归档便签/会话（默认 false）
 * - `maxItems`：该规则列最多展示多少条自动收入项（如「近期完成」限最近 20 条）
 */
export interface BoardColumnRule {
  entityKinds?: Array<'task' | 'session'>;
  taskStates?: BoardTaskRuleState[];
  sessionStates?: SessionState[];
  agentIds?: string[];
  cwdContains?: string;
  source?: string;
  includeArchived?: boolean;
  maxItems?: number;
}

export interface BoardFilter {
  agentId?: string;
  cwd?: string;
  query?: string;
  onlyPinned?: boolean;
  showClosed?: boolean;
}

export interface BoardRecord {
  id: string;
  name: string;
  description: string;
  icon?: string | null;
  isDefault: boolean;
  viewMode: BoardViewMode;
  density: BoardDensity;
  filter: BoardFilter;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

export interface BoardColumnRecord {
  id: string;
  boardId: string;
  name: string;
  color: BoardColumnColor;
  position: string;
  collapsed: boolean;
  wipLimit?: number | null;
  rule?: BoardColumnRule | null;
  onDropAction: BoardDropAction;
  createdAt: string;
  updatedAt: string;
}

export interface BoardItemRecord {
  id: string;
  boardId: string;
  columnId: string;
  entityKind: BoardEntityKind;
  entityId: string;
  position: string;
  pinned: boolean;
  manualOverride: boolean;
  tags: string[];
  userNote?: string | null;
  kittenNote?: string | null;
  kittenNoteAt?: string | null;
  addedBy: BoardActor;
  createdAt: string;
  updatedAt: string;
}

export interface BoardEventRecord {
  seq: number;
  boardId: string;
  eventType: 'board.mutated' | 'task.updated' | 'kitten.state';
  actor: BoardActor;
  clientMutationId?: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** 运行时实时摘要（由 BoardLiveHub 从 Runtime / Assistant / Usage 实时聚合）。 */
export interface BoardItemLiveDigest {
  title: string;
  /** 统一的视觉状态键：与卡片左侧色条、脉冲动画对应。 */
  visualState: 'running' | 'thinking' | 'waiting_approval' | 'needs_user' | 'review' | 'plan' | 'done' | 'failed' | 'user_stopped' | 'idle' | 'note';
  sessionId?: string;
  sessionState?: SessionState;
  interruptIntent?: SessionInterruptIntent | null;
  taskId?: string;
  taskState?: 'running' | 'review' | 'needs_user' | 'closed';
  plan?: boolean;
  outcome?: 'accepted' | 'cancelled';
  round?: number;
  isUserStopped?: boolean;
  stopCount?: number;
  agentId?: string;
  agentName?: string;
  model?: string | null;
  cwd?: string;
  source?: string | null;
  /** 实时单行进度脉搏（例如最新工具调用语义描述 / 权限提示 / 汇报摘要）。 */
  activity?: string;
  activeToolName?: string;
  activeToolInput?: unknown;
  pendingPermissionTitle?: string;
  startedAt?: string;
  runStartedAt?: string;
  completedAt?: string;
  activeMs?: number;
  updatedAt: string;
  doneWhenTotal?: number;
  doneWhenMet?: number;
  latestReviewNote?: string;
  latestReviewVerdict?: 'accepted' | 'rework' | 'needs_user' | 'cancelled';
  totalTokens?: number;
  liveTps?: number | null;
  archived?: boolean;
}

export interface HydratedBoardItem extends BoardItemRecord {
  /** 是否由智能规则实时投影（尚未手动持久化为固定行时为 true，拖曳/置顶/加批注时自动物化）。 */
  virtual?: boolean;
  live: BoardItemLiveDigest;
}

export interface HydratedBoardColumn extends BoardColumnRecord {
  items: HydratedBoardItem[];
}

export interface HydratedBoard {
  board: BoardRecord;
  columns: HydratedBoardColumn[];
  /** 看板级聚合计数，供顶栏与主小猫实时感知。 */
  summary: {
    totalItems: number;
    running: number;
    needsAttention: number;
    review: number;
    done: number;
  };
}

export interface BoardTemplatePayload {
  version: 1;
  name: string;
  description?: string;
  icon?: string | null;
  viewMode: BoardViewMode;
  density: BoardDensity;
  filter?: BoardFilter;
  columns: Array<{
    name: string;
    color: BoardColumnColor;
    collapsed?: boolean;
    wipLimit?: number | null;
    rule?: BoardColumnRule | null;
    onDropAction?: BoardDropAction;
  }>;
  items?: Array<{
    columnName: string;
    entityKind: BoardEntityKind;
    entityId: string;
    pinned?: boolean;
    tags?: string[];
    userNote?: string | null;
  }>;
}

export interface RuntimeActivityEvent {
  sessionId: string;
  kind: 'tool_call' | 'tool_result' | 'permission_request' | 'status' | 'text' | 'thinking';
  state?: SessionState;
  toolName?: string;
  toolInput?: unknown;
  toolStatus?: 'pending' | 'running' | 'completed' | 'failed';
  permissionTitle?: string;
  textPreview?: string;
  timestamp: string;
}

export interface BoardRepository {
  listBoards(includeArchived?: boolean): BoardRecord[];
  getBoard(id: string): BoardRecord | undefined;
  getDefaultBoard(): BoardRecord | undefined;
  saveBoard(board: BoardRecord): void;
  setDefaultBoard(id: string): void;
  bumpRevision(boardId: string): number;
  deleteBoard(id: string): boolean;

  listColumns(boardId: string): BoardColumnRecord[];
  getColumn(id: string): BoardColumnRecord | undefined;
  saveColumn(column: BoardColumnRecord): void;
  deleteColumn(id: string): boolean;

  listItems(boardId: string): BoardItemRecord[];
  getItem(id: string): BoardItemRecord | undefined;
  findItemByEntity(boardId: string, entityKind: BoardEntityKind, entityId: string): BoardItemRecord | undefined;
  saveItem(item: BoardItemRecord): void;
  deleteItem(id: string): boolean;
  deleteItemsByEntity(entityKind: BoardEntityKind, entityId: string): number;

  appendEvent(input: Omit<BoardEventRecord, 'seq'>): BoardEventRecord;
  listEventsSince(afterSeq: number, boardId?: string, limit?: number): BoardEventRecord[];
  transaction<T>(work: () => T): T;
}
