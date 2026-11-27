export interface LarkGroupSendRecord {
  sessionId: string;
  appId: string;
  chatId: string;
  messageId: string;
  timestamp: number;
}

const MAX_OWNED_TASKS = 5_000;
const MAX_OUTBOUND_MESSAGES = 5_000;
const MAX_TRACKED_SESSIONS = 1_000;
const MAX_SENDS_PER_SESSION = 50;

/**
 * 跨组件共享的飞书轮次归属与发送追踪器：
 * 1. 记录由飞书入站消息发起的 runtime task（`LarkMessageCoordinator` 拥有），防止同步管道重复转发；
 * 2. 提供 `beginLarkDispatch` / `waitForPendingLarkDispatch` 消除「dispatch 尚未返回 taskId、
 *    runtime 已抢先触发 onTurnStart」的竞态窗口；
 * 3. 记录本轮通过 `group send` 发往某绑定群的消息，供全轮次同步做同轮去重；
 * 4. 记录所有由同步管道或群工具主动发出的 `messageId`，防止飞书回声反向唤醒机器人形成自激循环。
 */
export class LarkTurnTracker {
  private readonly larkOwnedTasks = new Set<string>();
  private readonly pendingDispatches = new Map<string, Set<Promise<void>>>();
  private readonly activeLarkSendSessions = new Map<string, number>();
  private readonly outboundMessageIds = new Set<string>();
  private readonly groupSendsBySession = new Map<string, LarkGroupSendRecord[]>();
  private readonly groupSendListeners = new Set<(record: LarkGroupSendRecord) => void>();

  beginLarkDispatch(sessionId: string): () => void {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    let set = this.pendingDispatches.get(sessionId);
    if (!set) {
      set = new Set();
      this.pendingDispatches.set(sessionId, set);
    }
    set.add(promise);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
      const current = this.pendingDispatches.get(sessionId);
      if (current) {
        current.delete(promise);
        if (current.size === 0) this.pendingDispatches.delete(sessionId);
      }
    };
  }

  async waitForPendingLarkDispatch(sessionId: string): Promise<void> {
    while (true) {
      const pending = this.pendingDispatches.get(sessionId);
      if (!pending || pending.size === 0) return;
      await Promise.all([...pending]);
    }
  }

  markLarkOwnedTask(taskId: string | undefined): void {
    const trimmed = taskId?.trim();
    if (!trimmed) return;
    this.larkOwnedTasks.add(trimmed);
    if (this.larkOwnedTasks.size > MAX_OWNED_TASKS) {
      const oldest = this.larkOwnedTasks.values().next().value;
      if (oldest) this.larkOwnedTasks.delete(oldest);
    }
  }

  isLarkOwnedTask(taskId: string | undefined): boolean {
    const trimmed = taskId?.trim();
    return Boolean(trimmed && this.larkOwnedTasks.has(trimmed));
  }

  beginLarkSend(sessionId: string): () => void {
    this.activeLarkSendSessions.set(sessionId, (this.activeLarkSendSessions.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.activeLarkSendSessions.get(sessionId) ?? 1) - 1;
      if (next <= 0) this.activeLarkSendSessions.delete(sessionId);
      else this.activeLarkSendSessions.set(sessionId, next);
    };
  }

  isLarkSendActive(sessionId: string): boolean {
    return (this.activeLarkSendSessions.get(sessionId) ?? 0) > 0;
  }

  markOutboundMessage(messageId: string | undefined): void {
    const trimmed = messageId?.trim();
    if (!trimmed) return;
    this.outboundMessageIds.add(trimmed);
    if (this.outboundMessageIds.size > MAX_OUTBOUND_MESSAGES) {
      const oldest = this.outboundMessageIds.values().next().value;
      if (oldest) this.outboundMessageIds.delete(oldest);
    }
  }

  isOutboundMessage(messageId: string | undefined): boolean {
    const trimmed = messageId?.trim();
    return Boolean(trimmed && this.outboundMessageIds.has(trimmed));
  }

  recordGroupSend(record: LarkGroupSendRecord): void {
    this.markOutboundMessage(record.messageId);
    let list = this.groupSendsBySession.get(record.sessionId);
    if (!list) {
      list = [];
      this.groupSendsBySession.set(record.sessionId, list);
      if (this.groupSendsBySession.size > MAX_TRACKED_SESSIONS) {
        const oldest = this.groupSendsBySession.keys().next().value;
        if (oldest) this.groupSendsBySession.delete(oldest);
      }
    }
    list.push(record);
    if (list.length > MAX_SENDS_PER_SESSION) {
      list.splice(0, list.length - MAX_SENDS_PER_SESSION);
    }
    for (const listener of this.groupSendListeners) {
      try { listener(record); } catch { /* 监听方异常不影响 group send 主路径 */ }
    }
  }

  onGroupSend(listener: (record: LarkGroupSendRecord) => void): () => void {
    this.groupSendListeners.add(listener);
    return () => this.groupSendListeners.delete(listener);
  }

  hasGroupSendSince(sessionId: string, chatId: string, sinceMs: number): boolean {
    const list = this.groupSendsBySession.get(sessionId);
    if (!list?.length) return false;
    return list.some(item => item.chatId === chatId && item.timestamp >= sinceMs);
  }

  /**
   * 轮次结束消费该轮的 group send 记录：同一会话紧接着开始下一轮时，
   * 上一轮已触发去重的 group send 绝不会误伤下一轮的同步。
   */
  consumeGroupSends(sessionId: string, chatId: string, upToMs: number): void {
    const list = this.groupSendsBySession.get(sessionId);
    if (!list?.length) return;
    const remaining = list.filter(item => !(item.chatId === chatId && item.timestamp <= upToMs));
    if (remaining.length === 0) this.groupSendsBySession.delete(sessionId);
    else this.groupSendsBySession.set(sessionId, remaining);
  }

  clear(): void {
    this.larkOwnedTasks.clear();
    this.pendingDispatches.clear();
    this.activeLarkSendSessions.clear();
    this.outboundMessageIds.clear();
    this.groupSendsBySession.clear();
    this.groupSendListeners.clear();
  }
}
