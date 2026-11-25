import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeId, type Session, type TurnUsageRecord } from '@agent-dock/agent-dock-shared';

export interface UsageBackfillTarget {
  listSessions(): Promise<Session[]>;
  saveTurnUsage(record: TurnUsageRecord): Promise<boolean>;
}

type AcpxUsageEntry = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  thought_tokens?: number;
  total_tokens?: number;
};

type AcpxSessionFile = {
  created_at?: string;
  updated_at?: string;
  last_prompt_at?: string;
  cumulative_cost?: { amount?: number; currency?: string };
  request_token_usage?: Record<string, AcpxUsageEntry>;
};

const toNonNegInt = (value: unknown): number => {
  const num = Number(value ?? 0);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
};

/**
 * 从已有会话对应的 `.agentdock/acpx/sessions/<sessionId>.json` 中回填真实单轮 token 消耗。
 * 写入走 (session_id, request_id) 唯一索引幂等去重，不会与实时采集重复记账；
 * 并按文件 mtime 做内存缓存，避免频繁请求看板时重复读盘。
 */
export function createUsageBackfiller(target: UsageBackfillTarget, options: { minIntervalMs?: number } = {}) {
  const scannedMtime = new Map<string, number>();
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 60_000);
  let lastSyncedAt = 0;
  let inFlight: Promise<number> | undefined;

  async function runOnce(): Promise<number> {
    const sessions = await target.listSessions();
    let inserted = 0;

    for (const session of sessions) {
      if (!session.cwd) continue;
      const filePath = join(session.cwd, '.agentdock', 'acpx', 'sessions', `${session.id}.json`);
      let mtimeMs: number;
      try {
        const info = await stat(filePath);
        mtimeMs = info.mtimeMs;
      } catch {
        continue;
      }
      if (scannedMtime.get(filePath) === mtimeMs) continue;

      let parsed: AcpxSessionFile;
      try {
        parsed = JSON.parse(await readFile(filePath, 'utf8')) as AcpxSessionFile;
      } catch {
        scannedMtime.set(filePath, mtimeMs);
        continue;
      }
      scannedMtime.set(filePath, mtimeMs);

      const reqMap = parsed.request_token_usage;
      if (!reqMap || typeof reqMap !== 'object') continue;
      const entries = Object.entries(reqMap)
        .map(([requestId, raw]) => {
          const inputTokens = toNonNegInt(raw?.input_tokens);
          const rawOutput = toNonNegInt(raw?.output_tokens);
          const cacheReadTokens = toNonNegInt(raw?.cache_read_input_tokens);
          const cacheWriteTokens = toNonNegInt(raw?.cache_creation_input_tokens);
          const thoughtTokens = toNonNegInt(raw?.thought_tokens);
          const rawTotal = toNonNegInt(raw?.total_tokens);
          const baseSum = inputTokens + rawOutput + cacheReadTokens + cacheWriteTokens;
          const outputTokens = thoughtTokens > 0 && rawTotal > 0 && rawTotal === baseSum + thoughtTokens ? rawOutput + thoughtTokens : rawOutput;
          const totalTokens = rawTotal > 0 ? rawTotal : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
          return { requestId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, thoughtTokens, totalTokens };
        })
        .filter(item => item.totalTokens > 0 || item.inputTokens > 0 || item.outputTokens > 0);

      if (!entries.length) continue;

      const totalSessionTokens = entries.reduce((sum, item) => sum + item.totalTokens, 0);
      const totalCost = typeof parsed.cumulative_cost?.amount === 'number' && Number.isFinite(parsed.cumulative_cost.amount) && parsed.cumulative_cost.amount > 0
        ? parsed.cumulative_cost.amount
        : undefined;
      const fallbackTimestamp = parsed.last_prompt_at || parsed.updated_at || session.lastMessageAt || session.updatedAt || session.createdAt;

      for (const item of entries) {
        const costUsd = totalCost !== undefined && totalSessionTokens > 0
          ? Math.round((totalCost * (item.totalTokens / totalSessionTokens)) * 1_000_000) / 1_000_000
          : null;
        const ok = await target.saveTurnUsage({
          id: makeId('tu'),
          sessionId: session.id,
          taskId: null,
          requestId: item.requestId,
          agentId: session.agentId,
          cwd: session.cwd,
          model: session.model ?? null,
          inputTokens: item.inputTokens,
          outputTokens: item.outputTokens,
          cacheReadTokens: item.cacheReadTokens,
          cacheWriteTokens: item.cacheWriteTokens,
          thoughtTokens: item.thoughtTokens,
          totalTokens: item.totalTokens,
          costUsd,
          durationMs: null,
          generationMs: null,
          ttftMs: null,
          source: 'acpx-backfill',
          createdAt: fallbackTimestamp
        });
        if (ok) inserted += 1;
      }
    }

    return inserted;
  }

  return {
    async sync(force = false): Promise<number> {
      const nowMs = Date.now();
      if (!force && lastSyncedAt > 0 && nowMs - lastSyncedAt < minIntervalMs) return 0;
      if (!inFlight) {
        inFlight = runOnce().finally(() => {
          lastSyncedAt = Date.now();
          inFlight = undefined;
        });
      }
      return inFlight;
    }
  };
}
