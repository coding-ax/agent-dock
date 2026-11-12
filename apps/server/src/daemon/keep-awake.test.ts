import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { KeepAwakeService, keepAwakeConfigKey } from './keep-awake.js';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  constructor(private readonly spawnError?: Error) {
    super();
    queueMicrotask(() => this.spawnError ? this.emit('error', this.spawnError) : this.emit('spawn'));
  }
  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0, null);
    return true;
  }
}

function memoryConfig() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); })
  };
}

const service = (overrides: Partial<ConstructorParameters<typeof KeepAwakeService>[0]> = {}) => {
  const config = memoryConfig();
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  return {
    config,
    children,
    spawn,
    service: new KeepAwakeService({
      platform: 'darwin', config, spawn: spawn as unknown as typeof import('node:child_process').spawn,
      daemonPid: 4321, exists: () => true, ...overrides
    })
  };
};

describe('KeepAwakeService', () => {
  it('is unsupported off macOS and when caffeinate is missing, and never spawns there', async () => {
    const linux = service({ platform: 'linux' });
    expect(linux.service.status()).toMatchObject({ supported: false, enabled: false, reason: expect.stringContaining('macOS') });
    await expect(linux.service.set({ enabled: true })).rejects.toThrow(/macOS/);
    expect(linux.spawn).not.toHaveBeenCalled();

    const noBinary = service({ exists: () => false });
    expect(noBinary.service.status()).toMatchObject({ supported: false, reason: expect.stringContaining('caffeinate') });
    await expect(noBinary.service.set({ enabled: true })).rejects.toThrow(/caffeinate/);
    expect(noBinary.spawn).not.toHaveBeenCalled();
  });

  it('starts caffeinate bound to the daemon pid and persists the preference', async () => {
    const { service: keepAwake, spawn, config, children } = service();
    const status = await keepAwake.set({ enabled: true });
    expect(spawn).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-imsu', '-w', '4321'], { stdio: 'ignore' });
    expect(status).toMatchObject({ supported: true, enabled: true, keepDisplay: false });
    expect(children).toHaveLength(1);
    expect(JSON.parse(config.store.get(keepAwakeConfigKey)!)).toEqual({ enabled: true, keepDisplay: false });
  });

  it('restarts with -d for screen-on and kills the process on disable', async () => {
    const { service: keepAwake, spawn, config, children } = service();
    await keepAwake.set({ enabled: true });
    const first = children[0];

    const withDisplay = await keepAwake.set({ keepDisplay: true });
    expect(first?.killed).toBe(true);
    expect(spawn).toHaveBeenLastCalledWith('/usr/bin/caffeinate', ['-imsu', '-d', '-w', '4321'], { stdio: 'ignore' });
    expect(withDisplay).toMatchObject({ enabled: true, keepDisplay: true });
    expect(JSON.parse(config.store.get(keepAwakeConfigKey)!)).toEqual({ enabled: true, keepDisplay: true });

    const second = children[1];
    const off = await keepAwake.set({ enabled: false });
    expect(second?.killed).toBe(true);
    expect(off).toMatchObject({ supported: true, enabled: false, keepDisplay: true });
    expect(JSON.parse(config.store.get(keepAwakeConfigKey)!)).toEqual({ enabled: false, keepDisplay: true });
  });

  it('restores a persisted selection on daemon start', async () => {
    const { service: keepAwake, spawn, config } = service();
    config.store.set(keepAwakeConfigKey, JSON.stringify({ enabled: true, keepDisplay: true }));
    await keepAwake.restore();
    expect(spawn).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-imsu', '-d', '-w', '4321'], { stdio: 'ignore' });
    expect(keepAwake.status()).toMatchObject({ enabled: true, keepDisplay: true });
  });

  it('does not let a failed restore block startup or leave the preference on', async () => {
    const config = memoryConfig();
    const spawn = vi.fn(() => new FakeChild(new Error('spawn EACCES')));
    const keepAwake = new KeepAwakeService({
      platform: 'darwin', config, exists: () => true, daemonPid: 4321,
      spawn: spawn as unknown as typeof import('node:child_process').spawn
    });
    config.store.set(keepAwakeConfigKey, JSON.stringify({ enabled: true, keepDisplay: false }));
    await expect(keepAwake.restore()).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(keepAwake.status().enabled).toBe(false);
    expect(JSON.parse(config.store.get(keepAwakeConfigKey)!)).toEqual({ enabled: false, keepDisplay: false });
  });

  it('releases the assertion on close but keeps the preference for the next start', async () => {
    const { service: keepAwake, config, children } = service();
    await keepAwake.set({ enabled: true });
    keepAwake.close();
    expect(children[0]?.killed).toBe(true);
    expect(keepAwake.status().enabled).toBe(false);
    expect(JSON.parse(config.store.get(keepAwakeConfigKey)!)).toEqual({ enabled: true, keepDisplay: false });
  });

  it('flips off if caffeinate exits unexpectedly', async () => {
    const { service: keepAwake, config, children } = service();
    await keepAwake.set({ enabled: true });
    children[0]!.exitCode = 1;
    children[0]!.emit('exit', 1, null);
    expect(keepAwake.status().enabled).toBe(false);
    await Promise.resolve();
    expect(JSON.parse(config.store.get(keepAwakeConfigKey)!)).toEqual({ enabled: false, keepDisplay: false });
  });

  it('serializes rapid toggles so only one caffeinate survives', async () => {
    const { service: keepAwake, children } = service();
    await Promise.all([keepAwake.set({ enabled: true }), keepAwake.set({ keepDisplay: true })]);
    expect(keepAwake.status()).toMatchObject({ enabled: true, keepDisplay: true });
    expect(children.filter(child => !child.killed)).toHaveLength(1);
  });
});
