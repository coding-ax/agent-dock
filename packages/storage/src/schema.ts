import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const timestamps = { createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull() };
export const agentConfigs = sqliteTable('agent_configs', { id: text('id').primaryKey(), json: text('json').notNull(), ...timestamps });
export const machines = sqliteTable('machines', { id: text('id').primaryKey(), name: text('name').notNull(), metadata: text('metadata'), ...timestamps });
export const projects = sqliteTable('projects', { id: text('id').primaryKey(), machineId: text('machine_id'), name: text('name').notNull(), cwd: text('cwd').notNull(), pinnedAt: text('pinned_at'), ...timestamps });
export const sessions = sqliteTable('sessions', { id: text('id').primaryKey(), agentId: text('agent_id').notNull(), state: text('state').notNull(), interruptIntent: text('interrupt_intent'), cwd: text('cwd').notNull(), model: text('model'), reasoningEffort: text('reasoning_effort'), systemPrompt: text('system_prompt'), permissionMode: text('permission_mode').default('full-trust'), source: text('source'), sourceId: text('source_id'), sshHost: text('ssh_host'), archivedAt: text('archived_at'), protocol: text('protocol'), lastMessageAt: text('last_message_at'), customTitle: text('custom_title'), agentTitle: text('agent_title'), pinnedAt: text('pinned_at'), runId: text('run_id').notNull(), error: text('error'), ...timestamps });
export const tasks = sqliteTable('tasks', { id: text('id').primaryKey(), sessionId: text('session_id').notNull(), prompt: text('prompt').notNull(), sentPrompt: text('sent_prompt'), finalText: text('final_text'), status: text('status').notNull(), origin: text('origin'), ...timestamps });
export const events = sqliteTable('events', { id: text('id').primaryKey(), sessionId: text('session_id').notNull(), sequence: integer('sequence').notNull(), type: text('type').notNull(), timestamp: text('timestamp').notNull(), data: text('data').notNull(), raw: text('raw') });
export const toolCalls = sqliteTable('tool_calls', { id: text('id').primaryKey(), sessionId: text('session_id').notNull(), data: text('data').notNull(), ...timestamps });
export const permissionRequests = sqliteTable('permission_requests', { id: text('id').primaryKey(), sessionId: text('session_id').notNull(), status: text('status').notNull(), data: text('data').notNull(), ...timestamps });
export const errors = sqliteTable('errors', { id: text('id').primaryKey(), sessionId: text('session_id').notNull(), message: text('message').notNull(), details: text('details'), createdAt: text('created_at').notNull() });
export const channelMappings = sqliteTable('channel_mappings', { id: text('id').primaryKey(), channel: text('channel').notNull(), externalId: text('external_id').notNull(), sessionId: text('session_id').notNull(), extra: text('extra'), createdAt: text('created_at').notNull() });
export const schedules = sqliteTable('schedules', { id: text('id').primaryKey(), name: text('name').notNull(), sessionId: text('session_id'), delivery: text('delivery').notNull(), sessionTemplate: text('session_template'), cron: text('cron'), runAt: text('run_at'), intervalMinutes: integer('interval_minutes'), timezone: text('timezone').notNull(), prompt: text('prompt').notNull(), enabled: integer('enabled', { mode: 'boolean' }).notNull(), nextRunAt: text('next_run_at'), lastRunAt: text('last_run_at'), lastStatus: text('last_status'), runCount: integer('run_count').notNull(), createdBySessionId: text('created_by_session_id'), extra: text('extra'), ...timestamps });
export const scheduleRuns = sqliteTable('schedule_runs', { id: text('id').primaryKey(), scheduleId: text('schedule_id').notNull(), fireAt: text('fire_at').notNull(), status: text('status').notNull(), reason: text('reason'), sessionId: text('session_id'), taskId: text('task_id'), createdAt: text('created_at').notNull() });
export const configs = sqliteTable('configs', { key: text('key').primaryKey(), value: text('value').notNull() });
export const turnUsage = sqliteTable('turn_usage', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  taskId: text('task_id'),
  requestId: text('request_id'),
  agentId: text('agent_id').notNull(),
  cwd: text('cwd').notNull(),
  model: text('model'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  thoughtTokens: integer('thought_tokens').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  costUsd: real('cost_usd'),
  durationMs: integer('duration_ms'),
  generationMs: integer('generation_ms'),
  ttftMs: integer('ttft_ms'),
  source: text('source').notNull().default('acp'),
  createdAt: text('created_at').notNull()
});

export const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  icon: text('icon'),
  isDefault: integer('is_default').notNull().default(0),
  viewMode: text('view_mode').notNull().default('lanes'),
  density: text('density').notNull().default('compact'),
  filterJson: text('filter_json').notNull().default('{}'),
  revision: integer('revision').notNull().default(1),
  archivedAt: text('archived_at'),
  ...timestamps
});

export const boardColumns = sqliteTable('board_columns', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull(),
  name: text('name').notNull(),
  color: text('color').notNull().default('zinc'),
  position: text('position').notNull(),
  collapsed: integer('collapsed').notNull().default(0),
  wipLimit: integer('wip_limit'),
  ruleJson: text('rule_json'),
  onDropAction: text('on_drop_action').notNull().default('none'),
  ...timestamps
});

export const boardItems = sqliteTable('board_items', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull(),
  columnId: text('column_id').notNull(),
  entityKind: text('entity_kind').notNull(),
  entityId: text('entity_id').notNull(),
  position: text('position').notNull(),
  pinned: integer('pinned').notNull().default(0),
  manualOverride: integer('manual_override').notNull().default(0),
  tagsJson: text('tags_json').notNull().default('[]'),
  userNote: text('user_note'),
  kittenNote: text('kitten_note'),
  kittenNoteAt: text('kitten_note_at'),
  addedBy: text('added_by').notNull().default('user'),
  ...timestamps
});

export const boardEvents = sqliteTable('board_events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  boardId: text('board_id').notNull(),
  eventType: text('event_type').notNull(),
  actor: text('actor').notNull(),
  clientMutationId: text('client_mutation_id'),
  payloadJson: text('payload_json').notNull(),
  createdAt: text('created_at').notNull()
});
