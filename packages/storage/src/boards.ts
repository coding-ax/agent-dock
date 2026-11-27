import type Database from 'better-sqlite3';
import type {
  BoardActor,
  BoardColumnColor,
  BoardColumnRecord,
  BoardColumnRule,
  BoardDensity,
  BoardDropAction,
  BoardEntityKind,
  BoardEventRecord,
  BoardFilter,
  BoardItemRecord,
  BoardRecord,
  BoardRepository,
  BoardViewMode
} from '@agent-dock/agent-dock-shared';

const MAX_BOARD_EVENTS = 500;

export const BOARD_SCHEMA = `
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    view_mode TEXT NOT NULL DEFAULT 'lanes',
    density TEXT NOT NULL DEFAULT 'compact',
    filter_json TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE TABLE IF NOT EXISTS board_columns (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'zinc',
    position TEXT NOT NULL,
    collapsed INTEGER NOT NULL DEFAULT 0,
    wip_limit INTEGER,
    rule_json TEXT,
    on_drop_action TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS board_columns_board_pos ON board_columns(board_id, position);
  CREATE TABLE IF NOT EXISTS board_items (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    column_id TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    position TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    manual_override INTEGER NOT NULL DEFAULT 0,
    tags_json TEXT NOT NULL DEFAULT '[]',
    user_note TEXT,
    kitten_note TEXT,
    kitten_note_at TEXT,
    added_by TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(board_id, entity_kind, entity_id)
  );
  CREATE INDEX IF NOT EXISTS board_items_col_pos ON board_items(column_id, pinned DESC, position);
  CREATE INDEX IF NOT EXISTS board_items_entity ON board_items(entity_kind, entity_id);
  CREATE TABLE IF NOT EXISTS board_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    client_mutation_id TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS board_events_board_seq ON board_events(board_id, seq);
`;

type BoardRow = {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  is_default: number;
  view_mode: string;
  density: string;
  filter_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type ColumnRow = {
  id: string;
  board_id: string;
  name: string;
  color: string;
  position: string;
  collapsed: number;
  wip_limit: number | null;
  rule_json: string | null;
  on_drop_action: string;
  created_at: string;
  updated_at: string;
};

type ItemRow = {
  id: string;
  board_id: string;
  column_id: string;
  entity_kind: string;
  entity_id: string;
  position: string;
  pinned: number;
  manual_override: number;
  tags_json: string;
  user_note: string | null;
  kitten_note: string | null;
  kitten_note_at: string | null;
  added_by: string;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  seq: number;
  board_id: string;
  event_type: string;
  actor: string;
  client_mutation_id: string | null;
  payload_json: string;
  created_at: string;
};

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function boardFromRow(row: BoardRow): BoardRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    isDefault: row.is_default === 1,
    viewMode: (row.view_mode === 'grid' ? 'grid' : 'lanes') as BoardViewMode,
    density: (row.density === 'comfortable' ? 'comfortable' : 'compact') as BoardDensity,
    filter: parseJson<BoardFilter>(row.filter_json, {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

function columnFromRow(row: ColumnRow): BoardColumnRecord {
  return {
    id: row.id,
    boardId: row.board_id,
    name: row.name,
    color: row.color as BoardColumnColor,
    position: row.position,
    collapsed: row.collapsed === 1,
    wipLimit: row.wip_limit,
    rule: row.rule_json ? parseJson<BoardColumnRule | null>(row.rule_json, null) : null,
    onDropAction: row.on_drop_action as BoardDropAction,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function itemFromRow(row: ItemRow): BoardItemRecord {
  return {
    id: row.id,
    boardId: row.board_id,
    columnId: row.column_id,
    entityKind: row.entity_kind as BoardEntityKind,
    entityId: row.entity_id,
    position: row.position,
    pinned: row.pinned === 1,
    manualOverride: row.manual_override === 1,
    tags: parseJson<string[]>(row.tags_json, []),
    userNote: row.user_note,
    kittenNote: row.kitten_note,
    kittenNoteAt: row.kitten_note_at,
    addedBy: row.added_by as BoardActor,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function eventFromRow(row: EventRow): BoardEventRecord {
  return {
    seq: row.seq,
    boardId: row.board_id,
    eventType: row.event_type as BoardEventRecord['eventType'],
    actor: row.actor as BoardActor,
    clientMutationId: row.client_mutation_id,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    createdAt: row.created_at
  };
}

export function createBoardRepository(sqlite: Database.Database): BoardRepository {
  sqlite.exec(BOARD_SCHEMA);

  const upsertBoard = sqlite.prepare(`
    INSERT INTO boards (id, name, description, icon, is_default, view_mode, density, filter_json, revision, created_at, updated_at, archived_at)
    VALUES (@id, @name, @description, @icon, @isDefault, @viewMode, @density, @filterJson, @revision, @createdAt, @updatedAt, @archivedAt)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      icon = excluded.icon,
      is_default = excluded.is_default,
      view_mode = excluded.view_mode,
      density = excluded.density,
      filter_json = excluded.filter_json,
      revision = excluded.revision,
      updated_at = excluded.updated_at,
      archived_at = excluded.archived_at
  `);

  const upsertColumn = sqlite.prepare(`
    INSERT INTO board_columns (id, board_id, name, color, position, collapsed, wip_limit, rule_json, on_drop_action, created_at, updated_at)
    VALUES (@id, @boardId, @name, @color, @position, @collapsed, @wipLimit, @ruleJson, @onDropAction, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      color = excluded.color,
      position = excluded.position,
      collapsed = excluded.collapsed,
      wip_limit = excluded.wip_limit,
      rule_json = excluded.rule_json,
      on_drop_action = excluded.on_drop_action,
      updated_at = excluded.updated_at
  `);

  const upsertItem = sqlite.prepare(`
    INSERT INTO board_items (id, board_id, column_id, entity_kind, entity_id, position, pinned, manual_override, tags_json, user_note, kitten_note, kitten_note_at, added_by, created_at, updated_at)
    VALUES (@id, @boardId, @columnId, @entityKind, @entityId, @position, @pinned, @manualOverride, @tagsJson, @userNote, @kittenNote, @kittenNoteAt, @addedBy, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      column_id = excluded.column_id,
      position = excluded.position,
      pinned = excluded.pinned,
      manual_override = excluded.manual_override,
      tags_json = excluded.tags_json,
      user_note = excluded.user_note,
      kitten_note = excluded.kitten_note,
      kitten_note_at = excluded.kitten_note_at,
      added_by = excluded.added_by,
      updated_at = excluded.updated_at
  `);

  const insertEvent = sqlite.prepare(`
    INSERT INTO board_events (board_id, event_type, actor, client_mutation_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const pruneEvents = sqlite.prepare(`
    DELETE FROM board_events
    WHERE seq <= (SELECT seq FROM board_events ORDER BY seq DESC LIMIT 1 OFFSET ?)
  `);

  return {
    listBoards(includeArchived = false) {
      const sql = includeArchived
        ? 'SELECT * FROM boards ORDER BY is_default DESC, created_at ASC'
        : 'SELECT * FROM boards WHERE archived_at IS NULL ORDER BY is_default DESC, created_at ASC';
      return (sqlite.prepare(sql).all() as BoardRow[]).map(boardFromRow);
    },

    getBoard(id) {
      const row = sqlite.prepare('SELECT * FROM boards WHERE id = ?').get(id) as BoardRow | undefined;
      return row ? boardFromRow(row) : undefined;
    },

    getDefaultBoard() {
      const row = sqlite.prepare('SELECT * FROM boards WHERE archived_at IS NULL ORDER BY is_default DESC, created_at ASC LIMIT 1').get() as BoardRow | undefined;
      return row ? boardFromRow(row) : undefined;
    },

    saveBoard(board) {
      upsertBoard.run({
        id: board.id,
        name: board.name,
        description: board.description ?? '',
        icon: board.icon ?? null,
        isDefault: board.isDefault ? 1 : 0,
        viewMode: board.viewMode,
        density: board.density,
        filterJson: JSON.stringify(board.filter ?? {}),
        revision: board.revision,
        createdAt: board.createdAt,
        updatedAt: board.updatedAt,
        archivedAt: board.archivedAt ?? null
      });
    },

    setDefaultBoard(id) {
      sqlite.transaction(() => {
        sqlite.prepare('UPDATE boards SET is_default = 0 WHERE is_default = 1 AND id != ?').run(id);
        sqlite.prepare('UPDATE boards SET is_default = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      })();
    },

    bumpRevision(boardId) {
      const updatedAt = new Date().toISOString();
      sqlite.prepare('UPDATE boards SET revision = revision + 1, updated_at = ? WHERE id = ?').run(updatedAt, boardId);
      const row = sqlite.prepare('SELECT revision FROM boards WHERE id = ?').get(boardId) as { revision: number } | undefined;
      return row?.revision ?? 1;
    },

    deleteBoard(id) {
      return sqlite.transaction(() => {
        sqlite.prepare('DELETE FROM board_items WHERE board_id = ?').run(id);
        sqlite.prepare('DELETE FROM board_columns WHERE board_id = ?').run(id);
        sqlite.prepare('DELETE FROM board_events WHERE board_id = ?').run(id);
        return sqlite.prepare('DELETE FROM boards WHERE id = ?').run(id).changes > 0;
      })();
    },

    listColumns(boardId) {
      return (sqlite.prepare('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position ASC, created_at ASC').all(boardId) as ColumnRow[]).map(columnFromRow);
    },

    getColumn(id) {
      const row = sqlite.prepare('SELECT * FROM board_columns WHERE id = ?').get(id) as ColumnRow | undefined;
      return row ? columnFromRow(row) : undefined;
    },

    saveColumn(column) {
      upsertColumn.run({
        id: column.id,
        boardId: column.boardId,
        name: column.name,
        color: column.color,
        position: column.position,
        collapsed: column.collapsed ? 1 : 0,
        wipLimit: column.wipLimit ?? null,
        ruleJson: column.rule ? JSON.stringify(column.rule) : null,
        onDropAction: column.onDropAction,
        createdAt: column.createdAt,
        updatedAt: column.updatedAt
      });
    },

    deleteColumn(id) {
      return sqlite.transaction(() => {
        sqlite.prepare('DELETE FROM board_items WHERE column_id = ?').run(id);
        return sqlite.prepare('DELETE FROM board_columns WHERE id = ?').run(id).changes > 0;
      })();
    },

    listItems(boardId) {
      return (sqlite.prepare('SELECT * FROM board_items WHERE board_id = ? ORDER BY column_id ASC, pinned DESC, position ASC, created_at ASC').all(boardId) as ItemRow[]).map(itemFromRow);
    },

    getItem(id) {
      const row = sqlite.prepare('SELECT * FROM board_items WHERE id = ?').get(id) as ItemRow | undefined;
      return row ? itemFromRow(row) : undefined;
    },

    findItemByEntity(boardId, entityKind, entityId) {
      const row = sqlite.prepare('SELECT * FROM board_items WHERE board_id = ? AND entity_kind = ? AND entity_id = ?').get(boardId, entityKind, entityId) as ItemRow | undefined;
      return row ? itemFromRow(row) : undefined;
    },

    saveItem(item) {
      upsertItem.run({
        id: item.id,
        boardId: item.boardId,
        columnId: item.columnId,
        entityKind: item.entityKind,
        entityId: item.entityId,
        position: item.position,
        pinned: item.pinned ? 1 : 0,
        manualOverride: item.manualOverride ? 1 : 0,
        tagsJson: JSON.stringify(item.tags ?? []),
        userNote: item.userNote ?? null,
        kittenNote: item.kittenNote ?? null,
        kittenNoteAt: item.kittenNoteAt ?? null,
        addedBy: item.addedBy,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      });
    },

    deleteItem(id) {
      return sqlite.prepare('DELETE FROM board_items WHERE id = ?').run(id).changes > 0;
    },

    deleteItemsByEntity(entityKind, entityId) {
      return sqlite.prepare('DELETE FROM board_items WHERE entity_kind = ? AND entity_id = ?').run(entityKind, entityId).changes;
    },

    appendEvent(input) {
      const info = insertEvent.run(
        input.boardId,
        input.eventType,
        input.actor,
        input.clientMutationId ?? null,
        JSON.stringify(input.payload ?? {}),
        input.createdAt
      );
      const seq = Number(info.lastInsertRowid);
      // 每 50 条做一次轻量环形裁剪，避免事件表无限增长。
      if (seq % 50 === 0) pruneEvents.run(MAX_BOARD_EVENTS);
      return {
        seq,
        boardId: input.boardId,
        eventType: input.eventType,
        actor: input.actor,
        clientMutationId: input.clientMutationId ?? null,
        payload: input.payload ?? {},
        createdAt: input.createdAt
      };
    },

    listEventsSince(afterSeq, boardId, limit = 200) {
      const rows = boardId
        ? sqlite.prepare('SELECT * FROM board_events WHERE seq > ? AND board_id = ? ORDER BY seq ASC LIMIT ?').all(afterSeq, boardId, limit) as EventRow[]
        : sqlite.prepare('SELECT * FROM board_events WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(afterSeq, limit) as EventRow[];
      return rows.map(eventFromRow);
    },

    transaction<T>(work: () => T): T {
      return sqlite.transaction(work)();
    }
  };
}
