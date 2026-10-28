import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(serverRoot, '../..');
const webDist = resolve(workspaceRoot, 'apps/web/dist');
const publicDir = resolve(serverRoot, 'public');
const localRequire = createRequire(import.meta.url);
// 飞书 SDK 携带本地补丁（patches/@larksuiteoapi__node-sdk@*.patch：WS 重连次数上限 + 指数退避）。
// pnpm patch 只在本 workspace 生效，全局安装的用户会拿到未打补丁的 SDK，因此补丁必须随包分发。
// 方案：把已打补丁的 SDK 单独打成 dist/vendor/lark-sdk.cjs（CJS 格式，axios/ws 等依赖保持
// external，在全局扁平化 node_modules 下可正常 require），业务代码通过 src/lark/sdk.ts 加载它。
// 不能直接打进 ESM 主 bundle：SDK 产物混用 require 与顶层 await，会触发模块格式冲突。
const larkSdkEntry = join(dirname(localRequire.resolve('@larksuiteoapi/node-sdk/package.json')), 'lib', 'index.js');
const aliases = new Map([
  ['acpx/runtime', fileURLToPath(import.meta.resolve('acpx/runtime'))],
  ['@agent-dock/agent-dock-acp-client', 'packages/acp-client/src/index.ts'],
  ['@agent-dock/agent-dock-config', 'packages/config/src/index.ts'],
  ['@agent-dock/agent-dock-runtime', 'packages/agent-runtime/src/index.ts'],
  ['@agent-dock/agent-dock-shared', 'packages/shared/src/index.ts'],
  ['@agent-dock/agent-dock-storage', 'packages/storage/src/index.ts'],
  ['@agent-dock/agent-dock-transports', 'packages/transports/src/index.ts']
]);

rmSync(resolve(serverRoot, 'dist'), { recursive: true, force: true });
if (!existsSync(resolve(webDist, 'index.html'))) throw new Error('Web UI is not built. Run pnpm --dir apps/web build first.');
rmSync(publicDir, { recursive: true, force: true });
cpSync(webDist, publicDir, { recursive: true });
await build({
  entryPoints: [resolve(serverRoot, 'src/cli.ts')],
  outfile: resolve(serverRoot, 'dist/cli.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  plugins: [{
    name: 'agent-dock-workspace',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^(?:acpx\/runtime|@agent-dock\/agent-dock-)/ }, args => {
        const target = aliases.get(args.path);
        return target ? { path: isAbsolute(target) ? target : resolve(workspaceRoot, target) } : undefined;
      });
    }
  }]
});

// 单独把打补丁的飞书 SDK 打成 CJS vendor。SDK 的依赖（axios/ws/protobufjs/qs 等）保持 external：
// 它们会从安装后的顶层 node_modules 解析。业务侧通过 src/lark/sdk.ts 加载该 vendor。
const vendorDir = resolve(serverRoot, 'dist', 'vendor');
mkdirSync(vendorDir, { recursive: true });
await build({
  entryPoints: [larkSdkEntry],
  outfile: resolve(vendorDir, 'lark-sdk.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  packages: 'external'
});
// 老 glibc 基线编译的原生兜底产物（见 packages/storage/src/native.ts）：由
// scripts/build-sqlite-prebuild.mjs 用 debian:10 容器生成并入库，构建时原样搬进 dist。
const nativeVendor = resolve(serverRoot, 'vendor/native');
if (existsSync(nativeVendor)) cpSync(nativeVendor, resolve(vendorDir, 'native'), { recursive: true });
const agentsDir = resolve(serverRoot, 'dist/agents');
mkdirSync(agentsDir, { recursive: true });
cpSync(resolve(workspaceRoot, 'packages/acp-client/agents/claude-acp.mjs'), resolve(agentsDir, 'claude-acp.mjs'));
cpSync(resolve(workspaceRoot, 'packages/acp-client/agents/codex-acp.mjs'), resolve(agentsDir, 'codex-acp.mjs'));
const assetsDir = resolve(serverRoot, 'dist/assets');
mkdirSync(assetsDir, { recursive: true });
cpSync(resolve(serverRoot, 'src/lark/assets/agentdock-bouncing-ball.webp'), resolve(assetsDir, 'agentdock-bouncing-ball.webp'));
cpSync(resolve(serverRoot, 'src/lark/assets/SVG-SPINNERS-LICENSE.txt'), resolve(assetsDir, 'SVG-SPINNERS-LICENSE.txt'));
