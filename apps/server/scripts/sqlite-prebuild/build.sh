#!/bin/sh
# 在 debian:10（glibc 2.28 基线）里编译 better-sqlite3 的原生 addon，产出给老 glibc 机器用的兜底产物。
# 由 build-sqlite-prebuild.mjs 在容器里执行；入参 BS3_VERSION / TARGET / REGISTRY，产物写到 /out/better_sqlite3.node。
set -eu

echo "[build] node $(node -v)，g++ $(g++ -dumpversion)，$(python3 -V 2>&1)"

# buster 只有 python3.7，而 npm 内置的 node-gyp 11 的 gyp 需要 py3.8+（用了海象运算符），
# 所以这里固定用 node-gyp 9 编译。
npm install --global node-gyp@9.4.0 >/dev/null 2>&1

mkdir -p /work && cd /work
npm init -y >/dev/null 2>&1
npm config set registry "$REGISTRY"
npm install "better-sqlite3@$BS3_VERSION" --no-audit --no-fund >/dev/null 2>&1

cd node_modules/better-sqlite3
# 1) 删掉自带的预编译产物：binding.js 优先加载它，留着一辈子轮不到我们编的 build/Release。
rm -f "prebuilds/$TARGET.node"
# 2) GCC 8 不认 -std=c++20 这个别名（只认 c++2a）。源码本身在 C++17/2a 下能过，只有 warning。
sed -i 's/-std=c++20/-std=c++2a/g' binding.gyp
node-gyp rebuild --release >/tmp/node-gyp.log 2>&1 || { tail -40 /tmp/node-gyp.log; exit 1; }

python3 /scripts/verify-baseline.py build/Release/better_sqlite3.node
cp build/Release/better_sqlite3.node /out/better_sqlite3.node
echo "[build] 产出 better-sqlite3@$(node -p "require('./package.json').version") / $TARGET"
