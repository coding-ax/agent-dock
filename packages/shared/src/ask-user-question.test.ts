import { describe, expect, it } from 'vitest';
import {
  ASK_USER_QUESTION_XML_TAG,
  buildAskUserQuestionPromptGuidance,
  extractAskUserQuestionAnswerSearchText,
  extractTrailingAskUserQuestion,
  formatAskUserQuestionAnswerForAgent,
  maskProtectedMarkdown,
  parseAskUserQuestionAnswer,
  resolveAskUserQuestionEnabled,
  serializeAskUserQuestionAnswer,
  splitStreamingAskUserQuestion,
  summarizeAskUserQuestionAnswer
} from './ask-user-question.js';

describe('ask-user-question XML protocol', () => {
  it('extracts a trailing single-question single-select XML block with recommended option and descriptions', () => {
    const output = `我已经梳理完现有存储结构，下一步需要你拍板数据库方案。

<agentdock-ask-user-question id="db_choice" title="选择存储方案">
  <question id="q_db" multi="false" allow-other="true">
    <prompt>你希望使用哪种持久化后端？</prompt>
    <option value="sqlite" recommended="true" description="内置零运维，适合本地单机">SQLite</option>
    <option value="postgres" description="适合多节点部署">PostgreSQL</option>
  </question>
</agentdock-ask-user-question>
`;
    const extracted = extractTrailingAskUserQuestion(output);
    expect(extracted).not.toBeNull();
    expect(extracted!.proseText).toBe('我已经梳理完现有存储结构，下一步需要你拍板数据库方案。');
    expect(extracted!.spec).toEqual({
      id: 'db_choice',
      title: '选择存储方案',
      questions: [
        {
          id: 'q_db',
          prompt: '你希望使用哪种持久化后端？',
          multi: false,
          allowOther: true,
          options: [
            { value: 'sqlite', label: 'SQLite', description: '内置零运维，适合本地单机', recommended: true },
            { value: 'postgres', label: 'PostgreSQL', description: '适合多节点部署' }
          ]
        }
      ]
    });
  });

  it('supports multi-question, multi-select, XML entities, CDATA, and deterministic fallback ids', () => {
    const output = `<agentdock-ask-user-question title="发布确认 &amp; 选项">
  <description>请确认以下 2 项配置</description>
  <question multi="true" allow-other="false">
    <prompt><![CDATA[需要开启哪些模块（A & B）？]]></prompt>
    <option value="auth" recommended="true">鉴权 &amp; 审计</option>
    <option value="metrics">指标监控</option>
  </question>
  <question id="env" multi="false" allow-other="true" other-placeholder="输入自定义环境名">
    <prompt>目标发布环境？</prompt>
    <option value="staging" recommended="true">预发</option>
    <option value="prod" recommended="true">生产</option>
  </question>
</agentdock-ask-user-question>`;
    const extracted = extractTrailingAskUserQuestion(output);
    expect(extracted).not.toBeNull();
    expect(extracted!.proseText).toBe('');
    expect(extracted!.spec.id).toMatch(/^ask_[0-9a-f]{8}$/);
    expect(extracted!.spec.title).toBe('发布确认 & 选项');
    expect(extracted!.spec.description).toBe('请确认以下 2 项配置');
    expect(extracted!.spec.questions).toHaveLength(2);
    expect(extracted!.spec.questions[0]).toMatchObject({
      id: 'q1',
      prompt: '需要开启哪些模块（A & B）？',
      multi: true,
      allowOther: false,
      options: [
        { value: 'auth', label: '鉴权 & 审计', recommended: true },
        { value: 'metrics', label: '指标监控' }
      ]
    });
    // 单选模式最多保留 1 个 recommended
    expect(extracted!.spec.questions[1]!.options).toEqual([
      { value: 'staging', label: '预发', recommended: true },
      { value: 'prod', label: '生产' }
    ]);
    expect(extracted!.spec.questions[1]!.otherPlaceholder).toBe('输入自定义环境名');
  });

  it('strictly ignores XML inside fenced code blocks (``` and ~~~) and inline code', () => {
    const fencedBacktick = `这是一个协议示例：

\`\`\`xml
<agentdock-ask-user-question id="demo">
  <question id="q1">
    <prompt>示例问题</prompt>
    <option value="a">A</option>
  </question>
</agentdock-ask-user-question>
\`\`\``;
    expect(extractTrailingAskUserQuestion(fencedBacktick)).toBeNull();
    expect(splitStreamingAskUserQuestion(fencedBacktick, true)).toEqual({
      kind: 'none',
      proseText: fencedBacktick
    });

    const fencedTilde = `~~~xml
<agentdock-ask-user-question id="demo">
  <question id="q1"><prompt>示例</prompt><option value="a">A</option></question>
</agentdock-ask-user-question>
~~~`;
    expect(extractTrailingAskUserQuestion(fencedTilde)).toBeNull();

    const inlineCode = '你可以在末尾输出 `<agentdock-ask-user-question id="x"><question id="q1"><prompt>P</prompt><option value="a">A</option></question></agentdock-ask-user-question>`';
    expect(extractTrailingAskUserQuestion(inlineCode)).toBeNull();
  });

  it('ignores XML in the middle of output when followed by non-whitespace prose', () => {
    const mid = `<agentdock-ask-user-question id="mid">
  <question id="q1"><prompt>问题</prompt><option value="a">A</option></question>
</agentdock-ask-user-question>

上面只是示例，不是真正要你选。`;
    expect(extractTrailingAskUserQuestion(mid)).toBeNull();
  });

  it('handles code-fence discussion earlier AND a real trailing XML block at the very end', () => {
    const combined = `我们在代码里这样写示例：

\`\`\`xml
<agentdock-ask-user-question id="example_only">
  <question id="q0"><prompt>示例</prompt><option value="x">X</option></question>
</agentdock-ask-user-question>
\`\`\`

现在请确认你的真实偏好：

<agentdock-ask-user-question id="real_one" title="真实询问">
  <question id="q1"><prompt>采用哪套方案？</prompt><option value="v2" recommended="true">方案二</option></question>
</agentdock-ask-user-question>`;

    const extracted = extractTrailingAskUserQuestion(combined);
    expect(extracted).not.toBeNull();
    expect(extracted!.spec.id).toBe('real_one');
    expect(extracted!.proseText).toContain('```xml');
    expect(extracted!.proseText).toContain('现在请确认你的真实偏好：');
  });

  it('hides incomplete trailing XML during streaming without false-triggering on code fences or HTML tags', () => {
    const streamingOpen = '先看下这两个方案的区别。\n\n<agentdock-ask-user-question id="q1" title="部署策略">\n  <question id="a"><prompt>选哪';
    expect(splitStreamingAskUserQuestion(streamingOpen, true)).toEqual({
      kind: 'pending',
      proseText: '先看下这两个方案的区别。',
      partialTitle: '部署策略'
    });
    // 非流式下不隐藏未闭合片段
    expect(splitStreamingAskUserQuestion(streamingOpen, false)).toEqual({
      kind: 'none',
      proseText: streamingOpen
    });

    // 流式刚刚吐到 `<agentdock-ask`
    const partialPrefix = '请选一下：\n<agentdock-ask';
    expect(splitStreamingAskUserQuestion(partialPrefix, true)).toEqual({
      kind: 'pending',
      proseText: '请选一下：'
    });

    // 未闭合的 ```xml 代码块内不触发 pending
    const streamingCodeFence = '看这个示例：\n```xml\n<agentdock-ask-user-question id="demo">\n  <question>';
    expect(splitStreamingAskUserQuestion(streamingCodeFence, true)).toEqual({
      kind: 'none',
      proseText: streamingCodeFence
    });

    // 普通 HTML `<a` 或 `<article` 不触发 pending
    expect(splitStreamingAskUserQuestion('参考 <article', true).kind).toBe('none');
  });

  it('masks fenced blocks while preserving exact string length and newlines', () => {
    const src = 'a\n```xml\n<tag>\n```\nb';
    const masked = maskProtectedMarkdown(src);
    expect(masked.length).toBe(src.length);
    expect(masked.split('\n').length).toBe(src.split('\n').length);
    expect(masked).not.toContain('<tag>');
    expect(masked.startsWith('a\n')).toBe(true);
    expect(masked.endsWith('\nb')).toBe(true);
  });

  it('serializes, parses, and formats structured answer payloads cleanly', () => {
    const payload = {
      version: 1 as const,
      questionId: 'db_choice',
      title: '选择存储方案',
      source: 'lark' as const,
      answeredBy: '暮雪离歌',
      answeredAt: '2026-11-27T05:30:00.000Z',
      answers: [
        {
          questionId: 'q_db',
          prompt: '你希望使用哪种持久化后端？',
          selectedValues: ['sqlite'],
          selectedLabels: ['SQLite'],
          otherText: '开启 WAL 模式'
        }
      ]
    };

    const raw = serializeAskUserQuestionAnswer(payload);
    expect(parseAskUserQuestionAnswer(raw)).toEqual(payload);
    expect(parseAskUserQuestionAnswer('普通消息')).toBeNull();

    const forAgent = formatAskUserQuestionAnswerForAgent(payload);
    expect(forAgent).toContain('选择存储方案');
    expect(forAgent).toContain('飞书 · 暮雪离歌');
    expect(forAgent).toContain('你希望使用哪种持久化后端？');
    expect(forAgent).toContain('SQLite (sqlite)');
    expect(forAgent).toContain('自定义补充：开启 WAL 模式');

    expect(summarizeAskUserQuestionAnswer(payload)).toContain('SQLite');
    expect(extractAskUserQuestionAnswerSearchText(payload)).toContain('飞书');
    expect(buildAskUserQuestionPromptGuidance()).toContain(`<${ASK_USER_QUESTION_XML_TAG}`);
  });

  it('supports source="assistant" with responderName and responderSessionId', () => {
    const payload = {
      version: 1 as const,
      questionId: 'db_choice_cat',
      title: '选择存储方案',
      source: 'assistant' as const,
      answeredBy: '小A同学',
      responderName: '小A同学',
      responderSessionId: 'ses_main',
      answeredAt: '2026-11-28T02:10:00.000Z',
      answers: [
        {
          questionId: 'q1',
          prompt: '希望采用哪种持久化方案？',
          selectedValues: ['sqlite'],
          selectedLabels: ['SQLite'],
          otherText: '单机轻量零运维，开启 WAL 即可'
        }
      ]
    };

    const raw = serializeAskUserQuestionAnswer(payload);
    expect(parseAskUserQuestionAnswer(raw)).toEqual(payload);

    const forAgent = formatAskUserQuestionAnswerForAgent(payload);
    expect(forAgent).toContain('主会话小猫（小A同学）已代用户回答你刚才的询问「选择存储方案」');
    expect(forAgent).toContain('小猫代答 · 小A同学');
    expect(forAgent).toContain('SQLite (sqlite)');
    expect(forAgent).toContain('单机轻量零运维');
    expect(forAgent).toContain('请基于以上主会话代答的明确结论继续执行下一步');

    expect(summarizeAskUserQuestionAnswer(payload)).toContain('小猫已代答「选择存储方案」');
    const searchText = extractAskUserQuestionAnswerSearchText(payload);
    expect(searchText).toContain('小猫代答');
    expect(searchText).toContain('小A同学代答');
  });

  it('resolves session-level askUserQuestionEnabled override over global default consistently', () => {
    expect(resolveAskUserQuestionEnabled(undefined, true)).toBe(true);
    expect(resolveAskUserQuestionEnabled(null, true)).toBe(true);
    expect(resolveAskUserQuestionEnabled(undefined, false)).toBe(false);
    expect(resolveAskUserQuestionEnabled(null, false)).toBe(false);
    expect(resolveAskUserQuestionEnabled(false, true)).toBe(false);
    expect(resolveAskUserQuestionEnabled(true, false)).toBe(true);
    expect(resolveAskUserQuestionEnabled(undefined)).toBe(true);
  });
});
