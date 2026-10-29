import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.AGENT_DOCK_SKIP_NATIVE_CHECK === '1') process.exit(0);

// 安装期体检：这台机器能不能加载 better-sqlite3 的原生产物。加载不了不阻断安装（运行时还有随包兜底），
// 但要在装的时候就告诉用户发生了什么、下一步是什么。判断逻辑与 src/native-compat.ts 保持一致。

const manifestCandidates = ['../vendor/native/better-sqlite3.json', '../dist/vendor/native/better-sqlite3.json'];

function isMusl() {
  try {
    return process.platform === 'linux' && !process.report?.getReport().header.glibcVersionRuntime;
  } catch {
    return false;
  }
}

function target() {
  return `${process.platform === 'linux' && isMusl() ? 'linuxmusl' : process.platform}-${process.arch}`;
}

function packagedFallback(home) {
  for (const candidate of manifestCandidates) {
    const file = resolve(home, candidate);
    try {
      if (!existsSync(file)) continue;
      const entry = JSON.parse(readFileSync(file, 'utf8')).targets?.[target()];
      if (!entry) continue;
      const path = resolve(dirname(file), entry.file);
      if (existsSync(path)) return { path, version: entry.version };
    } catch {
      continue;
    }
  }
  return undefined;
}

const home = dirname(fileURLToPath(import.meta.url));
if (process.platform === 'linux') {
  const require = createRequire(import.meta.url);
  let failure;
  let installed;
  try {
    installed = require('better-sqlite3/package.json').version;
  } catch {}
  try {
    // 必须真的 new 一个库：better-sqlite3 的 addon 是构造时才 dlopen 的，光 require 模块不会碰原生产物。
    new (require('better-sqlite3'))(':memory:');
  } catch (error) {
    failure = error;
  }
  if (failure) {
    const firstLine = String(failure.message).split('\n')[0];
    const fallback = packagedFallback(home);
    let hint;
    if (fallback && fallback.version === installed) {
      // 光"有产物"不够：在这台机器上真开一次库，装的时候就确认兜底能兜住。
      let usable = true;
      try {
        new (require('better-sqlite3'))(':memory:', { nativeBinding: fallback.path });
      } catch {
        usable = false;
      }
      hint = usable
        ? `已随包带适配老 glibc 的产物（better-sqlite3 ${fallback.version}）并验证可用，AgentDock 启动时会自动使用，无需额外操作。`
        : `随包带了适配老 glibc 的产物（${fallback.path}），但它在本机也加载失败，请把上面一行报错发给 AgentDock 维护者。`;
    } else {
      let dir;
      try {
        dir = dirname(require.resolve('better-sqlite3/package.json'));
      } catch {}
      hint = `本机没有匹配的随包产物（target=${target()}，已安装 ${installed ?? '未知'}）。`
        + (dir ? `可在这台机器上手工编译后重启 daemon：\n`
          + `  cd ${dir}\n`
          + `  rm -f prebuilds/${target()}.node\n`
          + "  sed -i 's/-std=c++20/-std=c++2a/' binding.gyp   # 仅 g++ 低于 10 时需要\n"
          + '  npx --yes node-gyp@9 rebuild --release' : '');
    }
    process.stdout.write(`[agent-dock] better-sqlite3 的原生产物在本机无法加载：${firstLine}\n`
      + '[agent-dock] 常见原因是宿主 glibc / libstdc++ 太旧（预编译产物要求 glibc ≥ 2.34、GLIBCXX ≥ 3.4.29；Debian 10 只有 glibc 2.28）。\n'
      + `[agent-dock] ${hint}\n`);
  }
}
