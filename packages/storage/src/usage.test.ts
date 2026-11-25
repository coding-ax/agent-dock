import { describe, expect, it } from 'vitest';
import { computeTps, createRepositories } from './index.js';

describe('turn_usage 统计仓储', () => {
  it('按 (sessionId, requestId) 幂等写入并准确计算单轮与会话级 TPS', async () => {
    const repos = createRepositories(':memory:');
    try {
      await repos.sessions.save({
        id: 'ses_1', agentId: 'codex', state: 'idle', cwd: '/repo/alpha', model: 'gpt-5',
        permissionMode: 'full-trust', runId: 'run_1', createdAt: '2026-11-20T01:00:00.000Z', updatedAt: '2026-11-20T01:00:00.000Z'
      });

      const first = await repos.usage.save({
        id: 'u_1', sessionId: 'ses_1', taskId: 'task_1', requestId: 'req_1',
        agentId: 'codex', cwd: '/repo/alpha', model: 'gpt-5',
        inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 0, thoughtTokens: 100, totalTokens: 1800,
        costUsd: 0.012, durationMs: 10_000, generationMs: 5_000, ttftMs: 400,
        source: 'acp', createdAt: '2026-11-20T02:00:00.000Z'
      });
      expect(first).toBe(true);

      // 重复 requestId 幂等忽略
      const dup = await repos.usage.save({
        id: 'u_1_dup', sessionId: 'ses_1', taskId: 'task_1', requestId: 'req_1',
        agentId: 'codex', cwd: '/repo/alpha', model: 'gpt-5',
        inputTokens: 9999, outputTokens: 9999, cacheReadTokens: 0, cacheWriteTokens: 0, thoughtTokens: 0, totalTokens: 19998,
        source: 'acpx-backfill', createdAt: '2026-11-20T02:00:00.000Z'
      });
      expect(dup).toBe(false);

      await repos.usage.save({
        id: 'u_2', sessionId: 'ses_1', taskId: 'task_2', requestId: 'req_2',
        agentId: 'codex', cwd: '/repo/alpha', model: 'gpt-5',
        inputTokens: 500, outputTokens: 400, cacheReadTokens: 1000, cacheWriteTokens: 0, thoughtTokens: 0, totalTokens: 1900,
        costUsd: 0.008, durationMs: 8_000, generationMs: 4_000, ttftMs: 300,
        source: 'acp', createdAt: '2026-11-20T03:00:00.000Z'
      });

      const detail = await repos.usage.getSessionUsage('ses_1');
      expect(detail.totals.totalTokens).toBe(3700);
      expect(detail.totals.inputTokens).toBe(1500);
      expect(detail.totals.outputTokens).toBe(600);
      expect(detail.totals.thoughtTokens).toBe(100);
      expect(detail.totals.cacheReadTokens).toBe(1500);
      expect(detail.totals.costUsd).toBeCloseTo(0.02, 6);
      expect(detail.totals.turnCount).toBe(2);
      // outputTokens 已包含 thoughtTokens（ACP / OpenAI / Gemini 规范），不再重复相加：
      // (200 + 400) / (9000ms / 1000) = 600 / 9 = 66.7
      expect(detail.totals.avgTps).toBe(66.7);
      // 最近一轮：400 / 4s = 100
      expect(detail.totals.lastTps).toBe(100);
      expect(detail.turns).toHaveLength(2);
      // 第一轮：200 / 5s = 40（不把 thoughtTokens=100 再加一次）
      expect(detail.turns[0]!.tps).toBe(40);
      expect(detail.turns[1]!.tps).toBe(100);
    } finally {
      repos.close();
    }
  });

  it('支持时间范围筛选与按项目/Agent/会话/模型多维聚合', async () => {
    const repos = createRepositories(':memory:');
    try {
      await repos.projects.ensure('/repo/alpha');
      await repos.projects.ensure('/repo/beta');
      await repos.sessions.save({
        id: 'ses_a', agentId: 'claude', state: 'idle', cwd: '/repo/alpha', model: 'claude-opus',
        permissionMode: 'full-trust', runId: 'run_a', createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z'
      });
      await repos.sessions.saveTitles('ses_a', { customTitle: '架构改造' });
      await repos.sessions.save({
        id: 'ses_b', agentId: 'antigravity', state: 'idle', cwd: '/repo/beta', model: 'gemini-4-neon',
        permissionMode: 'full-trust', runId: 'run_b', createdAt: '2026-11-23T10:00:00.000Z', updatedAt: '2026-11-23T10:00:00.000Z'
      });

      await repos.usage.save({
        id: 'u_a', sessionId: 'ses_a', requestId: 'r_a', agentId: 'claude', cwd: '/repo/alpha', model: 'claude-opus',
        inputTokens: 100, outputTokens: 200, cacheReadTokens: 700, cacheWriteTokens: 0, thoughtTokens: 0, totalTokens: 1000,
        costUsd: 0.5, generationMs: 2000, source: 'acp', createdAt: '2026-11-18T10:05:00.000Z'
      });
      await repos.usage.save({
        id: 'u_b', sessionId: 'ses_b', requestId: 'r_b', agentId: 'antigravity', cwd: '/repo/beta', model: 'gemini-4-neon',
        inputTokens: 300, outputTokens: 600, cacheReadTokens: 100, cacheWriteTokens: 0, thoughtTokens: 200, totalTokens: 1200,
        costUsd: null, generationMs: 4000, source: 'acp', createdAt: '2026-11-23T10:05:00.000Z'
      });

      const allSummary = await repos.usage.summary();
      expect(allSummary.totals.totalTokens).toBe(2200);
      expect(allSummary.totals.sessionCount).toBe(2);
      expect(allSummary.daily).toHaveLength(2);

      const recentOnly = await repos.usage.summary({ from: '2026-11-22T00:00:00.000Z' });
      expect(recentOnly.totals.totalTokens).toBe(1200);
      expect(recentOnly.totals.sessionCount).toBe(1);

      const byProject = await repos.usage.breakdown('project');
      expect(byProject.items.map(i => [i.label, i.totals.totalTokens])).toEqual([
        ['beta', 1200],
        ['alpha', 1000]
      ]);

      const byAgent = await repos.usage.breakdown('agent');
      expect(byAgent.items.map(i => [i.key, i.totals.totalTokens])).toEqual([
        ['antigravity', 1200],
        ['claude', 1000]
      ]);

      const bySession = await repos.usage.breakdown('session');
      expect(bySession.items[1]!.label).toBe('架构改造');

      const byModel = await repos.usage.breakdown('model');
      expect(byModel.items.map(i => i.key)).toEqual(['gemini-4-neon', 'claude-opus']);

      expect(computeTps(0, 1000)).toBeNull();
      expect(computeTps(100, 0)).toBeNull();
      expect(computeTps(769, 6049)).toBe(127.1);
    } finally {
      repos.close();
    }
  });
});
