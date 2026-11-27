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
    expect(preload).toContain('{ update, network, projects, notifications }');
  });

  it('主进程只在 macOS 弹系统目录选择器，并把绝对路径交回渲染进程', () => {
    expect(main).toContain("ipcMain.handle('agentdock:desktop-projects:pick-directory'");
    expect(main).toContain("if (process.platform !== 'darwin') return { supported: false, canceled: true };");
    expect(main).toContain("properties: ['openDirectory', 'createDirectory']");
    expect(main).toContain('result.filePaths[0]');
  });
});

describe('桌面壳原生通知 bridge', () => {
  it('preload 暴露 notifications IPC 能力与点击/聚焦订阅', () => {
    expect(preload).toContain("ipcRenderer.invoke('agentdock:desktop-notification:capabilities')");
    expect(preload).toContain("ipcRenderer.invoke('agentdock:desktop-notification:is-focused')");
    expect(preload).toContain("ipcRenderer.invoke('agentdock:desktop-notification:show', payload)");
    expect(preload).toContain("ipcRenderer.invoke('agentdock:desktop-notification:set-badge', count)");
    expect(preload).toContain("const NOTIFY_CLICK_CHANNEL = 'agentdock:desktop-notification:click'");
    expect(preload).toContain("const NOTIFY_FOCUS_CHANNEL = 'agentdock:desktop-notification:focus'");
  });

  it('主进程注册原生 Notification、防 GC 引用表、点击聚焦跳转与 Dock/任务栏提示', () => {
    expect(main).toContain("ipcMain.handle('agentdock:desktop-notification:show'");
    expect(main).toContain("ipcMain.handle('agentdock:desktop-notification:is-focused'");
    expect(main).toContain("ipcMain.handle('agentdock:desktop-notification:set-badge'");
    expect(main).toContain('state.activeNotifications.set(id, notification)');
    expect(main).toContain("win.webContents.send('agentdock:desktop-notification:click', { id, sessionId })");
    expect(main).toContain('app.dock?.bounce');
    expect(main).toContain('state.window.flashFrame(true)');
  });
});
