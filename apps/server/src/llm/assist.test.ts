import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories, type Repositories } from '@agent-dock/agent-dock-storage';
import { buildApp } from '../app.js';
import { LlmEndpointService } from './service.js';
import type { Fetch } from './client.js';
import {
  buildLlmAssistPrompt,
  clipAssistDraft,
  extractMustacheVariables,
  formatAssistContext,
  parseRegexAssistOutput,
  sanitizePlainAssistText,
  sanitizeTitleOutput
} from './assist.js';

const repositories: Repositories[] = [];
afterEach(() => { while (repositories.length) repositories.pop()!.close(); });

const validEndpoint = {
  format: 'openai-chat' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test-assist-secret',
  model: 'gpt-5'
};

function sseJsonResponse(content: string) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}

function createHarness(reply = '已优化的正文') {
  const repos = createRepositories(':memory:');
  repositories.push(repos);
  const fetcher = vi.fn<Fetch>(async () => sseJsonResponse(reply));
  const service = new LlmEndpointService({ config: repos.config, fetcher });
  return { repos, service, fetcher };
}

describe('LLM 文本辅助提示词与上下文注入', () => {
  it('提取并去重 {{var}} 模板变量', () => {
    expect(extractMustacheVariables('请检查 {{ 项目 }} 并运行 {{验证命令}}，然后复核 {{项目}}')).toEqual(['项目', '验证命令']);
  });

  it('prompt_write / prompt_optimize 注入完整场景上下文与变量保护铁律', () => {
    const built = buildLlmAssistPrompt({
      mode: 'prompt_optimize',
      text: '帮我查一下 {{项目}} 的日志并跑 {{验证命令}}',
      action: 'structure',
      instruction: '分步骤写清楚验收要求',
      context: {
        field: '提示词模板内容',
        purpose: '发布前自动巡检',
        variables: ['项目', '验证命令', '负责人'],
        cwd: '/Users/dev/app',
        agentName: 'Claude'
      }
    });
    expect(built.systemPrompt).toContain('{{项目}}');
    expect(built.systemPrompt).toContain('{{验证命令}}');
    expect(built.systemPrompt).toContain('{{负责人}}');
    expect(built.systemPrompt).toContain('严禁添加任何开场白');
    expect(built.systemPrompt).toContain('结构化展开');
    expect(built.prompt).toContain('提示词模板内容');
    expect(built.prompt).toContain('/Users/dev/app');
    expect(built.prompt).toContain('分步骤写清楚验收要求');
  });

  it('message_polish 强调保留斜杠命令与技术细节', () => {
    const built = buildLlmAssistPrompt({
      mode: 'message_polish',
      text: '/plan 这个接口偶尔 502 你帮我看下哪里超时了',
      action: 'concise',
      context: {
        field: '会话输入框',
        agentName: 'Codex',
        recentMessages: [
          { role: 'user', text: '上次我们改了 timeoutMs' },
          { role: 'assistant', text: '已调整到 30 秒' }
        ]
      }
    });
    expect(built.systemPrompt).toContain('/plan');
    expect(built.systemPrompt).toContain('极简提炼');
    expect(built.prompt).toContain('[user] 上次我们改了 timeoutMs');
    expect(built.prompt).toContain('[assistant] 已调整到 30 秒');
  });

  it('title_generate 要求单行简短无标点且注入会话摘要', () => {
    const built = buildLlmAssistPrompt({
      mode: 'title_generate',
      text: '',
      context: {
        sessionTitle: 'Claude',
        cwd: '/Users/dev/agent-dock',
        maxChars: 18,
        recentMessages: [{ role: 'user', text: '帮我把全站输入框都接上 AI 辅助写作并支持回撤' }]
      }
    });
    expect(built.systemPrompt).toContain('只输出唯一一行纯标题文本');
    expect(built.systemPrompt).toContain('18 个字符');
    expect(built.maxTokens).toBe(96);
    expect(built.prompt).toContain('全站输入框都接上 AI 辅助写作');
  });

  it('regex_generate 注入群名、正反示例并禁止 g 标志与 ReDoS', () => {
    const built = buildLlmAssistPrompt({
      mode: 'regex_generate',
      text: '',
      instruction: '匹配线上告警或 P0 故障播报',
      context: {
        field: '飞书群聊正则触发',
        groupName: '核心研发值班群',
        sampleMessages: ['【告警】支付服务 5xx 飙升', 'P0 故障：登录失败'],
        negativeSamples: ['今天中午吃什么']
      }
    });
    expect(built.systemPrompt).toContain('ReDoS');
    expect(built.systemPrompt).toContain('不要添加 g 标志');
    expect(built.systemPrompt).toContain('{"pattern":');
    expect(built.prompt).toContain('核心研发值班群');
    expect(built.prompt).toContain('支付服务 5xx 飙升');
    expect(built.prompt).toContain('今天中午吃什么');
  });

  it('description_polish 注入看板与卡片上下文', () => {
    const built = buildLlmAssistPrompt({
      mode: 'description_polish',
      text: '这个卡用来跟进登录白屏bug',
      context: {
        field: '卡片备注',
        boardName: '本周发布冲刺',
        columnName: '待验收',
        cards: ['登录白屏修复']
      }
    });
    expect(built.prompt).toContain('本周发布冲刺');
    expect(built.prompt).toContain('待验收');
    expect(built.prompt).toContain('登录白屏修复');
  });

  it('超长草稿按首尾截断并保留省略提示', () => {
    const longText = `HEAD-${'内容'.repeat(2_500)}-TAIL`;
    const clipped = clipAssistDraft(longText, 1_000);
    expect(clipped).toContain('HEAD-');
    expect(clipped).toContain('-TAIL');
    expect(clipped).toContain('中间省略');
    expect(clipped.length).toBeLessThan(1_060);
  });

  it('formatAssistContext 透传自定义扩展字段且忽略空值', () => {
    const text = formatAssistContext({ field: '测试框', customTag: 'release-v2', empty: '' });
    expect(text).toContain('测试框');
    expect(text).toContain('customTag：release-v2');
    expect(text).not.toContain('empty');
  });
});

describe('输出后处理与正则校验', () => {
  it('清理礼貌开场白与整段代码围栏，但不破坏正文内嵌代码块', () => {
    expect(sanitizePlainAssistText('好的，以下是为您优化后的提示词：\n\n```markdown\n请检查单元测试\n```')).toBe('请检查单元测试');
    const withInnerCode = '请先运行以下命令：\n```bash\npnpm test\n```\n然后整理结果。';
    expect(sanitizePlainAssistText(withInnerCode)).toBe(withInnerCode);
  });

  it('清理标题引号、Markdown 符号、编号与多行冗余', () => {
    expect(sanitizeTitleOutput('标题：「全站接入 LLM 辅助输入」\n备选：第二个标题')).toBe('全站接入 LLM 辅助输入');
    expect(sanitizeTitleOutput('### **排查飞书去重异常。**')).toBe('排查飞书去重异常');
    expect(sanitizeTitleOutput('1. 每日早报定时汇总')).toBe('每日早报定时汇总');
  });

  it('解析 JSON 正则结果并校验 JS RegExp 合法性', () => {
    const parsed = parseRegexAssistOutput('```json\n{"pattern":"(告警|P0|故障)","flags":"i","explanation":"匹配告警或 P0 故障消息"}\n```');
    expect(parsed).toEqual({
      pattern: '(告警|P0|故障)',
      flags: 'i',
      explanation: '匹配告警或 P0 故障消息'
    });
    expect(new RegExp(parsed.pattern, parsed.flags).test('线上 P0 故障')).toBe(true);
  });

  it('兼容 /pattern/flags 字面量兜底并去重过滤非法 flags', () => {
    const parsed = parseRegexAssistOutput('/(?:error|timeout)\\s+\\d+/iiz');
    expect(parsed.pattern).toBe('(?:error|timeout)\\s+\\d+');
    expect(parsed.flags).toBe('i');
  });

  it('拒绝非法语法正则和明显嵌套量词 ReDoS 正则', () => {
    expect(() => parseRegexAssistOutput('{"pattern":"[unclosed","flags":""}')).toThrow(/不合法/);
    expect(() => parseRegexAssistOutput('{"pattern":"(a+)+$","flags":""}')).toThrow(/回溯风险/);
  });
});

describe('POST /api/llm/assist 路由', () => {
  const mount = async (service?: LlmEndpointService) => buildApp({} as any, service ? { llm: { service } } : {});

  it('未配置 LLM 端点时返回 503 与友好提示，不触发上游请求', async () => {
    const { service, fetcher } = createHarness();
    const app = await mount(service);

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/assist',
      payload: { mode: 'message_polish', text: '帮我修一下登录报错' }
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('LLM_NOT_CONFIGURED');
    expect(res.json().error.message).toContain('模型端点');
    expect(fetcher).not.toHaveBeenCalled();

    // 确认向后兼容：/api/llm/complete 仍返回 409
    const completeRes = await app.inject({
      method: 'POST',
      url: '/api/llm/complete',
      payload: { prompt: 'hello' }
    });
    expect(completeRes.statusCode).toBe(409);
  });

  it('参数非法或缺少必要内容时返回 400', async () => {
    const { service, fetcher } = createHarness();
    const app = await mount(service);
    await app.inject({ method: 'PUT', url: '/api/llm', payload: validEndpoint });

    const badMode = await app.inject({
      method: 'POST',
      url: '/api/llm/assist',
      payload: { mode: 'unknown_mode', text: 'hi' }
    });
    expect(badMode.statusCode).toBe(400);
    expect(badMode.json().error.code).toBe('INVALID_ASSIST_INPUT');

    const emptyOptimize = await app.inject({
      method: 'POST',
      url: '/api/llm/assist',
      payload: { mode: 'prompt_optimize', text: '   ' }
    });
    expect(emptyOptimize.statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('已配置时注入 systemPrompt 与上下文，并返回清理后的干净正文', async () => {
    const { service, fetcher } = createHarness('好的，优化如下：\n\n请排查 {{项目}} 登录接口偶发 502 的根因，并补充回归测试。');
    const app = await mount(service);
    await app.inject({ method: 'PUT', url: '/api/llm', payload: validEndpoint });

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/assist',
      payload: {
        mode: 'prompt_optimize',
        text: '查下 {{项目}} 登录 502',
        context: { field: '提示词模板', variables: ['项目'] }
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      mode: 'prompt_optimize',
      text: '请排查 {{项目}} 登录接口偶发 502 的根因，并补充回归测试。',
      model: 'gpt-5',
      format: 'openai-chat'
    });

    const upstreamBody = JSON.parse((fetcher.mock.calls[0]![1] as RequestInit).body as string);
    expect(upstreamBody.messages[0].role).toBe('system');
    expect(upstreamBody.messages[0].content).toContain('{{项目}}');
    expect(upstreamBody.messages[1].role).toBe('user');
    expect(upstreamBody.messages[1].content).toContain('查下 {{项目}} 登录 502');
  });

  it('regex_generate 返回 { text, pattern, flags, explanation } 结构', async () => {
    const { service } = createHarness('{"pattern":"(线上告警|P0)","flags":"i","explanation":"匹配线上告警或 P0 关键字"}');
    const app = await mount(service);
    await app.inject({ method: 'PUT', url: '/api/llm', payload: validEndpoint });

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/assist',
      payload: {
        mode: 'regex_generate',
        instruction: '匹配线上告警或 P0 故障',
        context: { groupName: '研发群', sampleMessages: ['线上告警：磁盘满'] }
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      mode: 'regex_generate',
      text: '(线上告警|P0)',
      pattern: '(线上告警|P0)',
      flags: 'i',
      explanation: '匹配线上告警或 P0 关键字',
      model: 'gpt-5'
    });
  });

  it('title_generate 返回单行干净标题', async () => {
    const { service } = createHarness('《修复飞书群聊正则监听》');
    const app = await mount(service);
    await app.inject({ method: 'PUT', url: '/api/llm', payload: validEndpoint });

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/assist',
      payload: {
        mode: 'title_generate',
        context: {
          recentMessages: [{ role: 'user', text: '请帮我修复飞书群聊正则监听的重复触发问题' }]
        }
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe('修复飞书群聊正则监听');
  });
});
