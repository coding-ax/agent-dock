import { useRef } from 'react';
import { useEventListener } from 'ahooks';

/**
 * 全局快捷键表。
 *
 * 之前全应用只有一个硬编码的 ⌘K（写在 App.tsx 的 keydown 里），标签文字是手写的、
 * 与绑定没有任何关联——改了键位忘了改标签就会说谎。这里把键位与展示文案放在同一条记录上，
 * 菜单直接渲染这张表，所以「显示的」与「生效的」不可能不一致。
 *
 * 约定沿用现有 ⌘K：必须带 meta/ctrl 前缀（所以在输入框里打字不会误触），
 * 用 event.key.toLowerCase() 比较，命中就 preventDefault。
 */
export interface Shortcut {
  /** 匹配用的主键，小写。 */
  key: string;
  shift?: boolean;
  /** 展示文案，例如 ⌘T。 */
  label: string;
  description: string;
  run(): void;
}

export const isMac = () => typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/** 按当前平台拼展示文案：Mac 用 ⌘⇧，其他平台用 Ctrl+Shift+。 */
export function shortcutLabel(key: string, shift = false, mac = isMac()): string {
  const main = key.toUpperCase();
  return mac ? `${shift ? '⇧' : ''}⌘${main}` : `Ctrl+${shift ? 'Shift+' : ''}${main}`;
}

/** 这条事件是否命中该快捷键。导出来测，避免只能靠 DOM 事件测。 */
export function matchesShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey'>, shortcut: Pick<Shortcut, 'key' | 'shift'>): boolean {
  if (!(event.metaKey || event.ctrlKey)) return false;
  // 目标键位没要求 shift 时也不允许 shift 被按下：⌘T 与 ⇧⌘T 是两回事。
  if (Boolean(shortcut.shift) !== event.shiftKey) return false;
  return event.key.toLowerCase() === shortcut.key;
}

/**
 * 挂载全局快捷键。
 *
 * 表每次渲染都会是新数组，所以放进 ref 让监听器读最新值——否则要么把 listener 重挂一遍
 * （每次渲染都挂/拆一次 document 监听），要么闭包抓到旧的 run()。
 */
export function useShortcuts(shortcuts: Shortcut[]): void {
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  useEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    // 中文输入法组字过程中不响应（与仓库其他地方一致）。
    if (event.isComposing || event.keyCode === 229) return;
    const hit = shortcutsRef.current.find(shortcut => matchesShortcut(event, shortcut));
    if (!hit) return;
    // ⌘P 之类的浏览器默认行为必须盖掉，否则会弹打印框。
    event.preventDefault();
    hit.run();
  });
}
