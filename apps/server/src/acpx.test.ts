import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { acpxPassThroughArgs, resolveAcpxLauncher, runAcpx } from './acpx.js';

describe('acpx pass-through', () => {
  it('preserves every argument after agent-dock acpx', () => {
    expect(acpxPassThroughArgs(['node', 'agent-dock', 'acpx', 'agents', 'list', '--json', '--scope=x'])).toEqual(['agents', 'list', '--json', '--scope=x']);
    expect(acpxPassThroughArgs(['node', 'agent-dock', '--help'])).toBeUndefined();
  });

  it('spawns acpx without a shell and returns its exit code', async () => {
    const launcher = { command: process.execPath, args: ['/vendor/acpx/dist/cli.js'] };
    const child = new EventEmitter() as any;
    const spawnProcess = vi.fn(() => child);
    const result = runAcpx(['run', '--raw', 'a b'], spawnProcess as any, launcher);
    child.emit('exit', 7, null);
    await expect(result).resolves.toBe(7);
    expect(spawnProcess).toHaveBeenCalledWith(process.execPath, ['/vendor/acpx/dist/cli.js', 'run', '--raw', 'a b'], expect.objectContaining({ stdio: 'inherit' }));
  });

  it('spawns the declared acpx dependency through Node instead of relying on PATH', async () => {
    const { dependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    const launcher = resolveAcpxLauncher();
    expect(dependencies).toHaveProperty('acpx');
    expect(launcher.command).toBe(process.execPath);
    expect(launcher.args).toHaveLength(1);
    expect(launcher.args[0]).toMatch(/[/\\]acpx[/\\]dist[/\\]cli\.js$/);
    expect(existsSync(launcher.args[0]!)).toBe(true);
    const child = new EventEmitter() as any;
    const spawnProcess = vi.fn(() => child);
    const result = runAcpx(['--version'], spawnProcess as any);
    child.emit('exit', 0, null);
    await expect(result).resolves.toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith(process.execPath, [launcher.args[0], '--version'], expect.objectContaining({ stdio: 'inherit' }));
  });
});
