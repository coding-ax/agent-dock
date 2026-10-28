import { createRequire } from 'node:module';

// 飞书 SDK 经本地补丁后内联为 dist/vendor/lark-sdk.cjs（见 build.mjs 与
// patches/@larksuiteoapi__node-sdk@*.patch：WS 重连次数上限 + 指数退避）。
// 走 CJS vendor 是因为 SDK 的 ESM 产物混入 require 与顶层 await，直接打进 ESM bundle 会触发
// ERR_AMBIGUOUS_MODULE_SYNTAX；而其依赖（axios/ws 等）在 CJS 下以 require 加载，保持 external 即可。
type LarkSdkModule = typeof import('@larksuiteoapi/node-sdk');
const localRequire = createRequire(import.meta.url);

const loadSdk = (): LarkSdkModule => {
  try {
    return localRequire('./vendor/lark-sdk.cjs');
  } catch (error) {
    // 仅允许「vendor 不存在」回退：tsx 开发环境下没有 dist/vendor，此时 workspace node_modules
    // 里的 SDK 已由 pnpm patch 打补丁，回退是安全的。
    // 其他错误（vendor 损坏、其 external 依赖解析失败）必须直接抛出：否则会静默改用未打补丁的
    // 原始 SDK，重连次数上限和指数退避整体失效，且没有任何告警，重新回到断网整夜刷日志的状态。
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
      && /vendor[\\/]lark-sdk/.test(String((error as NodeJS.ErrnoException).message ?? ''))) {
      return localRequire('@larksuiteoapi/node-sdk');
    }
    throw error;
  }
};
const sdk = loadSdk();

export const WSClient = sdk.WSClient;
export const EventDispatcher = sdk.EventDispatcher;
export const LoggerLevel = sdk.LoggerLevel;
export const registerApp = sdk.registerApp;
// 实例类型（构造器类型为 LarkSdkModule['WSClient']，此处取其实例形态供字段标注使用）。
export type WSClient = InstanceType<LarkSdkModule['WSClient']>;
export type EventDispatcher = InstanceType<LarkSdkModule['EventDispatcher']>;
