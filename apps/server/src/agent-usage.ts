export type AgentUsageWindow = { label: string; usedPercent: number; resetsAt?: number };
export type AgentUsage = {
  status: 'available' | 'unavailable';
  plan?: string;
  windows: AgentUsageWindow[];
  reason?: string;
  source?: string;
  stale?: boolean;
  checkedAt: number;
};

export const unavailableUsage = (reason: string, source?: string): AgentUsage => ({
  status: 'unavailable', reason, source, windows: [], checkedAt: Date.now()
});

export function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, 100) : undefined;
}

export function resetSeconds(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n > 1e11 ? n / 1000 : n) : undefined;
}
