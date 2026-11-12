import { afterEach, describe, expect, it } from 'vitest';
import { LarkAvatarStore, MAX_DRAFT_ITEMS, MAX_INBOX_ITEMS } from './store.js';
import type { LarkAvatarDraft, LarkAvatarInboxItem } from './types.js';

const stores: LarkAvatarStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
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
});
