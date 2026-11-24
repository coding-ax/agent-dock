import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { createUsageBackfiller } from './usage-backfill.js';

describe('历史 acpx 会话用量回填', () => {
  it('从 .agentdock/acpx/sessions/<id>.json 幂等回填真实 request_token_usage 与费用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-usage-backfill-'));
    const repos = createRepositories(':memory:');
    try {
      const acpxDir = join(dir, '.agentdock', 'acpx', 'sessions');
      mkdirSync(acpxDir, { recursive: true });
      await repos.sessions.save({
        id: 'ses_hist', agentId: 'claude', state: 'idle', cwd: dir, model: 'claude-opus',
        permissionMode: 'full-trust', runId: 'run_1',
        createdAt: '2026-11-20T01:00:00.000Z', updatedAt: '2026-11-20T02:00:00.000Z'
      });

      writeFileSync(join(acpxDir, 'ses_hist.json'), JSON.stringify({
        last_prompt_at: '2026-11-20T02:00:00.000Z',
        cumulative_cost: { amount: 1.5, currency: 'USD' },
        request_token_usage: {
          req_a: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 850, total_tokens: 1000 },
          req_b: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 1700, total_tokens: 2000 }
        }
      }));

      const backfiller = createUsageBackfiller({
        listSessions: () => repos.sessions.list(),
        saveTurnUsage: record => repos.usage.save(record)
      });
      const first = await backfiller.sync();
      expect(first).toBe(2);

      // 再次同步不会重复写入
      const second = await backfiller.sync();
      expect(second).toBe(0);

      const detail = await repos.usage.getSessionUsage('ses_hist');
      expect(detail.totals.totalTokens).toBe(3000);
      expect(detail.totals.inputTokens).toBe(300);
      expect(detail.totals.outputTokens).toBe(150);
      expect(detail.totals.cacheReadTokens).toBe(2550);
      expect(detail.totals.costUsd).toBeCloseTo(1.5, 5);
      expect(detail.turns).toHaveLength(2);
    } finally {
      repos.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
