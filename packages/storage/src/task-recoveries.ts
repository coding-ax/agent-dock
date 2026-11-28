import type Database from 'better-sqlite3';
import type {
  TaskRecoveryDecisionSource,
  TaskRecoveryListFilter,
  TaskRecoveryMode,
  TaskRecoveryRecord,
  TaskRecoveryRepository,
  TaskRecoverySkipReason,
  TaskRecoveryStatus
} from '@agent-dock/agent-dock-shared';

interface TaskRecoveryRow {
  id: string;
  session_id: string;
  interrupted_task_id: string;
  root_task_id: string;
  original_prompt: string;
  original_origin: string | null;
  interrupt_reason: string;
  interrupted_at: string;
  detected_at: string;
  mode: string;
  status: string;
  skip_reason: string | null;
  attempt_count: number;
  recovery_task_id: string | null;
  decided_source: string | null;
  decided_by: string | null;
  decided_at: string | null;
  lark_app_id: string | null;
  lark_chat_id: string | null;
  lark_message_id: string | null;
  lark_card_id: string | null;
  created_at: string;
  updated_at: string;
}

function hydrateRow(row: TaskRecoveryRow): TaskRecoveryRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    interruptedTaskId: row.interrupted_task_id,
    rootTaskId: row.root_task_id,
    originalPrompt: row.original_prompt,
    originalOrigin: row.original_origin,
    interruptReason: 'daemon_restart',
    interruptedAt: row.interrupted_at,
    detectedAt: row.detected_at,
    mode: row.mode as TaskRecoveryMode,
    status: row.status as TaskRecoveryStatus,
    skipReason: row.skip_reason as TaskRecoverySkipReason | null,
    attemptCount: Number(row.attempt_count ?? 0),
    recoveryTaskId: row.recovery_task_id,
    decidedSource: row.decided_source as TaskRecoveryDecisionSource | null,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    larkAppId: row.lark_app_id,
    larkChatId: row.lark_chat_id,
    larkMessageId: row.lark_message_id,
    larkCardId: row.lark_card_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowParams(record: TaskRecoveryRecord) {
  return {
    id: record.id,
    session_id: record.sessionId,
    interrupted_task_id: record.interruptedTaskId,
    root_task_id: record.rootTaskId,
    original_prompt: record.originalPrompt,
    original_origin: record.originalOrigin ?? null,
    interrupt_reason: record.interruptReason ?? 'daemon_restart',
    interrupted_at: record.interruptedAt,
    detected_at: record.detectedAt,
    mode: record.mode,
    status: record.status,
    skip_reason: record.skipReason ?? null,
    attempt_count: record.attemptCount ?? 0,
    recovery_task_id: record.recoveryTaskId ?? null,
    decided_source: record.decidedSource ?? null,
    decided_by: record.decidedBy ?? null,
    decided_at: record.decidedAt ?? null,
    lark_app_id: record.larkAppId ?? null,
    lark_chat_id: record.larkChatId ?? null,
    lark_message_id: record.larkMessageId ?? null,
    lark_card_id: record.larkCardId ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

export function createTaskRecoveryRepository(sqlite: Database.Database): TaskRecoveryRepository {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_recoveries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      interrupted_task_id TEXT NOT NULL,
      root_task_id TEXT NOT NULL,
      original_prompt TEXT NOT NULL,
      original_origin TEXT,
      interrupt_reason TEXT NOT NULL DEFAULT 'daemon_restart',
      interrupted_at TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      skip_reason TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      recovery_task_id TEXT,
      decided_source TEXT,
      decided_by TEXT,
      decided_at TEXT,
      lark_app_id TEXT,
      lark_chat_id TEXT,
      lark_message_id TEXT,
      lark_card_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS task_recoveries_interrupted_task ON task_recoveries(interrupted_task_id);
    CREATE INDEX IF NOT EXISTS task_recoveries_session ON task_recoveries(session_id, created_at);
    CREATE INDEX IF NOT EXISTS task_recoveries_recovery_task ON task_recoveries(recovery_task_id);
    CREATE INDEX IF NOT EXISTS task_recoveries_lark_card ON task_recoveries(lark_card_id);
  `);

  const insertOrIgnoreStmt = sqlite.prepare(`
    INSERT OR IGNORE INTO task_recoveries (
      id, session_id, interrupted_task_id, root_task_id, original_prompt, original_origin,
      interrupt_reason, interrupted_at, detected_at, mode, status, skip_reason, attempt_count,
      recovery_task_id, decided_source, decided_by, decided_at,
      lark_app_id, lark_chat_id, lark_message_id, lark_card_id,
      created_at, updated_at
    ) VALUES (
      @id, @session_id, @interrupted_task_id, @root_task_id, @original_prompt, @original_origin,
      @interrupt_reason, @interrupted_at, @detected_at, @mode, @status, @skip_reason, @attempt_count,
      @recovery_task_id, @decided_source, @decided_by, @decided_at,
      @lark_app_id, @lark_chat_id, @lark_message_id, @lark_card_id,
      @created_at, @updated_at
    )
  `);

  const upsertStmt = sqlite.prepare(`
    INSERT INTO task_recoveries (
      id, session_id, interrupted_task_id, root_task_id, original_prompt, original_origin,
      interrupt_reason, interrupted_at, detected_at, mode, status, skip_reason, attempt_count,
      recovery_task_id, decided_source, decided_by, decided_at,
      lark_app_id, lark_chat_id, lark_message_id, lark_card_id,
      created_at, updated_at
    ) VALUES (
      @id, @session_id, @interrupted_task_id, @root_task_id, @original_prompt, @original_origin,
      @interrupt_reason, @interrupted_at, @detected_at, @mode, @status, @skip_reason, @attempt_count,
      @recovery_task_id, @decided_source, @decided_by, @decided_at,
      @lark_app_id, @lark_chat_id, @lark_message_id, @lark_card_id,
      @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      original_prompt = excluded.original_prompt,
      original_origin = excluded.original_origin,
      interrupted_at = excluded.interrupted_at,
      detected_at = excluded.detected_at,
      mode = excluded.mode,
      status = excluded.status,
      skip_reason = excluded.skip_reason,
      attempt_count = excluded.attempt_count,
      recovery_task_id = excluded.recovery_task_id,
      decided_source = excluded.decided_source,
      decided_by = excluded.decided_by,
      decided_at = excluded.decided_at,
      lark_app_id = excluded.lark_app_id,
      lark_chat_id = excluded.lark_chat_id,
      lark_message_id = excluded.lark_message_id,
      lark_card_id = excluded.lark_card_id,
      updated_at = excluded.updated_at
  `);

  const getByIdStmt = sqlite.prepare('SELECT * FROM task_recoveries WHERE id = ?');
  const getByInterruptedStmt = sqlite.prepare('SELECT * FROM task_recoveries WHERE interrupted_task_id = ?');
  const getByRecoveryTaskStmt = sqlite.prepare('SELECT * FROM task_recoveries WHERE recovery_task_id = ? LIMIT 1');
  const getByLarkCardStmt = sqlite.prepare('SELECT * FROM task_recoveries WHERE lark_card_id = ? LIMIT 1');
  const listBySessionStmt = sqlite.prepare('SELECT * FROM task_recoveries WHERE session_id = ? ORDER BY created_at ASC, id ASC');

  const claimTx = sqlite.transaction((
    id: string,
    expectedStatuses: readonly TaskRecoveryStatus[],
    patch: Partial<Omit<TaskRecoveryRecord, 'id' | 'sessionId' | 'interruptedTaskId' | 'rootTaskId'>>
  ): TaskRecoveryRecord | undefined => {
    if (!expectedStatuses.length) return undefined;
    const currentRow = getByIdStmt.get(id) as TaskRecoveryRow | undefined;
    if (!currentRow) return undefined;
    if (!expectedStatuses.includes(currentRow.status as TaskRecoveryStatus)) return undefined;
    const current = hydrateRow(currentRow);
    const updated: TaskRecoveryRecord = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };
    const placeholders = expectedStatuses.map(() => '?').join(', ');
    const result = sqlite.prepare(`
      UPDATE task_recoveries
      SET
        mode = ?,
        status = ?,
        skip_reason = ?,
        attempt_count = ?,
        recovery_task_id = ?,
        decided_source = ?,
        decided_by = ?,
        decided_at = ?,
        lark_app_id = ?,
        lark_chat_id = ?,
        lark_message_id = ?,
        lark_card_id = ?,
        updated_at = ?
      WHERE id = ? AND status IN (${placeholders})
    `).run(
      updated.mode,
      updated.status,
      updated.skipReason ?? null,
      updated.attemptCount,
      updated.recoveryTaskId ?? null,
      updated.decidedSource ?? null,
      updated.decidedBy ?? null,
      updated.decidedAt ?? null,
      updated.larkAppId ?? null,
      updated.larkChatId ?? null,
      updated.larkMessageId ?? null,
      updated.larkCardId ?? null,
      updated.updatedAt,
      id,
      ...expectedStatuses
    );
    if (result.changes !== 1) return undefined;
    return updated;
  });

  return {
    async list(filter: TaskRecoveryListFilter = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter.sessionId) {
        clauses.push('session_id = ?');
        params.push(filter.sessionId);
      }
      if (filter.status) {
        clauses.push('status = ?');
        params.push(filter.status);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.min(200, Math.max(1, Math.round(filter.limit ?? 50)));
      const rows = sqlite.prepare(`SELECT * FROM task_recoveries ${where} ORDER BY detected_at DESC, created_at DESC, id DESC LIMIT ?`)
        .all(...params, limit) as TaskRecoveryRow[];
      return rows.map(hydrateRow);
    },
    async get(id) {
      const row = getByIdStmt.get(id) as TaskRecoveryRow | undefined;
      return row ? hydrateRow(row) : undefined;
    },
    async getByInterruptedTaskId(interruptedTaskId) {
      const row = getByInterruptedStmt.get(interruptedTaskId) as TaskRecoveryRow | undefined;
      return row ? hydrateRow(row) : undefined;
    },
    async getByRecoveryTaskId(recoveryTaskId) {
      const row = getByRecoveryTaskStmt.get(recoveryTaskId) as TaskRecoveryRow | undefined;
      return row ? hydrateRow(row) : undefined;
    },
    async getByLarkCardId(larkCardId) {
      const row = getByLarkCardStmt.get(larkCardId) as TaskRecoveryRow | undefined;
      return row ? hydrateRow(row) : undefined;
    },
    async listBySession(sessionId) {
      const rows = listBySessionStmt.all(sessionId) as TaskRecoveryRow[];
      return rows.map(hydrateRow);
    },
    async save(record) {
      upsertStmt.run(rowParams(record));
    },
    async insertIfAbsent(record) {
      return insertOrIgnoreStmt.run(rowParams(record)).changes === 1;
    },
    async claimTransition(id, expectedStatuses, patch) {
      return claimTx(id, expectedStatuses, patch);
    }
  };
}
