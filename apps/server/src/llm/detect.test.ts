import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectLlmEndpoints, publicDetectedLlmEndpoint } from './detect.js';

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function homeWith(files: Record<string, string>) {
  const home = await mkdtemp(join(tmpdir(), 'agentdock-llm-detect-'));
  homes.push(home);
  for (const [path, content] of Object.entries(files)) {
    const target = join(home, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return home;
}

const CLAUDE_TOKEN = 'magpie-secret';
const ENV_KEY = 'sk-ant-secret';
const claudeSettings = {
  model: 'workbuddy/fallback',
  env: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425',
    ANTHROPIC_AUTH_TOKEN: CLAUDE_TOKEN,
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'workbuddy/deepseek-v4.1-flash[1m]'
  }
};

describe('detectLlmEndpoints', () => {
  it('reads Claude Code settings/env and marks AUTH_TOKEN as Bearer', async () => {
    const home = await homeWith({ '.claude/settings.json': JSON.stringify(claudeSettings) });
    const found = await detectLlmEndpoints({ home, env: {} });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: 'claude-code:settings',
      source: 'claude-code',
      format: 'anthropic-messages',
      baseUrl: 'http://127.0.0.1:3425',
      model: 'workbuddy/deepseek-v4.1-flash[1m]',
      auth: 'bearer'
    });
    expect(found[0]!.apiKey).toBe(CLAUDE_TOKEN);
  });

  it('falls back to process env and never puts the key in the public projection', async () => {
    const home = await homeWith({});
    const found = await detectLlmEndpoints({
      home,
      env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com/', ANTHROPIC_API_KEY: ENV_KEY, ANTHROPIC_MODEL: 'claude-sonnet-5-5' }
    });
    expect(found[0]).toMatchObject({ id: 'claude-code:env', baseUrl: 'https://proxy.example.com' });
    const publicCandidate = publicDetectedLlmEndpoint(found[0]!);
    expect(publicCandidate).toMatchObject({ keySet: true, model: 'claude-sonnet-5-5' });
    expect(JSON.stringify(publicCandidate)).not.toContain(ENV_KEY);
  });

  it('parses a Codex provider bearer token and responses wire format', async () => {
    const home = await homeWith({
      '.codex/config.toml': [
        'model_provider = "magpie"',
        'model = "workbuddy/hy4free"',
        '[model_providers.magpie]',
        'name = "magpie"',
        'base_url = "http://127.0.0.1:3425/v1"',
        'wire_api = "responses"',
        'experimental_bearer_token = "codex-secret"'
      ].join('\n')
    });
    const found = await detectLlmEndpoints({ home, env: {} });
    expect(found[0]).toMatchObject({
      id: 'codex:config',
      source: 'codex',
      format: 'openai-responses',
      baseUrl: 'http://127.0.0.1:3425/v1',
      model: 'workbuddy/hy4free'
    });
    expect(found[0]!.apiKey).toBe('codex-secret');
  });

  it('dedupes the same endpoint from settings and env, keeping the more specific source', async () => {
    const home = await homeWith({ '.claude/settings.json': JSON.stringify(claudeSettings) });
    const found = await detectLlmEndpoints({
      home,
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425',
        ANTHROPIC_AUTH_TOKEN: CLAUDE_TOKEN,
        ANTHROPIC_MODEL: 'workbuddy/deepseek-v4.1-flash[1m]'
      }
    });
    expect(found.map(item => item.id)).toEqual(['claude-code:settings']);
  });

  it('returns nothing when there is no usable local config', async () => {
    const home = await homeWith({});
    await expect(detectLlmEndpoints({ home, env: {} })).resolves.toEqual([]);
  });
});
