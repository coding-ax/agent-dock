import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { listAcpxBuiltinAgents } from './index.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe('Claude ACP launcher', () => {
  it('routes the built-in Claude agent through the AgentDock launcher', () => {
    const claude = listAcpxBuiltinAgents().find(agent => agent.id === 'claude');
    expect(claude?.argv[0]).toBe(process.execPath);
    expect(claude?.argv[1]).toMatch(/claude-acp\.mjs$/);
  });

  it('ships the exact Claude ACP adapter as a vendor artifact with a source fallback', async () => {
    const packageJson = JSON.parse(await readFile(resolve(process.cwd(), 'packages/acp-client/package.json'), 'utf8'));
    const standalonePackageJson = JSON.parse(await readFile(resolve(process.cwd(), 'apps/server/package.json'), 'utf8'));
    const launcher = await readFile(resolve(process.cwd(), 'packages/acp-client/agents/claude-acp.mjs'), 'utf8');
    expect(packageJson.dependencies['@agentclientprotocol/claude-agent-acp']).toBe('0.106.0');
    expect(standalonePackageJson.devDependencies['@agentclientprotocol/claude-agent-acp']).toBe('0.106.0');
    expect(standalonePackageJson.dependencies['@agentclientprotocol/claude-agent-acp']).toBeUndefined();
    expect(launcher).toContain("'../vendor/claude-agent-acp.mjs'");
    expect(launcher).toContain("import.meta.resolve('@agentclientprotocol/claude-agent-acp/package.json')");
    expect(launcher).toContain("bin?.['claude-agent-acp']");
    expect(launcher).not.toMatch(/\bnpx\b/);
  });

  it('loads the adjacent vendored adapter before falling back to node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-claude-vendor-')); dirs.push(root);
    const agents = join(root, 'dist', 'agents'); const vendor = join(root, 'dist', 'vendor');
    await mkdir(agents, { recursive: true }); await mkdir(vendor, { recursive: true });
    await copyFile(resolve(process.cwd(), 'packages/acp-client/agents/claude-acp.mjs'), join(agents, 'claude-acp.mjs'));
    await writeFile(join(vendor, 'claude-agent-acp.mjs'), 'console.log(JSON.stringify({ vendor: true, executable: process.env.CLAUDE_CODE_EXECUTABLE }))\n');
    const claude = join(root, 'claude'); await writeFile(claude, '', { mode: 0o755 });
    const result = spawnSync(process.execPath, [join(agents, 'claude-acp.mjs')], {
      cwd: root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_EXECUTABLE: claude },
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ vendor: true, executable: claude });
  });

  it('falls back to the installed adapter bin when no vendor artifact exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-claude-fallback-')); dirs.push(root);
    const agents = join(root, 'agents'); await mkdir(agents);
    await copyFile(resolve(process.cwd(), 'packages/acp-client/agents/claude-acp.mjs'), join(agents, 'claude-acp.mjs'));
    const installed = join(root, 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
    await mkdir(join(installed, 'dist'), { recursive: true });
    await writeFile(join(installed, 'package.json'), JSON.stringify({
      name: '@agentclientprotocol/claude-agent-acp',
      type: 'module',
      exports: { './package.json': './package.json' },
      bin: { 'claude-agent-acp': 'dist/index.js' }
    }));
    await writeFile(join(installed, 'dist', 'index.js'), 'console.log(JSON.stringify({ fallback: true }))\n');
    const claude = join(root, 'claude'); await writeFile(claude, '', { mode: 0o755 });
    const result = spawnSync(process.execPath, [join(agents, 'claude-acp.mjs')], {
      cwd: root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_EXECUTABLE: claude },
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ fallback: true });
  });

  it('reports missing local Claude Code instead of relying on a removed bundled binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-claude-missing-')); dirs.push(root);
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE_|AGENTDOCK_CLAUDE_ACP_)/.test(key)));
    const result = spawnSync(process.execPath, [resolve(process.cwd(), 'packages/acp-client/agents/claude-acp.mjs')], {
      cwd: root,
      env: { ...inherited, PATH: '', CLAUDE_CONFIG_DIR: join(root, 'config') },
      encoding: 'utf8'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('未找到本机 Claude Code');
  });

  it('loads Claude settings env without overriding explicit process variables and reuses the installed CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-claude-launcher-')); dirs.push(root);
    const configDir = join(root, 'config'); const project = join(root, 'project');
    await mkdir(configDir, { recursive: true }); await mkdir(join(project, '.claude'), { recursive: true });
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'settings-token', ANTHROPIC_BASE_URL: 'https://user.example' } }));
    await writeFile(join(project, '.env'), 'ANTHROPIC_BASE_URL=https://dotenv.example\nCLAUDE_CODE_USE_BEDROCK=1\n');
    await writeFile(join(project, '.env.local'), 'ANTHROPIC_BASE_URL=https://dotenv-local.example\nAWS_PROFILE=agentdock-test\n');
    await writeFile(join(project, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://project.example' } }));
    await writeFile(join(project, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'local-model' } }));
    const bin = join(root, 'bin'); await mkdir(bin); const claude = join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    await writeFile(claude, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n'); await chmod(claude, 0o755);
    const inspect = `process.stdout.write(JSON.stringify({ token: process.env.ANTHROPIC_AUTH_TOKEN, base: process.env.ANTHROPIC_BASE_URL, model: process.env.ANTHROPIC_MODEL, bedrock: process.env.CLAUDE_CODE_USE_BEDROCK, awsProfile: process.env.AWS_PROFILE, executable: process.env.CLAUDE_CODE_EXECUTABLE }))`;
    // 启动器会做 { ...settingsEnv, ...process.env }：真实环境里的 ANTHROPIC_* / CLAUDE_* / AWS_*
    // 会盖掉本用例的 fixture，让断言读到开发机的真实配置而非被测的层级合并结果。
    // 因此这里剥掉这些前缀，只保留用例显式提供的变量——否则本地能过、装了这些变量的机器上必红。
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC_|CLAUDE_|AWS_)/.test(key)));
    const result = spawnSync(process.execPath, [resolve(process.cwd(), 'packages/acp-client/agents/claude-acp.mjs')], {
      cwd: project,
      env: { ...inherited, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_AUTH_TOKEN: 'explicit-token', AGENTDOCK_CLAUDE_ACP_COMMAND: process.execPath, AGENTDOCK_CLAUDE_ACP_ARGS_JSON: JSON.stringify(['-e', inspect]) },
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ token: 'explicit-token', base: 'https://project.example', model: 'local-model', bedrock: '1', awsProfile: 'agentdock-test', executable: claude });
  });
});
