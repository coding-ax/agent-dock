import type Database from 'better-sqlite3';
import { basename } from 'node:path';
import type {
  SessionUsageDetail,
  SessionUsageTurn,
  TurnUsageRecord,
  UsageBreakdown,
  UsageBreakdownGroup,
  UsageBreakdownItem,
  UsageDailyPoint,
  UsageQueryFilter,
  UsageRepository,
  UsageSummary,
  UsageTotals
} from '@agent-dock/agent-dock-shared';

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function normalizeUsageDateBound(raw: string | undefined, endOfDay: boolean): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const match = DATE_ONLY_RE.exec(trimmed);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = endOfDay
      ? new Date(year, month, day, 23, 59, 59, 999)
      : new Date(year, month, day, 0, 0, 0, 0);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function computeTps(outputTokens: number, thoughtTokens: number, generationMs: number | null | undefined): number | null {
  if (!generationMs || !Number.isFinite(generationMs) || generationMs <= 0) return null;
  const generated = Math.max(0, outputTokens) + Math.max(0, thoughtTokens);
  if (generated <= 0) return null;
  return Math.round((generated / (generationMs / 1000)) * 10) / 10;
}

type AggRow = {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  thought_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  turn_count: number | null;
  session_count: number | null;
  total_generation_ms: number | null;
  total_duration_ms: number | null;
  gen_output_tokens: number | null;
  gen_thought_tokens: number | null;
};

function rowToTotals(row: AggRow | undefined): UsageTotals {
  const inputTokens = Number(row?.input_tokens ?? 0);
  const outputTokens = Number(row?.output_tokens ?? 0);
  const cacheReadTokens = Number(row?.cache_read_tokens ?? 0);
  const cacheWriteTokens = Number(row?.cache_write_tokens ?? 0);
  const thoughtTokens = Number(row?.thought_tokens ?? 0);
  const totalTokens = Number(row?.total_tokens ?? 0);
  const costUsd = Math.round(Number(row?.cost_usd ?? 0) * 1_000_000) / 1_000_000;
  const turnCount = Number(row?.turn_count ?? 0);
  const sessionCount = Number(row?.session_count ?? 0);
  const totalGenerationMs = Number(row?.total_generation_ms ?? 0);
  const totalDurationMs = Number(row?.total_duration_ms ?? 0);
  const avgTps = computeTps(Number(row?.gen_output_tokens ?? 0), Number(row?.gen_thought_tokens ?? 0), totalGenerationMs);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    thoughtTokens,
    totalTokens,
    costUsd,
    turnCount,
    sessionCount,
    totalGenerationMs,
    totalDurationMs,
    avgTps
  };
}

const AGG_COLUMNS = `
  COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(u.thought_tokens), 0) AS thought_tokens,
  COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
  COALESCE(SUM(COALESCE(u.cost_usd, 0)), 0) AS cost_usd,
  COUNT(*) AS turn_count,
  COUNT(DISTINCT u.session_id) AS session_count,
  COALESCE(SUM(CASE WHEN u.generation_ms > 0 THEN u.generation_ms ELSE 0 END), 0) AS total_generation_ms,
  COALESCE(SUM(CASE WHEN u.duration_ms > 0 THEN u.duration_ms ELSE 0 END), 0) AS total_duration_ms,
  COALESCE(SUM(CASE WHEN u.generation_ms > 0 THEN u.output_tokens ELSE 0 END), 0) AS gen_output_tokens,
  COALESCE(SUM(CASE WHEN u.generation_ms > 0 THEN u.thought_tokens ELSE 0 END), 0) AS gen_thought_tokens
`;

function buildFilterWhere(filter: UsageQueryFilter | undefined) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const fromIso = normalizeUsageDateBound(filter?.from, false);
  const toIso = normalizeUsageDateBound(filter?.to, true);
  if (fromIso) { clauses.push('u.created_at >= ?'); params.push(fromIso); }
  if (toIso) { clauses.push('u.created_at <= ?'); params.push(toIso); }
  if (filter?.agentId?.trim()) { clauses.push('u.agent_id = ?'); params.push(filter.agentId.trim()); }
  if (filter?.sessionId?.trim()) { clauses.push('u.session_id = ?'); params.push(filter.sessionId.trim()); }
  if (filter?.model?.trim()) { clauses.push('u.model = ?'); params.push(filter.model.trim()); }
  if (filter?.project?.trim()) {
    const project = filter.project.trim();
    clauses.push('(u.cwd = ? OR EXISTS (SELECT 1 FROM projects p WHERE p.cwd = u.cwd AND p.name = ?))');
    params.push(project, project);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params, fromIso, toIso };
}

export function initUsageSchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS turn_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT,
      request_id TEXT,
      agent_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      thought_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      duration_ms INTEGER,
      generation_ms INTEGER,
      ttft_ms INTEGER,
      source TEXT NOT NULL DEFAULT 'acp',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS turn_usage_session_request ON turn_usage(session_id, request_id) WHERE request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS turn_usage_created_at ON turn_usage(created_at);
    CREATE INDEX IF NOT EXISTS turn_usage_session_id ON turn_usage(session_id, created_at);
    CREATE INDEX IF NOT EXISTS turn_usage_agent_id ON turn_usage(agent_id, created_at);
    CREATE INDEX IF NOT EXISTS turn_usage_cwd ON turn_usage(cwd, created_at);
  `);
}

function summarizePrompt(prompt: string | null | undefined): string | undefined {
  const line = prompt?.trim().split(/\r?\n/)[0]?.trim();
  if (!line) return undefined;
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

export function createUsageRepository(sqlite: Database.Database): UsageRepository {
  initUsageSchema(sqlite);

  const insertStmt = sqlite.prepare(`
    INSERT OR IGNORE INTO turn_usage (
      id, session_id, task_id, request_id, agent_id, cwd, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thought_tokens, total_tokens,
      cost_usd, duration_ms, generation_ms, ttft_ms, source, created_at
    ) VALUES (
      @id, @sessionId, @taskId, @requestId, @agentId, @cwd, @model,
      @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens, @thoughtTokens, @totalTokens,
      @costUsd, @durationMs, @generationMs, @ttftMs, @source, @createdAt
    )
  `);

  return {
    async save(record: TurnUsageRecord): Promise<boolean> {
      const info = insertStmt.run({
        id: record.id,
        sessionId: record.sessionId,
        taskId: record.taskId ?? null,
        requestId: record.requestId ?? null,
        agentId: record.agentId,
        cwd: record.cwd,
        model: record.model ?? null,
        inputTokens: Math.max(0, Math.round(record.inputTokens)),
        outputTokens: Math.max(0, Math.round(record.outputTokens)),
        cacheReadTokens: Math.max(0, Math.round(record.cacheReadTokens)),
        cacheWriteTokens: Math.max(0, Math.round(record.cacheWriteTokens)),
        thoughtTokens: Math.max(0, Math.round(record.thoughtTokens)),
        totalTokens: Math.max(0, Math.round(record.totalTokens)),
        costUsd: typeof record.costUsd === 'number' && Number.isFinite(record.costUsd) ? record.costUsd : null,
        durationMs: typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? Math.max(0, Math.round(record.durationMs)) : null,
        generationMs: typeof record.generationMs === 'number' && Number.isFinite(record.generationMs) ? Math.max(0, Math.round(record.generationMs)) : null,
        ttftMs: typeof record.ttftMs === 'number' && Number.isFinite(record.ttftMs) ? Math.max(0, Math.round(record.ttftMs)) : null,
        source: record.source || 'acp',
        createdAt: record.createdAt
      });
      return info.changes === 1;
    },

    async getSessionUsage(sessionId: string): Promise<SessionUsageDetail> {
      const session = sqlite.prepare('SELECT agent_id, cwd, model FROM sessions WHERE id = ?').get(sessionId) as
        | { agent_id: string; cwd: string; model: string | null }
        | undefined;
      const agg = sqlite.prepare(`SELECT ${AGG_COLUMNS} FROM turn_usage u WHERE u.session_id = ?`).get(sessionId) as AggRow | undefined;
      const rows = sqlite.prepare(`
        SELECT id, task_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
               thought_tokens, total_tokens, cost_usd, duration_ms, generation_ms, ttft_ms, created_at
        FROM turn_usage
        WHERE session_id = ?
        ORDER BY created_at ASC
      `).all(sessionId) as Array<{
        id: string;
        task_id: string | null;
        model: string | null;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        thought_tokens: number;
        total_tokens: number;
        cost_usd: number | null;
        duration_ms: number | null;
        generation_ms: number | null;
        ttft_ms: number | null;
        created_at: string;
      }>;

      const turns: SessionUsageTurn[] = rows.map(row => ({
        id: row.id,
        taskId: row.task_id,
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        thoughtTokens: row.thought_tokens,
        totalTokens: row.total_tokens,
        costUsd: row.cost_usd,
        durationMs: row.duration_ms,
        generationMs: row.generation_ms,
        ttftMs: row.ttft_ms,
        tps: computeTps(row.output_tokens, row.thought_tokens, row.generation_ms),
        createdAt: row.created_at
      }));

      let lastTps: number | null = null;
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turns[i]!.tps !== null) {
          lastTps = turns[i]!.tps;
          break;
        }
      }

      const totals = { ...rowToTotals(agg), lastTps };
      return {
        sessionId,
        ...(session ? { agentId: session.agent_id, cwd: session.cwd, model: session.model } : {}),
        totals,
        turns
      };
    },

    async summary(filter?: UsageQueryFilter): Promise<UsageSummary> {
      const { where, params, fromIso, toIso } = buildFilterWhere(filter);
      const agg = sqlite.prepare(`SELECT ${AGG_COLUMNS} FROM turn_usage u ${where}`).get(...params) as AggRow | undefined;
      const dailyRows = sqlite.prepare(`
        SELECT date(u.created_at, 'localtime') AS day, ${AGG_COLUMNS}
        FROM turn_usage u
        ${where}
        GROUP BY day
        ORDER BY day ASC
      `).all(...params) as Array<AggRow & { day: string }>;

      const daily: UsageDailyPoint[] = dailyRows.map(row => {
        const totals = rowToTotals(row);
        return {
          date: row.day,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          cacheWriteTokens: totals.cacheWriteTokens,
          thoughtTokens: totals.thoughtTokens,
          totalTokens: totals.totalTokens,
          costUsd: totals.costUsd,
          turnCount: totals.turnCount,
          avgTps: totals.avgTps
        };
      });

      return {
        ...(fromIso ? { from: fromIso } : {}),
        ...(toIso ? { to: toIso } : {}),
        totals: rowToTotals(agg),
        daily
      };
    },

    async breakdown(groupBy: UsageBreakdownGroup, filter?: UsageQueryFilter, limit = 50): Promise<UsageBreakdown> {
      const { where, params, fromIso, toIso } = buildFilterWhere(filter);
      const safeLimit = Math.max(1, Math.min(200, Math.round(limit)));

      if (groupBy === 'project') {
        const rows = sqlite.prepare(`
          SELECT u.cwd AS group_key, MAX(u.created_at) AS last_active_at, ${AGG_COLUMNS}
          FROM turn_usage u
          ${where}
          GROUP BY u.cwd
          ORDER BY total_tokens DESC
          LIMIT ?
        `).all(...params, safeLimit) as Array<AggRow & { group_key: string; last_active_at: string }>;

        const projectNames = new Map<string, string>();
        for (const p of sqlite.prepare('SELECT cwd, name FROM projects').all() as Array<{ cwd: string; name: string }>) {
          projectNames.set(p.cwd, p.name);
        }

        const items: UsageBreakdownItem[] = rows.map(row => ({
          key: row.group_key,
          label: projectNames.get(row.group_key) || basename(row.group_key) || row.group_key,
          sublabel: row.group_key,
          cwd: row.group_key,
          lastActiveAt: row.last_active_at,
          totals: rowToTotals(row)
        }));
        return { groupBy, ...(fromIso ? { from: fromIso } : {}), ...(toIso ? { to: toIso } : {}), items };
      }

      if (groupBy === 'agent') {
        const rows = sqlite.prepare(`
          SELECT u.agent_id AS group_key, MAX(u.created_at) AS last_active_at, ${AGG_COLUMNS}
          FROM turn_usage u
          ${where}
          GROUP BY u.agent_id
          ORDER BY total_tokens DESC
          LIMIT ?
        `).all(...params, safeLimit) as Array<AggRow & { group_key: string; last_active_at: string }>;

        const agentNames = new Map<string, string>();
        for (const a of sqlite.prepare('SELECT id, json FROM agent_configs').all() as Array<{ id: string; json: string }>) {
          try {
            const parsed = JSON.parse(a.json) as { name?: string };
            if (parsed.name) agentNames.set(a.id, parsed.name);
          } catch { /* ignore malformed */ }
        }

        const items: UsageBreakdownItem[] = rows.map(row => ({
          key: row.group_key,
          label: agentNames.get(row.group_key) || row.group_key,
          sublabel: row.group_key,
          agentId: row.group_key,
          lastActiveAt: row.last_active_at,
          totals: rowToTotals(row)
        }));
        return { groupBy, ...(fromIso ? { from: fromIso } : {}), ...(toIso ? { to: toIso } : {}), items };
      }

      if (groupBy === 'model') {
        const rows = sqlite.prepare(`
          SELECT COALESCE(NULLIF(TRIM(u.model), ''), '默认模型') AS group_key,
                 MAX(u.agent_id) AS sample_agent_id,
                 MAX(u.created_at) AS last_active_at,
                 ${AGG_COLUMNS}
          FROM turn_usage u
          ${where}
          GROUP BY group_key
          ORDER BY total_tokens DESC
          LIMIT ?
        `).all(...params, safeLimit) as Array<AggRow & { group_key: string; sample_agent_id: string; last_active_at: string }>;

        const items: UsageBreakdownItem[] = rows.map(row => ({
          key: row.group_key,
          label: row.group_key,
          sublabel: row.sample_agent_id,
          model: row.group_key,
          agentId: row.sample_agent_id,
          lastActiveAt: row.last_active_at,
          totals: rowToTotals(row)
        }));
        return { groupBy, ...(fromIso ? { from: fromIso } : {}), ...(toIso ? { to: toIso } : {}), items };
      }

      // groupBy === 'session'
      const rows = sqlite.prepare(`
        SELECT u.session_id AS group_key,
               MAX(u.agent_id) AS agent_id,
               MAX(u.cwd) AS cwd,
               MAX(u.model) AS model,
               MAX(u.created_at) AS last_active_at,
               ${AGG_COLUMNS}
        FROM turn_usage u
        ${where}
        GROUP BY u.session_id
        ORDER BY total_tokens DESC
        LIMIT ?
      `).all(...params, safeLimit) as Array<AggRow & { group_key: string; agent_id: string; cwd: string; model: string | null; last_active_at: string }>;

      const sessionIds = rows.map(r => r.group_key);
      const titles = new Map<string, string>();
      if (sessionIds.length) {
        const placeholders = sessionIds.map(() => '?').join(',');
        for (const s of sqlite.prepare(`SELECT id, custom_title, agent_title FROM sessions WHERE id IN (${placeholders})`).all(...sessionIds) as Array<{ id: string; custom_title: string | null; agent_title: string | null }>) {
          const t = s.custom_title?.trim() || s.agent_title?.trim();
          if (t) titles.set(s.id, t);
        }
        for (const t of sqlite.prepare(`
          SELECT session_id, prompt FROM tasks
          WHERE session_id IN (${placeholders})
          ORDER BY created_at ASC
        `).all(...sessionIds) as Array<{ session_id: string; prompt: string }>) {
          if (!titles.has(t.session_id)) {
            const summary = summarizePrompt(t.prompt);
            if (summary) titles.set(t.session_id, summary);
          }
        }
      }

      const items: UsageBreakdownItem[] = rows.map(row => ({
        key: row.group_key,
        label: titles.get(row.group_key) || row.group_key,
        sublabel: `${row.agent_id} · ${basename(row.cwd) || row.cwd}`,
        sessionId: row.group_key,
        agentId: row.agent_id,
        cwd: row.cwd,
        ...(row.model ? { model: row.model } : {}),
        lastActiveAt: row.last_active_at,
        totals: rowToTotals(row)
      }));
      return { groupBy, ...(fromIso ? { from: fromIso } : {}), ...(toIso ? { to: toIso } : {}), items };
    }
  };
}
