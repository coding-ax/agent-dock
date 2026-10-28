import type { ExternalSession } from './api';

/** UUID（v4/v7 等）字面量；用于从 `codex://threads/<uuid>` 这类深链里抠出会话 id。 */
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/**
 * 从搜索词里取出可能的会话 id。
 *
 * 允许三种写法直接命中同一条会话：
 * - 完整深链：`codex://threads/01a124f0-357b-7a21-8db4-3260e2238d00`
 * - 裸 id：`01a124f0-357b-7a21-8db4-3260e2238d00`
 * - id 前缀：`01a124f0`
 * 前两种都能被 UUID 正则抓出来；抓不到时退回原文（交给 prefix 匹配处理）。
 */
export function sessionIdFromQuery(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const uuid = trimmed.match(UUID)?.[0];
  return (uuid ?? trimmed).toLowerCase();
}

/** 外部会话是否命中关键词：标题 / 工作目录 / 会话 id（支持深链与 id 前缀）。 */
export function matchesExternalSession(session: ExternalSession, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  if ((session.title ?? '').toLowerCase().includes(needle)) return true;
  if (session.cwd.toLowerCase().includes(needle)) return true;
  const id = sessionIdFromQuery(keyword);
  return id ? session.sessionId.toLowerCase().includes(id) : false;
}
