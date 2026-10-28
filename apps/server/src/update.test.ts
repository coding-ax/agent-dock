import { describe, expect, it, vi } from 'vitest';
import { normalizeDistTag, updateAgentDock } from './update.js';

describe('AgentDock updater', () => {
  it('installs and verifies the selected dist-tag before restarting', async () => {
    const runNpm = vi.fn()
      .mockResolvedValueOnce('"0.1.23-fix.1"\n')
      .mockResolvedValueOnce('installed')
      .mockResolvedValueOnce(JSON.stringify({ dependencies: { '@agent-dock/cli': { version: '0.1.23-fix.1' } } }))
      .mockResolvedValueOnce('/opt/npm/lib/node_modules\n');
    const restart = vi.fn(async (_entrypoint: string) => {});
    await expect(updateAgentDock('0.1.22-fix.3', { distTag: 'fix' }, { runNpm, restart })).resolves.toEqual({
      action: 'update', packageName: '@agent-dock/cli', distTag: 'fix',
      previousVersion: '0.1.22-fix.3', version: '0.1.23-fix.1', updated: true, restarted: true
    });
    expect(runNpm).toHaveBeenNthCalledWith(1, ['view', '@agent-dock/cli@fix', 'version', '--json']);
    expect(runNpm).toHaveBeenNthCalledWith(2, ['install', '--global', '@agent-dock/cli@fix']);
    expect(runNpm).toHaveBeenNthCalledWith(3, ['list', '--global', '@agent-dock/cli', '--depth=0', '--json']);
    expect(runNpm).toHaveBeenNthCalledWith(4, ['root', '--global']);
    expect(restart).toHaveBeenCalledWith('/opt/npm/lib/node_modules/@agent-dock/cli/dist/cli.js');
  });

  it('defaults to latest and never restarts when installation verification fails', async () => {
    const runNpm = vi.fn()
      .mockResolvedValueOnce('"0.1.23"')
      .mockResolvedValueOnce('installed')
      .mockResolvedValueOnce(JSON.stringify({ dependencies: { '@agent-dock/cli': { version: '0.1.22' } } }));
    const restart = vi.fn(async (_entrypoint: string) => {});
    await expect(updateAgentDock('0.1.22', {}, { runNpm, restart })).rejects.toThrow('service was not restarted');
    expect(runNpm).toHaveBeenCalledWith(['view', '@agent-dock/cli@latest', 'version', '--json']);
    expect(restart).not.toHaveBeenCalled();
  });

  it('rejects unsafe or version-like dist-tags before invoking npm', async () => {
    expect(normalizeDistTag(' fix ')).toBe('fix');
    expect(() => normalizeDistTag('0.1.23')).toThrow('Invalid npm dist-tag');
    expect(() => normalizeDistTag('fix; reboot')).toThrow('Invalid npm dist-tag');
  });
});
