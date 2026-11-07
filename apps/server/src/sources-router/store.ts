import { openDatabase } from '@agent-dock/agent-dock-storage';
import type {
  ActionStatus, CaseEventRecord, CaseRecord, CaseSessionRecord, CaseWatchRecord,
  InboxStatus, RouterAuditRecord, RouterInboxRecord, RouterStateRecord, SourceActionRecord, SourceEventRecord,
  SourceEnvelope, SourceEventStatus, SourceInstance, CaseStatus, WatchStatus
} from './types.js';

export const SOURCE_ROUTER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS source_instances (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL,
    config TEXT NOT NULL, secret_refs TEXT NOT NULL, secrets TEXT NOT NULL,
    router_session_id TEXT, status TEXT NOT NULL, last_event_at TEXT, last_seen_at TEXT,
    last_error TEXT, trace_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source_events (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_event_id TEXT NOT NULL,
    event_type TEXT NOT NULL, dedupe_key TEXT NOT NULL, correlation_key TEXT,
    occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, status TEXT NOT NULL,
    payload TEXT NOT NULL, raw TEXT, trace_id TEXT NOT NULL, causation_id TEXT,
    UNIQUE(source_id, dedupe_key)
  );
  CREATE INDEX IF NOT EXISTS source_events_source_received ON source_events(source_id, received_at);
  CREATE TABLE IF NOT EXISTS source_checkpoints (
    source_id TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, correlation_key TEXT NOT NULL,
    open_key TEXT, title TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL,
    router_session_id TEXT, primary_session_id TEXT, summary TEXT NOT NULL,
    object TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    closed_at TEXT, close_reason TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS cases_open_key ON cases(source_id, open_key) WHERE open_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS cases_source_status ON cases(source_id, status);
  CREATE TABLE IF NOT EXISTS case_events (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL, source_event_id TEXT, kind TEXT NOT NULL,
    summary TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(case_id, source_event_id)
  );
  CREATE INDEX IF NOT EXISTS case_events_case_created ON case_events(case_id, created_at);
  CREATE TABLE IF NOT EXISTS case_sessions (
    case_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(case_id, session_id)
  );
  CREATE TABLE IF NOT EXISTS case_watches (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL, source_id TEXT NOT NULL, condition TEXT NOT NULL,
    expires_at TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, fired_at TEXT
  );
  CREATE INDEX IF NOT EXISTS case_watches_case_status ON case_watches(case_id, status);
  CREATE TABLE IF NOT EXISTS source_actions (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, case_id TEXT, action_type TEXT NOT NULL,
    target TEXT NOT NULL, payload TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(source_id, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS router_inbox (
    id TEXT PRIMARY KEY, router_session_id TEXT NOT NULL, case_id TEXT, kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
    available_at TEXT NOT NULL, created_at TEXT NOT NULL, dispatched_at TEXT,
    UNIQUE(router_session_id, dedupe_key)
  );
  CREATE INDEX IF NOT EXISTS router_inbox_pending ON router_inbox(router_session_id, status, available_at);
  CREATE TABLE IF NOT EXISTS router_state (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS router_audit (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor TEXT NOT NULL, summary TEXT NOT NULL,
    case_id TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS router_audit_created ON router_audit(created_at);
`;

type SourceRow = {
  id: string; name: string; kind: string; enabled: number; config: string; secret_refs: string;
  secrets: string; router_session_id: string | null; status: string; last_event_at: string | null;
  last_seen_at: string | null; last_error: string | null; trace_id: string; created_at: string; updated_at: string;
};

const parseJson = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

const sourceFromRow = (row: SourceRow): SourceInstance => ({
  id: row.id, name: row.name, kind: row.kind as SourceInstance['kind'], enabled: row.enabled === 1,
  config: parseJson(row.config, { correlation: { mode: 'object' } }), secretRefs: parseJson(row.secret_refs, []),
  secrets: parseJson(row.secrets, {}), routerSessionId: row.router_session_id,
  status: row.status as SourceInstance['status'], lastEventAt: row.last_event_at,
  lastSeenAt: row.last_seen_at, lastError: row.last_error, traceId: row.trace_id,
  createdAt: row.created_at, updatedAt: row.updated_at
});

const inboxFromRow = (row: Record<string, unknown>): RouterInboxRecord => ({
  id: String(row.id), routerSessionId: String(row.router_session_id), caseId: row.case_id === null ? null : String(row.case_id),
  kind: String(row.kind), dedupeKey: String(row.dedupe_key), payload: String(row.payload),
  status: String(row.status) as InboxStatus, availableAt: String(row.available_at),
  createdAt: String(row.created_at), dispatchedAt: row.dispatched_at === null ? null : String(row.dispatched_at)
});

export interface SourceInsert {
  event: Omit<SourceEventRecord, 'id' | 'receivedAt' | 'status'>;
  checkpoint?: string;
}

export interface InsertResult<T> { record: T; created: boolean }

export interface CaseInsert {
  id: string; sourceId: string; correlationKey: string; title: string; priority: string;
  summary: string; object: string; status: CaseStatus; createdAt: string;
}

export class SourceRouterStore {
  private readonly sqlite: ReturnType<typeof openDatabase>;

  constructor(filename: string) {
    this.sqlite = openDatabase(filename);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.exec(SOURCE_ROUTER_SCHEMA);
  }

  close() { this.sqlite.close(); }

  listSources(): SourceInstance[] {
    return (this.sqlite.prepare('SELECT * FROM source_instances ORDER BY created_at').all() as SourceRow[]).map(sourceFromRow);
  }

  getSource(id: string): SourceInstance | undefined {
    const row = this.sqlite.prepare('SELECT * FROM source_instances WHERE id = ?').get(id) as SourceRow | undefined;
    return row ? sourceFromRow(row) : undefined;
  }

  saveSource(source: SourceInstance): void {
    this.sqlite.prepare(`INSERT INTO source_instances
      (id, name, kind, enabled, config, secret_refs, secrets, router_session_id, status, last_event_at, last_seen_at, last_error, trace_id, created_at, updated_at)
      VALUES (@id, @name, @kind, @enabled, @config, @secret_refs, @secrets, @router_session_id, @status, @last_event_at, @last_seen_at, @last_error, @trace_id, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, enabled=excluded.enabled,
      config=excluded.config, secret_refs=excluded.secret_refs, secrets=excluded.secrets,
      router_session_id=excluded.router_session_id, status=excluded.status, last_event_at=excluded.last_event_at,
      last_seen_at=excluded.last_seen_at, last_error=excluded.last_error, trace_id=excluded.trace_id, updated_at=excluded.updated_at`
    ).run({
      id: source.id, name: source.name, kind: source.kind, enabled: source.enabled ? 1 : 0,
      config: JSON.stringify(source.config), secret_refs: JSON.stringify(source.secretRefs),
      secrets: JSON.stringify(source.secrets), router_session_id: source.routerSessionId ?? null,
      status: source.status, last_event_at: source.lastEventAt ?? null, last_seen_at: source.lastSeenAt ?? null,
      last_error: source.lastError ?? null, trace_id: source.traceId,
      created_at: source.createdAt, updated_at: source.updatedAt
    });
  }

  insertEvent(input: SourceInsert, now: string): InsertResult<SourceEventRecord> {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare('SELECT * FROM source_events WHERE source_id = ? AND dedupe_key = ?')
        .get(input.event.sourceId, input.event.dedupeKey) as Record<string, unknown> | undefined;
      if (existing) return { record: this.eventFromRow(existing), created: false };
      const record: SourceEventRecord = { ...input.event, id: `sevt_${crypto.randomUUID()}`, receivedAt: now, status: 'accepted' };
      this.sqlite.prepare(`INSERT INTO source_events
        (id, source_id, external_event_id, event_type, dedupe_key, correlation_key, occurred_at, received_at, status, payload, raw, trace_id, causation_id)
        VALUES (@id, @source_id, @external_event_id, @event_type, @dedupe_key, @correlation_key, @occurred_at, @received_at, @status, @payload, @raw, @trace_id, @causation_id)`
      ).run(this.eventToRow(record));
      if (input.checkpoint !== undefined) this.setCheckpoint(record.sourceId, input.checkpoint, now);
      this.sqlite.prepare("UPDATE source_instances SET last_event_at = ?, status = 'running', last_error = NULL, updated_at = ? WHERE id = ?")
        .run(now, now, record.sourceId);
      return { record, created: true };
    })();
  }

  private eventFromRow(row: Record<string, unknown>): SourceEventRecord {
    return {
      id: String(row.id), sourceId: String(row.source_id), externalEventId: String(row.external_event_id),
      eventType: String(row.event_type), dedupeKey: String(row.dedupe_key),
      correlationKey: row.correlation_key === null ? null : String(row.correlation_key),
      occurredAt: String(row.occurred_at), receivedAt: String(row.received_at),
      status: String(row.status) as SourceEventStatus, payload: String(row.payload),
      raw: row.raw === null ? null : String(row.raw), traceId: String(row.trace_id),
      causationId: row.causation_id === null ? null : String(row.causation_id)
    };
  }

  private eventToRow(record: SourceEventRecord): Record<string, unknown> {
    return {
      id: record.id, source_id: record.sourceId, external_event_id: record.externalEventId,
      event_type: record.eventType, dedupe_key: record.dedupeKey, correlation_key: record.correlationKey ?? null,
      occurred_at: record.occurredAt, received_at: record.receivedAt, status: record.status,
      payload: record.payload, raw: record.raw ?? null, trace_id: record.traceId,
      causation_id: record.causationId ?? null
    };
  }

  event(id: string): SourceEventRecord | undefined {
    const row = this.sqlite.prepare('SELECT * FROM source_events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.eventFromRow(row) : undefined;
  }

  listEvents(sourceId?: string, limit = 200): SourceEventRecord[] {
    const rows = sourceId
      ? this.sqlite.prepare('SELECT * FROM source_events WHERE source_id = ? ORDER BY received_at DESC LIMIT ?').all(sourceId, limit)
      : this.sqlite.prepare('SELECT * FROM source_events ORDER BY received_at DESC LIMIT ?').all(limit);
    return (rows as Array<Record<string, unknown>>).map(row => this.eventFromRow(row));
  }

  setEventStatus(id: string, status: SourceEventStatus): void {
    this.sqlite.prepare('UPDATE source_events SET status = ? WHERE id = ?').run(status, id);
  }

  checkpoint(sourceId: string): string | undefined {
    return (this.sqlite.prepare('SELECT cursor FROM source_checkpoints WHERE source_id = ?').get(sourceId) as { cursor: string } | undefined)?.cursor;
  }

  setCheckpoint(sourceId: string, cursor: string, now: string): void {
    this.sqlite.prepare(`INSERT INTO source_checkpoints(source_id, cursor, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at`).run(sourceId, cursor, now);
  }

  openCase(sourceId: string, openKey: string): CaseRecord | undefined {
    const row = this.sqlite.prepare('SELECT * FROM cases WHERE source_id = ? AND open_key = ?').get(sourceId, openKey) as Record<string, unknown> | undefined;
    return row ? this.caseFromRow(row) : undefined;
  }

  createCase(input: CaseInsert): InsertResult<CaseRecord> {
    try {
      const record: CaseRecord = {
        ...input, openKey: input.status === 'closed' ? null : input.correlationKey,
        routerSessionId: null, primarySessionId: null, updatedAt: input.createdAt,
        closedAt: null, closeReason: null
      };
      this.sqlite.prepare(`INSERT INTO cases
        (id, source_id, correlation_key, open_key, title, status, priority, router_session_id, primary_session_id, summary, object, created_at, updated_at, closed_at, close_reason)
        VALUES (@id, @source_id, @correlation_key, @open_key, @title, @status, @priority, @router_session_id, @primary_session_id, @summary, @object, @created_at, @updated_at, @closed_at, @close_reason)`
      ).run(this.caseToRow(record));
      return { record, created: true };
    } catch (error) {
      const existing = this.openCase(input.sourceId, input.correlationKey);
      if (existing) return { record: existing, created: false };
      throw error;
    }
  }

  private caseFromRow(row: Record<string, unknown>): CaseRecord {
    return {
      id: String(row.id), sourceId: String(row.source_id), correlationKey: String(row.correlation_key),
      openKey: row.open_key === null ? null : String(row.open_key), title: String(row.title),
      status: String(row.status) as CaseStatus, priority: String(row.priority),
      routerSessionId: row.router_session_id === null ? null : String(row.router_session_id),
      primarySessionId: row.primary_session_id === null ? null : String(row.primary_session_id),
      summary: String(row.summary), object: String(row.object), createdAt: String(row.created_at),
      updatedAt: String(row.updated_at), closedAt: row.closed_at === null ? null : String(row.closed_at),
      closeReason: row.close_reason === null ? null : String(row.close_reason)
    };
  }

  private caseToRow(record: CaseRecord): Record<string, unknown> {
    return {
      id: record.id, source_id: record.sourceId, correlation_key: record.correlationKey,
      open_key: record.openKey ?? null, title: record.title, status: record.status,
      priority: record.priority, router_session_id: record.routerSessionId ?? null,
      primary_session_id: record.primarySessionId ?? null, summary: record.summary,
      object: record.object, created_at: record.createdAt, updated_at: record.updatedAt,
      closed_at: record.closedAt ?? null, close_reason: record.closeReason ?? null
    };
  }

  case(id: string): CaseRecord | undefined {
    const row = this.sqlite.prepare('SELECT * FROM cases WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.caseFromRow(row) : undefined;
  }

  listCases(filter: { sourceId?: string; status?: CaseStatus } = {}): CaseRecord[] {
    const rows = filter.sourceId && filter.status
      ? this.sqlite.prepare('SELECT * FROM cases WHERE source_id = ? AND status = ? ORDER BY updated_at DESC').all(filter.sourceId, filter.status)
      : filter.sourceId
        ? this.sqlite.prepare('SELECT * FROM cases WHERE source_id = ? ORDER BY updated_at DESC').all(filter.sourceId)
        : filter.status
          ? this.sqlite.prepare('SELECT * FROM cases WHERE status = ? ORDER BY updated_at DESC').all(filter.status)
          : this.sqlite.prepare('SELECT * FROM cases ORDER BY updated_at DESC').all();
    return (rows as Array<Record<string, unknown>>).map(row => this.caseFromRow(row));
  }

  saveCase(record: CaseRecord): void {
    this.sqlite.prepare(`UPDATE cases SET correlation_key=@correlation_key, open_key=@open_key, title=@title,
      status=@status, priority=@priority, router_session_id=@router_session_id, primary_session_id=@primary_session_id,
      summary=@summary, object=@object, updated_at=@updated_at, closed_at=@closed_at, close_reason=@close_reason WHERE id=@id`
    ).run(this.caseToRow(record));
  }

  appendCaseEvent(record: Omit<CaseEventRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): boolean {
    const result = this.sqlite.prepare(`INSERT OR IGNORE INTO case_events
      (id, case_id, source_event_id, kind, summary, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(record.id ?? `cevt_${crypto.randomUUID()}`, record.caseId, record.sourceEventId ?? null, record.kind, record.summary, record.data, record.createdAt ?? new Date().toISOString());
    return result.changes === 1;
  }

  caseEvents(caseId: string): CaseEventRecord[] {
    return (this.sqlite.prepare('SELECT * FROM case_events WHERE case_id = ? ORDER BY created_at, id').all(caseId) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id), caseId: String(row.case_id), sourceEventId: row.source_event_id === null ? null : String(row.source_event_id),
      kind: String(row.kind), summary: String(row.summary), data: String(row.data), createdAt: String(row.created_at)
    }));
  }

  linkSession(record: CaseSessionRecord): void {
    this.sqlite.prepare('INSERT OR IGNORE INTO case_sessions(case_id, session_id, role, created_at) VALUES (?, ?, ?, ?)')
      .run(record.caseId, record.sessionId, record.role, record.createdAt);
  }

  caseSessions(caseId: string): CaseSessionRecord[] {
    return this.sqlite.prepare('SELECT * FROM case_sessions WHERE case_id = ? ORDER BY created_at').all(caseId) as CaseSessionRecord[];
  }

  sessionsForCase(sessionId: string): CaseSessionRecord[] {
    return this.sqlite.prepare('SELECT * FROM case_sessions WHERE session_id = ?').all(sessionId) as CaseSessionRecord[];
  }

  insertWatch(record: CaseWatchRecord): boolean {
    const result = this.sqlite.prepare(`INSERT OR IGNORE INTO case_watches
      (id, case_id, source_id, condition, expires_at, status, created_at, fired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.caseId, record.sourceId, record.condition, record.expiresAt ?? null, record.status, record.createdAt, record.firedAt ?? null);
    return result.changes === 1;
  }

  watchesForCase(caseId: string): CaseWatchRecord[] {
    return this.sqlite.prepare('SELECT * FROM case_watches WHERE case_id = ? ORDER BY created_at').all(caseId) as CaseWatchRecord[];
  }

  activeWatches(sourceId: string): CaseWatchRecord[] {
    return this.sqlite.prepare("SELECT * FROM case_watches WHERE source_id = ? AND status = 'active'").all(sourceId) as CaseWatchRecord[];
  }

  setWatchStatus(id: string, status: WatchStatus, now: string): void {
    this.sqlite.prepare('UPDATE case_watches SET status = ?, fired_at = CASE WHEN ? IN (\'fired\', \'expired\') THEN ? ELSE fired_at END WHERE id = ? AND status = \'active\'')
      .run(status, status, now, id);
  }

  insertAction(record: SourceActionRecord): InsertResult<SourceActionRecord> {
    const existing = this.sqlite.prepare('SELECT * FROM source_actions WHERE source_id = ? AND idempotency_key = ?')
      .get(record.sourceId, record.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return { record: this.actionFromRow(existing), created: false };
    try {
      this.sqlite.prepare(`INSERT INTO source_actions
        (id, source_id, case_id, action_type, target, payload, idempotency_key, status, attempts, last_error, created_at, updated_at)
        VALUES (@id, @source_id, @case_id, @action_type, @target, @payload, @idempotency_key, @status, @attempts, @last_error, @created_at, @updated_at)`
      ).run(this.actionToRow(record));
      return { record, created: true };
    } catch (error) {
      const row = this.sqlite.prepare('SELECT * FROM source_actions WHERE source_id = ? AND idempotency_key = ?')
        .get(record.sourceId, record.idempotencyKey) as Record<string, unknown> | undefined;
      if (row) return { record: this.actionFromRow(row), created: false };
      throw error;
    }
  }

  private actionFromRow(row: Record<string, unknown>): SourceActionRecord {
    return {
      id: String(row.id), sourceId: String(row.source_id), caseId: row.case_id === null ? null : String(row.case_id),
      actionType: String(row.action_type), target: String(row.target), payload: String(row.payload),
      idempotencyKey: String(row.idempotency_key), status: String(row.status) as ActionStatus,
      attempts: Number(row.attempts), lastError: row.last_error === null ? null : String(row.last_error),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  private actionToRow(record: SourceActionRecord): Record<string, unknown> {
    return {
      id: record.id, source_id: record.sourceId, case_id: record.caseId ?? null,
      action_type: record.actionType, target: record.target, payload: record.payload,
      idempotency_key: record.idempotencyKey, status: record.status, attempts: record.attempts,
      last_error: record.lastError ?? null, created_at: record.createdAt, updated_at: record.updatedAt
    };
  }

  actionsForCase(caseId: string): SourceActionRecord[] {
    return (this.sqlite.prepare('SELECT * FROM source_actions WHERE case_id = ? ORDER BY created_at').all(caseId) as Array<Record<string, unknown>>).map(row => this.actionFromRow(row));
  }

  setActionStatus(id: string, status: ActionStatus, now: string, error?: string): void {
    this.sqlite.prepare(`UPDATE source_actions SET status = ?,
      attempts = attempts + CASE WHEN ? IN ('failed', 'succeeded', 'dead') THEN 1 ELSE 0 END,
      last_error = ?, updated_at = ? WHERE id = ?`)
      .run(status, status, error ?? null, now, id);
  }

  /** 抢占一条可执行的 Action；并发的处理循环只有一个能成功把状态改成 running。 */
  markActionRunning(id: string, now: string): boolean {
    const result = this.sqlite.prepare("UPDATE source_actions SET status = 'running', updated_at = ? WHERE id = ? AND status IN ('pending', 'failed', 'throttled')")
      .run(now, id);
    return result.changes === 1;
  }

  /** 进程重启后，上次留在 running 的 Action 已经不可能完成；重新排队。 */
  recoverRunningActions(now: string): number {
    const result = this.sqlite.prepare("UPDATE source_actions SET status = 'failed', last_error = ?, updated_at = ? WHERE status = 'running'")
      .run('进程重启，动作已重新排队', now);
    return Number(result.changes);
  }

  insertInbox(record: RouterInboxRecord): boolean {
    const result = this.sqlite.prepare(`INSERT OR IGNORE INTO router_inbox
      (id, router_session_id, case_id, kind, dedupe_key, payload, status, available_at, created_at, dispatched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(record.id, record.routerSessionId, record.caseId ?? null, record.kind, record.dedupeKey,
      record.payload, record.status, record.availableAt, record.createdAt, record.dispatchedAt ?? null);
    return result.changes === 1;
  }

  listInbox(routerSessionId: string, limit = 200): RouterInboxRecord[] {
    return (this.sqlite.prepare('SELECT * FROM router_inbox WHERE router_session_id = ? ORDER BY created_at DESC LIMIT ?').all(routerSessionId, limit) as Array<Record<string, unknown>>).map(inboxFromRow);
  }

  dueInbox(routerSessionId: string, now: string, limit = 20): RouterInboxRecord[] {
    // 直接按 pending + available_at 查询，避免只扫描最近 N 条时漏掉更早的待处理项。
    return (this.sqlite.prepare(`SELECT * FROM router_inbox
      WHERE router_session_id = ? AND status = 'pending' AND available_at <= ?
      ORDER BY available_at, created_at LIMIT ?`).all(routerSessionId, now, limit) as Array<Record<string, unknown>>).map(inboxFromRow);
  }

  setInboxStatus(id: string, status: InboxStatus, now: string): void {
    this.sqlite.prepare('UPDATE router_inbox SET status = ?, dispatched_at = CASE WHEN ? = \'dispatched\' THEN ? ELSE dispatched_at END WHERE id = ?')
      .run(status, status, now, id);
  }

  state(key: string): RouterStateRecord | undefined {
    const row = this.sqlite.prepare('SELECT * FROM router_state WHERE key = ?').get(key) as { key: string; value: string; updated_at: string } | undefined;
    return row ? { key: row.key, value: row.value, updatedAt: row.updated_at } : undefined;
  }

  setState(key: string, value: string, now: string): void {
    this.sqlite.prepare(`INSERT INTO router_state(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, value, now);
  }

  insertAudit(record: RouterAuditRecord): void {
    this.sqlite.prepare('INSERT OR IGNORE INTO router_audit(id, kind, actor, summary, case_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, record.kind, record.actor, record.summary, record.caseId ?? null, record.createdAt);
  }

  audits(limit = 200): RouterAuditRecord[] {
    return (this.sqlite.prepare('SELECT * FROM router_audit ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id), kind: String(row.kind), actor: String(row.actor), summary: String(row.summary),
      caseId: row.case_id === null ? null : String(row.case_id), createdAt: String(row.created_at)
    }));
  }

  activeSessionCount(caseId: string): number {
    return (this.sqlite.prepare('SELECT count(*) AS count FROM case_sessions WHERE case_id = ?').get(caseId) as { count: number }).count;
  }

  recentCaseCount(sourceId: string, since: string): number {
    return (this.sqlite.prepare('SELECT count(*) AS count FROM cases WHERE source_id = ? AND created_at >= ?').get(sourceId, since) as { count: number }).count;
  }

  dueWatches(now: string): CaseWatchRecord[] {
    return (this.sqlite.prepare("SELECT * FROM case_watches WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").all(now) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id), caseId: String(row.case_id), sourceId: String(row.source_id),
      condition: String(row.condition), expiresAt: row.expires_at === null ? null : String(row.expires_at),
      status: String(row.status) as WatchStatus, createdAt: String(row.created_at),
      firedAt: row.fired_at === null ? null : String(row.fired_at)
    }));
  }

  eventPayload(id: string, sourceId?: string): { event?: SourceEnvelope; payload: string; raw?: string | null } | undefined {
    const row = sourceId
      ? this.sqlite.prepare('SELECT payload, raw FROM source_events WHERE id = ? AND source_id = ?').get(id, sourceId) as { payload: string; raw: string | null } | undefined
      : this.sqlite.prepare('SELECT payload, raw FROM source_events WHERE id = ?').get(id) as { payload: string; raw: string | null } | undefined;
    if (!row) return undefined;
    const parsed = parseJson<{ event?: unknown }>(row.payload, {});
    return {
      ...(parsed.event && typeof parsed.event === 'object' ? { event: parsed.event as SourceEnvelope } : {}),
      payload: row.payload, raw: row.raw
    };
  }

  statusCounts(): { sources: number; cases: number; events: number; pendingInbox: number; pendingActions: number } {
    const count = (sql: string) => Number((this.sqlite.prepare(sql).get() as { count: number }).count);
    return {
      sources: count('SELECT count(*) AS count FROM source_instances'),
      cases: count('SELECT count(*) AS count FROM cases'),
      events: count('SELECT count(*) AS count FROM source_events'),
      pendingInbox: count("SELECT count(*) AS count FROM router_inbox WHERE status = 'pending'"),
      pendingActions: count("SELECT count(*) AS count FROM source_actions WHERE status IN ('pending', 'failed', 'throttled')")
    };
  }
}

export function sourceRouterDatabasePath(databaseUrl: string): string {
  if (databaseUrl === ':memory:') return ':memory:';
  return `${databaseUrl}.sources-router.db`;
}
