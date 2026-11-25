export interface FilePreviewTarget {
  path: string;
  startLine?: number;
  endLine?: number;
  column?: number;
}

const imageFilePattern = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const videoFilePattern = /\.(mp4|webm|mov|m4v|ogv)$/i;
const audioFilePattern = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;

export function isImageFilePath(path: string | undefined): boolean {
  return Boolean(path && imageFilePattern.test(path));
}

export function isVideoFilePath(path: string | undefined): boolean {
  return Boolean(path && videoFilePattern.test(path));
}

export function isAudioFilePath(path: string | undefined): boolean {
  return Boolean(path && audioFilePattern.test(path));
}

export function isSvgFilePath(path: string | undefined): boolean {
  return Boolean(path && /\.svg$/i.test(path));
}

export function isMarkdownFilePath(path: string | undefined): boolean {
  return Boolean(path && /\.(md|markdown)$/i.test(path));
}

export function formatLineRange(startLine?: number, endLine?: number): string | undefined {
  if (!startLine || startLine < 1) return undefined;
  if (endLine && endLine > startLine) return `L${startLine}-L${endLine}`;
  return `L${startLine}`;
}

function parseHashLineRange(hash: string): { startLine?: number; endLine?: number } {
  const match = /^#L(\d+)(?:-L?(\d+))?$/i.exec(hash.trim());
  if (!match) return {};
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  if (!Number.isFinite(start) || start < 1) return {};
  if (end !== undefined && (!Number.isFinite(end) || end < start)) return { startLine: start };
  return end !== undefined ? { startLine: start, endLine: end } : { startLine: start };
}

/**
 * 解析本地文件链接，保留并提取 `#L14-L16` / `#L14` / `:12:5` / `:12` / `:12-16` 行列号。
 * 非本地链接（http/https/mailto/纯锚点/站内 /api/ 或 /sessions/）返回 undefined。
 */
export function parseFileLink(href: string): FilePreviewTarget | undefined {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^(?!file:)[a-z][a-z\d+.-]*:/i.test(href)) return undefined;
  let path = href;
  let hash = '';
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return undefined;
      path = decodeURIComponent(url.pathname);
      hash = url.hash;
    } catch { return undefined; }
  } else {
    const hashIndex = path.indexOf('#');
    if (hashIndex >= 0) {
      hash = path.slice(hashIndex);
      path = path.slice(0, hashIndex);
    }
    const queryIndex = path.indexOf('?');
    if (queryIndex >= 0) path = path.slice(0, queryIndex);
    try { path = decodeURIComponent(path); }
    catch { return undefined; }
  }

  let { startLine, endLine } = parseHashLineRange(hash);
  let column: number | undefined;

  // Agent 常输出 `path/to/file.md:43`、`file.ts:12:5` 或 `file.ts:12-16` 这样的代码引用。
  // 仅对带扩展名的末段剥离行列号，避免误伤不含扩展名的目录/路径。
  const filename = path.slice(path.lastIndexOf('/') + 1);
  const rangeMatch = /(\.[^/.:]+):(\d+)-(\d+)$/.exec(filename);
  const lineColMatch = !rangeMatch ? /(\.[^/.:]+):(\d+)(?::(\d+))?$/.exec(filename) : null;
  if (rangeMatch) {
    const start = Number(rangeMatch[2]);
    const end = Number(rangeMatch[3]);
    if (start >= 1) {
      startLine ??= start;
      if (end >= start) endLine ??= end;
    }
    path = path.slice(0, path.length - (rangeMatch[0].length - rangeMatch[1]!.length));
  } else if (lineColMatch) {
    const line = Number(lineColMatch[2]);
    const col = lineColMatch[3] ? Number(lineColMatch[3]) : undefined;
    if (line >= 1) startLine ??= line;
    if (col !== undefined && col >= 1) column = col;
    path = path.slice(0, path.length - (lineColMatch[0].length - lineColMatch[1]!.length));
  }

  if (!path || path.includes('\0') || path.startsWith('/api/') || path.startsWith('/sessions/')) return undefined;
  return {
    path,
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    ...(column !== undefined ? { column } : {})
  };
}

/** Only local Markdown file links belong in the file preview. */
export function localFileLink(href: string): string | undefined {
  return parseFileLink(href)?.path;
}

/** Convert an agent's file link to the relative path accepted by session fs routes. */
export function workspacePreviewPath(link: string, cwd: string): string | undefined {
  const path = localFileLink(link)?.replace(/\\/g, '/');
  if (!path) return undefined;
  const root = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  if (path.startsWith('~/')) return undefined;
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

/** Keep workspace browsing relative, but allow absolute and ~/ links in the owner's read-only preview. */
export function filePreviewPath(link: string, cwd: string): string | undefined {
  const local = localFileLink(link);
  return workspacePreviewPath(link, cwd) ?? (local?.startsWith('/') || local?.startsWith('~/') ? local : undefined);
}
