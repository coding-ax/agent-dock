import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { percent, resetSeconds, unavailableUsage, type AgentUsage, type AgentUsageWindow } from './agent-usage.js';

type Quota = { label?: string; used_percent?: number; remaining_percent?: number; resets_at?: string | number };
type OnWatchWindow = { used_percentage?: number; remaining_percentage?: number; resets_at?: number };
type ClaudeSnapshot = {
  plan?: string;
  quotas?: Record<string, Quota>;
  rate_limits?: { five_hour?: OnWatchWindow; seven_day?: OnWatchWindow };
  five_hour_used_percent?: number; five_hour_remaining_percent?: number; five_hour_resets_at?: string;
  seven_day_used_percent?: number; seven_day_remaining_percent?: number; seven_day_resets_at?: string;
};

export function normalizeClaudeUsage(raw: ClaudeSnapshot, checkedAt = Date.now(), stale = false): AgentUsage {
  const windows: AgentUsageWindow[] = [];
  const add = (label: string, used: unknown, remaining: unknown, reset: unknown) => {
    const usedPercent = percent(used) ?? (percent(remaining) === undefined ? undefined : 100 - percent(remaining)!);
    if (usedPercent !== undefined) windows.push({ label, usedPercent, ...(resetSeconds(reset) ? { resetsAt: resetSeconds(reset) } : {}) });
  };
  if (raw.quotas && Object.keys(raw.quotas).length) {
    for (const [key, quota] of Object.entries(raw.quotas)) add(quota.label ?? ({ five_hour: '5 小时', seven_day: '7 天' }[key] ?? key), quota.used_percent, quota.remaining_percent, quota.resets_at);
  } else if (raw.rate_limits) {
    const five = raw.rate_limits.five_hour;
    const seven = raw.rate_limits.seven_day;
    if (five) add('5 小时', five.used_percentage, five.remaining_percentage, five.resets_at);
    if (seven) add('7 天', seven.used_percentage, seven.remaining_percentage, seven.resets_at);
  } else {
    add('5 小时', raw.five_hour_used_percent, raw.five_hour_remaining_percent, raw.five_hour_resets_at);
    add('7 天', raw.seven_day_used_percent, raw.seven_day_remaining_percent, raw.seven_day_resets_at);
  }
  if (!windows.length) return { ...unavailableUsage('Claude statusline 快照没有可用额度。', 'statusline'), checkedAt };
  return { status: 'available', plan: raw.plan, windows, source: 'statusline', stale, checkedAt };
}

export async function readClaudeUsage(): Promise<AgentUsage> {
  const home = homedir();
  const candidates = [
    join(home, '.claude/statusline-snapshot.json'),
    join(home, '.claude/kaboo-statusline.json'),
    join(home, '.claude/anthropic-statusline.json'),
    join(home, '.onwatch/data/anthropic-statusline.json'),
    join(home, '.local/share/onwatch/claude_statusline.json')
  ];
  for (const path of candidates) {
    try {
      const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      if (content.length > 64 * 1024) return unavailableUsage('Claude statusline 快照过大。', 'statusline');
      const result = normalizeClaudeUsage(JSON.parse(content) as ClaudeSnapshot, Date.now(), Date.now() - info.mtimeMs > 5 * 60_000);
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return unavailableUsage('Claude statusline 快照无法读取或格式无效。', 'statusline');
    }
  }
  return unavailableUsage('未找到 Claude 额度快照。登录 Claude Code 并配置 statusline 后可查看；当前未读取其 OAuth 凭证。');
}

let cached: AgentUsage | undefined;
let inFlight: Promise<AgentUsage> | undefined;
export async function getClaudeUsage(refresh = false): Promise<AgentUsage> {
  if (!refresh && cached && Date.now() - cached.checkedAt < 60_000) return cached;
  if (!inFlight) inFlight = readClaudeUsage().then(result => { cached = result; return result; }).finally(() => { inFlight = undefined; });
  return inFlight;
}
