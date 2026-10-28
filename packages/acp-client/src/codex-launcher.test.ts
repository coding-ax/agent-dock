import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { AcpxAdapter, listAcpxBuiltinAgents } from './index.js';

const run = promisify(execFile);
const dirs: string[] = [];
const launcher = resolve('packages/acp-client/agents/codex-acp.mjs');
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(adapterCode: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-launcher-')); dirs.push(cwd);
  const adapterDir = join(cwd, 'node_modules/@agentclientprotocol/codex-acp');
  await mkdir(adapterDir, { recursive: true });
  await writeFile(join(adapterDir, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/codex-acp', type: 'module', main: 'index.js' }));
  await writeFile(join(adapterDir, 'index.js'), adapterCode);
  const file = join(cwd, 'launcher.mjs'); await copyFile(launcher, file);
  return { cwd, file };
}

it('uses local PATH Codex by default, without a bundled Codex dependency', async () => {
  const { cwd, file } = await fixture('console.log(JSON.stringify({ codexPath: process.env.CODEX_PATH }))');
  const bin = join(cwd, 'bin'); await mkdir(bin);
  const local = join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await writeFile(local, '', { mode: 0o755 });
  const env = { ...process.env, PATH: bin, CODEX_PATH: '' };
  expect(JSON.parse((await run(process.execPath, [file], { env })).stdout)).toEqual({ codexPath: local });
  expect(JSON.parse((await run(process.execPath, [file], { env: { ...env, CODEX_PATH: process.execPath } })).stdout)).toEqual({ codexPath: process.execPath });
  expect((await run(process.execPath, [file, '--version'], { env: { ...env, CODEX_PATH: process.execPath } })).stdout.trim()).toBe(process.version);
  expect(listAcpxBuiltinAgents().find(agent => agent.id === 'codex')?.argv).toEqual([process.execPath, launcher]);
});

it('reports missing local Codex rather than falling back to a bundled copy', async () => {
  const { cwd, file } = await fixture('console.log("must not start")');
  // An executable directory named codex is not a CLI binary.
  await mkdir(join(cwd, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  await expect(run(process.execPath, [file], { env: { ...process.env, PATH: cwd, CODEX_PATH: '' } })).rejects.toMatchObject({ stderr: expect.stringContaining('未找到本机 Codex') });
});

it('keeps explicit environment overrides out of persisted ACPX session options', async () => {
  const mock = pathToFileURL(resolve('tests/fixtures/mock-acp-agent.mjs')).href;
  const { cwd, file } = await fixture(`await import(${JSON.stringify(mock)})`);
  vi.stubEnv('CODEX_PATH', '/explicit/codex');
  const events: any[] = [];
  const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [file], protocol: 'acp', cwd, env: {}, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { sessionKey: `codex-launcher-${crypto.randomUUID()}`, onEvent: event => events.push(event) });
  try { await adapter.start(); await adapter.send('hello'); expect(events.some(event => event.type === 'text' && event.data.text.includes('Mock reply'))).toBe(true); }
  finally { await adapter.stop(); }
});

it('seeds the selected model while preserving inherited provider configuration', async () => {
  const { file } = await fixture('console.log(process.env.CODEX_CONFIG)');
  const config = { model: 'gateway-default', model_provider: 'gateway', model_providers: { gateway: { base_url: 'http://127.0.0.1/v1', env_key: 'CODEX_API_KEY', env_http_headers: { 'x-source': 'LLMGW_SOURCE' } } } };
  const env = { ...process.env, CODEX_PATH: process.execPath, CODEX_CONFIG: JSON.stringify(config), agentdock_codex_model: 'gateway-selected' };
  expect(JSON.parse((await run(process.execPath, [file], { env })).stdout)).toEqual({ ...config, model: 'gateway-selected' });
  expect(JSON.parse((await run(process.execPath, [file], { env: { ...env, agentdock_codex_model: '' } })).stdout)).toEqual(config);
  await expect(run(process.execPath, [file], { env: { ...env, CODEX_CONFIG: 'sensitive-invalid-value' } })).rejects.toMatchObject({ stderr: expect.stringContaining('CODEX_CONFIG 必须是有效的 JSON 对象') });
});

it('persists and restores independent Codex model selections without changing shared configuration', async () => {
  const { cwd, file } = await fixture(`
    import readline from 'node:readline';
    const config = JSON.parse(process.env.CODEX_CONFIG || '{}');
    const model = config.model || 'gateway-default';
    const configOptions = [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: model, options: [{ value: model, name: model }] }];
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const { id, method, params = {} } = JSON.parse(line);
      if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [] } });
      if (method === 'session/new' || method === 'session/load') return send({ jsonrpc: '2.0', id, result: { sessionId: params.sessionId || 'session-' + process.pid, configOptions, modes: { currentModeId: 'agent', availableModes: ['agent', 'read-only', 'agent-full-access'].map(id => ({ id, name: id })) } } });
      if (method === 'session/set_config_option') return send({ jsonrpc: '2.0', id, result: { configOptions } });
      if (method === 'session/prompt') {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ model, provider: config.model_provider, source: process.env.LLMGW_SOURCE }) } } } });
        return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      }
      if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
    });
  `);
  const config = JSON.stringify({ model: 'gateway-default', model_provider: 'gateway' });
  const sharedConfig = join(cwd, 'config.toml');
  await writeFile(sharedConfig, 'model = "gateway-default"\n');
  const make = (model: string) => {
    const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'codex', name: 'Codex', command: process.execPath, args: [file], protocol: 'acp', cwd, env: { CODEX_PATH: process.execPath, CODEX_CONFIG: config, LLMGW_SOURCE: 'gateway-test' }, model, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { sessionKey: `codex-gateway-${crypto.randomUUID()}`, onEvent: event => events.push(event) });
    return { adapter, events, model };
  };
  const sessions = [make('gateway-a'), make('gateway-b')];
  try {
    await Promise.all(sessions.map(async ({ adapter }) => { await adapter.start(); await adapter.send('hello'); }));
    for (const { adapter, events, model } of sessions) {
      expect(events.filter(event => event.type === 'text').map(event => JSON.parse(event.data.text))).toContainEqual({ model, provider: 'gateway', source: 'gateway-test' });
      expect(events.some(event => event.data?.state === 'model_fallback')).toBe(false);
      await adapter.stop(); await adapter.resume(); events.length = 0; await adapter.send('resumed');
      expect(events.filter(event => event.type === 'text').map(event => JSON.parse(event.data.text))).toContainEqual({ model, provider: 'gateway', source: 'gateway-test' });
    }
    expect(await readFile(sharedConfig, 'utf8')).toBe('model = "gateway-default"\n');
  } finally { await Promise.all(sessions.map(({ adapter }) => adapter.stop({ discardSession: true }))); }
});
