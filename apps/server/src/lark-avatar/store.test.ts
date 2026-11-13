import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@agent-dock/agent-dock-storage';
import { LarkAvatarStore, MAX_DRAFT_ITEMS, MAX_INBOX_ITEMS } from './store.js';
import type { LarkAvatarDraft, LarkAvatarInboxItem } from './types.js';

const stores: LarkAvatarStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const item = (index: number): LarkAvatarInboxItem => ({
  id: `item_${index}`,
  threadKey: 'lark:oc_chat',
  messageId: `om_${index}`,
  chatId: 'oc_chat',
  chatType: 'group',
  senderId: '100',
  senderName: '测试用户',
  title: `消息 ${index}`,
  tier: 'fyi',
  state: 'handled',
  occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  payload: {}
});

const draft = (index: number, state: LarkAvatarDraft['state'] = 'sent'): LarkAvatarDraft => ({
  id: `draft_${index}`,
  target: 'oc_chat',
  body: `回复 ${index}`,
  state,
  idempotencyKey: `key_${index}`,
  attempts: 1,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
});

describe('Lark avatar store', () => {
  it('keeps only the newest global inbox messages', () => {
    const store = new LarkAvatarStore(':memory:');
    stores.push(store);

    for (let index = 0; index <= MAX_INBOX_ITEMS; index++) store.upsertInbox(item(index));

    expect(store.listInbox()).toHaveLength(MAX_INBOX_ITEMS);
    expect(store.inboxItem('item_0')).toBeUndefined();
    expect(store.inboxItem(`item_${MAX_INBOX_ITEMS}`)).toMatchObject({ messageId: `om_${MAX_INBOX_ITEMS}` });
  });

  it('prunes old settled drafts but keeps pending replies', () => {
    const store = new LarkAvatarStore(':memory:');
    stores.push(store);

    for (let index = 0; index < MAX_DRAFT_ITEMS; index++) store.saveDraft(draft(index));
    expect(store.listDrafts()).toHaveLength(MAX_DRAFT_ITEMS);

    store.saveDraft(draft(MAX_DRAFT_ITEMS));
    expect(store.listDrafts()).toHaveLength(MAX_DRAFT_ITEMS);
    expect(store.draft('draft_0')).toBeUndefined();

    store.saveDraft(draft(10_000, 'pending'));
    expect(store.draft('draft_10000')).toMatchObject({ state: 'pending' });
    expect(store.listDrafts()).toHaveLength(MAX_DRAFT_ITEMS);
    expect(store.draft('draft_1')).toBeUndefined();
  });

  it('deduplicates seen messageIds even after pruneInbox evicts old items', () => {
    const store = new LarkAvatarStore(':memory:');
    stores.push(store);

    for (let index = 0; index <= MAX_INBOX_ITEMS; index++) {
      expect(store.upsertInbox(item(index)).created).toBe(true);
    }

    expect(store.inboxItem('item_0')).toBeUndefined();
    expect(store.hasSeenMessage('om_0')).toBe(true);

    const replay = store.upsertInbox({ ...item(0), id: 'item_0_replay' });
    expect(replay.created).toBe(false);
    expect(store.inboxItem('item_0_replay')).toBeUndefined();
    expect(store.listInbox()).toHaveLength(MAX_INBOX_ITEMS);
  });

  it('advances chat cursor monotonically without moving backwards', () => {
    const store = new LarkAvatarStore(':memory:');
    stores.push(store);

    expect(store.cursor('oc_chat')).toBeUndefined();
    store.setCursor('oc_chat', 1_767_225_700_000);
    expect(store.cursor('oc_chat')).toBe(1_767_225_700_000);

    store.setCursor('oc_chat', 1_767_225_600_000);
    expect(store.cursor('oc_chat')).toBe(1_767_225_700_000);

    store.setCursor('oc_chat', 1_767_225_800_000);
    expect(store.cursor('oc_chat')).toBe(1_767_225_800_000);
  });

  it('backfills seen message ids from an existing inbox when upgrading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avatar-upgrade-'));
    tempDirs.push(dir);
    const filename = join(dir, 'avatar.db');
    const sqlite = openDatabase(filename);
    sqlite.exec(`
      CREATE TABLE avatar_inbox (
        id TEXT PRIMARY KEY, thread_key TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL, chat_type TEXT NOT NULL, chat_name TEXT,
        chat_avatar_url TEXT, sender_id TEXT, sender_name TEXT, sender_avatar_url TEXT,
        title TEXT NOT NULL, summary TEXT,
        tier TEXT NOT NULL, tier_reason TEXT, state TEXT NOT NULL,
        occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL
      );
    `);
    sqlite.prepare(`INSERT INTO avatar_inbox
      (id, thread_key, message_id, chat_id, chat_type, sender_id, title, tier, state, occurred_at, received_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'item_legacy',
      'lark:oc_chat',
      'om_legacy',
      'oc_chat',
      'group',
      '42',
      '/ai 升级前的消息',
      'fyi',
      'handled',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '{}'
    );
    sqlite.close();

    const store = new LarkAvatarStore(filename);
    stores.push(store);

    expect(store.hasSeenMessage('om_legacy')).toBe(true);
    for (let index = 0; index <= MAX_INBOX_ITEMS; index++) store.upsertInbox(item(index));
    expect(store.inboxItem('item_legacy')).toBeUndefined();

    const replay = store.upsertInbox({ ...item(0), id: 'item_legacy_replay', messageId: 'om_legacy' });
    expect(replay.created).toBe(false);
    expect(store.inboxItem('item_legacy_replay')).toBeUndefined();
    expect(store.hasSeenMessage('om_legacy')).toBe(true);
  });
});
