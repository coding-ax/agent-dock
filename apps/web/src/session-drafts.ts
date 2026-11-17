/**
 * 按会话保存输入草稿。
 *
 * 只存纯文本，不存附件或二进制内容。草稿表整体序列化在一个 key 下：条目上限
 * 50 个、单条上限 2 万字符，最坏情况约 1M 字符，远低于常见 localStorage 配额。
 */
export const SESSION_DRAFT_STORAGE_KEY = 'agent-dock:session-drafts:v1';
export const MAX_DRAFT_CHARS = 20_000;
export const MAX_SESSION_DRAFTS = 50;
export const DEFAULT_DRAFT_DEBOUNCE_MS = 400;

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type SessionDraftEntry = { text: string; updatedAt: number };
type SessionDraftStore = {
  version: 1;
  /** 活跃的草稿，key 就是 sessionId。 */
  entries: Record<string, SessionDraftEntry>;
  /** LRU 顺序，末尾最新；单独维护，避免同一毫秒时间戳无法排序。 */
  order: string[];
};

export type SaveDraftResult = {
  saved: boolean;
  truncated: boolean;
  evicted: number;
  quotaExceeded: boolean;
};

export type SessionDraftWriter = {
  write(sessionId: string, text: string): void;
  /** 立即写入待保存值；页面隐藏/卸载时调用。 */
  flush(): SaveDraftResult | undefined;
  /** 丢弃待保存值并让已排队的旧写入失效；发送成功后调用。 */
  cancel(): void;
  hasPending(): boolean;
};

const emptyStore = (): SessionDraftStore => ({ version: 1, entries: {}, order: [] });

/**
 * 每个会话一个写入代次。clear/空写入会让之前排队的防抖写入过期，
 * flush 时发现代次变了就直接丢弃，避免已发送内容被定时器写回。
 * 只存在内存里：页面刷新后没有旧 timer，不需要持久化。
 */
const draftRevisions = new Map<string, number>();

function draftRevision(sessionId: string): number {
  return draftRevisions.get(sessionId) ?? 0;
}

function invalidateDraftWrites(sessionId: string): void {
  draftRevisions.set(sessionId, draftRevision(sessionId) + 1);
}

export function getBrowserDraftStorage(): DraftStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    // 隐私模式/被策略禁用时访问 localStorage 本身就会抛错，输入框仍要能正常用。
    return undefined;
  }
}

export function truncateDraftText(text: string, maxChars = MAX_DRAFT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let end = Math.max(0, maxChars);
  // 不要把代理对切成两半，否则恢复出来是替换字符。
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

export function parseSessionDraftStore(raw: string | null): SessionDraftStore {
  if (!raw) return emptyStore();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    const value = parsed as Partial<SessionDraftStore>;
    if (!value.entries || typeof value.entries !== 'object') return emptyStore();

    const entries: Record<string, SessionDraftEntry> = {};
    for (const [sessionId, entry] of Object.entries(value.entries)) {
      if (!sessionId || !entry || typeof entry !== 'object') continue;
      const candidate = entry as Partial<SessionDraftEntry>;
      if (typeof candidate.text !== 'string' || !candidate.text) continue;
      entries[sessionId] = {
        text: truncateDraftText(candidate.text).text,
        updatedAt: typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : 0
      };
    }

    const order: string[] = [];
    const seen = new Set<string>();
    for (const sessionId of Array.isArray(value.order) ? value.order : []) {
      if (typeof sessionId !== 'string' || !entries[sessionId] || seen.has(sessionId)) continue;
      seen.add(sessionId);
      order.push(sessionId);
    }
    // 旧数据/手改数据可能缺 order；按 entries 顺序补在末尾，至少不会丢草稿。
    for (const sessionId of Object.keys(entries)) if (!seen.has(sessionId)) order.push(sessionId);

    const limited = order.slice(-MAX_SESSION_DRAFTS);
    for (const sessionId of order.slice(0, Math.max(0, order.length - MAX_SESSION_DRAFTS))) delete entries[sessionId];
    return { version: 1, entries, order: limited };
  } catch {
    return emptyStore();
  }
}

export function loadSessionDraft(storage: DraftStorage | undefined, sessionId: string): string {
  if (!storage || !sessionId) return '';
  try {
    return parseSessionDraftStore(storage.getItem(SESSION_DRAFT_STORAGE_KEY)).entries[sessionId]?.text ?? '';
  } catch {
    return '';
  }
}

export function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  return candidate.name === 'QuotaExceededError'
    || candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || candidate.code === 22
    || candidate.code === 1014
    || (typeof candidate.message === 'string' && /quota/i.test(candidate.message));
}

function persistStore(storage: DraftStorage, store: SessionDraftStore): void {
  if (!store.order.length) {
    storage.removeItem(SESSION_DRAFT_STORAGE_KEY);
    return;
  }
  storage.setItem(SESSION_DRAFT_STORAGE_KEY, JSON.stringify(store));
}

function removeEntry(store: SessionDraftStore, sessionId: string): void {
  delete store.entries[sessionId];
  const index = store.order.indexOf(sessionId);
  if (index >= 0) store.order.splice(index, 1);
}

export function saveSessionDraft(
  storage: DraftStorage | undefined,
  sessionId: string,
  text: string,
  options: { now?: number } = {}
): SaveDraftResult {
  const result: SaveDraftResult = { saved: false, truncated: false, evicted: 0, quotaExceeded: false };
  if (!storage || !sessionId) return result;

  const normalized = truncateDraftText(text);
  result.truncated = normalized.truncated;
  // 任何一次显式落盘（包括空写入=清空）都比此前排队的防抖快照新；
  // 让旧快照失效，避免它稍后覆盖这次结果。
  invalidateDraftWrites(sessionId);

  let store: SessionDraftStore;
  try {
    store = parseSessionDraftStore(storage.getItem(SESSION_DRAFT_STORAGE_KEY));
  } catch {
    store = emptyStore();
  }

  if (!normalized.text) {
    removeEntry(store, sessionId);
  } else {
    const previousIndex = store.order.indexOf(sessionId);
    if (previousIndex >= 0) store.order.splice(previousIndex, 1);
    store.order.push(sessionId);
    store.entries[sessionId] = { text: normalized.text, updatedAt: options.now ?? Date.now() };
  }

  // 正常情况按 LRU 裁掉最旧的；配额不足时继续从最旧开始腾位置，但永远保留当前会话。
  while (store.order.length > MAX_SESSION_DRAFTS) {
    const victim = store.order.find(id => id !== sessionId);
    if (!victim) break;
    removeEntry(store, victim);
    result.evicted += 1;
  }

  while (true) {
    try {
      persistStore(storage, store);
      result.saved = true;
      return result;
    } catch (error) {
      if (!isQuotaExceededError(error)) return result;
      result.quotaExceeded = true;
      const victim = store.order.find(id => id !== sessionId);
      if (!victim) return result;
      removeEntry(store, victim);
      result.evicted += 1;
    }
  }
}

export function clearSessionDraft(storage: DraftStorage | undefined, sessionId: string): boolean {
  if (!sessionId) return false;
  // 即使当前没有落盘条目，也要让排队的旧写入过期（发送成功时 timer 可能还没到期）。
  invalidateDraftWrites(sessionId);
  if (!storage) return false;
  try {
    const store = parseSessionDraftStore(storage.getItem(SESSION_DRAFT_STORAGE_KEY));
    if (!store.entries[sessionId]) return false;
    removeEntry(store, sessionId);
    persistStore(storage, store);
    return true;
  } catch {
    // 清理失败也不能影响发送或继续输入；下次 save 会再尝试覆写。
    return false;
  }
}

/**
 * 可单测的防抖写入器。调度函数可注入，测试里配 fake timers 即可。
 */
export function createSessionDraftWriter(options: {
  storage: DraftStorage | undefined;
  delayMs?: number;
  now?: () => number;
  onSave?: (result: SaveDraftResult, sessionId: string, text: string) => void;
}): SessionDraftWriter {
  const delayMs = options.delayMs ?? DEFAULT_DRAFT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { sessionId: string; text: string; revision: number } | undefined;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const cancel = () => {
    clearTimer();
    // cancel 的语义是「这次待写内容已经不需要了」（发送成功），必须连 pending 一起丢掉；
    // 否则卸载/切会话时的 flush 会把刚清掉的已发送内容重新写回 localStorage。
    pending = undefined;
  };

  const flush = (): SaveDraftResult | undefined => {
    clearTimer();
    if (!pending) return undefined;
    const current = pending;
    pending = undefined;
    // 写入排队之后草稿被清空/覆盖过：这份文本已经过期，直接丢弃。
    if (draftRevision(current.sessionId) !== current.revision) return undefined;
    const result = saveSessionDraft(options.storage, current.sessionId, current.text, {
      ...(options.now ? { now: options.now() } : {})
    });
    options.onSave?.(result, current.sessionId, current.text);
    return result;
  };

  const write = (sessionId: string, text: string) => {
    if (!sessionId) return;
    clearTimer();
    pending = { sessionId, text, revision: draftRevision(sessionId) };
    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, delayMs);
  };

  return { write, flush, cancel, hasPending: () => pending !== undefined };
}

/** 页面卸载/进入 bfcache 前把待写草稿落盘。返回解绑函数。 */
export function registerDraftFlush(target: EventTarget, flush: () => void): () => void {
  const handler = () => flush();
  target.addEventListener('pagehide', handler);
  target.addEventListener('beforeunload', handler);
  return () => {
    target.removeEventListener('pagehide', handler);
    target.removeEventListener('beforeunload', handler);
  };
}
