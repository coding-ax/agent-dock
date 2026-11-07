import { routerSystemPrompt } from './constants.js';
import { routerPromptForDecision } from './prompt.js';

export interface RouterDriver {
  readonly model?: string;
  decide(prompt: string): Promise<string>;
}

export interface RunOnceRuntime {
  runOnce(input: {
    agentId: string; cwd: string; prompt: string; agentPrompt?: string; model?: string;
    timeoutMs?: number; source?: string; sourceId?: string; archiveWhenDone?: boolean;
  }): Promise<{ text: string; status?: string; sessionId?: string; error?: string }>;
}

/** 通过现有 runtime 的 runOnce 借一个 Agent 做小模型判定，不常驻进程。 */
export function createRuntimeRouterDriver(runtime: RunOnceRuntime, options: { agentId: string; cwd: string; timeoutMs?: number; model?: string }): RouterDriver {
  return {
    model: options.model,
    async decide(prompt) {
      const result = await runtime.runOnce({
        agentId: options.agentId, cwd: options.cwd, prompt,
        agentPrompt: `${routerSystemPrompt}\n\n${prompt}`,
        ...(options.model ? { model: options.model } : {}),
        timeoutMs: options.timeoutMs ?? 30_000,
        source: 'router', sourceId: 'agentdock-sources-router', archiveWhenDone: true
      });
      if (result.status && result.status !== 'completed') throw new Error(`Router 判定轮次未成功完成：${result.error ?? result.status}`);
      return result.text;
    }
  };
}

export { routerPromptForDecision };
