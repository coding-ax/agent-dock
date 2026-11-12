import { openDatabase } from '@agent-dock/agent-dock-storage';
import type {
  LarkAvatarCredentials,
  LarkAvatarDraft,
  LarkAvatarInboxItem,
  LarkAvatarState,
  LarkRegionName
} from './types.js';

/**
 * 最近消息面板只用于回看刚刚发生的对话，不是归档。
 * 保持一个很小的全局上限，并在每次写入时立即裁掉最旧记录，避免数据库无限长。
 */
export const MAX_INBOX_ITEMS = 60;
/** 回复记录也按同一个原则限量；pending 保留等待发送，其余状态超限时从最旧开始丢弃。 */
export const MAX_DRAFT_ITEMS = 80;

export const AVATAR_SCHEMA = `
  CREATE TABLE IF NOT EXISTS avatar_state (
    id TEXT PRIMARY KEY, config TEXT NOT NULL, account TEXT, state TEXT NOT NULL,
    tokens TEXT, credentials TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS avatar_inbox (
    id TEXT PRIMARY KEY, thread_key TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL, chat_type TEXT NOT NULL, chat_name TEXT,
    chat_avatar_url TEXT, sender_id TEXT, sender_name TEXT, sender_avatar_url TEXT,
    title TEXT NOT NULL, summary TEXT,
    tier TEXT NOT NULL, tier_reason TEXT, state TEXT NOT NULL,
    occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS avatar_inbox_thread ON avatar_inbox(thread_key, received_at);
  CREATE INDEX IF NOT EXISTS avatar_inbox_state ON avatar_inbox(state, received_at);
  CREATE INDEX IF NOT EXISTS avatar_inbox_received ON avatar_inbox(received_at);
  CREATE TABLE IF NOT EXISTS avatar_drafts (
    id TEXT PRIMARY KEY, item_id TEXT, thread_key TEXT, target TEXT NOT NULL,
    reply_root_id TEXT, reply_quote INTEGER, reply_thread_chat INTEGER,
    body TEXT NOT NULL, state TEXT NOT NULL, sent_message_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE, attempts INTEGER NOT NULL,
    last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS avatar_drafts_state ON avatar_drafts(state, updated_at);
  CREATE TABLE IF NOT EXISTS avatar_chat_cursor (
    chat_id TEXT PRIMARY KEY, last_seen_at INTEGER NOT NULL
  );
`;

export function avatarDatabasePath(databaseUrl: string): string {
  if (databaseUrl === ':memory:') return ':memory:';
  return `${databaseUrl}.lark-avatar.db`;
}

type StateRow = Record<string, unknown>;

const parseJson = <T>(value: unknown, fallback: T): T => {
  try { return JSON.parse(String(value ?? '')) as T; } catch { return fallback; }
};

const stateFromRow = (row: StateRow): LarkAvatarState => {
  const parsed = parseJson<Partial<LarkAvatarState['config']>>(row.config, {});
  const region: LarkRegionName = parsed.region === 'lark' ? 'lark' : 'feishu';
  const rawAccount = row.account ? parseJson<Record<string, unknown> | undefined>(row.account, undefined) : undefined;
  const account = rawAccount
    ? {
        userId: String(rawAccount.userId ?? rawAccount.openId ?? ''),
        name: String(rawAccount.name ?? rawAccount.userId ?? rawAccount.openId ?? '飞书用户'),
        ...(rawAccount.avatarUrl ? { avatarUrl: String(rawAccount.avatarUrl) } : {}),
        ...(rawAccount.email ? { email: String(rawAccount.email) } : {})
      }
    : undefined;
  return {
    id: String(row.id),
    config: {
      region,
      triggerPrefix: typeof parsed.triggerPrefix === 'string' && parsed.triggerPrefix.trim()
        ? parsed.triggerPrefix.trim()
        : '/ai',
      contextMessages: Number.isFinite(Number(parsed.contextMessages))
        ? Math.min(50, Math.max(1, Math.floor(Number(parsed.contextMessages))))
        : 10,
      contextScope: parsed.contextScope === 'chat' ? 'chat' : 'anchor',
      replyInTopic: typeof parsed.replyInTopic === 'boolean' ? parsed.replyInTopic : true,
      replyMode: parsed.replyMode === 'quote' || parsed.replyMode === 'thread' ? parsed.replyMode : 'direct',
      emojiReactions: parsed.emojiReactions === true,
      replySignature: typeof parsed.replySignature === 'string' ? parsed.replySignature : '',
      agentTimeoutSeconds: Number.isFinite(Number(parsed.agentTimeoutSeconds))
        ? Math.min(86_400, Math.max(0, Math.floor(Number(parsed.agentTimeoutSeconds))))
        : 7_200,
      listening: typeof parsed.listening === 'boolean' ? parsed.listening : true,
      listenChats: Array.isArray(parsed.listenChats) ? parsed.listenChats : [],
      allowedSenders: Array.isArray(parsed.allowedSenders) ? parsed.allowedSenders : [],
      agentId: typeof parsed.agentId === 'string' && parsed.agentId.trim() ? parsed.agentId.trim() : 'codex',
      model: typeof parsed.model === 'string' ? parsed.model.trim() : '',
      reasoningEffort: typeof parsed.reasoningEffort === 'string' ? parsed.reasoningEffort.trim() : '',
      workspace: typeof parsed.workspace === 'string' ? parsed.workspace.trim() : ''
    },
    ...(account ? { account } : {}),
    state: String(row.state) as LarkAvatarState['state'],
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
};

const inboxFromRow = (row: StateRow): LarkAvatarInboxItem => ({
  id: String(row.id), threadKey: String(row.thread_key), messageId: String(row.message_id),
  chatId: String(row.chat_id), chatType: String(row.chat_type),
  ...(row.chat_name ? { chatName: String(row.chat_name) } : {}),
  ...(row.chat_avatar_url ? { chatAvatarUrl: String(row.chat_avatar_url) } : {}),
  ...(row.sender_id ? { senderId: String(row.sender_id) } : {}),
  ...(row.sender_name ? { senderName: String(row.sender_name) } : {}),
  ...(row.sender_avatar_url ? { senderAvatarUrl: String(row.sender_avatar_url) } : {}),
  title: String(row.title), ...(row.summary ? { summary: String(row.summary) } : {}),
  tier: String(row.tier) as LarkAvatarInboxItem['tier'],
  ...(row.tier_reason ? { tierReason: String(row.tier_reason) } : {}),
  state: String(row.state) as LarkAvatarInboxItem['state'],
  occurredAt: String(row.occurred_at), receivedAt: String(row.received_at),
  payload: parseJson(row.payload, {})
});

const draftFromRow = (row: StateRow): LarkAvatarDraft => ({
  id: String(row.id), ...(row.item_id ? { itemId: String(row.item_id) } : {}),
  ...(row.thread_key ? { threadKey: String(row.thread_key) } : {}),
  target: String(row.target), ...(row.reply_root_id ? { replyRootId: String(row.reply_root_id) } : {}),
  ...(row.reply_quote ? { replyQuote: true } : {}),
  ...(row.reply_thread_chat ? { replyThreadChat: true } : {}),
  body: String(row.body),
  state: String(row.state) as LarkAvatarDraft['state'],
  ...(row.sent_message_id ? { sentMessageId: String(row.sent_message_id) } : {}),
  idempotencyKey: String(row.idempotency_key), attempts: Number(row.attempts),
  ...(row.last_error ? { lastError: String(row.last_error) } : {}),
  createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  ...(row.sent_at ? { sentAt: String(row.sent_at) } : {})
});

const insertValues = (record: LarkAvatarInboxItem) => ({
  id: record.id, thread_key: record.threadKey, message_id: record.messageId,
  chat_id: record.chatId, chat_type: record.chatType, chat_name: record.chatName ?? null,
  chat_avatar_url: record.chatAvatarUrl ?? null,
  sender_id: record.senderId ?? null, sender_name: record.senderName ?? null,
  sender_avatar_url: record.senderAvatarUrl ?? null,
  title: record.title, summary: record.summary ?? null, tier: record.tier,
  tier_reason: record.tierReason ?? null, state: record.state,
  occurred_at: record.occurredAt, received_at: record.receivedAt,
  payload: JSON.stringify(record.payload)
});

export class LarkAvatarStore {
  private readonly sqlite: ReturnType<typeof openDatabase>;

  constructor(filename: string) {
    this.sqlite = openDatabase(filename);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.exec(AVATAR_SCHEMA);
    const columns = this.sqlite.pragma('table_info(avatar_state)') as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'tokens')) this.sqlite.exec('ALTER TABLE avatar_state ADD COLUMN tokens TEXT');
    if (!columns.some(column => column.name === 'credentials')) this.sqlite.exec('ALTER TABLE avatar_state ADD COLUMN credentials TEXT');
    const inboxColumns = this.sqlite.pragma('table_info(avatar_inbox)') as Array<{ name: string }>;
    if (!inboxColumns.some(column => column.name === 'chat_avatar_url')) this.sqlite.exec('ALTER TABLE avatar_inbox ADD COLUMN chat_avatar_url TEXT');
    if (!inboxColumns.some(column => column.name === 'sender_avatar_url')) this.sqlite.exec('ALTER TABLE avatar_inbox ADD COLUMN sender_avatar_url TEXT');
    const draftColumns = this.sqlite.pragma('table_info(avatar_drafts)') as Array<{ name: string }>;
    if (!draftColumns.some(column => column.name === 'reply_root_id')) this.sqlite.exec('ALTER TABLE avatar_drafts ADD COLUMN reply_root_id TEXT');
    if (!draftColumns.some(column => column.name === 'reply_quote')) this.sqlite.exec('ALTER TABLE avatar_drafts ADD COLUMN reply_quote INTEGER');
    if (!draftColumns.some(column => column.name === 'reply_thread_chat')) this.sqlite.exec('ALTER TABLE avatar_drafts ADD COLUMN reply_thread_chat INTEGER');
    this.pruneInbox();
    this.pruneDrafts();
  }

  close() { this.sqlite.close(); }

  getState(): LarkAvatarState | undefined {
    const row = this.sqlite.prepare('SELECT * FROM avatar_state LIMIT 1').get() as StateRow | undefined;
    return row ? stateFromRow(row) : undefined;
  }

  saveState(next: LarkAvatarState): void {
    this.sqlite.prepare(`INSERT INTO avatar_state
      (id, config, account, state, last_error, created_at, updated_at)
      VALUES (@id, @config, @account, @state, @last_error, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET config=excluded.config, account=excluded.account,
      state=excluded.state, last_error=excluded.last_error, updated_at=excluded.updated_at`)
      .run({
        id: next.id, config: JSON.stringify(next.config),
        account: next.account ? JSON.stringify(next.account) : null,
        state: next.state, last_error: next.lastError ?? null,
        created_at: next.createdAt, updated_at: next.updatedAt
      });
  }

  getCredentials(): LarkAvatarCredentials | undefined {
    const row = this.sqlite.prepare('SELECT credentials FROM avatar_state LIMIT 1').get() as { credentials?: string | null } | undefined;
    const parsed = row?.credentials
      ? parseJson<LarkAvatarCredentials | undefined>(row.credentials, undefined)
      : undefined;
    if (!parsed?.cookies?.session) return undefined;
    return parsed;
  }

  saveCredentials(credentials: LarkAvatarCredentials | undefined): void {
    const row = this.sqlite.prepare('SELECT id FROM avatar_state LIMIT 1').get() as { id: string } | undefined;
    if (!row) return;
    this.sqlite.prepare('UPDATE avatar_state SET credentials = ? WHERE id = ?')
      .run(credentials ? JSON.stringify(credentials) : null, row.id);
  }

  upsertInbox(item: LarkAvatarInboxItem): { record: LarkAvatarInboxItem; created: boolean } {
    const run = this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare('SELECT * FROM avatar_inbox WHERE message_id = ?')
        .get(item.messageId) as StateRow | undefined;
      if (existing) {
        this.sqlite.prepare(`UPDATE avatar_inbox SET
          chat_name = COALESCE(?, chat_name),
          chat_avatar_url = COALESCE(?, chat_avatar_url),
          sender_name = COALESCE(?, sender_name),
          sender_avatar_url = COALESCE(?, sender_avatar_url)
          WHERE message_id = ?`).run(
          item.chatName ?? null,
          item.chatAvatarUrl ?? null,
          item.senderName ?? null,
          item.senderAvatarUrl ?? null,
          item.messageId
        );
        const updated = this.sqlite.prepare('SELECT * FROM avatar_inbox WHERE message_id = ?')
          .get(item.messageId) as StateRow;
        return { record: inboxFromRow(updated), created: false };
      }
      this.sqlite.prepare(`INSERT INTO avatar_inbox
        (id, thread_key, message_id, chat_id, chat_type, chat_name, chat_avatar_url,
         sender_id, sender_name, sender_avatar_url, title, summary, tier, tier_reason,
         state, occurred_at, received_at, payload)
        VALUES (@id, @thread_key, @message_id, @chat_id, @chat_type, @chat_name, @chat_avatar_url,
         @sender_id, @sender_name, @sender_avatar_url, @title, @summary,
         @tier, @tier_reason, @state, @occurred_at, @received_at, @payload)`).run(insertValues(item));
      this.pruneInbox();
      return { record: item, created: true };
    });
    return run();
  }

  listInbox(states?: string[], tier?: string): LarkAvatarInboxItem[] {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (states?.length) { filters.push(`state IN (${states.map(() => '?').join(',')})`); params.push(...states); }
    if (tier) { filters.push('tier = ?'); params.push(tier); }
    const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
    const rows = this.sqlite.prepare(`SELECT * FROM avatar_inbox${where} ORDER BY received_at DESC LIMIT ${MAX_INBOX_ITEMS}`)
      .all(...params) as StateRow[];
    return rows.map(inboxFromRow);
  }

  pruneInbox(limit = MAX_INBOX_ITEMS): number {
    const count = Number((this.sqlite.prepare('SELECT count(*) AS count FROM avatar_inbox').get() as { count?: number } | undefined)?.count ?? 0);
    const excess = count - limit;
    if (excess <= 0) return 0;
    const result = this.sqlite.prepare(`
      DELETE FROM avatar_inbox WHERE rowid IN (
        SELECT rowid FROM avatar_inbox ORDER BY received_at ASC, rowid ASC LIMIT ?
      )
    `).run(excess);
    return result.changes;
  }

  inboxItem(id: string): LarkAvatarInboxItem | undefined {
    const row = this.sqlite.prepare('SELECT * FROM avatar_inbox WHERE id = ?').get(id) as StateRow | undefined;
    return row ? inboxFromRow(row) : undefined;
  }

  setInboxState(id: string, state: string, summary?: string, tier?: string): LarkAvatarInboxItem | undefined {
    const current = this.inboxItem(id);
    if (!current) return undefined;
    const next = { ...current, state: state as LarkAvatarInboxItem['state'],
      ...(summary !== undefined ? { summary } : {}), ...(tier ? { tier: tier as LarkAvatarInboxItem['tier'] } : {}) };
    this.sqlite.prepare(`UPDATE avatar_inbox SET state = ?, summary = ?, tier = ? WHERE id = ?`)
      .run(next.state, next.summary ?? null, next.tier, id);
    this.pruneInbox();
    return next;
  }

  saveDraft(draft: LarkAvatarDraft): void {
    this.sqlite.prepare(`INSERT INTO avatar_drafts
      (id, item_id, thread_key, target, reply_root_id, reply_quote, reply_thread_chat,
       body, state, sent_message_id, idempotency_key,
       attempts, last_error, created_at, updated_at, sent_at)
      VALUES (@id, @item_id, @thread_key, @target, @reply_root_id, @reply_quote, @reply_thread_chat,
       @body, @state, @sent_message_id,
       @idempotency_key, @attempts, @last_error, @created_at, @updated_at, @sent_at)
      ON CONFLICT(id) DO UPDATE SET item_id=excluded.item_id, thread_key=excluded.thread_key,
       target=excluded.target, reply_root_id=excluded.reply_root_id, reply_quote=excluded.reply_quote,
       reply_thread_chat=excluded.reply_thread_chat, body=excluded.body, state=excluded.state,
       sent_message_id=excluded.sent_message_id, attempts=excluded.attempts,
       last_error=excluded.last_error, updated_at=excluded.updated_at, sent_at=excluded.sent_at`)
      .run({
        id: draft.id, item_id: draft.itemId ?? null, thread_key: draft.threadKey ?? null,
        target: draft.target, reply_root_id: draft.replyRootId ?? null,
        reply_quote: draft.replyQuote ? 1 : 0, reply_thread_chat: draft.replyThreadChat ? 1 : 0,
        body: draft.body, state: draft.state,
        sent_message_id: draft.sentMessageId ?? null, idempotency_key: draft.idempotencyKey,
        attempts: draft.attempts, last_error: draft.lastError ?? null,
        created_at: draft.createdAt, updated_at: draft.updatedAt, sent_at: draft.sentAt ?? null
      });
    this.pruneDrafts();
  }

  pruneDrafts(limit = MAX_DRAFT_ITEMS): number {
    const count = Number((this.sqlite.prepare('SELECT count(*) AS count FROM avatar_drafts').get() as { count?: number } | undefined)?.count ?? 0);
    const excess = count - limit;
    if (excess <= 0) return 0;
    const result = this.sqlite.prepare(`
      DELETE FROM avatar_drafts WHERE rowid IN (
        SELECT rowid FROM avatar_drafts
        WHERE state != 'pending'
        ORDER BY updated_at ASC, rowid ASC LIMIT ?
      )
    `).run(excess);
    return result.changes;
  }

  draft(id: string): LarkAvatarDraft | undefined {
    const row = this.sqlite.prepare('SELECT * FROM avatar_drafts WHERE id = ?').get(id) as StateRow | undefined;
    return row ? draftFromRow(row) : undefined;
  }

  draftByIdempotencyKey(key: string): LarkAvatarDraft | undefined {
    const row = this.sqlite.prepare('SELECT * FROM avatar_drafts WHERE idempotency_key = ?').get(key) as StateRow | undefined;
    return row ? draftFromRow(row) : undefined;
  }

  draftBySentMessageId(messageId: string): LarkAvatarDraft | undefined {
    const row = this.sqlite.prepare('SELECT * FROM avatar_drafts WHERE sent_message_id = ? LIMIT 1').get(messageId) as StateRow | undefined;
    return row ? draftFromRow(row) : undefined;
  }

  listDrafts(state?: string): LarkAvatarDraft[] {
    const rows = state
      ? this.sqlite.prepare(`SELECT * FROM avatar_drafts WHERE state = ? ORDER BY updated_at DESC LIMIT ${MAX_DRAFT_ITEMS}`).all(state)
      : this.sqlite.prepare(`SELECT * FROM avatar_drafts ORDER BY updated_at DESC LIMIT ${MAX_DRAFT_ITEMS}`).all();
    return (rows as StateRow[]).map(draftFromRow);
  }

  latestMessageTime(chatId: string): number | undefined {
    const row = this.sqlite.prepare('SELECT occurred_at FROM avatar_inbox WHERE chat_id = ? ORDER BY occurred_at DESC LIMIT 1')
      .get(chatId) as { occurred_at?: string } | undefined;
    const parsed = Date.parse(row?.occurred_at ?? '');
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  cursor(chatId: string): number | undefined {
    const row = this.sqlite.prepare('SELECT last_seen_at FROM avatar_chat_cursor WHERE chat_id = ?')
      .get(chatId) as { last_seen_at?: number } | undefined;
    return Number.isFinite(row?.last_seen_at) ? Number(row?.last_seen_at) : undefined;
  }

  setCursor(chatId: string, lastSeenAt: number): void {
    this.sqlite.prepare(`INSERT INTO avatar_chat_cursor (chat_id, last_seen_at)
      VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`)
      .run(chatId, Math.max(0, Math.floor(lastSeenAt)));
  }

  statusCounts(): { inbox: number; action: number; pendingDrafts: number } {
    const count = (sql: string) => Number((this.sqlite.prepare(sql).get() as { count: number }).count);
    return {
      inbox: count('SELECT count(*) AS count FROM avatar_inbox'),
      action: count("SELECT count(*) AS count FROM avatar_inbox WHERE state = 'new' AND tier = 'action'"),
      pendingDrafts: count("SELECT count(*) AS count FROM avatar_drafts WHERE state = 'pending'")
    };
  }
}
