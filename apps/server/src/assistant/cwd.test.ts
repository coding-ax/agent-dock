import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expandHomePath, resolveCwdArgument, validateCwd } from './cwd.js';

const directories: string[] = [];

const tempDir = (prefix = 'agentdock-cwd-') => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try { chmodSync(directory, 0o755); } catch { /* 已经删掉或本来就不可 chmod */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('task cwd resolution', () => {
  it('expands an explicit ~ to the CLI user home', () => {
    expect(expandHomePath('~')).toBe(homedir());
    expect(expandHomePath('~/work')).toBe(join(homedir(), 'work'));
    expect(expandHomePath('~someone/work')).toBe('~someone/work');
  });

  it('resolves a relative path against the invoking shell directory', () => {
    const base = tempDir();
    expect(resolveCwdArgument('projects/demo', base)).toBe(join(base, 'projects/demo'));
    expect(resolveCwdArgument('.', base)).toBe(base);
  });

  it('keeps spaces in paths intact', () => {
    const base = tempDir('agentdock cwd ');
    expect(resolveCwdArgument('work space', base)).toBe(join(base, 'work space'));
  });

  it('normalizes an existing absolute directory', () => {
    const directory = tempDir();
    mkdirSync(join(directory, 'nested'));
    expect(validateCwd(`${directory}/nested/..`)).toBe(directory);
  });

  it('rejects missing, non-directory, relative and inaccessible paths', () => {
    const directory = tempDir();
    expect(() => validateCwd(join(directory, 'missing'))).toThrow(/工作目录不存在/);
    const file = join(directory, 'file.txt');
    writeFileSync(file, 'x');
    expect(() => validateCwd(file)).toThrow(/工作目录不是文件夹/);
    expect(() => validateCwd('relative/path')).toThrow(/必须是绝对路径/);

    // root 不受目录权限限制，无法制造「不可访问」；CI 里如果以 root 跑就跳过这一条。
    if (process.getuid?.() !== 0) {
      const locked = join(directory, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        expect(() => validateCwd(locked)).toThrow(/工作目录不可访问/);
      } finally {
        chmodSync(locked, 0o755);
      }
    }
  });

  it('treats an empty value as inheriting the main session', () => {
    expect(validateCwd(undefined)).toBeUndefined();
    expect(validateCwd('   ')).toBeUndefined();
  });
});
