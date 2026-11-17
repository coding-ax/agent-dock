import { describe, expect, it, vi } from 'vitest';
import { hasMacDirectoryPicker, type DesktopProjectsApi } from './desktop-projects';

const api = (platform: string): DesktopProjectsApi => ({ platform, pickDirectory: vi.fn(async () => ({ supported: true, canceled: true })) });

describe('桌面目录选择器平台门', () => {
  it('只在 macOS 桌面壳里启用', () => {
    expect(hasMacDirectoryPicker(api('darwin'))).toBe(true);
    expect(hasMacDirectoryPicker(api('win32'))).toBe(false);
    expect(hasMacDirectoryPicker(api('linux'))).toBe(false);
  });

  it('浏览器里没有 bridge，退化为手输路径', () => {
    expect(hasMacDirectoryPicker(undefined)).toBe(false);
  });
});
