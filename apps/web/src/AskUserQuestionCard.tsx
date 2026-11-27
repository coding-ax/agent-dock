import { memo, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Globe2,
  MessageCircleQuestion,
  PenLine,
  Send,
  Sparkles
} from 'lucide-react';
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionAnswerPayload,
  AskUserQuestionItem,
  AskUserQuestionSpec
} from '@agent-dock/agent-dock-shared';
import { Disclosure } from './Disclosure';
import { Spinner } from './Loaders';
import { UserMessageTime } from './SendTimeHint';

interface QuestionDraftState {
  selectedValues: string[];
  otherSelected: boolean;
  otherText: string;
}

type DraftMap = Record<string, QuestionDraftState>;

function initialDrafts(spec: AskUserQuestionSpec): DraftMap {
  const result: DraftMap = {};
  for (const question of spec.questions) {
    result[question.id] = {
      selectedValues: [],
      otherSelected: question.options.length === 0 && question.allowOther,
      otherText: ''
    };
  }
  return result;
}

function isQuestionAnswered(question: AskUserQuestionItem, draft: QuestionDraftState | undefined): boolean {
  if (!draft) return false;
  if (draft.selectedValues.length > 0) return true;
  if (question.allowOther && draft.otherSelected && draft.otherText.trim().length > 0) return true;
  return false;
}

function buildSubmittedAnswers(spec: AskUserQuestionSpec, drafts: DraftMap): AskUserQuestionAnswerItem[] {
  return spec.questions.map(question => {
    const draft = drafts[question.id] ?? { selectedValues: [], otherSelected: false, otherText: '' };
    const optionMap = new Map(question.options.map(opt => [opt.value, opt.label]));
    const selectedValues = draft.selectedValues.filter(value => optionMap.has(value));
    const selectedLabels = selectedValues.map(value => optionMap.get(value)!);
    const otherText = question.allowOther && draft.otherSelected ? draft.otherText.trim() : '';
    return {
      questionId: question.id,
      prompt: question.prompt,
      selectedValues,
      selectedLabels,
      ...(otherText ? { otherText } : {})
    };
  });
}

/** 来源徽标（网页端 / 飞书），用于询问卡片已答态与特殊问答回复卡片统一呈现。 */
function SourceBadge({ source, answeredBy }: { source: 'web' | 'lark'; answeredBy?: string }) {
  const isLark = source === 'lark';
  const label = isLark
    ? (answeredBy?.trim() ? `飞书 · ${answeredBy.trim()}` : '飞书')
    : (answeredBy?.trim() ? `网页端 · ${answeredBy.trim()}` : '网页端');
  return (
    <span
      data-ask-source={source}
      className={`inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${
        isLark
          ? 'border-blue-200 bg-blue-50 text-blue-700'
          : 'border-emerald-200 bg-emerald-50 text-emerald-700'
      }`}
    >
      {isLark ? <Send size={10} className="shrink-0"/> : <Globe2 size={10} className="shrink-0"/>}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** 流式输出阶段末尾出现未闭合 `<agentdock-ask-user-question` 时的轻盈占位，彻底隐藏裸 XML 源码。 */
export const AskUserQuestionStreamingPlaceholder = memo(function AskUserQuestionStreamingPlaceholder({
  title
}: {
  title?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-ask-streaming-placeholder=""
      className="ui-timeline-item my-3 flex max-w-[78ch] items-center gap-2.5 rounded-2xl border border-zinc-200 bg-zinc-50/80 px-3.5 py-2.5 text-[13px] text-zinc-600"
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-sky-500 ui-live-dot"/>
      <MessageCircleQuestion size={15} className="shrink-0 text-sky-600"/>
      <span className="ui-shimmer-text min-w-0 truncate font-medium">
        {title ? `正在生成「${title}」选项…` : '正在生成选项…'}
      </span>
    </div>
  );
});

/** 助手轮次末尾的交互询问卡片（支持单选 / 多选 / 多题 / 推荐项 / 说明 / 自定义「其他」输入 / 已答锁定态）。 */
export const AskUserQuestionCard = memo(function AskUserQuestionCard({
  spec,
  answered,
  disabled = false,
  disabledReason,
  submitting = false,
  error,
  onSubmit
}: {
  spec: AskUserQuestionSpec;
  answered?: AskUserQuestionAnswerPayload;
  disabled?: boolean;
  disabledReason?: string;
  submitting?: boolean;
  error?: string;
  onSubmit?(answers: AskUserQuestionAnswerItem[]): void | Promise<void>;
}) {
  const [drafts, setDrafts] = useState<DraftMap>(() => initialDrafts(spec));

  const answeredCount = useMemo(
    () => spec.questions.filter(q => isQuestionAnswered(q, drafts[q.id])).length,
    [spec.questions, drafts]
  );
  const allAnswered = answeredCount === spec.questions.length && spec.questions.length > 0;
  const multiQuestion = spec.questions.length > 1;

  // 已回答态：优雅锁定为只读摘要卡，彻底禁止重复提交
  if (answered) {
    return (
      <section
        aria-label={spec.title ? `${spec.title}（已回答）` : '询问卡片（已回答）'}
        data-ask-card=""
        data-ask-card-id={spec.id}
        data-ask-card-state="answered"
        className="ui-timeline-item my-3 max-w-[78ch] overflow-hidden rounded-2xl border border-emerald-200/80 bg-[rgb(var(--surface))]"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200/75 bg-emerald-50/55 px-3.5 py-2.5">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700">
            <Check size={13} className="ui-icon-pop"/>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold text-zinc-900">
                {spec.title || '询问已确认'}
              </span>
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-700">
                已回答
              </span>
            </div>
          </div>
          <SourceBadge source={answered.source} answeredBy={answered.answeredBy}/>
        </div>

        <div className="divide-y divide-zinc-200/60 px-3.5 py-1">
          {answered.answers.map((item, idx) => (
            <div key={`${item.questionId}-${idx}`} className="py-2 text-[12.5px] leading-5">
              <div className="flex items-start gap-2 text-zinc-500">
                <span className="mt-0.5 shrink-0 font-mono text-[11px] font-semibold text-zinc-400">
                  {answered.answers.length > 1 ? `Q${idx + 1}` : 'Q'}
                </span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{item.prompt}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
                {item.selectedLabels.map((label, labelIdx) => (
                  <span
                    key={`${label}-${labelIdx}`}
                    className="inline-flex max-w-full items-center gap-1 rounded-md border border-emerald-200/80 bg-emerald-50/70 px-2 py-0.5 text-[12px] font-medium text-emerald-800 [overflow-wrap:anywhere]"
                  >
                    <Check size={11} className="shrink-0"/>
                    <span>{label}</span>
                  </span>
                ))}
                {item.otherText?.trim() && (
                  <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[12px] text-zinc-700 [overflow-wrap:anywhere]">
                    {item.selectedLabels.length > 0 && <span className="text-[10px] text-zinc-400">补充</span>}
                    <span>{item.otherText}</span>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  const toggleOption = (question: AskUserQuestionItem, value: string) => {
    if (disabled || submitting) return;
    setDrafts(current => {
      const prev = current[question.id] ?? { selectedValues: [], otherSelected: false, otherText: '' };
      if (question.multi) {
        const exists = prev.selectedValues.includes(value);
        const nextValues = exists
          ? prev.selectedValues.filter(item => item !== value)
          : [...prev.selectedValues, value];
        return { ...current, [question.id]: { ...prev, selectedValues: nextValues } };
      }
      return {
        ...current,
        [question.id]: {
          ...prev,
          selectedValues: [value],
          otherSelected: false
        }
      };
    });
  };

  const toggleOther = (question: AskUserQuestionItem) => {
    if (disabled || submitting || !question.allowOther) return;
    setDrafts(current => {
      const prev = current[question.id] ?? { selectedValues: [], otherSelected: false, otherText: '' };
      if (question.multi) {
        return { ...current, [question.id]: { ...prev, otherSelected: !prev.otherSelected } };
      }
      const nextOther = !prev.otherSelected;
      return {
        ...current,
        [question.id]: {
          ...prev,
          selectedValues: nextOther ? [] : prev.selectedValues,
          otherSelected: nextOther
        }
      };
    });
  };

  const setOtherText = (question: AskUserQuestionItem, text: string) => {
    setDrafts(current => {
      const prev = current[question.id] ?? { selectedValues: [], otherSelected: true, otherText: '' };
      return {
        ...current,
        [question.id]: {
          ...prev,
          otherSelected: true,
          ...(question.multi ? {} : { selectedValues: [] }),
          otherText: text
        }
      };
    });
  };

  const handleSubmit = () => {
    if (disabled || submitting || !allAnswered || !onSubmit) return;
    void onSubmit(buildSubmittedAnswers(spec, drafts));
  };

  return (
    <section
      aria-label={spec.title || '需要你的确认'}
      data-ask-card=""
      data-ask-card-id={spec.id}
      data-ask-card-state="pending"
      className="ui-timeline-item my-3 max-w-[78ch] overflow-hidden rounded-2xl border border-zinc-200 bg-[rgb(var(--surface))] shadow-[0_2px_12px_rgba(24,24,27,0.04)]"
    >
      <header className="flex flex-wrap items-start gap-2.5 border-b border-zinc-200/80 bg-zinc-50/75 px-4 py-3">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-xl border border-sky-200/80 bg-sky-50 text-sky-700">
          <MessageCircleQuestion size={15}/>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-[14px] font-semibold leading-5 text-zinc-900 [overflow-wrap:anywhere]">
              {spec.title || '需要你的确认'}
            </h3>
            <span className="ml-auto shrink-0 rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-500">
              {multiQuestion ? `共 ${spec.questions.length} 题` : spec.questions[0]?.multi ? '多选' : '单选'}
            </span>
          </div>
          {spec.description && (
            <p className="mb-0 mt-1 text-[12.5px] leading-5 text-zinc-500 [overflow-wrap:anywhere]">
              {spec.description}
            </p>
          )}
        </div>
      </header>

      <div className="divide-y divide-zinc-200/70">
        {spec.questions.map((question, qIndex) => {
          const draft = drafts[question.id] ?? { selectedValues: [], otherSelected: false, otherText: '' };
          const isOtherOnly = question.options.length === 0 && question.allowOther;

          return (
            <div key={question.id} className="space-y-2.5 px-4 py-3.5">
              <div className="flex items-start gap-2">
                {multiQuestion && (
                  <span className="mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-zinc-100 px-1 font-mono text-[11px] font-semibold text-zinc-600">
                    {qIndex + 1}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[14px] font-medium leading-6 text-zinc-900 [overflow-wrap:anywhere]">
                      {question.prompt}
                    </span>
                    {multiQuestion && question.multi && (
                      <span className="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-px text-[11px] font-medium text-sky-700">
                        多选
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {question.options.length > 0 && (
                <div
                  role={question.multi ? 'group' : 'radiogroup'}
                  aria-label={question.prompt}
                  className="space-y-2"
                >
                  {question.options.map(option => {
                    const selected = draft.selectedValues.includes(option.value);
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role={question.multi ? 'checkbox' : 'radio'}
                        aria-checked={selected}
                        disabled={disabled || submitting}
                        data-ask-option={option.value}
                        onClick={() => toggleOption(question, option.value)}
                        className={`ui-press flex w-full items-start gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                          selected
                            ? 'border-sky-500/80 bg-sky-50/75 ring-1 ring-sky-500/20'
                            : 'border-zinc-200 bg-[rgb(var(--surface))] hover:border-zinc-300 hover:bg-zinc-50/80'
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center border transition-colors ${
                            question.multi ? 'rounded-[5px]' : 'rounded-full'
                          } ${
                            selected
                              ? 'border-sky-600 bg-sky-600 text-white'
                              : 'border-zinc-300 bg-white'
                          }`}
                        >
                          {selected && (
                            question.multi
                              ? <Check size={11} strokeWidth={3} className="ui-icon-pop"/>
                              : <span className="ui-icon-pop h-2 w-2 rounded-full bg-white"/>
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[13.5px] font-medium leading-5 text-zinc-900 [overflow-wrap:anywhere]">
                              {option.label}
                            </span>
                            {option.recommended && (
                              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-px text-[11px] font-medium leading-4 text-sky-700">
                                <Sparkles size={10} className="shrink-0"/>
                                推荐
                              </span>
                            )}
                          </span>
                          {option.description && (
                            <span className="mt-0.5 block text-[12.5px] leading-5 text-zinc-500 [overflow-wrap:anywhere]">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {question.allowOther && (
                <div>
                  {!isOtherOnly && (
                    <button
                      type="button"
                      role={question.multi ? 'checkbox' : 'radio'}
                      aria-checked={draft.otherSelected}
                      disabled={disabled || submitting}
                      data-ask-other-toggle={question.id}
                      onClick={() => toggleOther(question)}
                      className={`ui-press flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                        draft.otherSelected
                          ? 'border-sky-500/80 bg-sky-50/75 ring-1 ring-sky-500/20'
                          : 'border-dashed border-zinc-300 bg-zinc-50/50 hover:border-zinc-400 hover:bg-zinc-50'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`grid h-[18px] w-[18px] shrink-0 place-items-center border transition-colors ${
                          question.multi ? 'rounded-[5px]' : 'rounded-full'
                        } ${
                          draft.otherSelected
                            ? 'border-sky-600 bg-sky-600 text-white'
                            : 'border-zinc-300 bg-white text-zinc-400'
                        }`}
                      >
                        {draft.otherSelected ? <Check size={11} strokeWidth={3} className="ui-icon-pop"/> : <PenLine size={10}/>}
                      </span>
                      <span className="min-w-0 flex-1 text-[13.5px] font-medium text-zinc-700">
                        {question.multi ? '其他 / 自定义补充' : '其他 / 自定义回答'}
                      </span>
                    </button>
                  )}
                  <Disclosure open={isOtherOnly || draft.otherSelected} unmountOnClose>
                    <div className={isOtherOnly ? '' : 'pt-2'}>
                      <textarea
                        rows={2}
                        disabled={disabled || submitting}
                        value={draft.otherText}
                        onChange={event => setOtherText(question, event.target.value)}
                        onKeyDown={event => {
                          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                            event.preventDefault();
                            handleSubmit();
                          }
                        }}
                        aria-label={`${question.prompt} - 自定义回答`}
                        placeholder={question.otherPlaceholder || '请输入你的自定义回答（⌘/Ctrl + Enter 提交）…'}
                        className="ui-field w-full resize-y rounded-xl border border-zinc-200 bg-[rgb(var(--bg))] px-3 py-2 text-[13.5px] leading-5 text-zinc-900 placeholder:text-zinc-400 disabled:opacity-60"
                      />
                    </div>
                  </Disclosure>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div
          role="alert"
          className="ui-status-banner-in flex items-start gap-2 border-t border-red-200 bg-red-50/75 px-4 py-2 text-[12px] leading-5 text-red-700"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0"/>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</span>
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200/80 bg-zinc-50/55 px-4 py-2.5">
        <span className="min-w-0 text-[12px] text-zinc-500">
          {disabledReason
            ? disabledReason
            : multiQuestion
              ? `已完成 ${answeredCount} / ${spec.questions.length} 题`
              : allAnswered
                ? '已选择，点击提交继续对话'
                : '请选择或填写后提交'}
        </span>
        <button
          type="button"
          disabled={disabled || submitting || !allAnswered || !onSubmit}
          data-ask-submit=""
          onClick={handleSubmit}
          className="ui-press ml-auto inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-zinc-900 px-4 text-[13px] font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? <Spinner size={13} label="正在提交"/> : <Check size={14}/>}
          <span>{submitting ? '提交中…' : '提交回答'}</span>
        </button>
      </footer>
    </section>
  );
});

/**
 * 回答轮次的专属视觉呈现（区别于普通用户气泡）：
 * 精致顶栏标示「已回复询问」+ 来源徽标（网页端 / 飞书），逐题成对展示当时的问题 Q 与用户的答案 A。
 */
export const AskUserQuestionAnswerCard = memo(function AskUserQuestionAnswerCard({
  payload,
  timestamp
}: {
  payload: AskUserQuestionAnswerPayload;
  timestamp: string;
}) {
  const multiQuestion = payload.answers.length > 1;
  return (
    <div
      data-ask-answer-card=""
      data-ask-answer-question-id={payload.questionId}
      data-ask-answer-source={payload.source}
      className="ui-user-send-time-row group/msg ui-timeline-item relative my-6 flex flex-col items-end"
    >
      <div className="w-full max-w-[min(100%,560px)] overflow-hidden rounded-2xl border border-sky-200/90 bg-[rgb(var(--surface))] text-left shadow-[0_2px_12px_rgba(14,165,233,0.06)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200/75 bg-sky-50/65 px-3.5 py-2">
          <CheckCircle2 size={14} className="shrink-0 text-sky-600"/>
          <span className="shrink-0 text-[12px] font-semibold text-zinc-900">已回复询问</span>
          {payload.title && (
            <span className="min-w-0 truncate text-[12px] text-zinc-500">· {payload.title}</span>
          )}
          <div className="ml-auto flex max-w-full shrink-0 items-center">
            <SourceBadge source={payload.source} answeredBy={payload.answeredBy}/>
          </div>
        </div>

        <div className="divide-y divide-zinc-200/60 px-3.5 py-1">
          {payload.answers.map((item, idx) => {
            const hasSelected = item.selectedLabels.length > 0;
            const hasOther = Boolean(item.otherText?.trim());
            return (
              <div key={`${item.questionId}-${idx}`} className="space-y-2 py-2.5">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 inline-flex h-[18px] min-w-[20px] shrink-0 items-center justify-center rounded-md bg-zinc-100 px-1 font-mono text-[10px] font-bold tracking-wide text-zinc-500">
                    {multiQuestion ? `Q${idx + 1}` : 'Q'}
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] leading-5 text-zinc-600 [overflow-wrap:anywhere]">
                    {item.prompt}
                  </span>
                </div>

                <div className="flex items-start gap-2">
                  <span className="mt-0.5 inline-flex h-[18px] min-w-[20px] shrink-0 items-center justify-center rounded-md bg-sky-100 px-1 font-mono text-[10px] font-bold tracking-wide text-sky-700">
                    A
                  </span>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    {hasSelected && (
                      <div className="flex flex-wrap gap-1.5">
                        {item.selectedLabels.map((label, labelIdx) => (
                          <span
                            key={`${label}-${labelIdx}`}
                            className="inline-flex max-w-full items-center gap-1 rounded-lg border border-sky-200/90 bg-sky-50/85 px-2.5 py-0.5 text-[13px] font-medium leading-5 text-sky-900 [overflow-wrap:anywhere]"
                          >
                            <Check size={12} className="shrink-0 text-sky-600"/>
                            <span>{label}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {hasOther && (
                      <div className="rounded-lg border border-zinc-200/90 bg-zinc-50/90 px-2.5 py-1.5 text-[13px] leading-5 text-zinc-800 whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {hasSelected && (
                          <span className="mr-1.5 inline-block rounded bg-zinc-200/80 px-1 py-px text-[10px] font-medium text-zinc-600">
                            自定义
                          </span>
                        )}
                        {item.otherText}
                      </div>
                    )}
                    {!hasSelected && !hasOther && (
                      <span className="text-[12.5px] text-zinc-400">（未作答）</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="ui-user-send-time-slot mt-1 flex max-w-[min(100%,560px)] items-center justify-end gap-2">
        <UserMessageTime timestamp={timestamp}/>
      </div>
    </div>
  );
});
