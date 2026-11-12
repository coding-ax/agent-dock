import { openDatabase } from '@agent-dock/agent-dock-storage';
import { makeId, now } from '@agent-dock/agent-dock-shared';
import type {
  AssistantTask, AssistantTaskOutcome, AssistantTaskState, DraftRecord, DraftState,
  TaskCheck, TaskReviewRecord, WatchMode, WatchRecord, WatchState
} from './types.js';

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
  ...(row.closed_at ? { closedAt: row.closed_at } : {})
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
}
