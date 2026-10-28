import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeTarget, packagedNativeFallback, readNativeManifest } from './native-compat.js';

const dependencies = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }).dependencies;

describe('随包的原生兜底产物', () => {
  it('manifest 带着 linux-x64 产物，且编它的版本与当前依赖一致', () => {
    const found = readNativeManifest();
    expect(found, '缺少 vendor/native/better-sqlite3.json，构建脚本没跑过？').toBeDefined();
    const entry = found!.manifest.targets['linux-x64'];
    expect(entry, '缺少 linux-x64 产物：跑 node apps/server/scripts/build-sqlite-prebuild.mjs').toBeDefined();
    // 版本不一致时 storage 会拒绝启用兜底，等于白带一份 2MB 的产物。
    expect(entry!.version).toBe(dependencies['better-sqlite3']);
    expect(existsSync(resolve(found!.dir, entry!.file))).toBe(true);
  });

  it('按机器目标取产物，没编过的平台返回 undefined', () => {
    const x64 = packagedNativeFallback('linux-x64');
    expect(x64?.version).toBe(dependencies['better-sqlite3']);
    expect(x64?.path.endsWith('linux-x64/better_sqlite3.node')).toBe(true);
    expect(packagedNativeFallback('linux-arm64')).toBeUndefined();
    expect(packagedNativeFallback('linuxmusl-x64')).toBeUndefined();
  });

  it('开发机（darwin）不启用兜底：默认加载路径完全不变', () => {
    expect(packagedNativeFallback(nativeTarget('darwin', process.arch, false))).toBeUndefined();
  });

  it('目标三元组：linux 区分 glibc / musl，与 better-sqlite3 的 prebuilds 命名对齐', () => {
    expect(nativeTarget('linux', 'x64', false)).toBe('linux-x64');
    expect(nativeTarget('linux', 'x64', true)).toBe('linuxmusl-x64');
    expect(nativeTarget('darwin', 'arm64', false)).toBe('darwin-arm64');
  });
});
