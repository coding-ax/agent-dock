import { normalizeOutputPluginId } from '@agent-dock/agent-dock-shared';

export interface LarkGroupSendRecord {
  sessionId: string;
  appId: string;
  chatId: string;
  messageId: string;
  timestamp: number;
}

export interface LarkOutputPluginCardDedupKey {
  sessionId: string;
  taskId?: string;
  pluginId: string;
  widgetId: string;
  chatId: string;
}

export interface LarkOutputPluginCardClaim {
  acquired: boolean;
  /** 飞书接口返回 messageId 后调用：将占坑提升为已发送状态，防止后续任意路径重复推送。 */
  markSent(): void;
  /** 飞书发卡前失败或中止时调用：释放占坑，允许后续真实重试。 */
  release(): void;
}

const MAX_OWNED_TASKS = 5_000;
const MAX_OUTBOUND_MESSAGES = 5_000;
const MAX_TRACKED_SESSIONS = 1_000;
const MAX_SENDS_PER_SESSION = 50;
const MAX_SENT_PLUGIN_CARDS = 10_000;

function outputPluginCardDedupKeys(input: LarkOutputPluginCardDedupKey): string[] {
  const sessionId = input.sessionId.trim();
  const pluginId = normalizeOutputPluginId(input.pluginId);
  const widgetId = input.widgetId.trim();
  const chatId = input.chatId.trim();
  const taskId = input.taskId?.trim() ?? '';
  if (!sessionId || !pluginId || !widgetId || !chatId) return [];
  const keys = [
    // 会话 + 插件 + 组件 + 目标群/私聊级去重键：即便不同路径 taskId 口径不一致，同一交互卡仍绝不双发
    `w:${sessionId}\u0000${pluginId}\u0000${widgetId}\u0000${chatId}`
  ];
  if (taskId) {
    // 精确五元组键：(sessionId, taskId, pluginId, widgetId, chatId)
    keys.push(`t:${sessionId}\u0000${taskId}\u0000${pluginId}\u0000${widgetId}\u0000${chatId}`);
  }
  return keys;
}

/**
 * 跨组件共享的飞书轮次归属与发送追踪器：
 * 1. 记录由飞书入站消息发起的 runtime task（`LarkMessageCoordinator` 拥有），防止同步管道重复转发；
 * 2. 提供 `beginLarkDispatch` / `waitForPendingLarkDispatch` 消除「dispatch 尚未返回 taskId、
 *    runtime 已抢先触发 onTurnStart」的竞态窗口；
 * 3. 记录本轮通过 `group send` 发往某绑定群的消息，供全轮次同步做同轮去重；
 * 4. 记录所有由同步管道或群工具主动发出的 `messageId`，防止飞书回声反向唤醒机器人形成自激循环；
 * 5. 提供跨 listener / turn-sync 共享的交互插件卡片同步占坑与已发幂等去重表，彻底消灭并发竞态双发。
 */
export class LarkTurnTracker {
  private readonly larkOwnedTasks = new Set<string>();
  private readonly pendingDispatches = new Map<string, Set<Promise<void>>>();
  private readonly activeLarkSendSessions = new Map<string, number>();
  private readonly outboundMessageIds = new Set<string>();
  private readonly groupSendsBySession = new Map<string, LarkGroupSendRecord[]>();
  private readonly groupSendListeners = new Set<(record: LarkGroupSendRecord) => void>();
  private readonly inFlightPluginCards = new Set<string>();
  private readonly sentPluginCards = new Set<string>();

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

  /**
   * 同步占坑飞书输出插件卡片派发权（必须在任何 await / 网络发卡前调用）：
   * 同一 `(sessionId, taskId, pluginId, widgetId, chatId)` 或 `(sessionId, pluginId, widgetId, chatId)`
   * 只要已有进行中或已完成的发送，后续并发或重复路径立即返回 `acquired: false`。
   */
  tryClaimOutputPluginCard(input: LarkOutputPluginCardDedupKey): LarkOutputPluginCardClaim {
    const keys = outputPluginCardDedupKeys(input);
    if (keys.length === 0) {
      return { acquired: false, markSent() {}, release() {} };
    }
    for (const key of keys) {
      if (this.inFlightPluginCards.has(key) || this.sentPluginCards.has(key)) {
        return { acquired: false, markSent() {}, release() {} };
      }
    }
    for (const key of keys) {
      this.inFlightPluginCards.add(key);
    }
    let settled = false;
    return {
      acquired: true,
      markSent: () => {
        if (settled) return;
        settled = true;
        for (const key of keys) {
          this.inFlightPluginCards.delete(key);
          this.addSentPluginCardKey(key);
        }
      },
      release: () => {
        if (settled) return;
        settled = true;
        for (const key of keys) {
          this.inFlightPluginCards.delete(key);
        }
      }
    };
  }

  markOutputPluginCardSent(input: LarkOutputPluginCardDedupKey): void {
    const keys = outputPluginCardDedupKeys(input);
    for (const key of keys) {
      this.inFlightPluginCards.delete(key);
      this.addSentPluginCardKey(key);
    }
  }

  hasOutputPluginCard(input: LarkOutputPluginCardDedupKey): boolean {
    const keys = outputPluginCardDedupKeys(input);
    return keys.some(key => this.inFlightPluginCards.has(key) || this.sentPluginCards.has(key));
  }

  private addSentPluginCardKey(key: string): void {
    this.sentPluginCards.add(key);
    if (this.sentPluginCards.size > MAX_SENT_PLUGIN_CARDS) {
      const oldest = this.sentPluginCards.values().next().value;
      if (oldest) this.sentPluginCards.delete(oldest);
    }
  }

  clear(): void {
    this.larkOwnedTasks.clear();
    this.pendingDispatches.clear();
    this.activeLarkSendSessions.clear();
    this.outboundMessageIds.clear();
    this.groupSendsBySession.clear();
    this.groupSendListeners.clear();
    this.inFlightPluginCards.clear();
    this.sentPluginCards.clear();
  }
}
