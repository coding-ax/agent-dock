import type { PaneTab, PaneTabKind } from './store';

/**
 * 地址栏 ↔ 右栏标签的编解码。
 *
 * 主会话保持 `/sessions/:id` 不变，所以改造前分享出去的双栏链接必须继续可用——
 * 旧格式是 `?pane=<sessionId>`，这里的 parse 要能认出它并还原成会话标签。
 * 这是整个改造里最容易悄悄弄坏的地方（改完自己的链接能用、别人的旧链接白屏），
 * 所以单独拆出来测。
 */
export function sessionUrl(primaryId?: string, tab?: PaneTab): string {
  if (!primaryId) return '/';
  const base = `/sessions/${encodeURIComponent(primaryId)}`;
  if (!tab) return base;
  // 终端 / 文件 / 原始日志锚定主会话，不需要带 id。
  if (tab.kind === 'terminal' || tab.kind === 'files' || tab.kind === 'raw') return `${base}?right=${tab.kind}`;
  return tab.sessionId && tab.sessionId !== primaryId ? `${base}?pane=${encodeURIComponent(tab.sessionId)}` : base;
}

export interface ParsedRight { kind: PaneTabKind; sessionId?: string }

/** URL 里的右栏描述 → 一个待打开的标签（不含 id，调用方补）。 */
export function parseRightParam(search: string, primaryId?: string): ParsedRight | undefined {
  const params = new URLSearchParams(search);
  const right = params.get('right');
  if (right === 'terminal' || right === 'files' || right === 'raw') return { kind: right };
  const pane = params.get('pane');
  // 与旧实现同一守卫：右栏不重复显示主会话。
  if (pane && pane !== primaryId) return { kind: 'session', sessionId: pane };
  return undefined;
}
