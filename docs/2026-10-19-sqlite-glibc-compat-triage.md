# 2026-10-19 Debian 10 上 better-sqlite3 加载失败排查

结论：故障不在 AgentDock，也不在"版本太高"这一个维度。`better-sqlite3@13.0.3` 随包分发的 `prebuilds/linux-x64.node` 是在新工具链上编的，要求 glibc ≥ 2.34、libstdc++ ≥ GLIBCXX_3.4.29；Debian 10 只有 glibc 2.28、GCC 8（GLIBCXX_3.4.25），所以安装能成功、进程一打开数据库就 `ERR_DLOPEN_FAILED`。已在 `debian:10` 容器里端到端复现，并验证了一条可用的修复路径。

## 证据

复现环境：`debian:10`（amd64，Debian 10.13，`ldd` 报 `Debian GLIBC 2.28-10+deb10u3`）+ 官方 `node-v22.19.0-linux-x64`。Node 本体能正常启动，说明 glibc 2.28 够 Node 用，但不够这个原生依赖用。

```
$ npm i better-sqlite3@13.0.3        # 安装成功
$ node -e 'new (require("better-sqlite3"))(":memory:")'
Error: /lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.29' not found
       (required by .../prebuilds/linux-x64.node)
       /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.33' not found
       /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found
       /usr/lib/x86_64-linux-gnu/libstdc++.so.6: version `GLIBCXX_3.4.29' not found
  code: 'ERR_DLOPEN_FAILED'
```

同一容器里对照 `node-pty@1.2.0-beta.15` 的 `prebuilds/linux-x64/pty.node`：只需要 `GLIBC_2.28`，加载正常。所以这不是"Debian 10 什么原生模块都不行"，只有 SQLite 这一个包踩线。

`apps/server/src/service.ts` 启动时就会 `createRepositories()`，加载失败即进程退出，表现为 daemon 起不来。

## 为什么"每次更新都被覆盖"

`better-sqlite3@13` 相对 12.x 改了两处，正好都指向这个症状：

1. 去掉了 `"install": "prebuild-install || node-gyp rebuild"`，改成把 8 个平台的 `.node` 直接打进 npm 包。安装期不再有任何"下载失败就本地编译"的兜底。
2. `lib/binding.js` 的解析顺序是：先找 `prebuilds/<platform>-<arch>.node`，找到就 `require`；只有该文件不存在才回落 `build/Release/better_sqlite3.node`。

于是：手工编出来的 `build/Release` 会被自带的 prebuild 遮蔽；更新走的是 `npm install --global @agent-dock/cli@latest`，每次都重新解包，把同一个不可用的 prebuild 放回来。

## 降级不是解法

| 版本 | linux-x64 官方预编译要求 | Debian 10 可用？ |
| --- | --- | --- |
| 11.0.0 / 11.9.1 / 11.10.0 / 12.11.1 | GLIBC_2.29 | 否（2.28 差 0.0.1） |
| 13.0.0 / 13.0.3 | GLIBC_2.34 + GLIBCXX_3.4.29 | 否 |
| ≤ 9.6.0 | 没有 Node 22（ABI 127）产物，`prebuild-install` 失败后回落源码编译 | 编译路径另有两道坎 |

老版本的兜底源码编译在 Debian 10 上也走不通：镜像自带 python3.7，而 npm 内置的 node-gyp 11 的 gyp 用到海象运算符，需要 python ≥ 3.8，实测直接 `SyntaxError: invalid syntax`（`gyp ERR! configure error`）。

## 已验证的修复路径

在同一个 debian:10 容器里把 13.0.3 从源码编译，两处适配后编译成功：

1. `binding.gyp` 里 `-std=c++20` 放宽为 `-std=c++2a`（GCC 8 不认 `c++20` 这个别名，只认 `c++2a`）；源码本身在 C++17/2a 下能过，只有 warning。
2. 用 `node-gyp@9.4.0` 绕开 python3.7（npm 内置的 node-gyp 11 不行）。
3. 删掉 `prebuilds/linux-x64.node`，否则 `binding.js` 仍然优先加载 prebuild。

产物只要求 `GLIBC_2.28`，加载正常，`iterate()`、WAL、`sqlite_version()` 都是 3.53.4：

```
$ rm prebuilds/linux-x64.node && sed -i 's/-std=c++20/-std=c++2a/' binding.gyp
$ npx --yes node-gyp@9 rebuild --release
$ node -e '...'   # SQLITE OK {"a":42} 3.53.4
```

## 已实现的修法

Node 22 本体最低就要求 glibc 2.28，所以"用 glibc 2.28 基线编一份 `better_sqlite3.node`"在所有能跑 Node 22 的 Linux 机器上都通用，一份产物覆盖全部用户：

- `apps/server/scripts/build-sqlite-prebuild.mjs`（配 `scripts/sqlite-prebuild/{Dockerfile,build.sh,verify-baseline.py}`）在 `debian:10` 容器里按基线编译并校验符号，产物入库到 `apps/server/vendor/native/`，manifest 里记下对应版本；构建时 `build.mjs` 把它搬进 `dist/vendor/native/`。
- `packages/storage/src/native.ts`：`openDatabase()` 先走默认加载（新机器行为完全不变），只在 `ERR_DLOPEN_FAILED` 时用随包产物带 `nativeBinding` 重试一次。产物文件缺失或版本与已安装的 better-sqlite3 不一致就不用（避免 addon 与 JS 侧错配）；重试仍失败则抛原始错误，附中文诊断和可执行的手工编译命令。
- `apps/server/src/native-compat.ts`：按平台目标（glibc/musl 区分）解析随包产物，入口 `cli.ts` 启动时登记。
- `apps/server/scripts/check-native-compat.mjs`（挂在 postinstall）：装的时候就真开一次库体检，把"以后莫名启动失败"变成当时的明确提示；确认随包产物可用时不打扰用户。注意 better-sqlite3 的 addon 是**构造时**才 dlopen 的，光 `require` 模块不会暴露问题。
- 回归：`packages/storage/src/native.test.ts`、`apps/server/src/native-compat.test.ts`。

验收（本次）：

| 场景 | 结果 |
| --- | --- |
| 全量单测 / 类型检查 / 构建（macOS 开发机） | 101 文件 1090 例通过；typecheck 与 build 通过 |
| 沙箱 daemon（`dev up`，走默认加载路径） | UI 200、`/api/sessions` 正常、库正常创建；行为与改动前一致 |
| debian:10 容器装真实包 | postinstall 报出 `GLIBC_2.29 not found`，并确认随包产物可用 |
| debian:10 容器 `agent-dock session list` | 退出码 0，库建表成功（此前是 ERR_DLOPEN_FAILED 直接退出） |
| debian:10 容器 `agent-dock daemon start` | 启动成功、监听 4310、真实建库 |

尚未做：故障机（邹翔开发机）上的实机验证，见文末"尚需确认"。

## 备选（未采用）

换 `node:sqlite`（Node 22 内置、零原生依赖，实测 22.19 可用，`StatementSync.iterate()` 齐全）能从根上摆脱该问题，但 drizzle 0.44.2 没有对应驱动，改动集中在 `packages/storage`，属于中期项。不推荐换 libsql：虽然其预编译基线只有 GLIBC_2.18，但 drizzle 的 libsql 驱动是异步的，会把整条同步调用链改成 Promise。

## 故障机临时解法

更新前有效，下次 `npm install -g` 会被覆盖：

```bash
D=$(npm root -g)/@agent-dock/cli/node_modules/better-sqlite3
cd "$D" && rm prebuilds/linux-x64.node
sed -i 's/-std=c++20/-std=c++2a/' binding.gyp
npx --yes node-gyp@9 rebuild --release
agent-dock restart
```

## 尚需确认

故障机未直连验证。需要 `node -p "process.report.getReport().header.glibcVersionRuntime"`（预期 2.28）与 `ldd .../prebuilds/linux-x64.node` 的输出（预期上述四条 `not found`）；若不符，说明另有一条根因，不能按本文结论处理。
