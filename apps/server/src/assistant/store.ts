import { openDatabase } from '@agent-dock/agent-dock-storage';
import { makeId, now } from '@agent-dock/agent-dock-shared';
import type {
  AssistantTask, AssistantTaskOutcome, AssistantTaskState, DraftRecord, DraftState,
  TaskCheck, TaskReviewRecord, WatchMode, WatchRecord, WatchState
} from './types.js';
import type {
  ArchiveBatch, ArchiveSource, CatRecord, CatState, HandoffOutcome, HandoffPackage, HandoffRecord, HandoffState,
  HandoffStepRecord, HandoffTrigger, LifeStage, LifecycleMetrics, MaintenanceRun, MaintenanceState, MetricReason,
  TransferKind, TransferRecord, TransferStatus
} from './lifecycle.js';

export const ASSISTANT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS assistant_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assistant_tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    done_when TEXT NOT NULL DEFAULT '[]', expect_minutes INTEGER,
    state TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0,
    session_id TEXT, agent_id TEXT, cwd TEXT, model TEXT, reasoning_effort TEXT,
    plan INTEGER NOT NULL DEFAULT 0, outcome TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS assistant_tasks_session ON assistant_tasks(session_id);
  CREATE INDEX IF NOT EXISTS assistant_tasks_state ON assistant_tasks(state);
  CREATE TABLE IF NOT EXISTS assistant_reviews (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, verdict TEXT NOT NULL,
    checks TEXT NOT NULL DEFAULT '[]', note TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS assistant_reviews_task ON assistant_reviews(task_id, created_at);
  CREATE TABLE IF NOT EXISTS assistant_watches (
    id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, name TEXT NOT NULL,
    command TEXT NOT NULL, cwd TEXT, interval_seconds INTEGER NOT NULL,
    timeout_seconds INTEGER NOT NULL, mode TEXT NOT NULL, cooldown_seconds INTEGER NOT NULL,
    state TEXT NOT NULL, last_run_at TEXT, last_exit_code INTEGER, last_output TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0, fire_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS assistant_watches_state ON assistant_watches(state);
  CREATE TABLE IF NOT EXISTS assistant_drafts (
    id TEXT PRIMARY KEY, task_id TEXT, channel TEXT NOT NULL, target TEXT NOT NULL,
    body TEXT NOT NULL, state TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_by TEXT,
    created_at TEXT NOT NULL, sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS assistant_drafts_state ON assistant_drafts(state, created_at);
  CREATE TABLE IF NOT EXISTS assistant_notifications (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, ask INTEGER NOT NULL DEFAULT 0,
    urgent INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
    created_at TEXT NOT NULL, sent_at TEXT
  );
  CREATE TABLE IF NOT EXISTS assistant_lineage (
    id TEXT PRIMARY KEY, family_id TEXT NOT NULL, generation INTEGER NOT NULL,
    session_id TEXT NOT NULL, name TEXT NOT NULL, agent_id TEXT, model TEXT, reasoning_effort TEXT, cwd TEXT,
    state TEXT NOT NULL, life_stage TEXT NOT NULL, peak_age_score REAL NOT NULL DEFAULT 0,
    rounds INTEGER NOT NULL DEFAULT 0, adopted_at TEXT NOT NULL, retired_at TEXT, retired_reason TEXT,
    predecessor_id TEXT, successor_id TEXT, handoff_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS assistant_lineage_session ON assistant_lineage(session_id);
  CREATE INDEX IF NOT EXISTS assistant_lineage_family ON assistant_lineage(family_id, generation);
  CREATE TABLE IF NOT EXISTS assistant_handoffs (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, outcome TEXT, trigger TEXT NOT NULL, reason TEXT,
    from_cat_id TEXT NOT NULL, from_session_id TEXT NOT NULL, to_cat_id TEXT, to_session_id TEXT,
    successor_name TEXT, metrics TEXT NOT NULL DEFAULT '{}', reasons TEXT NOT NULL DEFAULT '[]',
    package TEXT, archive_batch_id TEXT, briefing_task_id TEXT, steps TEXT NOT NULL DEFAULT '[]', error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, confirmed_at TEXT, completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS assistant_handoffs_state ON assistant_handoffs(state, created_at);
  CREATE TABLE IF NOT EXISTS assistant_transfers (
    id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL,
    title TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, previous TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(handoff_id, kind, item_id)
  );
  CREATE TABLE IF NOT EXISTS assistant_archive_batches (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, reason TEXT, handoff_id TEXT, run_id TEXT,
    task_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, undone_at TEXT
  );
  CREATE TABLE IF NOT EXISTS assistant_maintenance_runs (
    id TEXT PRIMARY KEY, trigger TEXT NOT NULL, state TEXT NOT NULL, reason TEXT,
    reasons TEXT NOT NULL DEFAULT '[]', session_id TEXT NOT NULL, cat_id TEXT, runtime_task_id TEXT,
    summary TEXT, error TEXT, archive_batch_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS assistant_maintenance_runs_state ON assistant_maintenance_runs(state, created_at);
`;

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

type TaskRow = {
  id: string; title: string; notes: string; done_when: string; expect_minutes: number | null;
  state: string; round: number; session_id: string | null; agent_id: string | null; cwd: string | null;
  model: string | null; reasoning_effort: string | null;
  plan: number; outcome: string | null; created_at: string; updated_at: string; closed_at: string | null;
  archived_at?: string | null; archive_batch_id?: string | null; restored_at?: string | null;
};

const taskFromRow = (row: TaskRow): AssistantTask => ({
  id: row.id, title: row.title, notes: row.notes,
  doneWhen: parseJson<string[]>(row.done_when, []),
  ...(row.expect_minutes === null ? {} : { expectMinutes: row.expect_minutes }),
  state: row.state as AssistantTaskState, round: row.round,
  ...(row.session_id ? { sessionId: row.session_id } : {}),
  ...(row.agent_id ? { agentId: row.agent_id } : {}),
  ...(row.cwd ? { cwd: row.cwd } : {}),
  ...(row.model ? { model: row.model } : {}),
  ...(row.reasoning_effort ? { reasoningEffort: row.reasoning_effort } : {}),
  plan: row.plan === 1,
  ...(row.outcome ? { outcome: row.outcome as AssistantTaskOutcome } : {}),
  createdAt: row.created_at, updatedAt: row.updated_at,
  ...(row.closed_at ? { closedAt: row.closed_at } : {}),
  ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  ...(row.archive_batch_id ? { archiveBatchId: row.archive_batch_id } : {}),
  ...(row.restored_at ? { restoredAt: row.restored_at } : {})
});

type WatchRow = {
  id: string; owner_session_id: string; name: string; command: string; cwd: string | null;
  interval_seconds: number; timeout_seconds: number; mode: string; cooldown_seconds: number;
  state: string; last_run_at: string | null; last_exit_code: number | null; last_output: string | null;
  fail_count: number; fire_count: number; expires_at: string | null; created_at: string; updated_at: string;
};

const watchFromRow = (row: WatchRow): WatchRecord => ({
  id: row.id, ownerSessionId: row.owner_session_id, name: row.name, command: row.command,
  ...(row.cwd ? { cwd: row.cwd } : {}),
  intervalSeconds: row.interval_seconds, timeoutSeconds: row.timeout_seconds,
  mode: row.mode as WatchMode, cooldownSeconds: row.cooldown_seconds,
  state: row.state as WatchState,
  ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
  ...(row.last_exit_code === null ? {} : { lastExitCode: row.last_exit_code }),
  ...(row.last_output ? { lastOutput: row.last_output } : {}),
  failCount: row.fail_count, fireCount: row.fire_count,
  ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  createdAt: row.created_at, updatedAt: row.updated_at
});

type DraftRow = {
  id: string; task_id: string | null; channel: string; target: string; body: string;
  state: string; idempotency_key: string; attempts: number; last_error: string | null;
  created_by: string | null; created_at: string; sent_at: string | null;
};

const draftFromRow = (row: DraftRow): DraftRecord => ({
  id: row.id,
  ...(row.task_id ? { taskId: row.task_id } : {}),
  channel: row.channel as DraftRecord['channel'], target: row.target, body: row.body,
  state: row.state as DraftState, idempotencyKey: row.idempotency_key,
  attempts: row.attempts,
  ...(row.last_error ? { lastError: row.last_error } : {}),
  ...(row.created_by ? { createdBy: row.created_by } : {}),
  createdAt: row.created_at,
  ...(row.sent_at ? { sentAt: row.sent_at } : {})
});

export class AssistantStore {
  private readonly sqlite: ReturnType<typeof openDatabase>;

  constructor(filename: string) {
    this.sqlite = openDatabase(filename);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.exec(ASSISTANT_SCHEMA);
    // 老库升级：派活配置是后加的，缺列时补上，已有事项开工时继续继承主会话。
    const columns = new Set((this.sqlite.prepare('PRAGMA table_info(assistant_tasks)').all() as Array<{ name: string }>).map(column => column.name));
    if (!columns.has('model')) this.sqlite.exec('ALTER TABLE assistant_tasks ADD COLUMN model TEXT');
    if (!columns.has('reasoning_effort')) this.sqlite.exec('ALTER TABLE assistant_tasks ADD COLUMN reasoning_effort TEXT');
    // 归档区是后加的：旧库补列，历史便签保持未归档。
    if (!columns.has('archived_at')) this.sqlite.exec('ALTER TABLE assistant_tasks ADD COLUMN archived_at TEXT');
    if (!columns.has('archive_batch_id')) this.sqlite.exec('ALTER TABLE assistant_tasks ADD COLUMN archive_batch_id TEXT');
    if (!columns.has('restored_at')) this.sqlite.exec('ALTER TABLE assistant_tasks ADD COLUMN restored_at TEXT');
  }

  /** 多步写入要么全成要么全不成（交接回滚、归档批次）。 */
  transaction<T>(work: () => T): T {
    return this.sqlite.transaction(work)();
  }

  close() { this.sqlite.close(); }

  getSetting(key: string): string | undefined {
    const row = this.sqlite.prepare('SELECT value FROM assistant_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string) {
    this.sqlite.prepare(`INSERT INTO assistant_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, now());
  }

  deleteSetting(key: string) { this.sqlite.prepare('DELETE FROM assistant_settings WHERE key = ?').run(key); }

  listTasks(): AssistantTask[] {
    return (this.sqlite.prepare('SELECT * FROM assistant_tasks ORDER BY created_at DESC').all() as TaskRow[]).map(taskFromRow);
  }

  getTask(id: string): AssistantTask | undefined {
    const row = this.sqlite.prepare('SELECT * FROM assistant_tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  findTaskBySession(sessionId: string): AssistantTask | undefined {
    const row = this.sqlite.prepare('SELECT * FROM assistant_tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  findOpenTaskBySession(sessionId: string): AssistantTask | undefined {
    const row = this.sqlite.prepare("SELECT * FROM assistant_tasks WHERE session_id = ? AND state != 'closed' ORDER BY created_at DESC LIMIT 1").get(sessionId) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  createTask(input: {
    title: string; notes?: string; doneWhen?: string[]; expectMinutes?: number;
    state?: AssistantTaskState; sessionId?: string; agentId?: string; cwd?: string;
    model?: string; reasoningEffort?: string; plan?: boolean;
  }): AssistantTask {
    const stamp = now();
    const task: AssistantTask = {
      id: makeId('atask'), title: input.title, notes: input.notes ?? '',
      doneWhen: input.doneWhen ?? [],
      ...(input.expectMinutes === undefined ? {} : { expectMinutes: input.expectMinutes }),
      state: input.state ?? 'running', round: 0,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      plan: input.plan ?? false,
      createdAt: stamp, updatedAt: stamp
    };
    this.saveTask(task);
    return task;
  }

  saveTask(task: AssistantTask) {
    task.updatedAt = now();
    this.sqlite.prepare(`INSERT INTO assistant_tasks
      (id, title, notes, done_when, expect_minutes, state, round, session_id, agent_id, cwd, model, reasoning_effort, plan, outcome, created_at, updated_at, closed_at)
      VALUES (@id, @title, @notes, @doneWhen, @expectMinutes, @state, @round, @sessionId, @agentId, @cwd, @model, @reasoningEffort, @plan, @outcome, @createdAt, @updatedAt, @closedAt)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, notes = excluded.notes, done_when = excluded.done_when,
        expect_minutes = excluded.expect_minutes, state = excluded.state, round = excluded.round,
        session_id = excluded.session_id, agent_id = excluded.agent_id, cwd = excluded.cwd,
        model = excluded.model, reasoning_effort = excluded.reasoning_effort,
        plan = excluded.plan, outcome = excluded.outcome, updated_at = excluded.updated_at,
        closed_at = excluded.closed_at`).run({
      id: task.id, title: task.title, notes: task.notes, doneWhen: JSON.stringify(task.doneWhen),
      expectMinutes: task.expectMinutes ?? null, state: task.state, round: task.round,
      sessionId: task.sessionId ?? null, agentId: task.agentId ?? null, cwd: task.cwd ?? null,
      model: task.model ?? null, reasoningEffort: task.reasoningEffort ?? null,
      plan: task.plan ? 1 : 0, outcome: task.outcome ?? null,
      createdAt: task.createdAt, updatedAt: task.updatedAt, closedAt: task.closedAt ?? null
    });
  }

  deleteTask(id: string) { this.sqlite.prepare('DELETE FROM assistant_tasks WHERE id = ?').run(id); }

  addReview(taskId: string, verdict: TaskReviewRecord['verdict'], checks: TaskCheck[], note?: string): TaskReviewRecord {
    const record: TaskReviewRecord = {
      id: makeId('areview'), taskId, verdict, checks,
      ...(note ? { note } : {}), createdAt: now()
    };
    this.sqlite.prepare('INSERT INTO assistant_reviews (id, task_id, verdict, checks, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, record.taskId, record.verdict, JSON.stringify(record.checks), record.note ?? null, record.createdAt);
    return record;
  }

  listReviews(taskId: string): TaskReviewRecord[] {
    return (this.sqlite.prepare('SELECT * FROM assistant_reviews WHERE task_id = ? ORDER BY created_at').all(taskId) as Array<{
      id: string; task_id: string; verdict: string; checks: string; note: string | null; created_at: string;
    }>).map(row => ({
      id: row.id, taskId: row.task_id, verdict: row.verdict as TaskReviewRecord['verdict'],
      checks: parseJson<TaskCheck[]>(row.checks, []), ...(row.note ? { note: row.note } : {}), createdAt: row.created_at
    }));
  }

  listWatches(): WatchRecord[] {
    return (this.sqlite.prepare('SELECT * FROM assistant_watches ORDER BY created_at DESC').all() as WatchRow[]).map(watchFromRow);
  }

  getWatch(id: string): WatchRecord | undefined {
    const row = this.sqlite.prepare('SELECT * FROM assistant_watches WHERE id = ?').get(id) as WatchRow | undefined;
    return row ? watchFromRow(row) : undefined;
  }

  createWatch(input: {
    ownerSessionId: string; name: string; command: string; cwd?: string;
    intervalSeconds: number; timeoutSeconds: number; mode: WatchMode;
    cooldownSeconds: number; expiresAt?: string;
  }): WatchRecord {
    const stamp = now();
    const watch: WatchRecord = {
      id: makeId('awatch'), ownerSessionId: input.ownerSessionId, name: input.name,
      command: input.command, ...(input.cwd ? { cwd: input.cwd } : {}),
      intervalSeconds: input.intervalSeconds, timeoutSeconds: input.timeoutSeconds,
      mode: input.mode, cooldownSeconds: input.cooldownSeconds, state: 'active',
      failCount: 0, fireCount: 0,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      createdAt: stamp, updatedAt: stamp
    };
    this.saveWatch(watch);
    return watch;
  }

  /**
   * 交接时把 watch 转给新主会话。saveWatch 的 upsert 故意不改 owner：
   * 正在执行的 watch 拿着旧对象回写时，不会把交接结果冲掉。
   */
  setWatchOwner(id: string, ownerSessionId: string): boolean {
    return this.sqlite.prepare('UPDATE assistant_watches SET owner_session_id = ?, updated_at = ? WHERE id = ?').run(ownerSessionId, now(), id).changes > 0;
  }

  saveWatch(watch: WatchRecord) {
    watch.updatedAt = now();
    this.sqlite.prepare(`INSERT INTO assistant_watches
      (id, owner_session_id, name, command, cwd, interval_seconds, timeout_seconds, mode,
       cooldown_seconds, state, last_run_at, last_exit_code, last_output, fail_count, fire_count,
       expires_at, created_at, updated_at)
      VALUES (@id, @ownerSessionId, @name, @command, @cwd, @intervalSeconds, @timeoutSeconds, @mode,
       @cooldownSeconds, @state, @lastRunAt, @lastExitCode, @lastOutput, @failCount, @fireCount,
       @expiresAt, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, command = excluded.command, cwd = excluded.cwd,
        interval_seconds = excluded.interval_seconds, timeout_seconds = excluded.timeout_seconds,
        mode = excluded.mode, cooldown_seconds = excluded.cooldown_seconds, state = excluded.state,
        last_run_at = excluded.last_run_at, last_exit_code = excluded.last_exit_code,
        last_output = excluded.last_output, fail_count = excluded.fail_count,
        fire_count = excluded.fire_count, expires_at = excluded.expires_at, updated_at = excluded.updated_at`).run({
      id: watch.id, ownerSessionId: watch.ownerSessionId, name: watch.name, command: watch.command,
      cwd: watch.cwd ?? null, intervalSeconds: watch.intervalSeconds, timeoutSeconds: watch.timeoutSeconds,
      mode: watch.mode, cooldownSeconds: watch.cooldownSeconds, state: watch.state,
      lastRunAt: watch.lastRunAt ?? null, lastExitCode: watch.lastExitCode ?? null,
      lastOutput: watch.lastOutput ?? null, failCount: watch.failCount, fireCount: watch.fireCount,
      expiresAt: watch.expiresAt ?? null, createdAt: watch.createdAt, updatedAt: watch.updatedAt
    });
  }

  deleteWatch(id: string) { this.sqlite.prepare('DELETE FROM assistant_watches WHERE id = ?').run(id); }

  listDrafts(): DraftRecord[] {
    return (this.sqlite.prepare('SELECT * FROM assistant_drafts ORDER BY created_at DESC').all() as DraftRow[]).map(draftFromRow);
  }

  getDraft(id: string): DraftRecord | undefined {
    const row = this.sqlite.prepare('SELECT * FROM assistant_drafts WHERE id = ?').get(id) as DraftRow | undefined;
    return row ? draftFromRow(row) : undefined;
  }

  createDraft(input: {
    taskId?: string; channel: DraftRecord['channel']; target: string; body: string;
    idempotencyKey?: string; createdBy?: string;
  }): DraftRecord {
    const draft: DraftRecord = {
      id: makeId('adraft'),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      channel: input.channel, target: input.target, body: input.body, state: 'pending',
      idempotencyKey: input.idempotencyKey ?? makeId('adraft-idem'),
      attempts: 0,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      createdAt: now()
    };
    this.saveDraft(draft);
    return draft;
  }

  saveDraft(draft: DraftRecord) {
    this.sqlite.prepare(`INSERT INTO assistant_drafts
      (id, task_id, channel, target, body, state, idempotency_key, attempts, last_error, created_by, created_at, sent_at)
      VALUES (@id, @taskId, @channel, @target, @body, @state, @idempotencyKey, @attempts, @lastError, @createdBy, @createdAt, @sentAt)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state, attempts = excluded.attempts, last_error = excluded.last_error,
        sent_at = excluded.sent_at`).run({
      id: draft.id, taskId: draft.taskId ?? null, channel: draft.channel, target: draft.target,
      body: draft.body, state: draft.state, idempotencyKey: draft.idempotencyKey,
      attempts: draft.attempts, lastError: draft.lastError ?? null, createdBy: draft.createdBy ?? null,
      createdAt: draft.createdAt, sentAt: draft.sentAt ?? null
    });
  }

  addNotification(text: string, ask: boolean, urgent: boolean, state: 'sent' | 'pending' | 'failed') {
    const id = makeId('anotify');
    this.sqlite.prepare('INSERT INTO assistant_notifications (id, text, ask, urgent, state, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, text, ask ? 1 : 0, urgent ? 1 : 0, state, now(), state === 'sent' ? now() : null);
    return id;
  }

  listPendingNotifications(): Array<{ id: string; text: string; ask: boolean; urgent: boolean; createdAt: string }> {
    return (this.sqlite.prepare("SELECT id, text, ask, urgent, created_at FROM assistant_notifications WHERE state = 'pending' ORDER BY created_at").all() as Array<{
      id: string; text: string; ask: number; urgent: number; created_at: string;
    }>).map(row => ({ id: row.id, text: row.text, ask: row.ask === 1, urgent: row.urgent === 1, createdAt: row.created_at }));
  }

  markNotificationSent(id: string) {
    this.sqlite.prepare("UPDATE assistant_notifications SET state = 'sent', sent_at = ? WHERE id = ?").run(now(), id);
  }

  // ---- 归档区：已关闭便签折叠进批次，只读、可取出 ----

  /** 只折叠已关闭且还没归档的；返回真正折叠了的 id（重复调用幂等）。 */
  archiveTasks(taskIds: string[], batchId: string, at: string): string[] {
    const archived: string[] = [];
    const update = this.sqlite.prepare("UPDATE assistant_tasks SET archived_at = ?, archive_batch_id = ? WHERE id = ? AND state = 'closed' AND archived_at IS NULL");
    for (const id of new Set(taskIds)) if (update.run(at, batchId, id).changes > 0) archived.push(id);
    return archived;
  }

  /** restoredAt 只在用户亲手取出时给：交接回滚把便签放回原处不算用户的决定。 */
  unarchiveTasks(taskIds: string[], restoredAt?: string): string[] {
    const restored: string[] = [];
    const update = this.sqlite.prepare('UPDATE assistant_tasks SET archived_at = NULL, archive_batch_id = NULL, restored_at = COALESCE(?, restored_at) WHERE id = ? AND archived_at IS NOT NULL');
    for (const id of new Set(taskIds)) if (update.run(restoredAt ?? null, id).changes > 0) restored.push(id);
    return restored;
  }

  saveArchiveBatch(batch: ArchiveBatch) {
    this.sqlite.prepare(`INSERT INTO assistant_archive_batches (id, source, reason, handoff_id, run_id, task_ids, created_at, undone_at)
      VALUES (@id, @source, @reason, @handoffId, @runId, @taskIds, @createdAt, @undoneAt)
      ON CONFLICT(id) DO UPDATE SET task_ids = excluded.task_ids, undone_at = excluded.undone_at, reason = excluded.reason`).run({
      id: batch.id, source: batch.source, reason: batch.reason ?? null, handoffId: batch.handoffId ?? null, runId: batch.runId ?? null,
      taskIds: JSON.stringify(batch.taskIds), createdAt: batch.createdAt, undoneAt: batch.undoneAt ?? null
    });
  }

  getArchiveBatch(id: string): ArchiveBatch | undefined {
    const row = this.sqlite.prepare('SELECT * FROM assistant_archive_batches WHERE id = ?').get(id) as ArchiveBatchRow | undefined;
    return row ? archiveBatchFromRow(row) : undefined;
  }

  listArchiveBatches(limit = 200): ArchiveBatch[] {
    return (this.sqlite.prepare('SELECT * FROM assistant_archive_batches ORDER BY created_at DESC LIMIT ?').all(limit) as ArchiveBatchRow[]).map(archiveBatchFromRow);
  }

  // ---- 血缘 ----

  listCats(): CatRecord[] {
    return (this.sqlite.prepare('SELECT * FROM assistant_lineage ORDER BY created_at ASC').all() as CatRow[]).map(catFromRow);
  }

  getCat(id: string): CatRecord | undefined {
    const row = this.sqlite.prepare('SELECT * FROM assistant_lineage WHERE id = ?').get(id) as CatRow | undefined;
    return row ? catFromRow(row) : undefined;
  }

  /** 同一个会话只会对应一只「活着」的猫；退休/中止的记录留作血缘。 */
  findCatBySession(sessionId: string, states: CatState[] = ['active']): CatRecord | undefined {
    const rows = this.sqlite.prepare('SELECT * FROM assistant_lineage WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as CatRow[];
    const row = rows.find(item => states.includes(item.state as CatState));
    return row ? catFromRow(row) : undefined;
  }

  saveCat(cat: CatRecord) {
    cat.updatedAt = now();
    this.sqlite.prepare(`INSERT INTO assistant_lineage
      (id, family_id, generation, session_id, name, agent_id, model, reasoning_effort, cwd, state, life_stage, peak_age_score,
       rounds, adopted_at, retired_at, retired_reason, predecessor_id, successor_id, handoff_id, created_at, updated_at)
      VALUES (@id, @familyId, @generation, @sessionId, @name, @agentId, @model, @reasoningEffort, @cwd, @state, @lifeStage, @peakAgeScore,
       @rounds, @adoptedAt, @retiredAt, @retiredReason, @predecessorId, @successorId, @handoffId, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, agent_id = excluded.agent_id, model = excluded.model, reasoning_effort = excluded.reasoning_effort,
        cwd = excluded.cwd, state = excluded.state, life_stage = excluded.life_stage, peak_age_score = excluded.peak_age_score,
        rounds = excluded.rounds, retired_at = excluded.retired_at, retired_reason = excluded.retired_reason,
        predecessor_id = excluded.predecessor_id, successor_id = excluded.successor_id, handoff_id = excluded.handoff_id,
        updated_at = excluded.updated_at`).run({
      id: cat.id, familyId: cat.familyId, generation: cat.generation, sessionId: cat.sessionId, name: cat.name,
      agentId: cat.agentId ?? null, model: cat.model ?? null, reasoningEffort: cat.reasoningEffort ?? null, cwd: cat.cwd ?? null,
      state: cat.state, lifeStage: cat.lifeStage, peakAgeScore: cat.peakAgeScore, rounds: cat.rounds, adoptedAt: cat.adoptedAt,
      retiredAt: cat.retiredAt ?? null, retiredReason: cat.retiredReason ?? null, predecessorId: cat.predecessorId ?? null,
      successorId: cat.successorId ?? null, handoffId: cat.handoffId ?? null, createdAt: cat.createdAt, updatedAt: cat.updatedAt
    });
  }

  // ---- 交接仪式 ----

  getHandoff(id: string): HandoffRecord | undefined {
    const row = this.sqlite.prepare('SELECT * FROM assistant_handoffs WHERE id = ?').get(id) as HandoffRow | undefined;
    return row ? handoffFromRow(row) : undefined;
  }

  listHandoffs(limit = 50): HandoffRecord[] {
    return (this.sqlite.prepare('SELECT * FROM assistant_handoffs ORDER BY created_at DESC LIMIT ?').all(limit) as HandoffRow[]).map(handoffFromRow);
  }

  /** 未结束的那一单（同一时刻最多一单）。 */
  openHandoff(): HandoffRecord | undefined {
    const row = this.sqlite.prepare("SELECT * FROM assistant_handoffs WHERE state NOT IN ('done', 'rolled_back', 'cancelled') ORDER BY created_at DESC LIMIT 1").get() as HandoffRow | undefined;
    return row ? handoffFromRow(row) : undefined;
  }

  saveHandoff(record: HandoffRecord) {
    record.updatedAt = now();
    this.sqlite.prepare(`INSERT INTO assistant_handoffs
      (id, state, outcome, trigger, reason, from_cat_id, from_session_id, to_cat_id, to_session_id, successor_name, metrics, reasons,
       package, archive_batch_id, briefing_task_id, steps, error, created_at, updated_at, confirmed_at, completed_at)
      VALUES (@id, @state, @outcome, @trigger, @reason, @fromCatId, @fromSessionId, @toCatId, @toSessionId, @successorName, @metrics, @reasons,
       @package, @archiveBatchId, @briefingTaskId, @steps, @error, @createdAt, @updatedAt, @confirmedAt, @completedAt)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state, outcome = excluded.outcome, reason = excluded.reason, to_cat_id = excluded.to_cat_id,
        to_session_id = excluded.to_session_id, successor_name = excluded.successor_name, metrics = excluded.metrics,
        reasons = excluded.reasons, package = excluded.package, archive_batch_id = excluded.archive_batch_id,
        briefing_task_id = excluded.briefing_task_id, steps = excluded.steps, error = excluded.error,
        updated_at = excluded.updated_at, confirmed_at = excluded.confirmed_at, completed_at = excluded.completed_at`).run({
      id: record.id, state: record.state, outcome: record.outcome ?? null, trigger: record.trigger, reason: record.reason ?? null,
      fromCatId: record.fromCatId, fromSessionId: record.fromSessionId, toCatId: record.toCatId ?? null, toSessionId: record.toSessionId ?? null,
      successorName: record.successorName ?? null, metrics: JSON.stringify(record.metrics), reasons: JSON.stringify(record.reasons),
      package: record.package ? JSON.stringify(record.package) : null, archiveBatchId: record.archiveBatchId ?? null,
      briefingTaskId: record.briefingTaskId ?? null, steps: JSON.stringify(record.steps), error: record.error ?? null,
      createdAt: record.createdAt, updatedAt: record.updatedAt, confirmedAt: record.confirmedAt ?? null, completedAt: record.completedAt ?? null
    });
  }

  /** 条件抢占：只有当前仍是 from 才改成 to。重复确认、并发确认只有一个能成功。 */
  compareAndSetHandoffState(id: string, from: HandoffState, to: HandoffState): boolean {
    return this.sqlite.prepare('UPDATE assistant_handoffs SET state = ?, updated_at = ? WHERE id = ? AND state = ?').run(to, now(), id, from).changes > 0;
  }

  listTransfers(handoffId: string): TransferRecord[] {
    return (this.sqlite.prepare('SELECT * FROM assistant_transfers WHERE handoff_id = ? ORDER BY created_at ASC, rowid ASC').all(handoffId) as TransferRow[]).map(transferFromRow);
  }

  getTransfer(handoffId: string, kind: TransferKind, itemId: string): TransferRecord | undefined {
    const row = this.sqlite.prepare('SELECT * FROM assistant_transfers WHERE handoff_id = ? AND kind = ? AND item_id = ?').get(handoffId, kind, itemId) as TransferRow | undefined;
    return row ? transferFromRow(row) : undefined;
  }

  saveTransfer(record: TransferRecord) {
    record.updatedAt = now();
    this.sqlite.prepare(`INSERT INTO assistant_transfers (id, handoff_id, kind, item_id, title, status, detail, previous, created_at, updated_at)
      VALUES (@id, @handoffId, @kind, @itemId, @title, @status, @detail, @previous, @createdAt, @updatedAt)
      ON CONFLICT(handoff_id, kind, item_id) DO UPDATE SET
        title = excluded.title, status = excluded.status, detail = excluded.detail, previous = excluded.previous, updated_at = excluded.updated_at`).run({
      id: record.id, handoffId: record.handoffId, kind: record.kind, itemId: record.itemId, title: record.title,
      status: record.status, detail: record.detail ?? null, previous: record.previous ? JSON.stringify(record.previous) : null,
      createdAt: record.createdAt, updatedAt: record.updatedAt
    });
  }

  // ---- 整理轮次 ----

  saveMaintenanceRun(run: MaintenanceRun) {
    run.updatedAt = now();
    this.sqlite.prepare(`INSERT INTO assistant_maintenance_runs
      (id, trigger, state, reason, reasons, session_id, cat_id, runtime_task_id, summary, error, archive_batch_id, created_at, updated_at, completed_at)
      VALUES (@id, @trigger, @state, @reason, @reasons, @sessionId, @catId, @runtimeTaskId, @summary, @error, @archiveBatchId, @createdAt, @updatedAt, @completedAt)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state, runtime_task_id = excluded.runtime_task_id, summary = excluded.summary, error = excluded.error,
        archive_batch_id = excluded.archive_batch_id, updated_at = excluded.updated_at, completed_at = excluded.completed_at`).run({
      id: run.id, trigger: run.trigger, state: run.state, reason: run.reason ?? null, reasons: JSON.stringify(run.reasons),
      sessionId: run.sessionId, catId: run.catId ?? null, runtimeTaskId: run.runtimeTaskId ?? null, summary: run.summary ?? null,
      error: run.error ?? null, archiveBatchId: run.archiveBatchId ?? null, createdAt: run.createdAt, updatedAt: run.updatedAt,
      completedAt: run.completedAt ?? null
    });
  }

  getMaintenanceRun(id: string): MaintenanceRun | undefined {
    const row = this.sqlite.prepare('SELECT * FROM assistant_maintenance_runs WHERE id = ?').get(id) as MaintenanceRow | undefined;
    return row ? maintenanceFromRow(row) : undefined;
  }

  listMaintenanceRuns(limit = 20): MaintenanceRun[] {
    return (this.sqlite.prepare('SELECT * FROM assistant_maintenance_runs ORDER BY created_at DESC LIMIT ?').all(limit) as MaintenanceRow[]).map(maintenanceFromRow);
  }

  activeMaintenanceRun(): MaintenanceRun | undefined {
    const row = this.sqlite.prepare("SELECT * FROM assistant_maintenance_runs WHERE state = 'running' ORDER BY created_at DESC LIMIT 1").get() as MaintenanceRow | undefined;
    return row ? maintenanceFromRow(row) : undefined;
  }
}

type ArchiveBatchRow = {
  id: string; source: string; reason: string | null; handoff_id: string | null; run_id: string | null;
  task_ids: string; created_at: string; undone_at: string | null;
};

const archiveBatchFromRow = (row: ArchiveBatchRow): ArchiveBatch => ({
  id: row.id, source: row.source as ArchiveSource,
  ...(row.reason ? { reason: row.reason } : {}),
  ...(row.handoff_id ? { handoffId: row.handoff_id } : {}),
  ...(row.run_id ? { runId: row.run_id } : {}),
  taskIds: parseJson<string[]>(row.task_ids, []),
  createdAt: row.created_at,
  ...(row.undone_at ? { undoneAt: row.undone_at } : {})
});

type CatRow = {
  id: string; family_id: string; generation: number; session_id: string; name: string; agent_id: string | null;
  model: string | null; reasoning_effort: string | null; cwd: string | null; state: string; life_stage: string;
  peak_age_score: number; rounds: number; adopted_at: string; retired_at: string | null; retired_reason: string | null;
  predecessor_id: string | null; successor_id: string | null; handoff_id: string | null; created_at: string; updated_at: string;
};

const catFromRow = (row: CatRow): CatRecord => ({
  id: row.id, familyId: row.family_id, generation: row.generation, sessionId: row.session_id, name: row.name,
  ...(row.agent_id ? { agentId: row.agent_id } : {}),
  ...(row.model ? { model: row.model } : {}),
  ...(row.reasoning_effort ? { reasoningEffort: row.reasoning_effort } : {}),
  ...(row.cwd ? { cwd: row.cwd } : {}),
  state: row.state as CatState, lifeStage: row.life_stage as LifeStage, peakAgeScore: row.peak_age_score,
  rounds: row.rounds, adoptedAt: row.adopted_at,
  ...(row.retired_at ? { retiredAt: row.retired_at } : {}),
  ...(row.retired_reason ? { retiredReason: row.retired_reason } : {}),
  ...(row.predecessor_id ? { predecessorId: row.predecessor_id } : {}),
  ...(row.successor_id ? { successorId: row.successor_id } : {}),
  ...(row.handoff_id ? { handoffId: row.handoff_id } : {}),
  createdAt: row.created_at, updatedAt: row.updated_at
});

type HandoffRow = {
  id: string; state: string; outcome: string | null; trigger: string; reason: string | null;
  from_cat_id: string; from_session_id: string; to_cat_id: string | null; to_session_id: string | null;
  successor_name: string | null; metrics: string; reasons: string; package: string | null; archive_batch_id: string | null;
  briefing_task_id: string | null; steps: string; error: string | null; created_at: string; updated_at: string;
  confirmed_at: string | null; completed_at: string | null;
};

const handoffFromRow = (row: HandoffRow): HandoffRecord => {
  const pkg = parseJson<HandoffPackage | null>(row.package, null);
  return {
    id: row.id, state: row.state as HandoffState,
    ...(row.outcome ? { outcome: row.outcome as HandoffOutcome } : {}),
    trigger: row.trigger as HandoffTrigger,
    ...(row.reason ? { reason: row.reason } : {}),
    fromCatId: row.from_cat_id, fromSessionId: row.from_session_id,
    ...(row.to_cat_id ? { toCatId: row.to_cat_id } : {}),
    ...(row.to_session_id ? { toSessionId: row.to_session_id } : {}),
    ...(row.successor_name ? { successorName: row.successor_name } : {}),
    metrics: parseJson<Partial<LifecycleMetrics>>(row.metrics, {}),
    reasons: parseJson<MetricReason[]>(row.reasons, []),
    ...(pkg ? { package: pkg } : {}),
    ...(row.archive_batch_id ? { archiveBatchId: row.archive_batch_id } : {}),
    ...(row.briefing_task_id ? { briefingTaskId: row.briefing_task_id } : {}),
    steps: parseJson<HandoffStepRecord[]>(row.steps, []),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.confirmed_at ? { confirmedAt: row.confirmed_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {})
  };
};

type TransferRow = {
  id: string; handoff_id: string; kind: string; item_id: string; title: string; status: string;
  detail: string | null; previous: string | null; created_at: string; updated_at: string;
};

const transferFromRow = (row: TransferRow): TransferRecord => {
  const previous = parseJson<Record<string, unknown> | null>(row.previous, null);
  return {
    id: row.id, handoffId: row.handoff_id, kind: row.kind as TransferKind, itemId: row.item_id, title: row.title,
    status: row.status as TransferStatus,
    ...(row.detail ? { detail: row.detail } : {}),
    ...(previous ? { previous } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at
  };
};

type MaintenanceRow = {
  id: string; trigger: string; state: string; reason: string | null; reasons: string; session_id: string;
  cat_id: string | null; runtime_task_id: string | null; summary: string | null; error: string | null;
  archive_batch_id: string | null; created_at: string; updated_at: string; completed_at: string | null;
};

const maintenanceFromRow = (row: MaintenanceRow): MaintenanceRun => ({
  id: row.id, trigger: row.trigger as MaintenanceRun['trigger'], state: row.state as MaintenanceState,
  ...(row.reason ? { reason: row.reason } : {}),
  reasons: parseJson<MetricReason[]>(row.reasons, []),
  sessionId: row.session_id,
  ...(row.cat_id ? { catId: row.cat_id } : {}),
  ...(row.runtime_task_id ? { runtimeTaskId: row.runtime_task_id } : {}),
  ...(row.summary ? { summary: row.summary } : {}),
  ...(row.error ? { error: row.error } : {}),
  ...(row.archive_batch_id ? { archiveBatchId: row.archive_batch_id } : {}),
  createdAt: row.created_at, updatedAt: row.updated_at,
  ...(row.completed_at ? { completedAt: row.completed_at } : {})
});
