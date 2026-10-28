import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureNativeFallback, installedBetterSqlite, openDatabase } from './native.js';

const localRequire = createRequire(import.meta.url);
const installed = installedBetterSqlite();
/** 当前平台真实存在的 addon，用来在测试里充当"可用的兜底产物"。 */
const realBinding = installed
  ? join(installed.dir, 'prebuilds', `${process.platform === 'linux' && !hasGlibc() ? 'linuxmusl' : process.platform}-${process.arch}.node`)
  : undefined;

function hasGlibc(): boolean {
  return Boolean(process.report?.getReport().header.glibcVersionRuntime);
}

/** 与真机一致的失败形状：dlopen 失败（glibc 符号不够时报的就是这个码）。 */
const dlopenFailure = (message = "libc.so.6: version `GLIBC_2.34' not found") => Object.assign(new Error(message), { code: 'ERR_DLOPEN_FAILED' });

afterEach(() => configureNativeFallback(undefined));

describe('原生 SQLite 加载兜底', () => {
  it('默认能加载时不碰兜底产物', () => {
    const calls: (Database.Options | undefined)[] = [];
    const db = openDatabase(':memory:', { fallback: { path: '/nope.node', version: '0' }, create: options => {
      calls.push(options);
      return new Database(':memory:', options);
    } });
    try {
      expect(calls).toEqual([undefined]);
      expect(db.prepare('select 1 as v').get()).toEqual({ v: 1 });
    } finally { db.close(); }
  });

  it('兜底产物存在且版本一致时，带 nativeBinding 重试并成功', () => {
    expect(realBinding && existsSync(realBinding), `测试环境缺少真实 addon：${realBinding}`).toBe(true);
    const calls: (Database.Options | undefined)[] = [];
    const db = openDatabase(':memory:', {
      fallback: { path: realBinding!, version: installed!.version },
      create: options => {
        calls.push(options);
        if (calls.length === 1) throw dlopenFailure();
        return new Database(':memory:', options);
      }
    });
    try {
      expect(calls).toEqual([undefined, { nativeBinding: realBinding }]);
      expect(db.prepare('select 2 as v').get()).toEqual({ v: 2 });
    } finally { db.close(); }
  });

  it('版本不一致就不用兜底：宁可报原始错误，也不拿别的版本的 addon 硬顶', () => {
    const calls: number[] = [];
    expect(() => openDatabase(':memory:', {
      fallback: { path: realBinding!, version: '0.0.1' },
      create: options => { calls.push(1); throw dlopenFailure(); }
    })).toThrow(/原生产物无法加载[\s\S]*GLIBC_2\.34/);
    expect(calls).toHaveLength(1);
  });

  it('兜底产物文件缺失时同样不重试，并说明原因', () => {
    const calls: number[] = [];
    let message = '';
    try {
      openDatabase(':memory:', { fallback: { path: '/definitely/missing.node', version: installed?.version ?? '1' }, create: () => { calls.push(1); throw dlopenFailure(); } });
    } catch (error) { message = (error as Error).message; }
    expect(calls).toHaveLength(1);
    expect(message).toContain('兜底产物不适用');
    expect(message).toContain('/definitely/missing.node');
    // 诊断要给出可执行的处置：指向实际安装的包目录与手工编译命令
    expect(message).toContain(installed!.dir);
    expect(message).toContain('node-gyp@9 rebuild --release');
  });

  it('兜底也加载失败时，抛出的仍是原始错误（附已尝试说明）', () => {
    let message = '';
    try {
      openDatabase(':memory:', {
        fallback: { path: realBinding!, version: installed!.version },
        create: () => { throw dlopenFailure(); }
      });
    } catch (error) { message = (error as Error).message; }
    expect(message).toContain("version `GLIBC_2.34' not found");
    expect(message).toContain('已尝试随包兜底产物');
    expect(message).toContain('better-sqlite3 的原生产物无法加载');
  });

  it('不是原生加载失败的错误不接管（库损坏、只读这些重试没有意义）', () => {
    const error = Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' });
    expect(() => openDatabase(':memory:', { fallback: { path: realBinding!, version: installed!.version }, create: () => { throw error; } })).toThrow(error);
  });

  it('入口登记的兜底产物对所有 createRepositories 调用生效', () => {
    configureNativeFallback({ path: realBinding!, version: installed!.version });
    const calls: (Database.Options | undefined)[] = [];
    const db = openDatabase(':memory:', {
      create: options => {
        calls.push(options);
        if (calls.length === 1) throw dlopenFailure();
        return new Database(':memory:', options);
      }
    });
    try {
      expect(calls[1]).toEqual({ nativeBinding: realBinding });
    } finally { db.close(); }
  });
});

describe('已安装依赖的解析', () => {
  it('拿得到真实版本与目录', () => {
    expect(installed?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(installed?.dir).toBe(dirname(localRequire.resolve('better-sqlite3/package.json')));
  });
});
