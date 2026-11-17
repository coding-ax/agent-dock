import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { RuntimeError } from '@agent-dock/agent-dock-shared';

/**
 * 项目导入的路径校验。
 *
 * 只做「登记一个工作目录」需要的检查，不在这里执行任何命令。路径会先展开 `~`、
 * 再 resolve 成绝对路径，最后 realpath——macOS 上 `/tmp`、`/etc`、`/var` 都是
 * `/private/*` 的别名，realpath 之后同一目录才会得到同一个 id，重复导入才能去重。
 */
export type ProjectPathFs = {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  access(path: string, mode?: number): Promise<void>;
};

const defaultFs: ProjectPathFs = { realpath, stat, access };

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;

export function expandHome(input: string, home = homedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~\\')) return `${home}${input.slice(1)}`;
  return input;
}

export async function resolveProjectPath(raw: unknown, options: { fs?: ProjectPathFs; home?: string } = {}): Promise<string> {
  const fs = options.fs ?? defaultFs;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new RuntimeError('PROJECT_PATH_REQUIRED', '请输入项目路径', 400);
  const expanded = expandHome(text, options.home);
  if (!isAbsolute(expanded)) {
    throw new RuntimeError('PROJECT_PATH_NOT_ABSOLUTE', '请填写绝对路径（例如 /Users/you/code 或 C:\\code；可用 ~ 表示主目录）', 400);
  }
  let real: string;
  try {
    real = await fs.realpath(resolve(expanded));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new RuntimeError('PROJECT_PATH_NOT_FOUND', `项目路径不存在：${text}`, 404);
    }
    throw new RuntimeError('PROJECT_PATH_NOT_READABLE', `没有权限访问该路径：${text}`, 400);
  }
  let info: { isDirectory(): boolean };
  try {
    info = await fs.stat(real);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new RuntimeError('PROJECT_PATH_NOT_FOUND', `项目路径不存在：${text}`, 404);
    }
    throw new RuntimeError('PROJECT_PATH_NOT_READABLE', `没有权限访问该路径：${text}`, 400);
  }
  if (!info.isDirectory()) {
    throw new RuntimeError('PROJECT_PATH_NOT_DIRECTORY', `该路径不是文件夹：${text}`, 400);
  }
  try {
    await fs.access(real, constants.R_OK);
  } catch {
    throw new RuntimeError('PROJECT_PATH_NOT_READABLE', `没有读取权限：${text}`, 400);
  }
  try {
    await fs.access(real, constants.W_OK);
  } catch {
    throw new RuntimeError('PROJECT_PATH_NOT_WRITABLE', `没有写入权限：${text}`, 400);
  }
  return real;
}
