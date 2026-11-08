import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const requireCjs = createRequire(import.meta.url);
const { createUpdaterController } = requireCjs('./updater.cjs') as {
  createUpdaterController: (options: any) => {
    snapshot(): any;
    check(): Promise<any>;
    download(): Promise<any>;
    install(): Promise<any>;
    start(): void;
    stop(): void;
  };
};

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkForUpdates = vi.fn(async () => {
    this.emit('update-available', { version: '0.2.0', releaseNotes: 'release notes' });
    return { updateInfo: { version: '0.2.0' } };
  });
  downloadUpdate = vi.fn(async () => {
    this.emit('download-progress', { percent: 42, transferred: 4_200_000, total: 10_000_000, bytesPerSecond: 1_500_000 });
    this.emit('update-downloaded', { version: '0.2.0' });
    return [];
  });
  quitAndInstall = vi.fn();
}

const app = { getVersion: () => '0.1.3' };

describe('desktop updater controller', () => {
  it('walks check → available → downloading → downloaded → install', async () => {
    const updater = new FakeUpdater();
    const beforeInstall = vi.fn(async () => {});
    const controller = createUpdaterController({ app, updater, beforeInstall });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);

    const checked = await controller.check();
    expect(checked).toMatchObject({ phase: 'available', latestVersion: '0.2.0', currentVersion: '0.1.3', releaseNotes: 'release notes' });

    const downloaded = await controller.download();
    expect(downloaded.phase).toBe('downloaded');
    expect(downloaded.percent).toBe(100);

    const installed = await controller.install();
    expect(installed.phase).toBe('installing');
    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(beforeInstall.mock.invocationCallOrder[0]).toBeLessThan(updater.quitAndInstall.mock.invocationCallOrder[0]!);
  });

  it('reports download progress to subscribers', async () => {
    const updater = new FakeUpdater();
    const states: any[] = [];
    const controller = createUpdaterController({ app, updater, emit: state => states.push(state) });
    await controller.check();
    updater.emit('download-progress', { percent: 42, transferred: 4_200_000, total: 10_000_000, bytesPerSecond: 1_500_000 });
    expect(states.at(-1)).toMatchObject({ phase: 'downloading', percent: 42, transferred: 4_200_000, total: 10_000_000, bytesPerSecond: 1_500_000 });
  });

  it('settles idle after a check with no update', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit('update-not-available', { version: '0.1.3' });
      return { updateInfo: { version: '0.1.3' } };
    });
    const controller = createUpdaterController({ app, updater });
    expect(await controller.check()).toMatchObject({ phase: 'idle', latestVersion: undefined });
  });

  it('surfaces check failures without throwing', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = vi.fn(async () => { throw new Error('registry unreachable'); });
    const controller = createUpdaterController({ app, updater });
    expect(await controller.check()).toMatchObject({ phase: 'error', error: 'registry unreachable' });
  });

  it('refuses to download before a check found an update', async () => {
    const updater = new FakeUpdater();
    const controller = createUpdaterController({ app, updater });
    expect(await controller.download()).toMatchObject({ phase: 'idle' });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('runs unsupported when the shell has no updater', async () => {
    const controller = createUpdaterController({ app, updater: null });
    expect(controller.snapshot()).toMatchObject({ phase: 'unsupported', currentVersion: '0.1.3' });
    expect(await controller.check()).toMatchObject({ phase: 'unsupported' });
    await expect(controller.install()).rejects.toThrow('不支持');
  });

  it('resets installing state when install fails', async () => {
    const updater = new FakeUpdater();
    updater.quitAndInstall = vi.fn(() => { throw new Error('installer missing'); });
    const onInstallError = vi.fn();
    const controller = createUpdaterController({ app, updater, onInstallError });
    await controller.check();
    await controller.download();
    await expect(controller.install()).rejects.toThrow('installer missing');
    expect(onInstallError).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toMatchObject({ phase: 'error', error: 'installer missing' });
  });
});
