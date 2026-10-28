import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAcpRuntime, createAgentRegistry, createRuntimeStore, type AcpRuntime } from 'acpx/runtime';
import { agentModelsCacheKey, agentModelProbeWarning, AgentModelProbeTimeoutError, discoverAgentModels, modelsFromAcpStatus, probeModelsThroughAcpRuntime } from './agent-models.js';

const probeInput = { sessionKey: 'probe', agent: 'codex', mode: 'oneshot' as const };
const handle = { sessionKey: 'probe', backend: 'acpx', runtimeSessionName: 'probe', acpxRecordId: 'probe-record' };

function runtime(overrides: Partial<AcpRuntime>): AcpRuntime {
  return {
    ensureSession: vi.fn(async () => handle),
    startTurn: vi.fn(),
    runTurn: vi.fn(),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides
  } as AcpRuntime;
}

describe('ACP-first Agent model discovery', () => {
  it('uses Agent-advertised model identifiers and display names', () => {
    expect(modelsFromAcpStatus({
      models: { currentModelId: 'model-a', availableModelIds: ['model-a', 'model-b'] },
      details: { configOptions: [
        { id: 'model', category: 'model', options: [{ value: 'model-a', name: 'Model A' }, { value: 'model-b', name: 'Model B' }] },
        { id: 'effort', category: 'thought_level', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }] }
      ] }
    })).toEqual({ models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }], defaultModel: 'model-a', reasoningEfforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }], defaultReasoningEffort: 'medium', source: 'acp' });
  });

  it('deduplicates aliased model ids and keeps the first advertised name', () => {
    // Agent 可能为同一个 model id 上报多个别名（如 "…o50[1M]" 与 "…o48"，value 均为 …o50）。
    // 重复 id 会让下拉出现同值多行：React key 冲突，且回填标签解析成第一条，
    // 表现为「选了 A 显示成 B」。这里在数据边界收敛。
    expect(modelsFromAcpStatus({
      models: { currentModelId: 'hub/o50', availableModelIds: ['hub/o50', 'hub/o50', 'hub/other'] },
      details: { configOptions: [
        { id: 'model', category: 'model', options: [
          { value: 'hub/o50', name: 'hub/o50[1M]' },
          { value: 'hub/o50', name: 'hub/o48' },
          { value: 'hub/other', name: 'Other' }
        ] }
      ] }
    })).toEqual({
      models: [{ id: 'hub/o50', name: 'hub/o50[1M]' }, { id: 'hub/other', name: 'Other' }],
      defaultModel: 'hub/o50', reasoningEfforts: [], source: 'acp'
    });
  });

  it('bounds a stalled ensureSession instead of leaving the HTTP request pending', async () => {
    const close = vi.fn(async () => undefined);
    const target = runtime({ ensureSession: vi.fn(() => new Promise(() => undefined)), close });
    await expect(probeModelsThroughAcpRuntime(target, probeInput, 10)).rejects.toEqual(expect.objectContaining<Partial<AgentModelProbeTimeoutError>>({ name: 'AgentModelProbeTimeoutError', phase: 'ensureSession' }));
    expect(close).not.toHaveBeenCalled();
  });

  it('closes the probe child when getStatus stalls', async () => {
    const close = vi.fn(async () => undefined);
    const target = runtime({ getStatus: vi.fn(() => new Promise(() => undefined)), close });
    await expect(probeModelsThroughAcpRuntime(target, probeInput, 10)).rejects.toEqual(expect.objectContaining<Partial<AgentModelProbeTimeoutError>>({ phase: 'getStatus' }));
    expect(close).toHaveBeenCalledWith({ handle, reason: 'AgentDock model discovery', discardPersistentState: true });
  });

  it('bounds close cleanup and still returns the model fallback', async () => {
    const target = runtime({
      getStatus: vi.fn(async () => ({ models: { currentModelId: 'codex', availableModelIds: ['codex'] } })),
      close: vi.fn(() => new Promise(() => undefined))
    });
    await expect(probeModelsThroughAcpRuntime(target, probeInput, 10)).resolves.toMatchObject({ defaultModel: 'codex', source: 'acp' });
  });

  it('keeps the local acpx patch limited to the hunks upstream has not absorbed yet', () => {
    const patch = readFileSync(new URL('../../../patches/acpx@0.20.0.patch', import.meta.url), 'utf8');
    const buildScript = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
    // Codex 的 app-server 释放 session writer 需要时间，stdin 关闭后的宽限期必须放宽到 4s。
    expect(patch).toContain('basenameToken(arg) === "codex-acp.mjs"');
    // ACP agent 恢复历史后不一定会恢复内存里的 mode，加载出来的 session 也要重放选中的 mode。
    expect(patch).toContain('desiredModeId: params.desiredModeId,');
    // 上游 0.17.1 起给 client.start() 加了超时，但紧随其后的 session/new、session/load 仍然裸奔：
    // agent 初始化完再卡住时 ensureSession 会永远挂着，所以这一段还得自己补。
    expect(patch).toContain('withTimeout(createOrLoadRuntimeSession(client, input.resumeSessionId, cwd), this.options.timeoutMs)');
    expect(buildScript).toContain("fileURLToPath(import.meta.resolve('acpx/runtime'))");
  });

  it('relies on upstream acpx to bound client.start(), so no patch is needed for it', () => {
    const acpxRuntime = readFileSync(join(dirname(createRequire(import.meta.url).resolve('acpx/package.json')), 'dist/runtime.js'), 'utf8');
    // 上游一旦回退，我们要立刻发现，否则 agent 完全起不来时又会挂到 agent.timeout 才失败。
    expect(acpxRuntime).toMatch(/await withTimeout\(\s*[\w.]*client\.start\(\), this\.options\.timeoutMs\s*\)/);
  });
});

it('explains incompatible configuration without exposing raw configuration values', () => {
  expect(agentModelProbeWarning({ data: 'failed to load configuration: secret/value invalid type' })).toBe('Agent 配置加载失败，请检查配置格式与 CLI 版本是否兼容后重新读取。');
});

it('closes a late session after the outer probe deadline', async () => {
  let resolve!: (value: typeof handle) => void;
  const target = runtime({ ensureSession: vi.fn(() => new Promise(done => { resolve = done; })) });
  await expect(probeModelsThroughAcpRuntime(target, probeInput, 10)).rejects.toBeInstanceOf(AgentModelProbeTimeoutError);
  resolve(handle);
  await vi.waitFor(() => expect(target.close).toHaveBeenCalledWith({ handle, reason: 'AgentDock model discovery', discardPersistentState: true }));
});

it('isolates model caches by environment, working directory and configured default', () => {
  const agent = { id: 'codex', command: 'node', args: ['adapter'], env: { token: 'secret', profile: 'a' }, cwd: '/a', timeout: 30, permissionMode: 'ask' } as any;
  const key = agentModelsCacheKey(agent);
  expect(key).not.toContain('secret');
  expect(agentModelsCacheKey({ ...agent, env: { profile: 'a', token: 'secret' } })).toBe(key);
  expect(agentModelsCacheKey({ ...agent, env: { token: 'different' } })).not.toBe(key);
  expect(agentModelsCacheKey({ ...agent, cwd: '/b' })).not.toBe(key);
  expect(agentModelsCacheKey({ ...agent, model: 'other' })).not.toBe(key);
});

it('terminates a real ACP child that stalls after initialization in session/new', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentdock-stalled-probe-'));
  const fixture = join(cwd, 'stall.mjs'); const pidFile = join(cwd, 'pid');
  await writeFile(fixture, `import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => { const m=JSON.parse(line);
if(m.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,agentCapabilities:{},authMethods:[]}})+'\\n');
if(m.method === 'session/new') writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
});`);
  const target = createAcpRuntime({ cwd, timeoutMs: 1000, sessionStore: createRuntimeStore({ stateDir: join(cwd, 'state') }), agentRegistry: createAgentRegistry({ overrides: { mock: [process.execPath, fixture] } }) });
  let pid: number | undefined;
  try {
    await expect(target.ensureSession({ sessionKey: 'stall', agent: 'mock', cwd, mode: 'oneshot' })).rejects.toThrow();
    pid = Number(await readFile(pidFile, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 3000 });
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(cwd, { recursive: true, force: true });
  }
}, 10000);

it('allows the Codex launcher to finish delayed stdin cleanup before killing it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentdock-codex-close-'));
  const fixture = join(cwd, 'codex-acp.mjs'); const marker = join(cwd, 'released');
  await writeFile(fixture, `import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => { const m=JSON.parse(line); let result;
if(m.method === 'initialize') result={protocolVersion:m.params.protocolVersion,agentCapabilities:{},authMethods:[]};
if(m.method === 'session/new') result={sessionId:'graceful'};
if(result) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
process.stdin.on('end', () => setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, 'released'); process.exit(0); }, 300));`);
  const target = createAcpRuntime({ cwd, timeoutMs: 1000, sessionStore: createRuntimeStore({ stateDir: join(cwd, 'state') }), agentRegistry: createAgentRegistry({ overrides: { codex: [process.execPath, fixture] } }) });
  try {
    const session = await target.ensureSession({ sessionKey: 'close-test', agent: 'codex', cwd, mode: 'persistent' });
    await target.close({ handle: session });
    expect(await readFile(marker, 'utf8')).toBe('released');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it('probes the configured Codex gateway model and an explicit override using the session startup selection', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-model-discovery-'));
  const fixture = join(cwd, 'agent.mjs');
  await writeFile(fixture, `import readline from 'node:readline';
const model = process.env.agentdock_codex_model || 'wrong-default';
const configOptions = [{ id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: model, options: [{ name: model, value: model }] }];
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [] } });
  if (method === 'session/new') return send({ jsonrpc: '2.0', id, result: { sessionId: 'probe', configOptions } });
  if (method === 'session/set_config_option') return send({ jsonrpc: '2.0', id, result: { configOptions } });
});`);
  const agent = { id: 'codex', name: 'Codex', command: process.execPath, args: [fixture], protocol: 'acp' as const, cwd, model: 'gateway-default', env: {}, permissionMode: 'deny-all' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  try {
    expect(await discoverAgentModels(agent)).toMatchObject({ defaultModel: 'gateway-default', models: [{ id: 'gateway-default' }], source: 'acp' });
    expect(await discoverAgentModels(agent, 'gateway-selected')).toMatchObject({ defaultModel: 'gateway-selected', models: [{ id: 'gateway-selected' }], source: 'acp' });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it('merges user-supplied extra models with ACP-discovered models, keeping existing display names', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-extra-models-'));
  const fixture = join(cwd, 'agent.mjs');
  await writeFile(fixture, `import readline from 'node:readline';
const model = process.env.agentdock_codex_model || 'gateway-default';
const configOptions = [{ id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: model, options: [{ name: 'Gateway Default', value: 'gateway-default' }] }];
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [] } });
  if (method === 'session/new') return send({ jsonrpc: '2.0', id, result: { sessionId: 'probe', configOptions } });
  if (method === 'session/set_config_option') return send({ jsonrpc: '2.0', id, result: { configOptions } });
});`);
  const agent = { id: 'codex', name: 'Codex', command: process.execPath, args: [fixture], protocol: 'acp' as const, cwd, model: 'gateway-default', extraModels: ['gateway-default', 'proxy-model-1', 'proxy-model-2'], env: {}, permissionMode: 'deny-all' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  try {
    const result = await discoverAgentModels(agent);
    // gateway-default 已由 ACP 上报，保留其显示名 "Gateway Default"，不被 extraModels 覆盖
    expect(result.models).toContainEqual({ id: 'gateway-default', name: 'Gateway Default' });
    // 反向代理模型不在 ACP 列表中，以 id 作为名称追加
    expect(result.models).toContainEqual({ id: 'proxy-model-1', name: 'proxy-model-1' });
    expect(result.models).toContainEqual({ id: 'proxy-model-2', name: 'proxy-model-2' });
    expect(result.models.length).toBe(3);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
