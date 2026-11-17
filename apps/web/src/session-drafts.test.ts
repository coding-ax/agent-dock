import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSessionDraft,
  createSessionDraftWriter,
  loadSessionDraft,
  MAX_DRAFT_CHARS,
  MAX_SESSION_DRAFTS,
  parseSessionDraftStore,
  registerDraftFlush,
  saveSessionDraft,
  SESSION_DRAFT_STORAGE_KEY,
  truncateDraftText,
  type DraftStorage
} from './session-drafts';

function memoryStorage(): DraftStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); }
  };
}

describe('session drafts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('isolates drafts by session id and restores them independently', () => {
    const storage = memoryStorage();
    expect(saveSessionDraft(storage, 'session-a', 'A 的草稿').saved).toBe(true);
    expect(saveSessionDraft(storage, 'session-b', 'B 的草稿').saved).toBe(true);

    expect(loadSessionDraft(storage, 'session-a')).toBe('A 的草稿');
    expect(loadSessionDraft(storage, 'session-b')).toBe('B 的草稿');
    expect(loadSessionDraft(storage, 'session-c')).toBe('');
  });

  it('clears only the sent session draft', () => {
    const storage = memoryStorage();
    saveSessionDraft(storage, 'session-a', '要发送');
    saveSessionDraft(storage, 'session-b', '别动');

    expect(clearSessionDraft(storage, 'session-a')).toBe(true);
    expect(loadSessionDraft(storage, 'session-a')).toBe('');
    expect(loadSessionDraft(storage, 'session-b')).toBe('别动');
  });

  it('removes the storage key when the last draft is cleared', () => {
    const storage = memoryStorage();
    saveSessionDraft(storage, 'session-a', '只有一条');
    clearSessionDraft(storage, 'session-a');
    expect(storage.getItem(SESSION_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('truncates oversized drafts and reports the truncation', () => {
    const storage = memoryStorage();
    const result = saveSessionDraft(storage, 'session-a', 'x'.repeat(MAX_DRAFT_CHARS + 37));

    expect(result.saved).toBe(true);
    expect(result.truncated).toBe(true);
    expect(loadSessionDraft(storage, 'session-a')).toHaveLength(MAX_DRAFT_CHARS);
  });

  it('never splits a surrogate pair at the character limit', () => {
    const text = `${'a'.repeat(MAX_DRAFT_CHARS - 1)}😀`;
    const truncated = truncateDraftText(text);
    expect(truncated.truncated).toBe(true);
    expect(truncated.text).toBe('a'.repeat(MAX_DRAFT_CHARS - 1));
    expect(truncated.text).not.toContain('\uFFFD');
  });

  it('evicts the least recently written session beyond the LRU limit', () => {
    const storage = memoryStorage();
    for (let index = 0; index <= MAX_SESSION_DRAFTS; index++) {
      saveSessionDraft(storage, `session-${index}`, `draft-${index}`);
    }

    expect(loadSessionDraft(storage, 'session-0')).toBe('');
    expect(loadSessionDraft(storage, `session-${MAX_SESSION_DRAFTS}`)).toBe(`draft-${MAX_SESSION_DRAFTS}`);
    expect(parseSessionDraftStore(storage.getItem(SESSION_DRAFT_STORAGE_KEY)).order).toHaveLength(MAX_SESSION_DRAFTS);
  });

  it('moves an updated session to the newest position instead of evicting it', () => {
    const storage = memoryStorage();
    saveSessionDraft(storage, 'old', 'first');
    for (let index = 0; index < MAX_SESSION_DRAFTS - 1; index++) saveSessionDraft(storage, `filler-${index}`, 'x');

    // old 原本是最旧的一条，重新写入后应变成最新，被淘汰的应是最早的 filler。
    saveSessionDraft(storage, 'old', 'updated');
    saveSessionDraft(storage, 'newest', 'new');

    expect(loadSessionDraft(storage, 'old')).toBe('updated');
    expect(loadSessionDraft(storage, 'filler-0')).toBe('');
    expect(loadSessionDraft(storage, 'newest')).toBe('new');
  });

  it('degrades without throwing when localStorage rejects a quota write', () => {
    const storage: DraftStorage = {
      getItem: () => null,
      setItem: () => {
        const error = new Error('quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      },
      removeItem: () => undefined
    };

    const result = saveSessionDraft(storage, 'session-a', '仍然可以继续输入');
    expect(result.saved).toBe(false);
    expect(result.quotaExceeded).toBe(true);
  });

  it('retries quota failures by evicting older drafts and keeps the current one', () => {
    const base = memoryStorage();
    for (const id of ['a', 'b', 'c']) saveSessionDraft(base, id, id);
    let failures = 2;
    const flaky: DraftStorage = {
      getItem: base.getItem,
      setItem: (key, value) => {
        if (failures-- > 0) {
          const error = new Error('quota');
          error.name = 'QuotaExceededError';
          throw error;
        }
        base.setItem(key, value);
      },
      removeItem: base.removeItem
    };

    const result = saveSessionDraft(flaky, 'c', 'latest');
    expect(result.saved).toBe(true);
    expect(result.quotaExceeded).toBe(true);
    expect(result.evicted).toBe(2);
    expect(loadSessionDraft(base, 'a')).toBe('');
    expect(loadSessionDraft(base, 'b')).toBe('');
    expect(loadSessionDraft(base, 'c')).toBe('latest');
  });

  it('treats malformed or manually edited storage as empty', () => {
    const storage = memoryStorage();
    storage.setItem(SESSION_DRAFT_STORAGE_KEY, '{"entries":');
    expect(loadSessionDraft(storage, 'a')).toBe('');
    expect(parseSessionDraftStore('{"version":1,"entries":{"a":{"text":42}},"order":["a"]}').order).toEqual([]);
  });

  it('debounces writes and only persists the latest text', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const writer = createSessionDraftWriter({ storage, delayMs: 400 });

    writer.write('a', 'h');
    writer.write('a', 'hello');
    vi.advanceTimersByTime(399);
    expect(loadSessionDraft(storage, 'a')).toBe('');
    expect(writer.hasPending()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(loadSessionDraft(storage, 'a')).toBe('hello');
    expect(writer.hasPending()).toBe(false);
  });

  it('flushes the pending draft immediately, e.g. before unload', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const writer = createSessionDraftWriter({ storage, delayMs: 400 });
    writer.write('a', '还来不及防抖');

    writer.flush();
    expect(loadSessionDraft(storage, 'a')).toBe('还来不及防抖');
    expect(writer.hasPending()).toBe(false);
  });

  it('drops the pending draft after a successful send so unmount/switch cannot write it back', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const writer = createSessionDraftWriter({ storage, delayMs: 400 });
    writer.write('a', '已经发出去的消息');

    // 发送成功：调用方先取消防抖，再清掉草稿。
    writer.cancel();
    clearSessionDraft(storage, 'a');
    // 紧接着切换会话/卸载触发 flush；pending 必须已经被作废。
    writer.flush();

    expect(loadSessionDraft(storage, 'a')).toBe('');
    vi.advanceTimersByTime(1_000);
    expect(loadSessionDraft(storage, 'a')).toBe('');
    expect(writer.hasPending()).toBe(false);
  });

  it('does not resurrect text when the draft is cleared before the debounce fires', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const writer = createSessionDraftWriter({ storage, delayMs: 400 });
    writer.write('a', '清空前的旧内容');

    // 清空可能来自发送成功、显式清草稿或其它面板；此时防抖 timer 还没到期。
    // 这里故意不调用 writer.cancel，验证 clear 本身就能让旧 timer 的写入过期。
    clearSessionDraft(storage, 'a');
    vi.advanceTimersByTime(400);

    expect(loadSessionDraft(storage, 'a')).toBe('');
  });

  it('keeps two rapid sends isolated and only persists the second draft while it is still unsent', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const writer = createSessionDraftWriter({ storage, delayMs: 400 });

    writer.write('a', '第一条');
    writer.cancel();
    clearSessionDraft(storage, 'a');
    writer.write('a', '第二条还没发');
    vi.advanceTimersByTime(400);

    expect(loadSessionDraft(storage, 'a')).toBe('第二条还没发');
  });

  it('treats a queued send like an immediate one: no residue, and a newer draft survives', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const writer = createSessionDraftWriter({ storage, delayMs: 400 });

    // 会话忙时走的是「排队发送」；提交用的是编辑器 getValue 快照，清空的也是编辑器本身。
    // 发送前那次防抖（400ms）可能还没落盘，发送成功必须让它失效，不能把已发送文本写回来。
    writer.write('a', '排队发送的第一条');
    writer.cancel();
    clearSessionDraft(storage, 'a');

    // 发送后紧接着输入的第二条（尚未发）要继续落盘，且不能和第一条串位。
    writer.write('a', '紧接着输入的第二条');
    vi.advanceTimersByTime(400);
    expect(loadSessionDraft(storage, 'a')).toBe('紧接着输入的第二条');
  });

  it('flushes the old session before writing the next one', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const writer = createSessionDraftWriter({ storage, delayMs: 400 });
    writer.write('a', 'A 的未发送内容');
    // 切换会话时 use-session-draft 会先 flush 旧会话，再写新会话。
    writer.flush();
    writer.write('b', 'B 的未发送内容');
    vi.advanceTimersByTime(400);

    expect(loadSessionDraft(storage, 'a')).toBe('A 的未发送内容');
    expect(loadSessionDraft(storage, 'b')).toBe('B 的未发送内容');
  });

  it('registers pagehide/beforeunload flush listeners and removes them cleanly', () => {
    const target = new EventTarget();
    const flush = vi.fn();
    const unregister = registerDraftFlush(target, flush);

    target.dispatchEvent(new Event('pagehide'));
    target.dispatchEvent(new Event('beforeunload'));
    expect(flush).toHaveBeenCalledTimes(2);

    unregister();
    target.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
