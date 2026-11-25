import type { FastifyInstance } from 'fastify';
import { createReadStream, realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import { RuntimeError } from '@agent-dock/agent-dock-shared';
import {
  allowedReadRoots,
  imageMimeForName,
  isBinaryBuffer,
  isRealPathWithinRoots,
  isSensitivePath,
  maxDocumentPreviewBytes,
  maxMediaPreviewBytes,
  maxTextPreviewBytes,
  mediaMimeForName,
  previewKindForName,
  resolveExistingInside,
  WorkspacePathError
} from './fs-paths.js';

export interface FsListEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  mtime: string;
}

export interface FsRoutesOptions {
  homeDir?: string;
  tempDir?: string;
  extraMasterRoots?: string[];
}

function badPath(error: unknown): never {
  if (error instanceof RuntimeError) throw error;
  if (error instanceof WorkspacePathError) throw new RuntimeError('INVALID_PATH', error.message, 400);
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new RuntimeError('PATH_NOT_FOUND', '路径不存在', 404);
  if ((error as NodeJS.ErrnoException)?.code === 'ENOTDIR') throw new RuntimeError('NOT_A_DIRECTORY', '目标不是目录', 400);
  throw error;
}

function contentDispositionAttachment(filename: string): string {
  const safeAscii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function parseSingleByteRange(rangeHeader: string, totalSize: number): { start: number; end: number } | 'invalid' | undefined {
  if (!rangeHeader.startsWith('bytes=')) return undefined;
  const spec = rangeHeader.slice('bytes='.length).split(',')[0]?.trim();
  if (!spec) return 'invalid';
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return 'invalid';
  const [, startText, endText] = match;
  if (!startText && !endText) return 'invalid';
  if (totalSize === 0) return 'invalid';
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'invalid';
    const start = Math.max(0, totalSize - suffixLength);
    return { start, end: totalSize - 1 };
  }
  const start = Number(startText);
  const end = endText ? Math.min(Number(endText), totalSize - 1) : totalSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= totalSize || end < start) {
    return 'invalid';
  }
  return { start, end };
}

/**
 * 会话文件浏览与预览路由：
 * - 拦截 SSH 远端会话误走本机文件系统；
 * - 分层访问控制：
 *   - session（分享链接）严格限制在 cwd + 本会话 uploads；
 *   - master（本机控制台所有者）允许通过绝对路径或 ~/ 路径预览/下载本机任意非敏感文件；
 * - realpath 防 symlink 逃逸 + 全角色强制敏感文件黑名单；
 * - SVG raw 响应强制 CSP sandbox + nosniff，支持 ?format=text 源码读取、?download=1 流式下载与音视频 Range 流式预览。
 */
export async function registerFsRoutes(app: FastifyInstance, runtime: AgentDockRuntime, options: FsRoutesOptions = {}): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/sessions/:id/fs/list', async request => {
    const session = await runtime.getSession(request.params.id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
    if (session.sshHost) {
      throw new RuntimeError('REMOTE_SESSION_UNSUPPORTED', `SSH 远端会话（${session.sshHost}）暂不支持本机文件浏览`, 400);
    }
    const userPath = request.query.path ?? '';
    let resolved;
    try { resolved = resolveExistingInside(session.cwd, userPath); }
    catch (error) { badPath(error); }
    let names: string[];
    try { names = await readdir(resolved.absolute); }
    catch (error) { badPath(error); }
    const entries: FsListEntry[] = [];
    await Promise.all(names.map(async name => {
      // 隐藏噪音目录（依赖/版本控制/agentdock 自身），浏览器树里看它们没有价值。
      if (name === 'node_modules' || name === '.git' || name === '.agentdock') return;
      try {
        const info = await stat(`${resolved.absolute}/${name}`);
        entries.push({ name, type: info.isDirectory() ? 'dir' : 'file', size: info.size, mtime: info.mtime.toISOString() });
      } catch { /* 权限错误/竞态删除：跳过该项。 */ }
    }));
    entries.sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'dir' ? -1 : 1);
    return { cwd: session.cwd, path: resolved.relative, entries };
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string; format?: string; download?: string } }>('/api/sessions/:id/fs/read', async (request, reply) => {
    const session = await runtime.getSession(request.params.id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
    if (session.sshHost) {
      throw new RuntimeError('REMOTE_SESSION_UNSUPPORTED', `SSH 远端会话（${session.sshHost}）暂不支持本机文件预览`, 400);
    }
    const userPath = request.query.path;
    if (!userPath) throw new RuntimeError('INVALID_PATH', '缺少 path 参数', 400);
    const expandedPath = userPath.startsWith('~/')
      ? join(options.homeDir ?? homedir(), userPath.slice(2))
      : userPath;
    if (isSensitivePath(userPath) || isSensitivePath(expandedPath)) {
      throw new RuntimeError('SENSITIVE_FILE_BLOCKED', '禁止预览或下载敏感文件', 403);
    }

    const claim = (request as unknown as { webClaim?: { kind: 'master' | 'session' } }).webClaim;
    const role: 'master' | 'session' = claim?.kind === 'session' ? 'session' : 'master';

    let resolved: { absolute: string; relative: string };
    try {
      if (isAbsolute(expandedPath)) {
        const realTarget = realpathSync(expandedPath);
        if (role === 'session') {
          const roots = allowedReadRoots({
            role,
            cwd: session.cwd,
            sessionId: request.params.id,
            ...(options.homeDir ? { homeDir: options.homeDir } : {}),
            ...(options.tempDir ? { tempDir: options.tempDir } : {}),
            ...(options.extraMasterRoots ? { extraMasterRoots: options.extraMasterRoots } : {})
          });
          if (!isRealPathWithinRoots(realTarget, roots)) {
            throw new RuntimeError('FORBIDDEN', '会话分享链接只能预览该会话工作区及上传目录内的文件', 403);
          }
        }
        let rel = expandedPath;
        try {
          const realCwd = realpathSync(session.cwd);
          if (realTarget === realCwd || realTarget.startsWith(`${realCwd}${sep}`)) {
            rel = relative(realCwd, realTarget);
          }
        } catch { /* cwd 不存在时退回绝对路径展示。 */ }
        resolved = { absolute: realTarget, relative: rel };
      } else {
        resolved = resolveExistingInside(session.cwd, expandedPath);
      }
    } catch (error) { badPath(error); }

    // realpath 后再验一次敏感黑名单，防止工作区/临时目录内用软链指向 .env / ~/.ssh / *.key 等。
    if (isSensitivePath(resolved.absolute)) {
      throw new RuntimeError('SENSITIVE_FILE_BLOCKED', '禁止预览或下载敏感文件', 403);
    }

    let info;
    try { info = await stat(resolved.absolute); }
    catch (error) { badPath(error); }
    if (!info.isFile()) throw new RuntimeError('NOT_A_FILE', '目标不是文件', 400);

    const filename = basename(resolved.absolute);
    const isSvg = filename.toLowerCase().endsWith('.svg');
    const wantDownload = request.query.download === '1' || request.query.download === 'true';
    const wantText = request.query.format === 'text';

    if (wantDownload) {
      const contentType = imageMimeForName(filename)
        ?? mediaMimeForName(filename)
        ?? (filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
      reply.header('Content-Type', contentType);
      reply.header('Content-Length', String(info.size));
      reply.header('Content-Disposition', contentDispositionAttachment(filename));
      reply.header('X-Content-Type-Options', 'nosniff');
      if (isSvg) reply.header('Content-Security-Policy', 'sandbox');
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(createReadStream(resolved.absolute));
    }

    const baseKind = previewKindForName(filename);
    const effectiveKind = wantText && (baseKind === 'text' || isSvg) ? 'text' : baseKind;

    if (effectiveKind === 'unsupported') {
      throw new RuntimeError('UNSUPPORTED_PREVIEW', '不支持预览的文件类型，请在终端中查看或下载', 415);
    }
    if (effectiveKind === 'video' || effectiveKind === 'audio') {
      if (info.size > maxMediaPreviewBytes) {
        throw new RuntimeError('FILE_TOO_LARGE', `音视频文件超过 500MB 预览上限（实际 ${info.size} 字节），请下载或用本机播放器查看`, 415);
      }
      const contentType = mediaMimeForName(filename) ?? 'application/octet-stream';
      reply.header('Content-Type', contentType);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'private, max-age=60');
      const rangeHeader = typeof request.headers.range === 'string' ? request.headers.range : undefined;
      if (rangeHeader) {
        const parsed = parseSingleByteRange(rangeHeader, info.size);
        if (parsed === 'invalid') {
          reply.code(416);
          reply.header('Content-Range', `bytes */${info.size}`);
          return reply.send();
        }
        if (parsed) {
          reply.code(206);
          reply.header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${info.size}`);
          reply.header('Content-Length', String(parsed.end - parsed.start + 1));
          return reply.send(createReadStream(resolved.absolute, { start: parsed.start, end: parsed.end }));
        }
      }
      reply.header('Content-Length', String(info.size));
      return reply.send(createReadStream(resolved.absolute));
    }

    const maxBytes = effectiveKind === 'text' ? maxTextPreviewBytes : maxDocumentPreviewBytes;
    if (info.size > maxBytes) {
      throw new RuntimeError('FILE_TOO_LARGE', `文件超过 ${effectiveKind === 'text' ? '1MB' : '20MB'} 预览上限（实际 ${info.size} 字节），请在终端中查看或下载`, 415);
    }

    const buffer = await readFile(resolved.absolute);
    if (effectiveKind === 'image' || effectiveKind === 'pdf') {
      reply.header('Content-Type', effectiveKind === 'pdf' ? 'application/pdf' : imageMimeForName(filename) ?? 'application/octet-stream');
      reply.header('X-Content-Type-Options', 'nosniff');
      if (isSvg) reply.header('Content-Security-Policy', 'sandbox');
      reply.header('Cache-Control', 'private, max-age=60');
      return reply.send(buffer);
    }

    if (isBinaryBuffer(buffer)) {
      throw new RuntimeError('BINARY_FILE', '检测到二进制文件内容，暂不支持文本预览，请下载查看', 415);
    }
    return { cwd: session.cwd, path: resolved.relative, size: info.size, content: buffer.toString('utf8') };
  });
}
