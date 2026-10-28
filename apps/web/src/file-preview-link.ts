/** Only local Markdown file links belong in the file preview. */
export function localFileLink(href: string): string | undefined {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^(?!file:)[a-z][a-z\d+.-]*:/i.test(href)) return undefined;
  let path = href;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return undefined;
      path = decodeURIComponent(url.pathname);
    } catch { return undefined; }
  } else {
    try { path = decodeURIComponent(path.split(/[?#]/, 1)[0]!); }
    catch { return undefined; }
  }
  // Agent 常输出 `path/to/file.md:43` 或 `file.ts:12:5` 这样的代码引用。
  // 行列号用于定位，不属于磁盘文件名；仅对带扩展名的末段做转换。
  const filename = path.slice(path.lastIndexOf('/') + 1);
  if (/\.[^/.]+:\d+(?::\d+)?$/.test(filename)) path = path.replace(/:\d+(?::\d+)?$/, '');
  if (!path || path.includes('\0') || path.startsWith('/api/') || path.startsWith('/sessions/')) return undefined;
  return path;
}

/** Convert an agent's file link to the relative path accepted by session fs routes. */
export function workspacePreviewPath(link: string, cwd: string): string | undefined {
  const path = localFileLink(link)?.replace(/\\/g, '/');
  if (!path) return undefined;
  const root = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  if (path.startsWith('/')) {
    if (!root || !path.startsWith(`${root}/`)) return undefined;
    return path.slice(root.length + 1);
  }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return undefined; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/') || undefined;
}

/** Keep workspace browsing relative, but allow absolute links in the owner's read-only preview. */
export function filePreviewPath(link: string, cwd: string): string | undefined {
  const local = localFileLink(link);
  return workspacePreviewPath(link, cwd) ?? (local?.startsWith('/') ? local : undefined);
}
