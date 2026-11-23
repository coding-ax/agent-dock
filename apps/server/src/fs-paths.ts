import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * 会话文件浏览的路径安全：
 * 1. 分层白名单：
 *    - session（分享链接）：仅允许当前会话 cwd 与本会话的 .agentdock/uploads/<sessionId>；
 *    - master（控制台所有者）：允许当前会话 cwd、.agentdock/uploads 及产物/临时目录（~/.gemini、/tmp、/private/tmp、os.tmpdir()）；
 * 2. 所有路径必须经 realpath 解析后校验 containment，防 symlink 逃逸；
 * 3. 全角色强制敏感文件黑名单：.env、.env.*、.npmrc、~/.ssh/**、*.key、*.pem、id_rsa*、auth.json 等一律拒绝。
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

/**
 * 敏感文件黑名单（全角色强制生效，包括 master 与 cwd 内部）。
 * 同时校验原始路径与 realpath，防止通过软链绕过。
 */
const sensitiveExactNames = new Set([
  '.env',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.dockercfg',
  '.htpasswd',
  'auth.json',
  'credentials.json',
  '.credentials.json',
  'secrets.json',
  'token.json'
]);

const sensitiveExtensions = new Set([
  '.key',
  '.pem',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore'
]);

const sensitiveKeyPrefixPattern = /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\..+)?$/i;

export function isSensitivePath(targetPath: string): boolean {
  const normalized = targetPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length) return false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!.toLowerCase();
    if (seg === '.ssh' || seg === '.gnupg') return true;
    // ~/.aws/credentials、~/.kube/config
    if (seg === '.aws' && segments[i + 1]?.toLowerCase() === 'credentials') return true;
    if (seg === '.kube' && segments[i + 1]?.toLowerCase() === 'config') return true;
  }
  const name = basename(normalized).toLowerCase();
  if (sensitiveExactNames.has(name)) return true;
  if (name.startsWith('.env.')) return true;
  if (sensitiveKeyPrefixPattern.test(name)) return true;
  if (name.startsWith('service-account') && name.endsWith('.json')) return true;
  const dot = name.lastIndexOf('.');
  if (dot >= 0 && sensitiveExtensions.has(name.slice(dot))) return true;
  return false;
}

export interface AllowedRootsOptions {
  role: 'master' | 'session';
  cwd: string;
  sessionId?: string;
  homeDir?: string;
  tempDir?: string;
  extraMasterRoots?: string[];
}

/**
 * 计算当前角色允许读取的根目录列表（去重且仅保留已存在目录的 realpath）。
 * - session：仅 cwd + 本会话的 ~/.agentdock/uploads/<sessionId>
 * - master：cwd + ~/.agentdock/uploads + 产物/临时目录（~/.gemini、/tmp、/private/tmp、tmpdir()）
 */
export function allowedReadRoots(options: AllowedRootsOptions): string[] {
  const home = options.homeDir ?? homedir();
  const candidates: string[] = [options.cwd];
  if (options.role === 'session') {
    if (options.sessionId) {
      candidates.push(join(home, '.agentdock', 'uploads', options.sessionId));
    }
  } else {
    candidates.push(
      join(home, '.agentdock', 'uploads'),
      join(home, '.gemini'),
      '/tmp',
      '/private/tmp',
      options.tempDir ?? tmpdir(),
      ...(options.extraMasterRoots ?? [])
    );
  }
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const real = realpathSync(candidate);
      if (!seen.has(real)) {
        seen.add(real);
        resolved.push(real);
      }
    } catch { /* 无法 realpath 的候选目录忽略。 */ }
  }
  return resolved;
}

/** 判断已 realpath 的绝对路径是否落在任意允许根目录内。 */
export function isRealPathWithinRoots(realTarget: string, realRoots: string[]): boolean {
  return realRoots.some(root => realTarget === root || realTarget.startsWith(`${root}${sep}`));
}

/**
 * 简单二进制嗅探：检查前 8KB 是否包含 NUL 字节或高比例不可打印控制字符。
 * 防止改了文本扩展名（如 .log/.txt/.json）的二进制文件把乱码塞进文本预览。
 */
export function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8192);
  if (len === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const byte = buffer[i]!;
    if (byte === 0) return true;
    // 允许常见空白/控制字符：\t(9), \n(10), \v(11), \f(12), \r(13), ESC(27)
    if (byte < 7 || (byte > 14 && byte < 32 && byte !== 27)) {
      suspicious++;
    }
  }
  return suspicious / len > 0.3;
}

// 可直接按 UTF-8 文本预览的扩展名白名单；移除了 .env/.npmrc（敏感）与 .svg（归类到 image，源码模式走 ?format=text）。
export const textExtensions = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.csv', '.tsv',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm', '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.html', '.htm', '.css', '.scss', '.less', '.xml', '.vue', '.svelte',
  '.sql', '.graphql', '.gql', '.proto', '.thrift',
  '.gitignore', '.dockerignore', '.editorconfig', '.eslintrc', '.prettierrc',
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
  if (imageExtensions.has(ext)) return 'image';
  if (textExtensions.has(ext)) return 'text';
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
