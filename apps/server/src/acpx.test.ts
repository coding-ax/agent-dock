import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { acpxPassThroughArgs, runAcpx } from './acpx.js';

describe('acpx pass-through', () => {
  it('preserves every argument after agent-dock acpx', () => {
    expect(acpxPassThroughArgs(['node', 'agent-dock', 'acpx', 'agents', 'list', '--json', '--scope=x'])).toEqual(['agents', 'list', '--json', '--scope=x']);
    expect(acpxPassThroughArgs(['node', 'agent-dock', '--help'])).toBeUndefined();
  });

  it('spawns acpx without a shell and returns its exit code', async () => {
    const child = new EventEmitter() as any;
    const spawnProcess = vi.fn(() => child);
    const result = runAcpx(['run', '--raw', 'a b'], spawnProcess as any);
    child.emit('exit', 7, null);
    await expect(result).resolves.toBe(7);
    expect(spawnProcess).toHaveBeenCalledWith('acpx', ['run', '--raw', 'a b'], expect.objectContaining({ stdio: 'inherit' }));
  });

  // 这个用例存在的理由：原实现 spawn 的是 'acpk' —— 一个 npm 上不存在、PATH 里也没有的名字，
  // 而旧测试用 mock spawn 断言同一个 'acpk' 字面量，于是「测试全绿 + 命令必然 ENOENT」并存了一个多月。
  // 把二进制名钉在 package.json 声明的依赖上，下次再写错名字就会立刻失败，
  // 且不依赖运行测试的机器是否装了 acpx（CI 里不一定装）。
  it('spawns the binary provided by the declared acpx dependency', async () => {
    const { dependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    const child = new EventEmitter() as any;
    const spawnProcess = vi.fn(() => child);
    const result = runAcpx(['--version'], spawnProcess as any);
    child.emit('exit', 0, null);
    await expect(result).resolves.toBe(0);
    const [binary] = spawnProcess.mock.calls[0]!;
    expect(dependencies).toHaveProperty(binary as string);
  });
});
