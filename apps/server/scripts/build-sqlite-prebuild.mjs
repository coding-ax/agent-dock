#!/usr/bin/env node
// 重新生成 better-sqlite3 的老 glibc 基线兜底产物（用途见 packages/storage/src/native.ts 与
// docs/2026-10-19-sqlite-glibc-compat-triage.md）。
//
// 什么时候必须重跑：apps/server 里 better-sqlite3 的版本一变（产物与版本强绑定，storage 侧会校验，
// 不匹配就不启用兜底）。生成结果入库到 apps/server/vendor/native/，构建时被 build.mjs 搬进 dist/vendor。
//
// 用法（需要本机有 docker，macOS 上先 `colima start`）：
//   node apps/server/scripts/build-sqlite-prebuild.mjs                 # 只编 linux-x64
//   node apps/server/scripts/build-sqlite-prebuild.mjs --target linux-arm64
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(scriptsDir, '..');
const recipeDir = join(scriptsDir, 'sqlite-prebuild');
const vendorDir = join(serverRoot, 'vendor/native');
const manifestFile = join(vendorDir, 'better-sqlite3.json');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const target = arg('target', 'linux-x64');
const nodeVersion = arg('node', '22.19.0');
const registry = arg('registry', 'https://registry.npmjs.org/');
const targetMatch = /^(linux|linuxmusl|darwin|win32)-(x64|arm64)$/.exec(target);
if (!targetMatch) throw new Error(`不支持的 target：${target}（形如 linux-x64）`);
if (targetMatch[1] !== 'linux') throw new Error('兜底产物只针对 Linux 的老 glibc 机器，其他平台走上游预编译产物');
const [, , targetArch] = targetMatch;

const packageJson = JSON.parse(readFileSync(join(serverRoot, 'package.json'), 'utf8'));
const version = packageJson.dependencies?.['better-sqlite3'];
if (!version || /[\^~*]/.test(version)) throw new Error(`apps/server 里 better-sqlite3 必须是精确版本，当前是 ${version}`);

const dockerPlatform = `linux/${targetArch === 'x64' ? 'amd64' : 'arm64'}`;
const imageTag = `agentdock-sqlite-prebuild:${version}-${target}`;
const outputDir = join(vendorDir, target);
mkdirSync(outputDir, { recursive: true });

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });

console.log(`[prebuild] better-sqlite3@${version} / ${target} / ${dockerPlatform} / node ${nodeVersion}`);
run('docker', ['build', '--platform', dockerPlatform, '-t', imageTag,
  '--build-arg', `NODE_VERSION=${nodeVersion}`,
  '--build-arg', `NODE_ARCH=${targetArch}`,
  '-f', join(recipeDir, 'Dockerfile'), recipeDir]);
// 产物直接挂载到 vendor 目录下：容器里编完就落库，不经过宿主机临时文件。
run('docker', ['run', '--rm', '--platform', dockerPlatform,
  '-v', `${outputDir}:/out`,
  '-v', `${recipeDir}:/scripts:ro`,
  '-e', `BS3_VERSION=${version}`,
  '-e', `TARGET=${target}`,
  '-e', `REGISTRY=${registry}`,
  imageTag, 'sh', '/scripts/build.sh']);

const manifest = readFileSync(manifestFile, 'utf8');
const parsed = JSON.parse(manifest);
parsed.targets = {
  ...parsed.targets,
  [target]: {
    file: `${target}/better_sqlite3.node`,
    version,
    requires: { glibc: '2.28', 'libstdc++': '3.4.25' },
    builtFrom: `debian:10 + g++ 8.3 (-std=c++2a) + node-gyp 9.4.0 + node ${nodeVersion}`,
    builtAt: new Date().toISOString().slice(0, 10)
  }
};
parsed.targets = Object.fromEntries(Object.entries(parsed.targets).sort());
writeFileSync(manifestFile, `${JSON.stringify(parsed, null, 2)}\n`);
console.log(`[prebuild] 已更新 ${manifestFile}`);
