import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@agent-dock/agent-dock-storage';
import { LarkAvatarStore, MAX_DRAFT_ITEMS, MAX_INBOX_ITEMS } from './store.js';
import type { LarkAvatarDraft, LarkAvatarInboxItem, LarkAvatarReactionTrigger } from './types.js';

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

  it('allows a stale pending reaction trigger to be reclaimed after a restart', () => {
    const store = new LarkAvatarStore(':memory:');
    stores.push(store);
    const trigger = (
      key: string,
      updatedAt: string,
      actionTime = '1000',
      state: LarkAvatarReactionTrigger['state'] = 'pending'
    ): LarkAvatarReactionTrigger => ({
      key,
      messageId: 'om_test',
      emoji: 'THUMBSUP',
      route: 'main',
      operatorId: 'ou_me',
      operatorType: 'user',
      state,
      actionTime,
      payload: {},
      createdAt: updatedAt,
      updatedAt
    });

    const freshKey = 'om_fresh\u0000ou_me\u0000THUMBSUP';
    const fresh = new Date().toISOString();
    expect(store.recordReactionTrigger(trigger(freshKey, fresh))).toBe(true);
    // 刚写入的 pending 仍然只允许一次，防止同一事件在进程内重复派发。
    expect(store.recordReactionTrigger(trigger(freshKey, fresh))).toBe(false);

    const staleKey = 'om_stale\u0000ou_me\u0000THUMBSUP';
    expect(store.recordReactionTrigger(trigger(staleKey, '2020-01-01T00:00:00.000Z'))).toBe(true);
    // 超过 2 分钟的 pending 说明进程在落账后、派发前中断；飞书重投同一 action_time 应能重领。
    expect(store.recordReactionTrigger(trigger(staleKey, '2020-01-01T00:00:00.000Z', '1000'))).toBe(true);
  });

  it('does not auto-reclaim a stale dispatching trigger because the turn may already have started', () => {
    const store = new LarkAvatarStore(':memory:');
    stores.push(store);
    const now = new Date().toISOString();
    const record: LarkAvatarReactionTrigger = {
      key: 'stale-dispatching-key',
      messageId: 'om_test',
      emoji: 'THUMBSUP',
      route: 'main',
      operatorId: 'ou_me',
      operatorType: 'user',
      state: 'pending',
      actionTime: '1000',
      payload: {},
      createdAt: now,
      updatedAt: now
    };
    expect(store.claimReactionTrigger(record)).toBe('claimed');
    expect(store.claimReactionTrigger(record)).toBe('duplicate');
    // 派发开始后被进程崩溃打断，记录停在 dispatching 且已过 2 分钟。
    store.updateReactionTrigger(record.key, { state: 'dispatching', updatedAt: '2020-01-01T00:00:00.000Z' });
    // 已进入 dispatching 且超过 2 分钟：不能自动重派，只标成 dispatch_uncertain。
    expect(store.claimReactionTrigger({ ...record, updatedAt: now })).toBe('dispatch_uncertain');
    expect(store.reactionTrigger(record.key)).toMatchObject({ state: 'failed' });
    expect(store.reactionTrigger(record.key)!.reason).toContain('dispatch_uncertain');
    // 同一事件重投仍是 duplicate，不能因为变成 failed 就自动重跑。
    expect(store.claimReactionTrigger({ ...record, updatedAt: now })).toBe('duplicate');
    // 用户重新加表情（新 action_time）才允许重试。
    expect(store.claimReactionTrigger({ ...record, updatedAt: now, actionTime: '2000' })).toBe('claimed');
  });
  it('survives a real process restart: a reopened database still refuses to re-dispatch dispatching rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-reaction-restart-'));
    tempDirs.push(dir);
    const file = join(dir, 'avatar.db');
    const record: LarkAvatarReactionTrigger = {
      key: 'restart-key',
      messageId: 'om_restart',
      emoji: 'THUMBSUP',
      route: 'main',
      operatorId: 'ou_me',
      operatorType: 'user',
      state: 'pending',
      actionTime: '1000',
      payload: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const first = new LarkAvatarStore(file);
    expect(first.claimReactionTrigger(record)).toBe('claimed');
    first.updateReactionTrigger(record.key, { state: 'dispatching', updatedAt: '2020-01-01T00:00:00.000Z' });
    first.close();

    // 新进程/新连接读同一个库：stale dispatching 仍然不能自动重派。
    const reopened = new LarkAvatarStore(file);
    try {
      expect(reopened.claimReactionTrigger({ ...record, updatedAt: new Date().toISOString() })).toBe('dispatch_uncertain');
      expect(reopened.reactionTrigger(record.key)).toMatchObject({ state: 'failed' });
    } finally {
      reopened.close();
    }
  });
});
