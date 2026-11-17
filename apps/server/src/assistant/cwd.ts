import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { RuntimeError } from '@agent-dock/agent-dock-shared';

/** 展开用户显式写出的 `~` / `~/...`；shell 没展开（例如加了引号）时也按用户本意处理。 */
export function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return resolve(homedir(), trimmed.slice(2));
  return trimmed;
}

/**
 * CLI 侧解析 `--cwd`：相对路径必须按调用者当前 shell 目录展开，而不是 daemon 的 cwd。
 * 返回归一化后的绝对路径。
 */
export function resolveCwdArgument(value: string, base = process.cwd()): string {
  return resolve(base, expandHomePath(value));
}

/**
 * daemon 侧校验工作目录：只接受绝对路径，且必须存在、是目录、可读可进入。
 * 返回归一化后的绝对路径；空值表示没有显式指定，由调用方继承主会话。
 */
export function validateCwd(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const expanded = expandHomePath(trimmed);
  if (!isAbsolute(expanded)) {
    throw new RuntimeError('INVALID_TASK_CWD', `工作目录必须是绝对路径：${trimmed}`, 400);
  }
  const absolute = resolve(expanded);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    throw new RuntimeError('INVALID_TASK_CWD', `工作目录不存在：${absolute}`, 400);
  }
  if (!stats.isDirectory()) {
    throw new RuntimeError('INVALID_TASK_CWD', `工作目录不是文件夹：${absolute}`, 400);
  }
  try {
    accessSync(absolute, constants.R_OK | constants.X_OK);
  } catch {
    throw new RuntimeError('INVALID_TASK_CWD', `工作目录不可访问（需要读和执行权限）：${absolute}`, 400);
  }
  return absolute;
}
