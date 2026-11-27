import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentUsage } from './agent-usage.js';
import {
  MAGPIE_CACHE_TTL_MS,
  MAGPIE_NEGATIVE_TTL_MS,
  MAGPIE_REFRESH_COOLDOWN_MS,
  maskAccountLabel,
  resetMagpieUsageCacheForTests,
  resolveAcpSessionIdFromStore,
  resolveAgentUsage,
  type FetchLike
} from './magpie-usage.js';

const tempDirs: string[] = [];

beforeEach(() => {
  resetMagpieUsageCacheForTests();
});

afterEach(async () => {
  resetMagpieUsageCacheForTests();
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeTempHome(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'agentdock-magpie-usage-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return dir;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const MAGPIE_ORIGIN = 'http://127.0.0.1:3425';

function createMagpieMockFetch(overrides: {
  requireAuthToken?: string;
  forbidQuotas?: boolean;
  root?: unknown;
  quotas?: unknown;
  accounts?: unknown;
  models?: unknown;
  usageToday?: unknown;
  routes?: Record<string, unknown>;
} = {}) {
  const calls: Array<{ url: string; auth?: string | null }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization');
    calls.push({ url: input, auth });

    if (overrides.requireAuthToken && auth !== `Bearer ${overrides.requireAuthToken}`) {
      if (!input.endsWith('/')) {
        return jsonResponse({ error: { message: 'unauthorized magpie key' } }, 401);
      }
    }
    if (overrides.forbidQuotas && input.includes('/v1/magpie/quotas')) {
      return jsonResponse({ error: { message: 'quotas disabled for this key' } }, 403);
    }

    const url = new URL(input);
    if (url.pathname === '/') {
      return jsonResponse(overrides.root ?? {
        name: 'magpie',
        version: '0.1.4808',
        apis: ['/v1/messages', '/v1/responses', '/v1/magpie/quotas', '/v1/magpie/accounts', '/v1/magpie/usage', '/v1/magpie/route']
      });
    }
    if (url.pathname === '/v1/magpie/quotas') {
      return jsonResponse(overrides.quotas ?? {
        object: 'list',
        data: [
          {
            provider: 'workbuddy',
            name: 'WorkBuddy',
            kind: 'subscription',
            plan: 'Free plan',
            user: 'alpha-owner',
            windows: [
              { name: 'Credits', used: 100, remaining: 0, amount: 500, limit: 500, unit: 'credits', resetsAt: '2026-11-30T15:59:59Z' },
              { name: 'Extra credits', used: 50, remaining: 50, amount: 2500, limit: 5000, unit: 'credits', runsOutAt: '2026-12-08T12:00:00Z' },
              { name: 'Total credits', used: 54.55, remaining: 45.45, amount: 3000, limit: 5500, unit: 'credits', resetsAt: '2026-11-30T15:59:59Z', runsOutAt: '2026-12-08T12:00:00Z' }
            ],
            readAt: '2026-11-27T01:50:00Z'
          },
          {
            provider: 'workbuddy',
            name: 'WorkBuddy',
            kind: 'subscription',
            plan: 'Free plan',
            user: 'beta@example.com',
            alias: '备用主号',
            windows: [
              { name: 'Credits', used: 20, remaining: 80, amount: 100, limit: 500, unit: 'credits', resetsAt: '2026-11-30T15:59:59Z' },
              { name: 'Extra credits', used: 0, remaining: 100, amount: 0, limit: 4000, unit: 'credits' },
              { name: 'Total credits', used: 2.22, remaining: 97.78, amount: 100, limit: 4500, unit: 'credits', resetsAt: '2026-11-30T15:59:59Z', runsOutAt: '2026-12-06T08:00:00Z' }
            ],
            readAt: '2026-11-27T01:50:00Z'
          },
          {
            provider: 'deepseek',
            name: 'DeepSeek',
            kind: 'balance',
            user: 'sk-live-secret-should-never-leak',
            windows: [],
            balance: '¥256.16',
            readAt: '2026-11-27T01:50:00Z'
          },
          {
            provider: 'agy-cli',
            name: 'Antigravity (local agy CLI)',
            kind: 'subscription',
            user: 'owner@example.com',
            windows: [{ name: 'Gemini · 5 hours', used: 4, remaining: 96 }],
            readAt: '2026-11-27T01:50:00Z'
          },
          {
            provider: 'cursor',
            name: 'Cursor',
            kind: 'subscription',
            user: 'owner@example.com',
            windows: [{ name: 'Weekly', used: 40, remaining: 60 }],
            readAt: '2026-11-27T01:50:00Z'
          }
        ]
      });
    }
    if (url.pathname === '/v1/magpie/accounts') {
      return jsonResponse(overrides.accounts ?? {
        object: 'list',
        data: [
          { provider: 'workbuddy', providerName: 'WorkBuddy', id: 'wb1', kind: 'account', user: 'alpha-owner', on: true },
          { provider: 'workbuddy', providerName: 'WorkBuddy', id: 'wb2', kind: 'account', user: 'beta@example.com', on: true },
          { provider: 'deepseek', providerName: 'DeepSeek', id: 'ds1', kind: 'key', user: 'sk-live-secret-should-never-leak', on: true },
          { provider: 'cpa', providerName: 'CPA Singapore', id: 'cpa1', kind: 'key', label: 'a796…babe', on: true },
          { provider: 'agy-cli', providerName: 'Antigravity (local agy CLI)', id: 'agy1', kind: 'account', user: 'owner@example.com', on: true }
        ]
      });
    }
    if (url.pathname === '/v1/models') {
      return jsonResponse(overrides.models ?? {
        data: [
          { id: 'workbuddy/deepseek-v4.1-flash', owned_by: 'workbuddy' },
          { id: 'cpa/claude-opus-5-5', owned_by: 'cpa' },
          { id: 'deepseek/deepseek-flash', owned_by: 'deepseek' }
        ]
      });
    }
    if (url.pathname === '/v1/magpie/usage') {
      return jsonResponse(overrides.usageToday ?? {
        period: 'today',
        models: [
          { provider: 'cpa', model: 'claude-opus-5-5', calls: 12, errors: 1, input: 18_000, output: 6_500, cache_read: 95_000, cache_write: 0, cost: 0.482 }
        ],
        accounts: [
          { provider: 'workbuddy', account: 'beta@example.com', calls: 38, errors: 0, input: 90_000, output: 20_000, cache_read: 400_000, cost: 0.05, credits: 12.5 }
        ]
      });
    }
    if (url.pathname === '/v1/magpie/route') {
      const sid = url.searchParams.get('session') ?? '';
      return jsonResponse(overrides.routes?.[sid] ?? { route: null, seq: 0, session: sid });
    }
    return jsonResponse({ error: { message: 'not found' } }, 404);
  };
  return { fetchImpl, calls };
}

const sampleOfficial = (source: string, usedPercent = 12): AgentUsage => ({
  status: 'available',
  plan: 'Official Pro',
  source,
  windows: [{ label: '5 小时', usedPercent }],
  checkedAt: 1_700_000_000_000
});

describe('magpie-usage 自动识别、多供应商聚合、脱敏与缓存', () => {
  it('maskAccountLabel 保留非敏感 alias，脱敏邮箱、密钥、UUID 与普通账号名', () => {
    expect(maskAccountLabel('alice@example.com', '工作主号')).toBe('工作主号');
    expect(maskAccountLabel('alice@example.com')).toBe('a***@example.com');
    expect(maskAccountLabel('alice@example.com', 'bob@example.com')).toBe('a***@example.com');
    expect(maskAccountLabel('sk-1234567890abcdef')).toBe('密钥账号');
    expect(maskAccountLabel('a64e16ed-1d61-4481-9607-fbf4c4b495ba')).toBe('a64e…95ba');
    expect(maskAccountLabel('落叶几分秋')).toBe('落***秋');
    expect(maskAccountLabel('尘')).toBe('尘*');
  });

  it('Claude Code 经由本机 Magpie 路由：自动聚合多账号池、识别活跃账号、脱敏邮箱并映射别名槽位', async () => {
    const home = await makeTempHome({
      '.claude/settings.json': JSON.stringify({
        model: 'sonnet[1m]',
        env: {
          ANTHROPIC_BASE_URL: MAGPIE_ORIGIN,
          ANTHROPIC_AUTH_TOKEN: 'magpie-secret-token-xyz',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'workbuddy/deepseek-v4.1-flash[1m]'
        }
      }),
      '.config/magpie/gateway.json': JSON.stringify({ addr: '127.0.0.1:3425' })
    });
    const { fetchImpl } = createMagpieMockFetch();
    const officialClaude = vi.fn(async () => sampleOfficial('statusline', 80));

    const result = await resolveAgentUsage({
      agentId: 'claude',
      model: 'sonnet[1m]',
      home,
      env: {},
      fetchImpl,
      now: () => 1_700_000_000_000,
      officialFetchers: { claude: officialClaude }
    });

    expect(officialClaude).not.toHaveBeenCalled();
    expect(result.status).toBe('available');
    expect(result.source).toBe('Magpie · WorkBuddy');
    expect(result.sourceMeta).toMatchObject({
      service: 'magpie',
      providerId: 'workbuddy',
      providerName: 'WorkBuddy',
      endpoint: MAGPIE_ORIGIN,
      gatewayVersion: '0.1.4808',
      matchedBy: 'agent_config',
      matchedModel: 'workbuddy/deepseek-v4.1-flash',
      activeAccount: '备用主号',
      accountCount: 2
    });
    // 汇总 Total credits: (3000 + 100) / (5500 + 4500) = 3100 / 10000 = 31%
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]).toMatchObject({
      label: 'Total credits',
      usedPercent: 31,
      display: '3,100 / 10,000 credits',
      aggregated: true
    });
    expect(result.windows[0]?.runsOutAt).toBe(Math.floor(Date.parse('2026-12-06T08:00:00Z') / 1000));
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts?.map(a => a.label)).toEqual(['a***r', '备用主号']);
    expect(result.accounts?.[1]?.active).toBe(true);
    expect(result.alternateSources).toEqual([{ kind: 'official', label: '查看官方直连额度' }]);

    // 安全红线：响应中绝不含真实邮箱与 Token
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('beta@example.com');
    expect(serialized).not.toContain('magpie-secret-token-xyz');
  });

  it('Codex 经由 Magpie 路由时优先使用 Magpie，支持显式切换 official 并提供切回 Magpie 入口', async () => {
    const home = await makeTempHome({
      '.codex/config.toml': [
        'model_provider = "magpie"',
        'model = "workbuddy/deepseek-v4.1-flash"',
        '[model_providers.magpie]',
        'name = "magpie"',
        `base_url = "${MAGPIE_ORIGIN}/v1"`,
        'wire_api = "responses"',
        'experimental_bearer_token = "codex-magpie-secret"',
        'http_headers = { "x-openai-actor-authorization" = "magpie" }'
      ].join('\n')
    });
    const { fetchImpl } = createMagpieMockFetch();
    const officialCodex = vi.fn(async () => sampleOfficial('Codex CLI', 44));

    const autoRes = await resolveAgentUsage({
      agentId: 'codex',
      home,
      env: {},
      fetchImpl,
      officialFetchers: { codex: officialCodex }
    });
    expect(autoRes.sourceMeta?.service).toBe('magpie');
    expect(autoRes.sourceMeta?.providerId).toBe('workbuddy');
    expect(officialCodex).not.toHaveBeenCalled();

    const officialRes = await resolveAgentUsage({
      agentId: 'codex',
      source: 'official',
      home,
      env: {},
      fetchImpl,
      officialFetchers: { codex: officialCodex }
    });
    expect(officialCodex).toHaveBeenCalledTimes(1);
    expect(officialRes.sourceMeta?.service).toBe('official');
    expect(officialRes.alternateSources).toEqual([{ kind: 'magpie', label: '切回 Magpie 供应商额度' }]);
  });

  it('零误判：本机运行着 Magpie（且含 agy-cli/cursor 插件）时，直连 Antigravity 与 Cursor 绝不误判为 Magpie', async () => {
    const home = await makeTempHome({
      '.config/magpie/gateway.json': JSON.stringify({ addr: '127.0.0.1:3425' }),
      '.gemini/antigravity-cli/settings.json': JSON.stringify({ model: 'Gemini 4 Hydrogen (Medium)' }),
      '.cursor/cli-config.json': JSON.stringify({ selectedModel: { modelId: 'default' } })
    });
    const { fetchImpl, calls } = createMagpieMockFetch();
    const officialAgy = vi.fn(async () => sampleOfficial('Antigravity CLI', 10));
    const officialCursor = vi.fn(async () => sampleOfficial('cursor.com', 20));

    const agyRes = await resolveAgentUsage({
      agentId: 'antigravity',
      model: 'gemini-4-neon',
      home,
      env: {},
      fetchImpl,
      officialFetchers: { antigravity: officialAgy }
    });
    const cursorRes = await resolveAgentUsage({
      agentId: 'cursor',
      home,
      env: {},
      fetchImpl,
      officialFetchers: { cursor: officialCursor }
    });

    expect(calls).toHaveLength(0);
    expect(agyRes.sourceMeta).toEqual({ service: 'official', providerName: 'Antigravity CLI', matchedBy: 'official_direct' });
    expect(agyRes.alternateSources).toBeUndefined();
    expect(cursorRes.sourceMeta).toEqual({ service: 'official', providerName: 'cursor.com', matchedBy: 'official_direct' });
    expect(cursorRes.alternateSources).toBeUndefined();
  });

  it('零误判：指向非 Magpie 的本地反代（如 127.0.0.1:8317）时，指纹探测拒绝并回落官方', async () => {
    const home = await makeTempHome({
      '.claude/settings.json': JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
          ANTHROPIC_AUTH_TOKEN: 'cpa-direct-secret'
        }
      })
    });
    const otherProxyFetch: FetchLike = async () => jsonResponse({ status: 'ok', service: 'cliproxyapi' });
    const officialClaude = vi.fn(async () => sampleOfficial('statusline', 35));

    const res = await resolveAgentUsage({
      agentId: 'claude',
      home,
      env: {},
      fetchImpl: otherProxyFetch,
      officialFetchers: { claude: officialClaude }
    });

    expect(officialClaude).toHaveBeenCalledTimes(1);
    expect(res.sourceMeta?.service).toBe('official');
    expect(res.source).toBe('statusline');
  });

  it('Class B（API Key 余额型）与 Class C（无上游额度如 CPA，附带今日网关统计且绝不错挂官方）', async () => {
    const home = await makeTempHome({
      '.claude/settings.json': JSON.stringify({
        env: { ANTHROPIC_BASE_URL: MAGPIE_ORIGIN, ANTHROPIC_AUTH_TOKEN: 'magpie' }
      })
    });
    const { fetchImpl } = createMagpieMockFetch();
    const officialClaude = vi.fn(async () => sampleOfficial('statusline', 50));

    // Class B: DeepSeek 余额
    const dsRes = await resolveAgentUsage({
      agentId: 'claude',
      model: 'deepseek/deepseek-flash',
      home,
      env: {},
      fetchImpl,
      officialFetchers: { claude: officialClaude }
    });
    expect(dsRes.status).toBe('available');
    expect(dsRes.source).toBe('Magpie · DeepSeek');
    expect(dsRes.balance).toEqual({ display: '¥256.16', currency: '¥', amount: 256.16 });
    expect(JSON.stringify(dsRes)).not.toContain('sk-live-secret');

    // Class C: CPA Singapore 无上游额度接口，附带今日网关统计
    const cpaRes = await resolveAgentUsage({
      agentId: 'claude',
      model: 'cpa/claude-opus-5-5[1m]',
      home,
      env: {},
      fetchImpl,
      officialFetchers: { claude: officialClaude }
    });
    expect(officialClaude).not.toHaveBeenCalled();
    expect(cpaRes.status).toBe('unavailable');
    expect(cpaRes.unavailableCode).toBe('provider_no_quota');
    expect(cpaRes.source).toBe('Magpie · CPA Singapore');
    expect(cpaRes.sourceMeta).toMatchObject({
      service: 'magpie',
      providerId: 'cpa',
      providerName: 'CPA Singapore',
      matchedBy: 'session_model',
      matchedModel: 'cpa/claude-opus-5-5'
    });
    expect(cpaRes.gatewayStats).toEqual({
      period: 'today',
      calls: 12,
      errors: 1,
      totalTokens: 119_500,
      costUsd: 0.482
    });
  });

  it('路由组 group/<id> 动态穿透 `/v1/magpie/route?session=<acpSessionId>` 并识别 429 重试提示', async () => {
    const cwd = await makeTempHome({
      '.agentdock/acpx/sessions/ses_group_1.json': JSON.stringify({
        acp_session_id: 'native-thread-999'
      })
    });
    const home = await makeTempHome({
      '.claude/settings.json': JSON.stringify({
        env: { ANTHROPIC_BASE_URL: MAGPIE_ORIGIN }
      })
    });

    expect(await resolveAcpSessionIdFromStore('ses_group_1', cwd, home)).toBe('native-thread-999');

    const { fetchImpl } = createMagpieMockFetch({
      routes: {
        'native-thread-999': {
          route: {
            asked: 'group/fast',
            model: 'workbuddy/deepseek-v4.1-flash',
            served: 'deepseek-v4.1-flash',
            status: 200,
            tries: [
              { model: 'trae-cn/deepseek-v4.1-flash-max', status: 429, ms: 320 },
              { model: 'workbuddy/deepseek-v4.1-flash', status: 200, ms: 1800 }
            ]
          },
          seq: 7,
          session: 'native-thread-999'
        }
      }
    });

    const res = await resolveAgentUsage({
      agentId: 'claude',
      model: 'group/fast',
      sessionId: 'ses_group_1',
      sessionCwd: cwd,
      home,
      env: {},
      fetchImpl
    });

    expect(res.status).toBe('available');
    expect(res.sourceMeta?.matchedBy).toBe('magpie_route');
    expect(res.sourceMeta?.providerId).toBe('workbuddy');
    expect(res.sourceMeta?.matchedModel).toBe('workbuddy/deepseek-v4.1-flash');
    expect(res.notices?.some(n => n.includes('429'))).toBe(true);
  });

  it('支持 OMP 与 OpenCode 配置自动识别', async () => {
    const home = await makeTempHome({
      '.config/magpie/gateway.json': JSON.stringify({ addr: '127.0.0.1:3425' }),
      '.omp/agent/config.yml': 'modelRoles:\n  default: magpie/workbuddy/deepseek-v4.1-flash\n',
      '.config/opencode/opencode.json': JSON.stringify({
        model: 'magpie/deepseek/deepseek-flash',
        provider: { magpie: { options: { baseURL: `${MAGPIE_ORIGIN}/v1` } } }
      })
    });
    const { fetchImpl } = createMagpieMockFetch();

    const ompRes = await resolveAgentUsage({ agentId: 'omp', home, env: {}, fetchImpl });
    expect(ompRes.status).toBe('available');
    expect(ompRes.sourceMeta?.providerId).toBe('workbuddy');

    const ocRes = await resolveAgentUsage({ agentId: 'opencode', home, env: {}, fetchImpl });
    expect(ocRes.status).toBe('available');
    expect(ocRes.sourceMeta?.providerId).toBe('deepseek');
    expect(ocRes.balance?.display).toBe('¥256.16');
  });

  it('401/403 自动在内存复用 Agent 网关 Token 重试，且鉴权失败时清晰降级并零泄露', async () => {
    const secretToken = 'mp_gateway_top_secret_987654321';
    const home = await makeTempHome({
      '.claude/settings.json': JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: MAGPIE_ORIGIN,
          ANTHROPIC_AUTH_TOKEN: secretToken,
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek/deepseek-flash'
        }
      })
    });

    const authed = createMagpieMockFetch({ requireAuthToken: secretToken });
    const okRes = await resolveAgentUsage({ agentId: 'claude', home, env: {}, fetchImpl: authed.fetchImpl });
    expect(okRes.status).toBe('available');
    expect(okRes.balance?.display).toBe('¥256.16');
    expect(authed.calls.some(c => c.url.endsWith('/v1/magpie/quotas') && c.auth === `Bearer ${secretToken}`)).toBe(true);
    expect(JSON.stringify(okRes)).not.toContain(secretToken);

    // 密钥被 Magpie 禁止读 quotas（403）
    resetMagpieUsageCacheForTests();
    const denied = createMagpieMockFetch({ requireAuthToken: secretToken, forbidQuotas: true });
    const deniedRes = await resolveAgentUsage({ agentId: 'claude', home, env: {}, fetchImpl: denied.fetchImpl });
    expect(deniedRes.status).toBe('unavailable');
    expect(deniedRes.unavailableCode).toBe('magpie_auth_required');
    expect(JSON.stringify(deniedRes)).not.toContain(secretToken);
  });

  it('显式指向 Magpie 但网关未启动时返回 magpie_unreachable 且不静默回退官方；30s 负缓存后可恢复', async () => {
    const home = await makeTempHome({
      '.codex/config.toml': [
        'model_provider = "magpie"',
        'model = "workbuddy/deepseek-v4.1-flash"',
        '[model_providers.magpie]',
        'name = "magpie"',
        `base_url = "${MAGPIE_ORIGIN}/v1"`
      ].join('\n')
    });
    let currentTime = 1_700_000_000_000;
    const now = () => currentTime;
    const failingFetch: FetchLike = async () => { throw new Error('ECONNREFUSED'); };
    const officialCodex = vi.fn(async () => sampleOfficial('Codex CLI', 10));

    const first = await resolveAgentUsage({
      agentId: 'codex',
      home,
      env: {},
      fetchImpl: failingFetch,
      now,
      officialFetchers: { codex: officialCodex }
    });
    expect(first.status).toBe('unavailable');
    expect(first.unavailableCode).toBe('magpie_unreachable');
    expect(officialCodex).not.toHaveBeenCalled();

    // 30s 负缓存期过后，Magpie 启动即恢复
    currentTime += MAGPIE_NEGATIVE_TTL_MS + 1_000;
    const recovered = createMagpieMockFetch();
    const second = await resolveAgentUsage({
      agentId: 'codex',
      home,
      env: {},
      fetchImpl: recovered.fetchImpl,
      now,
      officialFetchers: { codex: officialCodex }
    });
    expect(second.status).toBe('available');
    expect(second.sourceMeta?.providerId).toBe('workbuddy');
  });

  it('按 Magpie origin 共享 5 分钟快照缓存 + 并发去重 + 手动刷新 10 秒防抖冷却', async () => {
    const home = await makeTempHome({
      '.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_BASE_URL: MAGPIE_ORIGIN } }),
      '.codex/config.toml': `model_provider = "magpie"\nmodel = "deepseek/deepseek-flash"\n[model_providers.magpie]\nbase_url = "${MAGPIE_ORIGIN}/v1"\n`
    });
    let currentTime = 1_700_000_000_000;
    const now = () => currentTime;
    const { fetchImpl, calls } = createMagpieMockFetch();

    // Claude(workbuddy) 与 Codex(deepseek) 并发查同一 Magpie origin -> 共享同一次抓取
    const [r1, r2] = await Promise.all([
      resolveAgentUsage({ agentId: 'claude', model: 'workbuddy/deepseek-v4.1-flash', home, env: {}, fetchImpl, now }),
      resolveAgentUsage({ agentId: 'codex', model: 'deepseek/deepseek-flash', home, env: {}, fetchImpl, now })
    ]);
    expect(r1.sourceMeta?.providerId).toBe('workbuddy');
    expect(r2.sourceMeta?.providerId).toBe('deepseek');
    const quotasHits1 = calls.filter(c => c.url.endsWith('/v1/magpie/quotas')).length;
    expect(quotasHits1).toBe(1);

    // 4 分 59 秒内再查 cpa -> 命中 5 分钟缓存，不发新请求
    currentTime += MAGPIE_CACHE_TTL_MS - 1_000;
    const r3 = await resolveAgentUsage({ agentId: 'claude', model: 'cpa/claude-opus-5-5', home, env: {}, fetchImpl, now });
    expect(r3.sourceMeta?.providerId).toBe('cpa');
    expect(calls.filter(c => c.url.endsWith('/v1/magpie/quotas')).length).toBe(1);

    // 满 5 分钟后自动过期重拉
    currentTime = 1_700_000_000_000 + MAGPIE_CACHE_TTL_MS;
    await resolveAgentUsage({ agentId: 'claude', model: 'workbuddy/deepseek-v4.1-flash', home, env: {}, fetchImpl, now });
    expect(calls.filter(c => c.url.endsWith('/v1/magpie/quotas')).length).toBe(2);

    // 手动 refresh 在 10 秒冷却内被防抖合并
    currentTime += MAGPIE_REFRESH_COOLDOWN_MS - 1_000;
    await resolveAgentUsage({ agentId: 'claude', model: 'workbuddy/deepseek-v4.1-flash', refresh: true, home, env: {}, fetchImpl, now });
    expect(calls.filter(c => c.url.endsWith('/v1/magpie/quotas')).length).toBe(2);

    // 过 10 秒冷却后手动 refresh 立即穿透缓存
    currentTime += 2_000;
    await resolveAgentUsage({ agentId: 'claude', model: 'workbuddy/deepseek-v4.1-flash', refresh: true, home, env: {}, fetchImpl, now });
    expect(calls.filter(c => c.url.endsWith('/v1/magpie/quotas')).length).toBe(3);
  });
});
