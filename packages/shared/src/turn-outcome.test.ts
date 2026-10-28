import { describe, expect, it } from 'vitest';
import { agentWarningPrefix, hasUnresolvedToolCalls, isAgentStreamErrorText, isAgentWarningText, isTurnActivity, pickFinalAssistantEntry, pickFinalAssistantText, stripAgentStreamErrorSuffix, unresolvedToolCallsAfterAnswer } from './turn-outcome.js';

const text = (value: string, role: 'user' | 'assistant' = 'assistant') => ({ type: 'text', data: { role, text: value } });
const thinking = () => ({ type: 'thinking', data: { text: '…' } });
const toolCall = (id: string, status = 'running') => ({ type: 'tool_call', data: { id, status, name: 'bash' } });
const toolResult = (id: string, status = 'completed') => ({ type: 'tool_result', data: { id, status } });
const warning = (value = 'Skill descriptions were shortened to fit the skills context budget') => text(`Warning: ${value}`);

describe('isTurnActivity', () => {
  it('思考与工具调用算活动，文本与状态类事件不算', () => {
    expect(isTurnActivity(thinking())).toBe(true);
    expect(isTurnActivity(toolCall('a'))).toBe(true);
    expect(isTurnActivity(toolResult('a'))).toBe(true);
    for (const type of ['text', 'status', 'error', 'permission_request', 'completed']) {
      expect(isTurnActivity({ type, data: {} })).toBe(false);
    }
  });
});

describe('pickFinalAssistantEntry', () => {
  it('取最后一次活动之后的最后一条 assistant 文本', () => {
    const events = [text('开始处理'), toolCall('a'), toolResult('a'), text('最终结果')];
    expect(pickFinalAssistantEntry(events)?.data.text).toBe('最终结果');
  });

  it('活动之后再无文本时退化为末条文本——答案是真实存在的，不该报「未返回最终输出」', () => {
    // 线上实测（Trae / Codex 走网关）：Agent 会写完回答再执行收尾动作（飞书群里答完再
    // group send 一条），末尾没有新文本。严格规则取不到，但回答确实产出了——此时按
    // 「未返回最终输出」判失败，会让整轮被标红、卡片丢掉回答。
    const events = [text('我先跑个命令'), toolCall('a'), toolResult('a')];
    expect(pickFinalAssistantEntry(events)?.data.text).toBe('我先跑个命令');
  });

  it('文本之后卡着未返回结果的工具调用时不退化——那是说到一半去干活没回来', () => {
    // 「我先看一下文件」+ 一次没收口的调用：那句是开场白，不是回答，整轮仍按失败处理。
    expect(pickFinalAssistantEntry([text('我先看一下文件'), toolCall('a')])).toBeUndefined();
    expect(pickFinalAssistantEntry([text('我先看一下文件'), toolCall('a'), toolCall('a', 'running')])).toBeUndefined();
  });

  it('多条文本取最后一条', () => {
    expect(pickFinalAssistantEntry([text('草稿'), text('定稿')])?.data.text).toBe('定稿');
  });

  it('只有用户消息时没有最终输出', () => {
    expect(pickFinalAssistantEntry([text('帮我改个 bug', 'user')])).toBeUndefined();
    expect(pickFinalAssistantEntry([])).toBeUndefined();
  });

  it('error / status 等非活动事件不打断最终输出', () => {
    const events = [text('最终结果'), { type: 'status', data: {} }, { type: 'error', data: { message: 'x' } }];
    expect(pickFinalAssistantEntry(events)?.data.text).toBe('最终结果');
  });

  it('保留调用方条目的原始类型', () => {
    const traceEntry = { type: 'text' as const, data: { role: 'assistant', text: 'ok' }, timestamp: '2026-01-01T00:00:00.000Z' };
    expect(pickFinalAssistantEntry([traceEntry])?.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('pickFinalAssistantText', () => {
  it('把连续推送的 chunk 折成一条——这是 ACP 的实际推送方式', () => {
    // 线上实测：一句「平台 AI 已就绪。」被拆成六条事件，只取最后一条拿到的是一个句号。
    const events = [text('平台'), text(' AI'), text(' 已'), text('就'), text('绪'), text('。')];
    expect(pickFinalAssistantText(events)).toBe('平台 AI 已就绪。');
  });

  it('合并后仍保留 Markdown 表格的行换行', () => {
    const chunks = ['结论。\n\n', '| 步骤 | 结果 |\n', '|---|---|\n', '| 1 | 通过 |'];
    expect(pickFinalAssistantText(chunks.map(chunk => text(chunk)))).toBe(chunks.join(''));
  });

  it('只取最后一次活动之后的那一段', () => {
    const events = [text('我先跑个命令'), toolCall('a'), toolResult('a'), text('结果是'), text(' 42')];
    expect(pickFinalAssistantText(events)).toBe('结果是 42');
  });

  it('活动之后再无正文时退化为末条正文；整轮没有正文才返回空串', () => {
    expect(pickFinalAssistantText([text('我先跑个命令'), toolCall('a'), toolResult('a')])).toBe('我先跑个命令');
    expect(pickFinalAssistantText([])).toBe('');
    expect(pickFinalAssistantText([text('帮我改个 bug', 'user')])).toBe('');
    // 整轮只有思考与工具调用，一个字都没说：仍然算没有最终输出。
    expect(pickFinalAssistantText([thinking(), toolCall('a'), toolResult('a')])).toBe('');
  });

  it('Agent 自己吐的告警不算正文，也不并进答案', () => {
    expect(pickFinalAssistantText([warning(), text('答案')])).toBe('答案');
    // 告警落在答案中间也照样丢掉，不能把两段正文粘成一个词。
    expect(pickFinalAssistantText([text('前半'), warning(), text('后半')])).toBe('前半后半');
    // 整轮只有告警等于没有正文。
    expect(pickFinalAssistantText([warning()])).toBe('');
  });

  it('丢掉 cursor-agent 尾部的内部流错误，不并进最终输出', () => {
    const streamError = text('\n\nError: RetriableError: WritableIterable is closed');
    expect(pickFinalAssistantText([text('你好，有什么需要帮忙的？'), streamError])).toBe('你好，有什么需要帮忙的？');
    expect(pickFinalAssistantText([text('hi'), text('\n\nError: T: WritableIterable is closed')])).toBe('hi');
    expect(pickFinalAssistantText([text('答案\n\nError: RetriableError: WritableIterable is closed')])).toBe('答案');
    expect(pickFinalAssistantText([streamError])).toBe('');
  });

  it('状态类事件不打断同一条回答——它们可能落在两个 chunk 之间', () => {
    const events = [text('平台'), { type: 'status', data: { state: 'running' } }, text(' AI 已就绪。')];
    expect(pickFinalAssistantText(events)).toBe('平台 AI 已就绪。');
    const withError = [text('平台'), { type: 'error', data: { message: 'x' } }, text(' AI 已就绪。')];
    expect(pickFinalAssistantText(withError)).toBe('平台 AI 已就绪。');
  });

  it('用户消息仍然分隔两次回答', () => {
    const events = [text('第一轮'), text('补充一句', 'user'), text('第二轮')];
    expect(pickFinalAssistantText(events)).toBe('第二轮');
  });

  it('不改调用方传进来的事件对象', () => {
    const events = [text('平'), text('台')];
    pickFinalAssistantText(events);
    expect(events[0]!.data.text).toBe('平');
    expect(events[1]!.data.text).toBe('台');
  });

  it('折叠保留错误对象之外的其他字段（role / taskId）', () => {
    const events = [{ type: 'text', data: { role: 'assistant', taskId: 'task_1', text: '答' } }, { type: 'text', data: { role: 'assistant', taskId: 'task_1', text: '案' } }];
    const folded = pickFinalAssistantEntry(events);
    expect(folded?.data.taskId).toBe('task_1');
    expect(pickFinalAssistantText(events)).toBe('答案');
  });
});

describe('agent 告警识别', () => {
  it('只认开头（大小写与前后空白不敏感）', () => {
    expect(isAgentWarningText('Warning: 技能描述被裁剪')).toBe(true);
    expect(isAgentWarningText('  warning:  裁剪')).toBe(true);
    expect(isAgentWarningText('WARNING:裁剪')).toBe(true);
    // 正文里提到 Warning: 不算告警。
    expect(isAgentWarningText('日志里出现 Warning: 就忽略')).toBe(false);
    expect(isAgentWarningText('')).toBe(false);
    expect(agentWarningPrefix.test('Warning: x')).toBe(true);
  });
});

describe('cursor-agent 内部流错误识别', () => {
  it('只认整段以 Error: RetriableError: / Error: T: 开头的 chunk', () => {
    expect(isAgentStreamErrorText('\n\nError: RetriableError: WritableIterable is closed')).toBe(true);
    expect(isAgentStreamErrorText('Error: T: [resource_exhausted] Error')).toBe(true);
    expect(isAgentStreamErrorText('Error: RetriableError: [canceled] http/2 stream closed')).toBe(true);
    expect(isAgentStreamErrorText('排查一下 Error: RetriableError: WritableIterable is closed')).toBe(false);
    expect(isAgentStreamErrorText('')).toBe(false);
  });

  it('只剥正文末尾那一行，中间提到的原文不动', () => {
    expect(stripAgentStreamErrorSuffix('你好\n\nError: RetriableError: WritableIterable is closed')).toBe('你好');
    expect(stripAgentStreamErrorSuffix('正文里写了 Error: RetriableError: WritableIterable is closed 但后面还有结论')).toBe('正文里写了 Error: RetriableError: WritableIterable is closed 但后面还有结论');
    expect(stripAgentStreamErrorSuffix('普通回复')).toBe('普通回复');
    expect(stripAgentStreamErrorSuffix('表格标题\n\n')).toBe('表格标题\n\n');
    expect(stripAgentStreamErrorSuffix('\n| 步骤 | 结果 |\n')).toBe('\n| 步骤 | 结果 |\n');
  });
});

describe('hasUnresolvedToolCalls', () => {
  it('仍在执行的工具调用算未返回结果', () => {
    expect(hasUnresolvedToolCalls([toolCall('a', 'in_progress')])).toBe(true);
    expect(hasUnresolvedToolCalls([toolCall('a', 'pending')])).toBe(true);
    // tool_call 不带 status 时默认视为已开始执行。
    expect(hasUnresolvedToolCalls([{ type: 'tool_call', data: { id: 'a' } }])).toBe(true);
  });

  it('已完成的工具调用不算未返回结果', () => {
    expect(hasUnresolvedToolCalls([toolCall('a'), toolResult('a')])).toBe(false);
    expect(hasUnresolvedToolCalls([toolCall('a', 'completed')])).toBe(false);
    expect(hasUnresolvedToolCalls([])).toBe(false);
  });

  it('终态一旦出现就不再被迟到的乱序快照推翻', () => {
    // ACP 会对同一个 toolCallId 重复推送 tool_call_update，迟到的 running 只是旧快照。
    expect(hasUnresolvedToolCalls([toolCall('a', 'completed'), toolCall('a', 'running')])).toBe(false);
    expect(hasUnresolvedToolCalls([toolResult('a'), toolCall('a', 'in_progress')])).toBe(false);
    // 但从未出现过终态的调用仍然是未返回结果。
    expect(hasUnresolvedToolCalls([toolCall('a'), toolCall('a', 'running')])).toBe(true);
  });

  it('失败也是终态，不会被后续 running 翻回执行中', () => {
    expect(hasUnresolvedToolCalls([toolCall('a', 'failed'), toolCall('a', 'running')])).toBe(false);
  });

  it('未知状态不计入未解决，避免新增字面量把正常轮次判失败', () => {
    expect(hasUnresolvedToolCalls([toolCall('a', 'awaiting_approval')])).toBe(false);
  });

  it('状态大小写不敏感，缺失 id 的条目忽略', () => {
    expect(hasUnresolvedToolCalls([toolCall('a', 'IN_PROGRESS')])).toBe(true);
    expect(hasUnresolvedToolCalls([{ type: 'tool_call', data: { status: 'running' } }])).toBe(false);
  });

  it('多个工具调用只看各自最终状态', () => {
    expect(hasUnresolvedToolCalls([toolCall('a'), toolResult('a'), toolCall('b', 'in_progress')])).toBe(true);
  });
});

describe('unresolvedToolCallsAfterAnswer', () => {
  it('只有卡在最终输出之后的调用才算这一轮没结束', () => {
    // 线上实测（Trae / Codex 走网关）：偶发丢一次 tool_result，Agent 越过它继续调工具、
    // 继续作答，最后给出完整回答并 end_turn。老规则按「有一个没收口就判失败」，把这种
    // 有完整回答的轮次整轮标红。
    const midTurnLoss = [text('先看看目录'), toolCall('x'), text('继续查'), toolCall('z'), toolResult('z'), text('结论：没问题')];
    expect(unresolvedToolCallsAfterAnswer(midTurnLoss)).toEqual([]);
    // 回答之后才卡住的调用才是失败原因。
    const stuckAfterAnswer = [text('先跑了三条命令'), toolCall('z'), toolResult('z'), text('结论：没问题'), toolCall('y', 'in_progress')];
    expect(unresolvedToolCallsAfterAnswer(stuckAfterAnswer)).toEqual(['y']);
  });

  it('认不出最终输出时，未收口的调用全部算数', () => {
    // 整轮一个字都没说。
    expect(unresolvedToolCallsAfterAnswer([thinking(), toolCall('x'), toolCall('y', 'completed')])).toEqual(['x']);
    // 说完开场白就卡在工具上——那句不算回答，这一轮确实停在工具上。
    expect(unresolvedToolCallsAfterAnswer([text('我先看一下文件'), toolCall('x')])).toEqual(['x']);
  });

  it('调用之后迟到的终态会把它从名单里去掉', () => {
    // 调用在答案之前发出，结果在答案之后才回来：不构成失败原因。
    expect(unresolvedToolCallsAfterAnswer([text('跑一下'), toolCall('x'), toolResult('x')])).toEqual([]);
    // 卡在答案之后的调用，即便此前有过乱序的 running 快照，只要最终收了口就不算。
    expect(unresolvedToolCallsAfterAnswer([text('答完了'), toolCall('x'), toolCall('x', 'running'), toolResult('x')])).toEqual([]);
  });
});
