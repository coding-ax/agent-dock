import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * 会话文件浏览的路径安全：所有路径都必须被关在会话 cwd（realpath 后）内。
 * 单纯做字符串 prefix 检查防不住 symlink 逃逸（cwd 内一个指向 /etc 的软链），
 * 因此解析为绝对路径后还要与 realpath(cwd) 做前缀比较。
 */

export interface ResolvedWorkspacePath {
  /** 相对于 root 的 POSIX 风格路径；root 本身为空串。 */
  relative: string;
  absolute: string;
}

/**
 * 把用户传入的相对路径解析到 root 内。先做词法 containment（不触盘、可纯函数测试），
 * 拒绝绝对路径与 `..` 越界；realpath 级校验见 resolveExistingInside。
 */
export function resolveInsideRoot(root: string, userPath: string): ResolvedWorkspacePath {
  const normalized = (userPath ?? '').trim();
  if (isAbsolute(normalized)) throw new WorkspacePathError('路径必须是相对工作区的相对路径');
  const absolute = resolve(root, normalized);
  const rootResolved = resolve(root);
  if (absolute !== rootResolved && !absolute.startsWith(`${rootResolved}${sep}`)) {
    throw new WorkspacePathError('路径超出工作区范围');
  }
  const relative = absolute === rootResolved ? '' : absolute.slice(rootResolved.length + 1);
  return { relative, absolute };
}

/** 词法 containment 判定（不触盘）；供需要布尔结果的调用方/测试使用。 */
export function isInsideRoot(root: string, userPath: string): boolean {
  try { resolveInsideRoot(root, userPath); return true; }
  catch { return false; }
}

/**
 * realpath 级 containment：要求目标已存在。root 本身不存在时抛错；
 * 目标的 realpath 必须仍在 root 的 realpath 内。
 */
export function resolveExistingInside(root: string, userPath: string): ResolvedWorkspacePath {
  const lexical = resolveInsideRoot(root, userPath);
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(lexical.absolute);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
    throw new WorkspacePathError('路径解析后超出工作区范围（符号链接逃逸）');
  }
  const relative = realTarget === realRoot ? '' : realTarget.slice(realRoot.length + 1);
  return { relative, absolute: realTarget };
}

export class WorkspacePathError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkspacePathError'; }
}

// 可直接按 UTF-8 文本预览的扩展名白名单；其余类型走图片/415 分支。
export const textExtensions = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.csv', '.tsv',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm', '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.html', '.htm', '.css', '.scss', '.less', '.xml', '.svg', '.vue', '.svelte',
  '.sql', '.graphql', '.gql', '.proto', '.thrift',
  '.gitignore', '.dockerignore', '.editorconfig', '.eslintrc', '.prettierrc', '.npmrc',
  '.lock', '.sum', '.mod', '.work',
  '.log', '.patch', '.diff', '.rst', '.tex', '.bib'
]);

export const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif']);

export const maxTextPreviewBytes = 1024 * 1024;
export const maxDocumentPreviewBytes = 20 * 1024 * 1024;

export type PreviewKind = 'text' | 'image' | 'pdf' | 'unsupported';

/** 按扩展名判定预览类型（纯函数；大小限制由调用方实施）。 */
export function previewKindForName(name: string): PreviewKind {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  // .gitignore 这类点开头无后缀名也要能按文本打开。
  const ext = dot >= 0 ? lower.slice(dot) : lower;
  if (textExtensions.has(ext)) return 'text';
  if (imageExtensions.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  return 'unsupported';
}

const imageMime: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif'
};

export function imageMimeForName(name: string): string | undefined {
  const dot = name.toLowerCase().lastIndexOf('.');
  return dot >= 0 ? imageMime[name.toLowerCase().slice(dot)] : undefined;
}
