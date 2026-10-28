let sequence = 0;

// These IDs only identify pending UI messages in this page, not persisted tasks.
// A page-local sequence also works on HTTP deployments without crypto.randomUUID.
export function createOptimisticMessageId(): string {
  return `optimistic-${++sequence}`;
}
