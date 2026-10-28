import type Database from 'better-sqlite3';
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase, type NativeBindingFallback } from './native.js';
import type { AgentConfig, AgentEvent, RepositoryBundle, ScheduleRecord, ScheduleRunRecord, Session, TaskRecord } from '@agent-dock/agent-dock-shared';
import { agentConfigs, channelMappings, configs, errors, events, machines, permissionRequests, projects, scheduleRuns, schedules, sessions, tasks, toolCalls } from './schema.js';
export * from './native.js';
export * from './schema.js';

type EventRow = { id: string; session_id: string; sequence: number; type: AgentEvent['type']; timestamp: string; data: string; raw: string | null };

const iterateEvents = (sqlite: Database.Database, sessionId: string, afterSequence: number): Iterable<EventRow> =>
  sqlite.prepare('SELECT id, session_id, sequence, type, timestamp, data, raw FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence')
    .iterate(sessionId, afterSequence) as Iterable<EventRow>;

/** 逐行解析成事件。惰性求值，调用方可以边读边用（回放、导出），不必先物化整段历史。 */
function* parseEvents(rows: Iterable<EventRow>): Generator<AgentEvent> {
  for (const row of rows) {
    yield { id: row.id, sessionId: row.session_id, sequence: row.sequence, type: row.type, timestamp: row.timestamp, data: JSON.parse(row.data), raw: row.raw ?? undefined };
  }
}

/**
 * 流式分片的合并。ACP 把正文和思考都按 chunk 推：一句「平台 AI 已就绪。」会拆成六条事件，
 * 历史会话里这种两三字的事件能到百万条。逐行迭代并合并连续片段，避免先把完整结果放进内存。
 *
 * `mergeText` 决定正文是否一起合并：主时间线（listCompacted）保持只合 thinking —— 它那边的
 * 客户端自己折 text；按轮取事件（listCompactedRange）要的是能直接看的一轮，连正文一起合。
 *
 * role 必须参与判定，且 `role:'user'` 一律不并：那是轮次锚点，被并进正文就再也切不回轮次。
 * 合并时新建 data 对象，不改调用方可能正持有的对象。
 *
 * `maxBytes` 是累计原始字节的预算：一轮若塞满整页 HTML 的 tool_result，单轮就能有几 MB
 * （实测最重的一轮 860 段 / 9.5 MB），光靠行数限不住。规则是「加进下一行会超预算就停」，
 * 所以结果不会超过预算加最大的一行——行是原子的，绝不会把一条事件截成半截；且第一行无论
 * 多大都收，否则超大行会让调用方按 nextAfter 续读时原地打转。
 */
function mergeStreamingSegments(rows: Iterable<EventRow>, mergeText: boolean, maxBytes?: number): AgentEvent[] {
  const result: AgentEvent[] = [];
  let pending: AgentEvent<Record<string, unknown>> | undefined;
  let textParts: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (!pending) return;
    result.push({ ...pending, data: { ...pending.data, text: textParts.join('') } });
    pending = undefined;
    textParts = [];
  };
  for (const row of rows) {
    if (maxBytes !== undefined && (result.length || pending) && bytes + row.data.length > maxBytes) {
      flush();
      break;
    }
    bytes += row.data.length;
    const event: AgentEvent<Record<string, unknown>> = { id: row.id, sessionId: row.session_id, sequence: row.sequence, type: row.type, timestamp: row.timestamp, data: JSON.parse(row.data), raw: row.raw ?? undefined };
    const role = event.data.role ?? 'assistant';
    const mergeable = typeof event.data.text === 'string'
      && (event.type === 'thinking' || (mergeText && event.type === 'text' && role !== 'user'));
    if (mergeable) {
      if (pending && (pending.type !== event.type || (pending.data.role ?? 'assistant') !== role)) flush();
      if (!pending) pending = event;
      else { pending.sequence = event.sequence; pending.timestamp = event.timestamp; }
      textParts.push(event.data.text as string);
    } else {
      flush();
      result.push(event);
    }
  }
  flush();
  return result;
}

export function createRepositories(filename: string, options: { nativeFallback?: NativeBindingFallback } = {}): RepositoryBundle {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const sqlite = openDatabase(filename, options.nativeFallback ? { fallback: options.nativeFallback } : {});
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_configs (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, machine_id TEXT, name TEXT NOT NULL, cwd TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, state TEXT NOT NULL, cwd TEXT NOT NULL, model TEXT, reasoning_effort TEXT, system_prompt TEXT, permission_mode TEXT DEFAULT 'full-trust', source TEXT, source_id TEXT, archived_at TEXT, protocol TEXT, last_message_at TEXT, custom_title TEXT, agent_title TEXT, run_id TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, sent_prompt TEXT, final_text TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL, raw TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS events_session_seq ON events(session_id, sequence);
    CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS permission_requests (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS errors (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_mappings (id TEXT PRIMARY KEY, channel TEXT NOT NULL, external_id TEXT NOT NULL, session_id TEXT NOT NULL, extra TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS channel_external ON channel_mappings(channel, external_id);
    CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, name TEXT NOT NULL, session_id TEXT, delivery TEXT NOT NULL, session_template TEXT, cron TEXT, run_at TEXT, timezone TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at TEXT, last_run_at TEXT, last_status TEXT, run_count INTEGER NOT NULL DEFAULT 0, created_by_session_id TEXT, extra TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, next_run_at);
    CREATE TABLE IF NOT EXISTS schedule_runs (id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, fire_at TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, session_id TEXT, task_id TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS schedule_runs_fire ON schedule_runs(schedule_id, fire_at);
  `);
  const sessionColumns = sqlite.pragma('table_info(sessions)') as Array<{ name: string }>;
  if (!sessionColumns.some(column => column.name === 'reasoning_effort')) sqlite.exec('ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT');
  if (!sessionColumns.some(column => column.name === 'system_prompt')) sqlite.exec('ALTER TABLE sessions ADD COLUMN system_prompt TEXT');
  if (!sessionColumns.some(column => column.name === 'permission_mode')) sqlite.exec("ALTER TABLE sessions ADD COLUMN permission_mode TEXT DEFAULT 'full-trust'");
  if (!sessionColumns.some(column => column.name === 'source')) sqlite.exec('ALTER TABLE sessions ADD COLUMN source TEXT');
  if (!sessionColumns.some(column => column.name === 'source_id')) sqlite.exec('ALTER TABLE sessions ADD COLUMN source_id TEXT');
  if (!sessionColumns.some(column => column.name === 'archived_at')) sqlite.exec('ALTER TABLE sessions ADD COLUMN archived_at TEXT');
  // 最后一次对话时间。与 updated_at 分开：updated_at 记录任何状态变化，排序会「最近动过的」压过
  // 「最近聊过的」。增量列，旧库补 ALTER，历史行保持 NULL，由调用方回退 updated_at。
  if (!sessionColumns.some(column => column.name === 'last_message_at')) sqlite.exec('ALTER TABLE sessions ADD COLUMN last_message_at TEXT');
  // 会话名字的两个持久化来源：用户手改的，和 Agent 通过 ACP `session_info_update` 推来的。
  // 显示用的 title 不进库——它是 list 时按「用户 > Agent > 首条 prompt 摘要」现算的，
  // 存下来会和这套回退链打架。旧库补 ALTER，历史行保持 NULL，行为不变。
  if (!sessionColumns.some(column => column.name === 'custom_title')) sqlite.exec('ALTER TABLE sessions ADD COLUMN custom_title TEXT');
  if (!sessionColumns.some(column => column.name === 'agent_title')) sqlite.exec('ALTER TABLE sessions ADD COLUMN agent_title TEXT');
  const taskColumns = sqlite.pragma('table_info(tasks)') as Array<{ name: string }>;
  if (!taskColumns.some(column => column.name === 'sent_prompt')) sqlite.exec('ALTER TABLE tasks ADD COLUMN sent_prompt TEXT');
  // 本轮最终输出。runtime 每轮结尾本来就为了判成败算出了这段文本，落库后轨迹面板不必
  // 为了显示「每轮最终输出」去扫该轮事件（重会话上一轮就是全量扫描）。
  if (!taskColumns.some(column => column.name === 'final_text')) sqlite.exec('ALTER TABLE tasks ADD COLUMN final_text TEXT');
  // feat/schedules 开发期的 beta 包建过 session_id NOT NULL 的旧表：空表直接重建放开约束，有数据则整表搬迁。
  const scheduleSessionColumn = (sqlite.pragma('table_info(schedules)') as Array<{ name: string; notnull: number }>).find(column => column.name === 'session_id');
  if (scheduleSessionColumn?.notnull) sqlite.transaction(() => {
    sqlite.exec('ALTER TABLE schedules RENAME TO schedules_old');
    sqlite.exec('CREATE TABLE schedules (id TEXT PRIMARY KEY, name TEXT NOT NULL, session_id TEXT, delivery TEXT NOT NULL, session_template TEXT, cron TEXT, run_at TEXT, timezone TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at TEXT, last_run_at TEXT, last_status TEXT, run_count INTEGER NOT NULL DEFAULT 0, created_by_session_id TEXT, extra TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    sqlite.exec('INSERT INTO schedules SELECT id, name, session_id, delivery, session_template, cron, run_at, timezone, prompt, enabled, next_run_at, last_run_at, last_status, run_count, created_by_session_id, extra, created_at, updated_at FROM schedules_old');
    sqlite.exec('DROP TABLE schedules_old');
    sqlite.exec('CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, next_run_at)');
  })();
  const scheduleColumns = sqlite.pragma('table_info(schedules)') as Array<{ name: string }>;
  if (!scheduleColumns.some(column => column.name === 'interval_minutes')) sqlite.exec('ALTER TABLE schedules ADD COLUMN interval_minutes INTEGER');
  const channelMappingColumns = sqlite.pragma('table_info(channel_mappings)') as Array<{ name: string }>;
  if (!channelMappingColumns.some(column => column.name === 'extra')) sqlite.exec('ALTER TABLE channel_mappings ADD COLUMN extra TEXT');
  const db = drizzle(sqlite);
  return {
    agents: {
      async list() { return db.select().from(agentConfigs).all().map(r => JSON.parse(r.json)); },
      async get(id) { const r = db.select().from(agentConfigs).where(eq(agentConfigs.id, id)).get(); return r ? JSON.parse(r.json) : undefined; },
      async save(agent) { const time = new Date().toISOString(); db.insert(agentConfigs).values({ id: agent.id, json: JSON.stringify(agent), createdAt: time, updatedAt: time }).onConflictDoUpdate({ target: agentConfigs.id, set: { json: JSON.stringify(agent), updatedAt: time } }).run(); },
      async delete(id) { db.delete(agentConfigs).where(eq(agentConfigs.id, id)).run(); }
    },
    sessions: {
      async list() { return db.select().from(sessions).orderBy(asc(sessions.createdAt)).all() as Session[]; },
      async get(id) { return db.select().from(sessions).where(eq(sessions.id, id)).get() as Session | undefined; },
      /**
       * 整行 upsert。**刻意不写会话名那两列**（custom_title / agent_title）。
       *
       * 因为 `save()` 的入参是「随时可能过期的内存快照」：driver 回调绑定的是注册驱动时的
       * 那个会话对象，而 `runTask` 每次都用 `active()` 重新读一份；两者不是同一个实例。
       * 实测过——Agent 在轮次中途写下的标题，会被本轮收尾那次整行 save 用旧快照覆盖回 null。
       * 会话名因此只走 `saveTitles()` 这条窄路径，任何整行 save 都不可能把它冲掉。
       */
      async save(s) {
        const { customTitle: _customTitle, agentTitle: _agentTitle, ...row } = s;
        db.insert(sessions).values(row).onConflictDoUpdate({ target: sessions.id, set: row }).run();
      },
      /**
       * 会话名的唯一写入口，按列定向更新，不受整行 save 的快照新鲜度影响。
       * 未传的档位保持原值（drizzle 会跳过 undefined），所以「只更新 agent 名」不会动用户手改的名字。
       */
      async saveTitles(id, patch) {
        db.update(sessions).set({ ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() }).where(eq(sessions.id, id)).run();
      }
    },
    tasks: {
      async save(t) { db.insert(tasks).values(t).onConflictDoUpdate({ target: tasks.id, set: t }).run(); },
      async listBySession(sessionId) { return db.select().from(tasks).where(eq(tasks.sessionId, sessionId)).all() as TaskRecord[]; },
      // 列表标题用：每个会话取创建时间最早的一条 task 的 prompt。一次查询、内存归并，
      // 避免按会话 N+1；同刻钟多条取 id 更小者保证稳定。
      async firstPromptBySessions(sessionIds) {
        if (!sessionIds.length) return {};
        const rows = db.select({ sessionId: tasks.sessionId, prompt: tasks.prompt, createdAt: tasks.createdAt, id: tasks.id })
          .from(tasks).where(inArray(tasks.sessionId, sessionIds)).all();
        const earliest = new Map<string, { prompt: string; createdAt: string; id: string }>();
        for (const row of rows) {
          const cur = earliest.get(row.sessionId);
          if (!cur || row.createdAt < cur.createdAt || (row.createdAt === cur.createdAt && row.id < cur.id)) {
            earliest.set(row.sessionId, { prompt: row.prompt, createdAt: row.createdAt, id: row.id });
          }
        }
        return Object.fromEntries([...earliest].map(([sessionId, row]) => [sessionId, row.prompt]));
      }
    },
    events: {
      async append(e) { db.insert(events).values({ ...e, data: JSON.stringify(e.data) }).run(); },
      async list(sessionId, afterSequence = 0) { return db.select().from(events).where(and(eq(events.sessionId, sessionId), gt(events.sequence, afterSequence))).orderBy(asc(events.sequence)).all().map(r => ({ ...r, data: JSON.parse(r.data) })) as AgentEvent[]; },
      // 逐行迭代原始事件。全量回放（SSE 重放、CLI 导出）走它：内存占用与历史长度解耦，
      // 实测 145 万行 / 235 MB 的会话不再需要在服务端整体物化。
      iterate(sessionId, afterSequence = 0) { return parseEvents(iterateEvents(sqlite, sessionId, afterSequence)); },
      async listCompacted(sessionId, afterSequence = 0) {
        // 历史会话可能含百万条几字长的 thinking delta。逐行迭代并合并连续片段，
        // 避免先把完整结果放进内存，再序列化几百 MB 给浏览器。
        return mergeStreamingSegments(iterateEvents(sqlite, sessionId, afterSequence), false);
      },
      async listCompactedRange(sessionId, { after, before, limit, maxBytes }) {
        // 按轮取事件：范围两端都是排他的（after 是上一轮锚点/本轮锚点，before 是下一轮锚点），
        // 且入参带 limit —— 单轮过程最多上万条分片，不设上限同样能拖垮服务端。
        const rows = sqlite.prepare('SELECT id, session_id, sequence, type, timestamp, data, raw FROM events WHERE session_id = ? AND sequence > ? AND sequence < ? ORDER BY sequence LIMIT ?')
          .iterate(sessionId, after, before, limit) as Iterable<EventRow>;
        // 这里连 text 一起合并（主时间线不合并，由客户端折）：调用方要的是「这一轮发生了什么」，
        // 拿一堆半句话的正文分片没法看。
        return mergeStreamingSegments(rows, true, maxBytes);
      },
      // 原始事件（不合并）的范围读，两端排他，**不带行数与字节上限**：终态判定必须看全一整轮，
      // 截断会把「有最终输出」误判成没有最终输出。范围由锚点图或锚点序号给出，上界是确定的，
      // 所以这里的无上限只覆盖「一轮」，不覆盖「整个会话」。
      async listRange(sessionId, { after, before }) {
        const rows = sqlite.prepare('SELECT id, session_id, sequence, type, timestamp, data, raw FROM events WHERE session_id = ? AND sequence > ? AND sequence < ? ORDER BY sequence')
          .iterate(sessionId, after, before) as Iterable<EventRow>;
        return [...parseEvents(rows)];
      },
      // 有界前向分页读：一次把 limit 行**同步读完并 finalize 迭代器**，绝不让 better-sqlite3 的
      // statement 跨 await 存活。流式回放必须走它——同一条连接上只要还有个未结束的迭代器，
      // 任何 events.append / saveState 都会抛 "This database connection is busy executing a query"，
      // 能把别的会话正在跑的一轮判失败。分页读取一样与历史长度解耦，代价只是多几次查询。
      async listPage(sessionId, { after, limit }) {
        const rows = sqlite.prepare('SELECT id, session_id, sequence, type, timestamp, data, raw FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
          .iterate(sessionId, after, limit) as Iterable<EventRow>;
        return [...parseEvents(rows)];
      },
      async listRecent(sessionId, limit, beforeSequence) {        const rows = db.select().from(events).where(and(eq(events.sessionId, sessionId), beforeSequence === undefined ? undefined : lt(events.sequence, beforeSequence))).orderBy(desc(events.sequence)).limit(limit).all();
        return rows.reverse().map(r => ({ ...r, data: JSON.parse(r.data) })) as AgentEvent[];
      },
      // 只回行数：给「被截断的读取」标出总量，告诉用户手里这份不是全部。走 session_id 索引，
      // 不把任何一行读进内存。
      async countBySession(sessionId) {
        return (sqlite.prepare('SELECT count(*) AS total FROM events WHERE session_id = ?').get(sessionId) as { total: number }).total;
      },
      async maxSequence(sessionId) {
        return (sqlite.prepare('SELECT coalesce(max(sequence), 0) AS max FROM events WHERE session_id = ?').get(sessionId) as { max: number }).max;
      },
      /**
       * 单个 taskId 的轮次边界。锚点是每轮唯一的可靠标记，所以找不到锚点就是找不到这一轮
       * ——返回 undefined，让调用方承认不知道，不要退化成「整个会话都算它的」。
       */
      async turnRange(sessionId, taskId) {
        const anchor = sqlite.prepare(`
          SELECT sequence FROM events
          WHERE session_id = ? AND type = 'text'
            AND json_extract(data, '$.role') = 'user' AND json_extract(data, '$.taskId') = ?
          LIMIT 1
        `).get(sessionId, taskId) as { sequence: number } | undefined;
        if (!anchor) return undefined;
        // 下一轮锚点即本轮排他上界；末轮没有下一轮，用该会话最大序号 +1。
        const next = sqlite.prepare(`
          SELECT min(sequence) AS next FROM events
          WHERE session_id = ? AND sequence > ? AND type = 'text'
            AND json_extract(data, '$.role') = 'user' AND json_extract(data, '$.taskId') IS NOT NULL
        `).get(sessionId, anchor.sequence) as { next: number | null };
        const max = (sqlite.prepare('SELECT coalesce(max(sequence), 0) AS max FROM events WHERE session_id = ?').get(sessionId) as { max: number }).max;
        return { startSequence: anchor.sequence, endSequence: next.next ?? max + 1 };
      },
      async listTurns(sessionId) {
        // 轮次边界只能靠锚点事件认：runtime 每轮开始必写一条
        // `text` + `role:'user'` + `taskId` 的事件（packages/agent-runtime/src/index.ts 里
        // 紧随「落 running 状态」之后的那次 emit），这是唯一可靠的按轮切分依据——
        // `events.task_id` 那列是历史遗留、全为 null，不能用来切。
        const anchors = sqlite.prepare(`
          SELECT sequence, json_extract(data, '$.taskId') AS task_id
          FROM events
          WHERE session_id = ? AND type = 'text'
            AND json_extract(data, '$.role') = 'user'
            AND json_extract(data, '$.taskId') IS NOT NULL
          ORDER BY sequence
        `).all(sessionId) as Array<{ sequence: number; task_id: string }>;
        if (!anchors.length) return [];
        const max = (sqlite.prepare('SELECT coalesce(max(sequence), 0) AS max FROM events WHERE session_id = ?').get(sessionId) as { max: number }).max;
        // 每轮的过程条数单独数一次：count(*) 只走索引、不解析 JSON，一轮一次远比
        // 「拉回来再算」便宜，面板靠它决定这一轮有没有东西可展开、展开大约多大。
        const countRange = sqlite.prepare('SELECT count(*) AS n FROM events WHERE session_id = ? AND sequence > ? AND sequence < ?');
        return anchors.map((anchor, index) => {
          // 末轮没有下一条锚点，用会话最大序号 +1 当排他上界，保证覆盖到最后一轮。
          const endSequence = anchors[index + 1]?.sequence ?? max + 1;
          const segments = (countRange.get(sessionId, anchor.sequence, endSequence) as { n: number }).n;
          return { taskId: anchor.task_id, startSequence: anchor.sequence, endSequence, segments };
        });
      }
    },
    config: {
      async get(key) { return db.select().from(configs).where(eq(configs.key, key)).get()?.value; },
      async set(key, value) { db.insert(configs).values({ key, value }).onConflictDoUpdate({ target: configs.key, set: { value } }).run(); },
      async compareAndSet(key, expected, value) {
        const result = expected === undefined
          ? db.insert(configs).values({ key, value }).onConflictDoNothing().run()
          : db.update(configs).set({ value }).where(and(eq(configs.key, key), eq(configs.value, expected))).run();
        return result.changes === 1;
      }
    },
    channelMappings: {
      async get(channel, externalId) { return db.select().from(channelMappings).where(and(eq(channelMappings.channel, channel), eq(channelMappings.externalId, externalId))).get(); },
      async list(channel) { return db.select().from(channelMappings).where(eq(channelMappings.channel, channel)).all(); },
      async save(mapping) { db.insert(channelMappings).values(mapping).onConflictDoUpdate({ target: channelMappings.id, set: mapping }).run(); }
    },
    schedules: {
      async list() { return db.select().from(schedules).orderBy(asc(schedules.createdAt)).all() as ScheduleRecord[]; },
      async get(id) { return db.select().from(schedules).where(eq(schedules.id, id)).get() as ScheduleRecord | undefined; },
      async save(schedule) { db.insert(schedules).values(schedule).onConflictDoUpdate({ target: schedules.id, set: schedule }).run(); },
      async delete(id) { db.delete(schedules).where(eq(schedules.id, id)).run(); },
      async listDue(at) {
        return db.select().from(schedules)
          .where(and(eq(schedules.enabled, true), isNotNull(schedules.nextRunAt), lte(schedules.nextRunAt, at)))
          .orderBy(asc(schedules.nextRunAt)).all() as ScheduleRecord[];
      },
      async claim(id, expected, next, at) {
        const result = db.update(schedules).set({ nextRunAt: next, updatedAt: at })
          .where(and(eq(schedules.id, id), eq(schedules.nextRunAt, expected), eq(schedules.enabled, true))).run();
        return result.changes === 1;
      },
      async addRun(run) { return db.insert(scheduleRuns).values(run).onConflictDoNothing().run().changes === 1; },
      async updateRun(run) { db.update(scheduleRuns).set(run).where(eq(scheduleRuns.id, run.id)).run(); },
      async listRuns(scheduleId, limit = 20) {
        return db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, scheduleId)).orderBy(desc(scheduleRuns.fireAt)).limit(limit).all() as ScheduleRunRecord[];
      },
      async listRecentRuns(limit, scheduleIds) {
        if (scheduleIds && !scheduleIds.length) return [];
        const query = db.select().from(scheduleRuns);
        return (scheduleIds ? query.where(inArray(scheduleRuns.scheduleId, scheduleIds)) : query).orderBy(desc(scheduleRuns.fireAt)).limit(limit).all() as ScheduleRunRecord[];
      }
    },
    artifacts: {
      async ensureLocalProject(cwd) { const time = new Date().toISOString(); db.insert(machines).values({ id: 'local', name: 'Local machine', metadata: '{}', createdAt: time, updatedAt: time }).onConflictDoNothing().run(); db.insert(projects).values({ id: `local:${cwd}`, machineId: 'local', name: cwd.split('/').filter(Boolean).at(-1) ?? cwd, cwd, createdAt: time, updatedAt: time }).onConflictDoUpdate({ target: projects.id, set: { cwd, updatedAt: time } }).run(); },
      async saveToolCall(sessionId, data) { const time = new Date().toISOString(); db.insert(toolCalls).values({ id: `${sessionId}:${data.id}`, sessionId, data: JSON.stringify(data), createdAt: data.startedAt ?? time, updatedAt: time }).onConflictDoUpdate({ target: toolCalls.id, set: { data: JSON.stringify(data), updatedAt: time } }).run(); },
      async savePermission(sessionId, data) { const time = new Date().toISOString(); db.insert(permissionRequests).values({ id: `${sessionId}:${data.id}`, sessionId, status: data.status, data: JSON.stringify(data), createdAt: time, updatedAt: time }).onConflictDoUpdate({ target: permissionRequests.id, set: { status: data.status, data: JSON.stringify(data), updatedAt: time } }).run(); },
      async saveError(sessionId, message, details) { db.insert(errors).values({ id: `error:${crypto.randomUUID()}`, sessionId, message, details: details === undefined ? undefined : JSON.stringify(details), createdAt: new Date().toISOString() }).run(); }
    },
    close() { sqlite.close(); }
  };
}
