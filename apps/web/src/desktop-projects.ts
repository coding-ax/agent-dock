/**
 * 桌面壳（Electron preload）暴露的目录选择能力。
 *
 * 浏览器里 `window.agentdockDesktop` 不存在，`platform` 也不是 darwin，
 * 两条路径都会自然退化到「手输绝对路径」，不需要额外探测 userAgent。
 */
export type DesktopProjectPickerResult = { supported: boolean; canceled: boolean; path?: string };

export type DesktopProjectsApi = {
  platform: string;
  pickDirectory(): Promise<DesktopProjectPickerResult>;
};

export function desktopProjectPicker(): DesktopProjectsApi | undefined {
  const api = typeof window === 'undefined' ? undefined : window.agentdockDesktop?.projects;
  return api && typeof api.pickDirectory === 'function' ? api : undefined;
}

/** 只有 macOS 桌面端调系统目录选择器；其他端一律手输。 */
export function hasMacDirectoryPicker(api: DesktopProjectsApi | undefined = desktopProjectPicker()): boolean {
  return api?.platform === 'darwin';
}
