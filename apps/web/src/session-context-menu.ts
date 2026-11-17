import type { Session } from './api';
import { modelBadge, modelBadgeText } from './model-label';
import { absoluteActivityTime, sessionStatusLabel } from './session-details';
import { sessionLabel } from './session-groups';
import { sessionUrl } from './session-url';

/**
 * 会话右键菜单的纯逻辑：菜单项、可打开的绝对链接、可复制的信息文本、
 * 视口内定位以及剪贴板降级。组件只负责渲染和焦点，单测全走这里。
 */

export const CONTEXT_MENU_WIDTH = 240;
export const CONTEXT_MENU_HEIGHT = 296;
const CONTEXT_MENU_GAP = 8;

export type SessionContextMenuAction = 'rename' | 'copy-link' | 'copy-id' | 'copy-title' | 'copy-info' | 'archive';

export type SessionContextMenuItem = { kind: 'item'; action: SessionContextMenuAction; label: string; value?: string; danger?: boolean };
export type SessionContextMenuEntry = SessionContextMenuItem | { kind: 'separator' };

/** 现有路由只生成站内路径；分享给别人的链接必须是可直接打开的绝对 URL。 */
export function sessionLink(sessionId: string, origin: string): string {
  return new URL(sessionUrl(sessionId), origin).toString();
}

/**
 * 复制给同事/贴进 issue 的纯文本。字段按「先能定位、再能复现」的顺序排，
 * 时间用本地绝对刻度，不用「几分钟前」这种会随阅读时间漂移的说法。
 */
export function sessionInfoText(session: Session, agentName?: string): string {
  const title = sessionLabel(session, agentName);
  const model = modelBadgeText(modelBadge(session.model, session.reasoningEffort)) ?? '默认';
  return [
    `标题：${title}`,
    `会话 ID：${session.id}`,
    `Agent：${agentName?.trim() || session.agentId}`,
    `模型：${model}`,
    `工作目录：${session.cwd}`,
    `状态：${sessionStatusLabel(session).text}`,
    `创建时间：${absoluteActivityTime(session.createdAt)}`,
    `更新时间：${absoluteActivityTime(session.updatedAt)}`
  ].join('\n');
}

export function sessionContextMenuEntries(session: Session, options: { agentName?: string; origin: string }): SessionContextMenuEntry[] {
  const title = sessionLabel(session, options.agentName);
  return [
    { kind: 'item', action: 'rename', label: '重命名会话' },
    { kind: 'separator' },
    { kind: 'item', action: 'copy-link', label: '复制会话链接', value: sessionLink(session.id, options.origin) },
    { kind: 'item', action: 'copy-id', label: '复制会话 ID', value: session.id },
    { kind: 'item', action: 'copy-title', label: '复制会话标题', value: title },
    { kind: 'item', action: 'copy-info', label: '复制会话信息', value: sessionInfoText(session, options.agentName) },
    { kind: 'separator' },
    { kind: 'item', action: 'archive', label: '归档会话', danger: true }
  ];
}

export type ContextMenuPoint = { x: number; y: number };
export type ContextMenuSize = { width: number; height: number };
export type ContextMenuViewport = { width: number; height: number };
export type ContextMenuPlacement = { left: number; top: number; flippedHorizontally: boolean; flippedVertically: boolean };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * 右键菜单默认从鼠标位置向右下展开；右侧/下侧放不下就翻到光标左边/上边，
 * 最后再夹回视口内，避免贴边时只露出一半。
 */
export function placeContextMenu(point: ContextMenuPoint, menu: ContextMenuSize, viewport: ContextMenuViewport, gap = CONTEXT_MENU_GAP): ContextMenuPlacement {
  const flippedHorizontally = point.x + menu.width + gap > viewport.width;
  const flippedVertically = point.y + menu.height + gap > viewport.height;
  const preferredLeft = flippedHorizontally ? point.x - menu.width : point.x;
  const preferredTop = flippedVertically ? point.y - menu.height : point.y;
  return {
    left: clamp(preferredLeft, gap, viewport.width - menu.width - gap),
    top: clamp(preferredTop, gap, viewport.height - menu.height - gap),
    flippedHorizontally,
    flippedVertically
  };
}

/** Shift+F10 和键盘上的菜单键（key = ContextMenu）都按右键处理。 */
export function isContextMenuKeyboardEvent(event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
}

/** 长按打开菜单后浏览器仍会补发 click；这个窗口内不能把 click 当成「打开会话」。 */
export function shouldOpenSessionFromClick(suppressClickUntil: number, now: number): boolean {
  return now >= suppressClickUntil;
}

export type CopyMethod = 'clipboard' | 'execCommand';
export type CopyResult = { ok: true; method: CopyMethod } | { ok: false; message: string };

type CopyOptions = {
  clipboard?: Pick<Clipboard, 'writeText'> | null;
  execCommand?(text: string): boolean;
};

function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-9999px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, area.value.length);
  const copied = document.execCommand('copy');
  area.remove();
  return copied;
}

/**
 * 优先 Clipboard API。局域网 http 不是安全上下文，navigator.clipboard 可能不存在
 * 或直接拒绝，这时退回 execCommand；两者都失败才让 UI 提示手动复制。
 */
export async function copyText(text: string, options: CopyOptions = {}): Promise<CopyResult> {
  const clipboard = 'clipboard' in options ? options.clipboard : (typeof navigator === 'undefined' ? undefined : navigator.clipboard);
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return { ok: true, method: 'clipboard' };
    } catch {
      // 继续尝试 execCommand。
    }
  }
  const fallback = options.execCommand ?? execCommandCopy;
  try {
    if (fallback(text)) return { ok: true, method: 'execCommand' };
  } catch {
    // 统一落到可读的失败提示。
  }
  return { ok: false, message: '复制失败，请手动选择文本复制' };
}
