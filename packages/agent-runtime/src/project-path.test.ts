import { describe, expect, it } from 'vitest';
import { expandHome, resolveProjectPath, type ProjectPathFs } from './project-path.js';

const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const eacces = () => Object.assign(new Error('denied'), { code: 'EACCES' });

function fakeFs(overrides: Partial<ProjectPathFs> = {}): ProjectPathFs {
  return {
    async realpath(path) { return path; },
    async stat() { return { isDirectory: () => true }; },
    async access() {},
    ...overrides
  };
}

describe('项目路径归一化', () => {
  it('展开 ~ 与 ~/，其他波浪号原样保留', () => {
    expect(expandHome('~', '/Users/me')).toBe('/Users/me');
    expect(expandHome('~/code/app', '/Users/me')).toBe('/Users/me/code/app');
    expect(expandHome('~\\code\\app', 'C:\\Users\\me')).toBe('C:\\Users\\me\\code\\app');
    expect(expandHome('/tmp/~backup', '/Users/me')).toBe('/tmp/~backup');
  });

  it('resolve 后交给 realpath：macOS 的 /tmp 别名归一成 /private/tmp', async () => {
    const fs = fakeFs({ async realpath(path) { return path.replace(/^\/tmp\//, '/private/tmp/'); } });
    await expect(resolveProjectPath('/tmp/demo', { fs, home: '/Users/me' })).resolves.toBe('/private/tmp/demo');
  });

  it('接受 ~ 开头的绝对路径', async () => {
    await expect(resolveProjectPath('~/code/app', { fs: fakeFs(), home: '/Users/me' })).resolves.toBe('/Users/me/code/app');
  });
});

describe('项目路径四类错误', () => {
  it('空路径', async () => {
    await expect(resolveProjectPath('   ', { fs: fakeFs() })).rejects.toMatchObject({ code: 'PROJECT_PATH_REQUIRED', statusCode: 400 });
  });

  it('相对路径', async () => {
    await expect(resolveProjectPath('./project', { fs: fakeFs() })).rejects.toMatchObject({ code: 'PROJECT_PATH_NOT_ABSOLUTE', statusCode: 400 });
  });

  it('不存在', async () => {
    const fs = fakeFs({ async realpath() { throw enoent(); } });
    await expect(resolveProjectPath('/missing', { fs })).rejects.toMatchObject({ code: 'PROJECT_PATH_NOT_FOUND', statusCode: 404, message: expect.stringContaining('不存在') });
  });

  it('不是目录', async () => {
    const fs = fakeFs({ async stat() { return { isDirectory: () => false }; } });
    await expect(resolveProjectPath('/etc/hosts', { fs })).rejects.toMatchObject({ code: 'PROJECT_PATH_NOT_DIRECTORY', statusCode: 400, message: expect.stringContaining('不是文件夹') });
  });

  it('没有读取权限', async () => {
    const fs = fakeFs({ async access() { throw eacces(); } });
    await expect(resolveProjectPath('/private/secret', { fs })).rejects.toMatchObject({ code: 'PROJECT_PATH_NOT_READABLE', statusCode: 400, message: expect.stringContaining('读取权限') });
  });

  it('可读但不可写', async () => {
    let call = 0;
    const fs = fakeFs({ async access() { call++; if (call === 2) throw eacces(); } });
    await expect(resolveProjectPath('/readonly', { fs })).rejects.toMatchObject({ code: 'PROJECT_PATH_NOT_WRITABLE', statusCode: 400, message: expect.stringContaining('写入权限') });
  });
});
