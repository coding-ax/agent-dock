import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, MessageCircleQuestion, Send, ShieldCheck, Sparkles } from 'lucide-react';
import { Switch } from 'antd';
import { ASK_USER_QUESTION_XML_TAG, DEFAULT_ASK_USER_QUESTION_CONFIG } from '@agent-dock/agent-dock-shared';
import { api } from './api';
import { HoverTooltip } from './HoverTooltip';
import { Spinner } from './Loaders';
import { useToast } from './Toast';
import { bi, useBi } from './i18n';

export const ASK_USER_QUESTION_CONFIG_QUERY_KEY = ['ask-user-question-config'] as const;

/** 侧栏设置菜单里的快捷开关，与 Agent 设置中的「询问卡片」面板共用同一份持久化状态。 */
export function AskUserQuestionToggle({ enabled }: { enabled: boolean }) {
  const L = useBi();
  const toast = useToast(6_000);
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ASK_USER_QUESTION_CONFIG_QUERY_KEY,
    queryFn: api.askUserQuestionConfig,
    enabled,
    retry: false,
    refetchOnWindowFocus: false
  });
  const toggle = useMutation({
    mutationFn: (askUserQuestionXmlEnabled: boolean) => api.saveAskUserQuestionConfig({ askUserQuestionXmlEnabled }),
    scope: { id: 'ask-user-question-config' },
    onSuccess: next => qc.setQueryData(ASK_USER_QUESTION_CONFIG_QUERY_KEY, next),
    onError: error => {
      toast.show(error instanceof Error ? error.message : L("更新询问卡片开关失败", "Failed to update Question Card setting"));
      void state.refetch();
    }
  });

  if (!enabled) return null;
  const pending = toggle.isPending;
  const checked = pending && toggle.variables !== undefined
    ? toggle.variables
    : (state.data?.config.askUserQuestionXmlEnabled ?? DEFAULT_ASK_USER_QUESTION_CONFIG.askUserQuestionXmlEnabled);

  return (
    <>
      <div className="flex h-[34px] items-center gap-1 text-[12px]">
        <HoverTooltip content={L("全局默认开关：新会话默认继承此处设置，也可在任意会话输入框底栏或右上角菜单随时单独开关（纯 XML，无 MCP/Tool）", "Global default: inherited by new sessions and overridable per session in the composer or header menu (Pure XML, no MCP/Tool)")}>
          <span className="min-w-0 flex-1 truncate">{L("XML 询问卡片", "XML Question Card")}</span>
        </HoverTooltip>
        <Switch
          size="small"
          className="!ml-auto shrink-0"
          aria-label={L("XML 询问卡片", "XML Question Card")}
          checked={checked}
          loading={pending}
          onChange={value => toggle.mutate(value)}
        />
      </div>
      {toast.toast}
    </>
  );
}

const getProtocolExample = () => bi(`<${ASK_USER_QUESTION_XML_TAG} id="db_choice" title="选择存储方案">
  <question id="q1" multi="false" allow-other="true">
    <prompt>希望采用哪种持久化方案？</prompt>
    <option value="sqlite" recommended="true" description="内置零运维">SQLite</option>
    <option value="postgres" description="适合多节点">PostgreSQL</option>
  </question>
</${ASK_USER_QUESTION_XML_TAG}>`, `<${ASK_USER_QUESTION_XML_TAG} id="db_choice" title="Choose Storage Engine">
  <question id="q1" multi="false" allow-other="true">
    <prompt>Which persistence layer should we use?</prompt>
    <option value="sqlite" recommended="true" description="Zero-ops embedded">SQLite</option>
    <option value="postgres" description="Best for multi-node">PostgreSQL</option>
  </question>
</${ASK_USER_QUESTION_XML_TAG}>`);

/** Agent 设置弹窗内的「询问卡片」配置面板。 */
export function AskUserQuestionSettingsPanel() {
  const L = useBi();
  const qc = useQueryClient();
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string }>();
  const state = useQuery({
    queryKey: ASK_USER_QUESTION_CONFIG_QUERY_KEY,
    queryFn: api.askUserQuestionConfig,
    refetchOnWindowFocus: false
  });
  const save = useMutation({
    mutationFn: (askUserQuestionXmlEnabled: boolean) => api.saveAskUserQuestionConfig({ askUserQuestionXmlEnabled }),
    scope: { id: 'ask-user-question-config' },
    onSuccess: next => {
      qc.setQueryData(ASK_USER_QUESTION_CONFIG_QUERY_KEY, next);
      setFeedback({
        ok: true,
        message: next.config.askUserQuestionXmlEnabled
          ? L("已开启 XML 询问卡片：网页端与飞书会话将自动注入协议并渲染交互式询问卡片。", "XML Question Card enabled: Web and Lark sessions will inject the protocol and render interactive cards.")
          : L("已关闭 XML 询问卡片：不再注入 XML 协议提示词，也不再将结尾 XML 转为交互卡片。", "XML Question Card disabled: protocol prompt will not be injected.")
      });
    },
    onError: error => setFeedback({ ok: false, message: error instanceof Error ? error.message : String(error) })
  });

  const enabled = save.isPending && save.variables !== undefined
    ? save.variables
    : (state.data?.config.askUserQuestionXmlEnabled ?? DEFAULT_ASK_USER_QUESTION_CONFIG.askUserQuestionXmlEnabled);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-4 sm:px-5">
        <div className="mx-auto max-w-2xl space-y-5">
          <div className="rounded-xl border border-zinc-200 bg-zinc-50/75 px-4 py-3">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-zinc-900">
              <MessageCircleQuestion size={15} className="text-sky-600"/>
              <span>{L("XML 协议版 AskUserQuestion（全局默认）", "XML AskUserQuestion (Global Default)")}</span>
            </div>
            <p className="mb-0 mt-1 text-[12px] leading-5 text-zinc-500">
              
              {L("不依赖 MCP 或额外 Tool：仅当 Agent 真正需要你拍板、多选一或确认偏好时，在回答最末尾输出精简 XML 块，前端与飞书客户端即可直接呈现为交互选项卡片。新会话默认继承此处设置，也可在任意会话输入框底栏随时单独开关。", "Zero MCP or extra tools: the Agent emits a compact XML block at the end of a reply only when your decision is needed, rendered natively in Web and Lark.")}
            </p>
          </div>

          {state.isLoading ? (
            <div className="flex items-center gap-2 py-6 text-[12px] text-zinc-400">
              <Spinner size={13}/>{L("正在读取配置…", "Loading settings…")}
            </div>
          ) : (
            <>
              <section className="space-y-3 rounded-xl border border-zinc-200 bg-[rgb(var(--surface))] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-zinc-900">{L("启用 XML 询问卡片协议", "Enable XML Question Card Protocol")}</span>
                      <span className={`rounded-full border px-2 py-px text-[11px] font-medium ${
                        enabled
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border-zinc-200 bg-zinc-100 text-zinc-500'
                      }`}>
                        {enabled ? L("已开启（默认）", "Enabled (Default)") : L("已关闭", "Disabled")}
                      </span>
                    </div>
                    <p className="mb-0 mt-1 text-[12px] leading-5 text-zinc-500">
                      
                      {L("作为所有未单独设置会话的全局默认：开启时自动向交互式会话注入精简 XML 规范并在网页端与飞书推送交互卡片；关闭后默认不再注入与解析。新会话默认继承此处设置，也可在任意会话输入框底栏或右上角 ⋯ 菜单随时单独开关。", "Global default for sessions without overrides. Overridable anytime per session in the composer or header ⋯ menu.")}
                    </p>
                  </div>
                  <Switch
                    className="mt-0.5 shrink-0"
                    aria-label={L("启用 XML 询问卡片协议", "Enable XML Question Card Protocol")}
                    checked={enabled}
                    loading={save.isPending}
                    onChange={checked => {
                      setFeedback(undefined);
                      save.mutate(checked);
                    }}
                  />
                </div>
              </section>

              <section className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-zinc-200 bg-[rgb(var(--surface))] p-3.5">
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-800">
                    <Sparkles size={13} className="text-sky-600"/>
                    <span>{L("流畅交互与专属回显", "Smooth Interaction & Structured Echo")}</span>
                  </div>
                  <p className="mb-0 mt-1.5 text-[12px] leading-5 text-zinc-500">
                    
                    {L("支持单选、多选、多题、推荐项与自定义填写；回答后原卡片锁定，并在时间线展示成对的 Q&amp;A 问答轮次。", "Supports single/multi-select, multiple questions, recommended picks, and custom answers with paired Q&A timeline display.")}
                  </p>
                </div>
                <div className="rounded-xl border border-zinc-200 bg-[rgb(var(--surface))] p-3.5">
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-800">
                    <Send size={13} className="text-blue-600"/>
                    <span>{L("飞书卡片双向同步", "Lark Two-Way Sync")}</span>
                  </div>
                  <p className="mb-0 mt-1.5 text-[12px] leading-5 text-zinc-500">
                    
                    {L("飞书会话自动推送 Schema 2.0 交互卡片（一键按钮 / 表单）；任一端作答后双端同步锁定并驱动 Agent 续跑。", "Pushes Schema 2.0 cards to Lark; answering on either Web or Lark locks both ends and resumes the Agent.")}
                  </p>
                </div>
                <div className="rounded-xl border border-zinc-200 bg-[rgb(var(--surface))] p-3.5">
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-800">
                    <ShieldCheck size={13} className="text-emerald-600"/>
                    <span>{L("代码围栏免疫", "Code-Fence Safe")}</span>
                  </div>
                  <p className="mb-0 mt-1.5 text-[12px] leading-5 text-zinc-500">
                    
                    {L("严格只解析回答最末尾的裸 XML 块，忽略 Markdown 代码块与行内代码示例，流式输出平滑占位不闪烁。", "Parses only trailing raw XML blocks, ignoring Markdown code blocks, with flicker-free streaming placeholders.")}
                  </p>
                </div>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-[rgb(var(--surface))] p-4">
                <div className="text-[12px] font-medium text-zinc-700">{L("协议格式速览", "Protocol Format Overview")}</div>
                <pre className="m-0 mt-2 overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-[11.5px] leading-5 text-zinc-600">
                  {getProtocolExample()}
                </pre>
              </section>

              {feedback && (
                <div className={`ui-status-banner-in flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] leading-5 ${
                  feedback.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-red-200 bg-red-50 text-red-700'
                }`}>
                  {feedback.ok ? <Check size={13} className="ui-icon-pop mt-0.5 shrink-0"/> : <AlertTriangle size={13} className="mt-0.5 shrink-0"/>}
                  <span>{feedback.message}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
