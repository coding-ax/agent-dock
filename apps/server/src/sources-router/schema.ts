import { z } from 'zod';
import { routerDecisions, type RouterDecision } from './types.js';

export const routerDecisionSchema = z.object({
  decision: z.enum(routerDecisions),
  caseId: z.string().min(1).optional(),
  session: z.object({
    mode: z.enum(['reuse', 'create']),
    sessionId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).optional()
  }).strict().optional(),
  task: z.object({ prompt: z.string().min(1), mode: z.enum(['queue', 'interrupt']).default('queue') }).strict().optional(),
  watch: z.object({
    on: z.array(z.string().min(1)).default([]),
    until: z.string().datetime().optional(),
    timeoutMinutes: z.number().int().positive().optional()
  }).strict().optional(),
  reply: z.object({ action: z.string().min(1), target: z.string().min(1), body: z.string().optional() }).strict().optional(),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  decisionSource: z.enum(['rule', 'router', 'fallback']).optional(),
  throttled: z.boolean().optional()
}).strict();

const stripFences = (text: string) => text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

/** 从模型文本里取一个 JSON 对象：一次直接解析，失败后再截首尾大括号修复一次。 */
export function parseRouterDecision(text: string): { decision?: RouterDecision; error?: string; repaired: boolean } {
  const direct = stripFences(text);
  const candidates = [direct];
  const start = direct.indexOf('{');
  const end = direct.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(direct.slice(start, end + 1));
  for (const [index, candidate] of candidates.entries()) {
    try {
      const parsed = routerDecisionSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return { decision: parsed.data as RouterDecision, repaired: index > 0 };
      return { error: parsed.error.issues[0]?.message ?? '决策 JSON 校验失败', repaired: index > 0 };
    } catch {
      if (index === candidates.length - 1) return { error: '决策不是合法 JSON', repaired: index > 0 };
    }
  }
  return { error: '决策不是合法 JSON', repaired: false };
}
