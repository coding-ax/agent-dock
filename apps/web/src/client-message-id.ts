let sequence = 0;

/**
 * 一次「用户按下发送」的稳定标识。
 *
 * 只用页面内序号不够：刷新后序号从头开始，会和服务端刚记下的 key 撞上。
 * 所以优先用 crypto.randomUUID；不可用（非安全上下文）时退回时间戳 + 随机数。
 * 同一次提交在重试时必须复用同一个值，服务端才能把重放认成同一轮。
 */
export function createClientMessageId(): string {
  const unique = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `send-${unique}-${++sequence}`;
}
