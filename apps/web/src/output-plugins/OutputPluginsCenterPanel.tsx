import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Code2,
  Copy,
  FolderOpen,
  Puzzle,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles
} from 'lucide-react';
import { Switch } from 'antd';
import type { OutputPluginCatalogItem } from '@agent-dock/agent-dock-shared';
import { api } from '../api';
import { Disclosure } from '../Disclosure';
import { HoverTooltip } from '../HoverTooltip';
import { Spinner } from '../Loaders';
import { ASK_USER_QUESTION_CONFIG_QUERY_KEY } from '../AskUserQuestionSettingsPanel';
import { PluginIcon } from './PluginIcon';
import { OUTPUT_PLUGINS_QUERY_KEY, useOutputPluginsCatalog } from './useOutputPlugins';

const DECLARATIVE_TEMPLATE_JSON = `{
  "id": "local:release-signoff",
  "name": "发版评审签核卡",
  "description": "在正式发版或切换流量前，让负责人在 Web 或飞书一键签核并附加变更窗口说明。",
  "icon": "check-square",
  "tagName": "agentdock-release-signoff",
  "version": "1.0.0",
  "defaultEnabled": false,
  "kind": "action-card",
  "card": {
    "accentTone": "sky",
    "headerTitle": "发版评审签核",
    "allowNote": true,
    "notePlaceholder": "可选：补充灰度比例或发布窗口说明…",
    "actions": [
      { "value": "approve", "label": "签核放行", "style": "primary" },
      { "value": "hold", "label": "暂缓发布", "style": "danger" }
    ]
  }
}`;

function CopyMiniButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }).catch(() => undefined);
  };
  return (
    <HoverTooltip content={copied ? '已复制' : label}>
      <button
        type="button"
        aria-label={label}
        onClick={handleCopy}
        className="ui-press inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-zinc-200 bg-[rgb(var(--surface))] px-2 text-[11px] font-medium text-zinc-600 hover:border-zinc-300 hover:text-zinc-900"
      >
        {copied ? <Check size={11} className="text-emerald-600"/> : <Copy size={11}/>}
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
    </HoverTooltip>
  );
}

function PluginCatalogCard({
  plugin,
  checked,
  pending,
  onToggle
}: {
  plugin: OutputPluginCatalogItem;
  checked: boolean;
  pending: boolean;
  onToggle(next: boolean): void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section
      data-testid={`plugin-center-card-${plugin.id}`}
      data-plugin-id={plugin.id}
      data-plugin-enabled={checked ? 'true' : 'false'}
      className="overflow-hidden rounded-xl border border-zinc-200 bg-[rgb(var(--surface))] transition-colors"
    >
      <div className="flex items-start gap-3 p-3.5 sm:p-4">
        <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl border ${
          checked
            ? 'border-sky-200/90 bg-sky-50 text-sky-700 dark:text-sky-300'
            : 'border-zinc-200 bg-zinc-50 text-zinc-500'
        }`}>
          <PluginIcon name={plugin.icon} size={16}/>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="m-0 text-[13.5px] font-semibold text-zinc-900 [overflow-wrap:anywhere]">
              {plugin.name}
            </h4>
            <span className={`rounded-full border px-1.5 py-px text-[10.5px] font-medium ${
              plugin.builtin
                ? 'border-sky-200 bg-sky-50 text-sky-700 dark:text-sky-300'
                : 'border-amber-200 bg-amber-50 text-amber-700 dark:text-amber-300'
            }`}>
              {plugin.builtin ? '内置' : '本地扩展'}
            </span>
            <span className="rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-px font-mono text-[10.5px] text-zinc-500">
              v{plugin.version}
            </span>
            <span className={`rounded-full border px-1.5 py-px text-[10.5px] font-medium ${
              checked
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:text-emerald-300'
                : 'border-zinc-200 bg-zinc-100 text-zinc-500'
            }`}>
              {checked ? '全局默认开启' : '全局默认关闭'}
            </span>
          </div>
          <p className="mb-0 mt-1 text-[12px] leading-5 text-zinc-500 [overflow-wrap:anywhere]">
            {plugin.description}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
            <code className="max-w-full truncate rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[11px] text-zinc-700">
              &lt;{plugin.tagName}&gt;
            </code>
            {plugin.capabilities.web && (
              <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200/80 bg-zinc-50/70 px-1.5 py-0.5 text-zinc-600">
                <Sparkles size={10} className="text-sky-600 dark:text-sky-400"/>
                Web {plugin.capabilities.interactive ? '交互卡' : '展示卡'}
              </span>
            )}
            {plugin.capabilities.lark && (
              <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200/80 bg-zinc-50/70 px-1.5 py-0.5 text-zinc-600">
                <Send size={10} className="text-blue-600 dark:text-blue-400"/>
                飞书 2.0 卡片
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200/80 bg-zinc-50/70 px-1.5 py-0.5 text-zinc-600">
              <ShieldCheck size={10} className="text-emerald-600 dark:text-emerald-400"/>
              围栏免疫
            </span>
          </div>
        </div>
        <Switch
          className="mt-0.5 shrink-0"
          aria-label={`全局默认开关：${plugin.name}`}
          checked={checked}
          loading={pending}
          onChange={onToggle}
        />
      </div>

      <div className="border-t border-zinc-200/75 bg-zinc-50/50 px-3.5 py-2 sm:px-4">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
          className="flex w-full items-center gap-1.5 text-left text-[11.5px] font-medium text-zinc-600 hover:text-zinc-900"
        >
          <ChevronRight size={13} className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}/>
          <Code2 size={12} className="shrink-0 text-zinc-400"/>
          <span>协议格式速览与按需提示词</span>
          {plugin.sourcePath && (
            <span className="ml-auto hidden max-w-[45%] truncate font-mono text-[10.5px] font-normal text-zinc-400 sm:inline">
              {plugin.sourcePath}
            </span>
          )}
        </button>
        <Disclosure open={expanded} unmountOnClose>
          <div className="mt-2.5 space-y-2.5 pb-1">
            {plugin.protocolExample && (
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-zinc-500">XML 输出示例（需位于回答最末尾，勿包代码块）</span>
                  <CopyMiniButton text={plugin.protocolExample} label="复制 XML 示例"/>
                </div>
                <pre className="m-0 mt-1 overflow-x-auto rounded-lg border border-zinc-200 bg-[rgb(var(--bg))] p-2.5 font-mono text-[11px] leading-5 text-zinc-700">
                  {plugin.protocolExample}
                </pre>
              </div>
            )}
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-zinc-500">按需注入提示词（会话关闭该插件时不注入，零 Token 消耗）</span>
                <CopyMiniButton text={plugin.promptInstruction} label="复制提示词"/>
              </div>
              <pre className="m-0 mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-200 bg-[rgb(var(--bg))] p-2.5 font-mono text-[11px] leading-5 text-zinc-600 [overflow-wrap:anywhere]">
                {plugin.promptInstruction}
              </pre>
            </div>
          </div>
        </Disclosure>
      </div>
    </section>
  );
}

/** Agent 设置弹窗内的「交互插件中心」面板（管理所有内置与本地声明式纯 XML 交互插件）。 */
export function OutputPluginsCenterPanel() {
  const qc = useQueryClient();
  const { query, catalog, plugins, enabledCount, totalCount } = useOutputPluginsCatalog(true);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string }>();
  const [pendingPluginId, setPendingPluginId] = useState<string>();
  const [templateOpen, setTemplateOpen] = useState(false);

  const togglePlugin = useMutation({
    mutationFn: ({ pluginId, enabled }: { pluginId: string; enabled: boolean }) =>
      api.saveOutputPluginsConfig({ [pluginId]: enabled }),
    onMutate: ({ pluginId }) => {
      setPendingPluginId(pluginId);
      setFeedback(undefined);
    },
    onSuccess: (next, variables) => {
      qc.setQueryData(OUTPUT_PLUGINS_QUERY_KEY, next);
      void qc.invalidateQueries({ queryKey: ASK_USER_QUESTION_CONFIG_QUERY_KEY });
      const target = next.plugins.find(item => item.id === variables.pluginId);
      setFeedback({
        ok: true,
        message: variables.enabled
          ? `已全局默认开启「${target?.name ?? variables.pluginId}」：新会话与未单独覆写的会话将自动生效。`
          : `已全局默认关闭「${target?.name ?? variables.pluginId}」：未单独开启的会话不再注入协议，零 Token 消耗。`
      });
    },
    onError: error => {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : String(error) });
    },
    onSettled: () => setPendingPluginId(undefined)
  });

  const reloadLocal = useMutation({
    mutationFn: () => api.reloadOutputPlugins(),
    onMutate: () => setFeedback(undefined),
    onSuccess: next => {
      qc.setQueryData(OUTPUT_PLUGINS_QUERY_KEY, next);
      const localCount = next.plugins.filter(item => !item.builtin).length;
      setFeedback({
        ok: true,
        message: next.warnings.length
          ? `已重新扫描本地插件目录（已加载 ${localCount} 个扩展，发现 ${next.warnings.length} 条告警，请查看下方详情）。`
          : `已重新扫描本地插件目录，当前共加载 ${next.plugins.length} 个插件（含 ${localCount} 个本地扩展）。`
      });
    },
    onError: error => {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  return (
    <div data-testid="output-plugins-center" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-4 sm:px-5">
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-zinc-50/75 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 text-[13.5px] font-semibold text-zinc-900">
                <Puzzle size={15} className="text-sky-600 dark:text-sky-400"/>
                <span>交互插件中心（纯 XML · 零 MCP / 零 Tool）</span>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px]">
                <span className="rounded-full border border-zinc-200 bg-[rgb(var(--surface))] px-2 py-0.5 font-medium tabular-nums text-zinc-600">
                  共 {totalCount} 个
                </span>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium tabular-nums text-emerald-700 dark:text-emerald-300">
                  默认开启 {enabledCount}
                </span>
              </div>
            </div>
            <p className="mb-0 mt-1.5 text-[12px] leading-5 text-zinc-500">
              任何 Agent CLI（Claude / Codex / Antigravity / Trae 等）只需在回复末尾输出插件约定的轻量 XML 标签，AgentDock 即可自动在 Web 与飞书渲染原生交互卡片并回传结构化轮次。此处控制全局默认开关；任意会话也可在输入框底栏「🧩 交互插件」面板随时独立覆盖。
            </p>
          </div>

          {query.isLoading ? (
            <div className="flex items-center gap-2 py-6 text-[12px] text-zinc-400">
              <Spinner size={13}/>正在加载交互插件列表…
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {plugins.map(plugin => {
                  const isPending = togglePlugin.isPending && pendingPluginId === plugin.id;
                  const checked = isPending && togglePlugin.variables
                    ? togglePlugin.variables.enabled
                    : plugin.globalEnabled;
                  return (
                    <PluginCatalogCard
                      key={plugin.id}
                      plugin={plugin}
                      checked={checked}
                      pending={isPending}
                      onToggle={enabled => togglePlugin.mutate({ pluginId: plugin.id, enabled })}
                    />
                  );
                })}
              </div>

              <section className="rounded-xl border border-zinc-200 bg-[rgb(var(--surface))] p-3.5 sm:p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-zinc-900">
                    <FolderOpen size={14} className="text-amber-600 dark:text-amber-400"/>
                    <span>本地 / 社区声明式插件扩展</span>
                  </div>
                  <button
                    type="button"
                    data-testid="output-plugins-reload"
                    disabled={reloadLocal.isPending}
                    onClick={() => reloadLocal.mutate()}
                    className="ui-press ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 text-[11.5px] font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-100 disabled:opacity-50"
                  >
                    <RefreshCw size={11} className={reloadLocal.isPending ? 'animate-spin' : ''}/>
                    <span>{reloadLocal.isPending ? '扫描中…' : '重新扫描'}</span>
                  </button>
                </div>
                <p className="mb-0 mt-1.5 text-[12px] leading-5 text-zinc-500">
                  将声明式 JSON 插件清单（支持 <code className="rounded bg-zinc-100 px-1 py-px font-mono text-[11px] text-zinc-700">action-card</code> / <code className="rounded bg-zinc-100 px-1 py-px font-mono text-[11px] text-zinc-700">form-card</code> / <code className="rounded bg-zinc-100 px-1 py-px font-mono text-[11px] text-zinc-700">info-card</code>）放入下方目录后点击「重新扫描」，即可零重启热加载并同时支持 Web 与飞书 Schema 2.0 卡片：
                </p>
                {catalog?.localDir && (
                  <div className="mt-2 flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/75 px-2.5 py-1.5">
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-700">
                      {catalog.localDir}
                    </code>
                    <CopyMiniButton text={catalog.localDir} label="复制目录路径"/>
                  </div>
                )}

                {Boolean(catalog?.warnings?.length) && (
                  <div className="mt-2.5 space-y-1.5 rounded-lg border border-amber-200 bg-amber-50/80 p-2.5 text-[11.5px] text-amber-800 dark:text-amber-300">
                    <div className="flex items-center gap-1.5 font-semibold">
                      <AlertTriangle size={12} className="shrink-0"/>
                      <span>发现 {catalog!.warnings.length} 条本地清单加载告警</span>
                    </div>
                    {catalog!.warnings.map((warning, idx) => (
                      <div key={`${warning.file}-${idx}`} className="font-mono text-[11px] leading-4 [overflow-wrap:anywhere]">
                        • {warning.file}：{warning.message}
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-2.5 border-t border-zinc-200/70 pt-2.5">
                  <button
                    type="button"
                    aria-expanded={templateOpen}
                    onClick={() => setTemplateOpen(value => !value)}
                    className="flex w-full items-center gap-1.5 text-left text-[11.5px] font-medium text-zinc-600 hover:text-zinc-900"
                  >
                    <ChevronRight size={13} className={`shrink-0 transition-transform duration-150 ${templateOpen ? 'rotate-90' : ''}`}/>
                    <span>查看声明式插件 JSON 模板（release-signoff.json）</span>
                  </button>
                  <Disclosure open={templateOpen} unmountOnClose>
                    <div className="mt-2 space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-500">
                        <span>完整开发契约与自定义代码插件指南见 <code className="font-mono">docs/output-plugins.md</code></span>
                        <CopyMiniButton text={DECLARATIVE_TEMPLATE_JSON} label="复制模板 JSON"/>
                      </div>
                      <pre className="m-0 overflow-x-auto rounded-lg border border-zinc-200 bg-[rgb(var(--bg))] p-2.5 font-mono text-[11px] leading-5 text-zinc-700">
                        {DECLARATIVE_TEMPLATE_JSON}
                      </pre>
                    </div>
                  </Disclosure>
                </div>
              </section>

              {feedback && (
                <div className={`ui-status-banner-in flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-5 ${
                  feedback.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:text-emerald-300'
                    : 'border-red-200 bg-red-50 text-red-700 dark:text-red-300'
                }`}>
                  {feedback.ok
                    ? <Check size={13} className="ui-icon-pop mt-0.5 shrink-0"/>
                    : <AlertTriangle size={13} className="mt-0.5 shrink-0"/>}
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
