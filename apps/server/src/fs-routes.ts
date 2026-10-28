import type { FastifyInstance } from 'fastify';
import { realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import { RuntimeError } from '@agent-dock/agent-dock-shared';
import { imageMimeForName, maxDocumentPreviewBytes, maxTextPreviewBytes, previewKindForName, resolveExistingInside, WorkspacePathError } from './fs-paths.js';

export interface FsListEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  mtime: string;
}

function badPath(error: unknown): never {
  if (error instanceof WorkspacePathError) throw new RuntimeError('INVALID_PATH', error.message, 400);
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new RuntimeError('PATH_NOT_FOUND', '路径不存在', 404);
  if ((error as NodeJS.ErrnoException)?.code === 'ENOTDIR') throw new RuntimeError('NOT_A_DIRECTORY', '目标不是目录', 400);
  throw error;
}

/**
 * 会话文件浏览默认关在 cwd 内。主控台可预览 Agent 返回的工作区外绝对路径；
 * 分享会话的令牌仍只能读取该会话 cwd 内的文件。
 */
export async function registerFsRoutes(app: FastifyInstance, runtime: AgentDockRuntime): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/sessions/:id/fs/list', async request => {
    const session = await runtime.getSession(request.params.id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
    const userPath = request.query.path ?? '';
    let resolved;
    try { resolved = resolveExistingInside(session.cwd, userPath); }
    catch (error) { badPath(error); }
    let names: string[];
    try { names = await readdir(resolved.absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RuntimeError('PATH_NOT_FOUND', '路径不存在', 404); if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') throw new RuntimeError('NOT_A_DIRECTORY', '目标不是目录', 400); throw error; }
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

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/sessions/:id/fs/read', async (request, reply) => {
    const session = await runtime.getSession(request.params.id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
    const userPath = request.query.path;
    if (!userPath) throw new RuntimeError('INVALID_PATH', '缺少 path 参数', 400);
    let resolved;
    try {
      if (isAbsolute(userPath)) {
        try {
          resolved = resolveExistingInside(session.cwd, relative(session.cwd, userPath));
        } catch {
          const claim = (request as unknown as { webClaim?: { kind: 'master' | 'session' } }).webClaim;
          if (claim?.kind === 'session') throw new RuntimeError('FORBIDDEN', '会话分享链接只能预览该会话工作区内的文件', 403);
          // 主控台本来就有本机终端权限；这里只开放只读且限制文件类型和大小。
          resolved = { absolute: realpathSync(userPath), relative: userPath };
        }
      } else {
        resolved = resolveExistingInside(session.cwd, userPath);
      }
    } catch (error) { badPath(error); }
    let info;
    try { info = await stat(resolved.absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RuntimeError('PATH_NOT_FOUND', '路径不存在', 404); throw error; }
    if (!info.isFile()) throw new RuntimeError('NOT_A_FILE', '目标不是文件', 400);
    const kind = previewKindForName(resolved.absolute.split('/').pop() ?? '');
    if (kind === 'unsupported') throw new RuntimeError('UNSUPPORTED_PREVIEW', '不支持预览的文件类型，请在终端中查看或下载', 415);
    const maxBytes = kind === 'text' ? maxTextPreviewBytes : maxDocumentPreviewBytes;
    if (info.size > maxBytes) throw new RuntimeError('FILE_TOO_LARGE', `文件超过 ${kind === 'text' ? '1MB' : '20MB'} 预览上限（实际 ${info.size} 字节），请在终端中查看`, 415);
    const buffer = await readFile(resolved.absolute);
    if (kind === 'image' || kind === 'pdf') {
      reply.header('Content-Type', kind === 'pdf' ? 'application/pdf' : imageMimeForName(resolved.absolute) ?? 'application/octet-stream');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'private, max-age=60');
      return reply.send(buffer);
    }
    return { cwd: session.cwd, path: resolved.relative, size: info.size, content: buffer.toString('utf8') };
  });
}
