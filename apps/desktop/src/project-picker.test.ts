import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, 'main.cjs'), 'utf8');
const preload = readFileSync(join(here, 'preload.cjs'), 'utf8');

describe('桌面壳目录选择 bridge', () => {
  it('preload 暴露 projects.pickDirectory 与平台信息', () => {
    expect(preload).toContain("ipcRenderer.invoke('agentdock:desktop-projects:pick-directory')");
    expect(preload).toContain('platform: process.platform');
    expect(preload).toContain('{ update, network, projects }');
  });

  it('主进程只在 macOS 弹系统目录选择器，并把绝对路径交回渲染进程', () => {
    expect(main).toContain("ipcMain.handle('agentdock:desktop-projects:pick-directory'");
    expect(main).toContain("if (process.platform !== 'darwin') return { supported: false, canceled: true };");
    expect(main).toContain("properties: ['openDirectory', 'createDirectory']");
    expect(main).toContain('result.filePaths[0]');
  });
});
