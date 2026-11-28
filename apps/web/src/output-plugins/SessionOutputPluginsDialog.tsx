import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Code2,
  Globe,
  Puzzle,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  X
} from 'lucide-react';
import { Switch } from 'antd';
import {
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  mergeSessionOutputPluginsPatch,
  type OutputPluginCatalogItem,
  type OutputPluginsGlobalConfig
} from '@agent-dock/agent-dock-shared';
import { api, type Agent, type Session } from '../api';
import { Spinner } from '../Loaders';
import { sessionLabel } from '../session-groups';
import { IconButton } from '../ui-controls';
import { useModalFocusTrap } from '../useModalFocusTrap';
import { PluginIcon } from './PluginIcon';
import {
  buildEffectiveGlobalPluginsConfig,
  buildFallbackOutputPluginCatalogItems,
  buildSessionOutputPluginItems,
  type ResolvedSessionOutputPluginItem
} from './useOutputPlugins';
import { localizeOutputPluginDisplay } from '@agent-dock/agent-dock-shared';
import { useBi, useLocale } from '../i18n';

export interface SessionOutputPluginsDialogProps {
  session: Session;
  agent?: Agent;
  outputPluginItems?: OutputPluginCatalogItem[];
  outputPluginsGlobalConfig?: OutputPluginsGlobalConfig;
  askUserQuestionXmlEnabled?: boolean;
  onClose(): void;
  onOpenGlobalCenter?(): void;
}

function SessionPluginItemCard({
  plugin,
  archived,
  pending,
  disabled,
  onToggle,
  onReset
}: {
  plugin: ResolvedSessionOutputPluginItem;
  archived: boolean;
  pending: boolean;
  disabled: boolean;
  onToggle(next: boolean): void;
  onReset(): void;
}) {
  const L = useBi();
  const locale = useLocale();
  const localized = localizeOutputPluginDisplay(plugin, locale);
  const isMarkdownBlocks = plugin.syntaxKind === 'markdown-blocks';
  const overrideState = plugin.override === null
    ? 'inherit'
    : plugin.override
      ? 'enabled'
      : 'disabled';
  const statusBadge = plugin.override === null
    ? {
        label: L("跟随全局", "Follow Global"),
        className: 'border-zinc-200 bg-zinc-100 text-zinc-600'
      }
    : plugin.override
      ? {
          label: L("仅本会话开启", "On (Session)"),
          className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:text-emerald-300'
        }
      : {
          label: L("仅本会话关闭", "Off (Session)"),
          className: 'border-amber-200 bg-amber-50 text-amber-700 dark:text-amber-300'
        };

  return (
    <section
      data-testid={`session-plugin-row-${plugin.id}`}
      data-plugin-id={plugin.id}
      data-state={plugin.enabled ? 'on' : 'off'}
      data-override={overrideState}
      className="overflow-hidden rounded-xl border border-zinc-200 bg-[rgb(var(--surface))] transition-colors"
    >
      <div className="flex items-start gap-3 p-3.5">
        <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl border ${
          plugin.enabled
            ? 'border-sky-200/90 bg-sky-50 text-sky-700 dark:text-sky-300'
            : 'border-zinc-200 bg-zinc-50 text-zinc-400'
        }`}>
          <PluginIcon name={plugin.icon} size={15}/>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="m-0 text-[13.5px] font-semibold text-zinc-900 [overflow-wrap:anywhere]">
              {localized.name}
            </h3>
            {!plugin.builtin && (
              <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
                
                {L("本地扩展", "Local")}
              </span>
            )}
            <span
              data-testid={`session-plugin-status-${plugin.id}`}
              className={`shrink-0 rounded-full border px-1.5 py-px text-[10.5px] font-medium ${statusBadge.className}`}
            >
              {statusBadge.label}
            </span>
          </div>
          <p className="mb-0 mt-1 text-[12px] leading-5 text-zinc-500 [overflow-wrap:anywhere]">
            {localized.description}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
            <code className="max-w-full truncate rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600">
              {isMarkdownBlocks ? '```metrics / ```steps' : `<${plugin.tagName}>`}
            </code>
            <span className="inline-flex items-center rounded-md border border-zinc-200/80 bg-zinc-50/70 px-1.5 py-0.5 text-zinc-500">
              {L("全局默认：", "Global: ")}{plugin.globalEnabled ? L("开启", "On") : L("关闭", "Off")}
            </span>
            {isMarkdownBlocks && (
              <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200/80 bg-zinc-50/70 px-1.5 py-0.5 text-zinc-500">
                <Code2 size={10} className="text-sky-600 dark:text-sky-400"/>
                {L("Markdown 块", "Markdown Blocks")}
              </span>
            )}
            {plugin.capabilities.web && (
              <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200/80 bg-zinc-50/70 px-1.5 py-0.5 text-zinc-500">
                <Sparkles size={10} className="text-sky-600 dark:text-sky-400"/>
                {isMarkdownBlocks ? L("Web 富文本", "Web Rich") : 'Web'}
              </span>
            )}
            {plugin.capabilities.lark && (
              <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200/80 bg-zinc-50/70 px-1.5 py-0.5 text-zinc-500">
                <Send size={10} className="text-blue-600 dark:text-blue-400"/>
                {isMarkdownBlocks ? L("飞书降级", "Lark Fallback") : L("飞书", "Lark")}
              </span>
            )}
            {plugin.override !== null && !archived && (
              <button
                type="button"
                data-testid={`session-plugin-reset-${plugin.id}`}
                disabled={disabled}
                onClick={onReset}
                className="ui-press inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <RotateCcw size={10}/>
                <span>{L("恢复跟随全局", "Reset to Global")}</span>
              </button>
            )}
          </div>
        </div>
        <Switch
          size="small"
          className="mt-1 shrink-0"
          aria-label={L(`当前会话开关：${localized.name}`, `Session toggle: ${localized.name}`)}
          checked={plugin.enabled}
          loading={pending}
          disabled={archived || disabled}
          onChange={onToggle}
        />
      </div>
    </section>
  );
}

/**
 * 单个会话专属的「当前会话 · 交互插件」配置弹窗。
 *
 * 与全局「交互插件中心」严格隔离：
 * - 仅调用会话级 `PATCH /api/sessions/:id/config` 写入 `outputPlugins` 覆写，绝不修改全局默认配置；
 * - 纯元数据即时生效，不重启 Agent CLI；
 * - 清晰标注每个插件是「跟随全局」「仅本会话开启」还是「仅本会话关闭」，支持单项重置与一键恢复默认；
 * - 底部明确区分次级跳转入口，点击后才进入全局插件中心管理默认开关与本地扩展。
 */
export function SessionOutputPluginsDialog({
  session,
  agent,
  outputPluginItems,
  outputPluginsGlobalConfig,
  askUserQuestionXmlEnabled = true,
  onClose,
  onOpenGlobalCenter
}: SessionOutputPluginsDialogProps) {
  const L = useBi();
  const locale = useLocale();
  const qc = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: panelRef, dismissible: true, onDismiss: onClose });

  const switchVersionRef = useRef(0);
  const [pendingPluginId, setPendingPluginId] = useState<string>();
  const [resettingAll, setResettingAll] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string }>();

  useEffect(() => {
    switchVersionRef.current += 1;
    setPendingPluginId(undefined);
    setResettingAll(false);
    setFeedback(undefined);
  }, [session.id]);

  const effectiveCatalog = useMemo<OutputPluginCatalogItem[]>(
    () => (outputPluginItems?.length ? outputPluginItems : buildFallbackOutputPluginCatalogItems()),
    [outputPluginItems]
  );
  const effectiveGlobalConfig = useMemo<OutputPluginsGlobalConfig>(
    () => buildEffectiveGlobalPluginsConfig(effectiveCatalog, outputPluginsGlobalConfig, askUserQuestionXmlEnabled),
    [effectiveCatalog, outputPluginsGlobalConfig, askUserQuestionXmlEnabled]
  );
  const plugins = useMemo(
    () => buildSessionOutputPluginItems(
      effectiveCatalog,
      effectiveGlobalConfig,
      session.outputPlugins,
      session.askUserQuestionEnabled
    ),
    [effectiveCatalog, effectiveGlobalConfig, session.outputPlugins, session.askUserQuestionEnabled]
  );

  const enabledCount = plugins.filter(item => item.enabled).length;
  const totalCount = plugins.length;
  const overriddenCount = plugins.filter(item => item.override !== null).length;
  const archived = Boolean(session.archivedAt);
  const currentSessionLabel = sessionLabel(session, agent?.name);

  const applySessionPatch = useCallback((
    patch: Record<string, boolean | null>,
    options: { activePluginId?: string; isResetAll?: boolean; successMessage: string }
  ) => {
    if (archived || !Object.keys(patch).length) return;
    const latestSession = qc.getQueryData<Session[]>(['sessions'])?.find(item => item.id === session.id) ?? session;
    const previousPlugins = latestSession.outputPlugins;
    const previousAsk = typeof latestSession.askUserQuestionEnabled === 'boolean'
      ? latestSession.askUserQuestionEnabled
      : null;
    const merged = mergeSessionOutputPluginsPatch(previousPlugins, patch, previousAsk);
    const nextAsk = typeof merged[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID] === 'boolean'
      ? merged[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]
      : null;

    const version = ++switchVersionRef.current;
    setFeedback(undefined);
    setPendingPluginId(options.activePluginId);
    setResettingAll(Boolean(options.isResetAll));

    qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => (
      item.id === session.id
        ? {
            ...item,
            outputPlugins: Object.keys(merged).length ? merged : undefined,
            askUserQuestionEnabled: nextAsk
          }
        : item
    )));

    void api.setSessionOutputPlugins(session.id, patch).then(updatedSession => {
      if (switchVersionRef.current !== version) return;
      setPendingPluginId(undefined);
      setResettingAll(false);
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => (
        item.id === updatedSession.id ? updatedSession : item
      )));
      setFeedback({ ok: true, message: options.successMessage });
    }).catch(error => {
      if (switchVersionRef.current !== version) return;
      setPendingPluginId(undefined);
      setResettingAll(false);
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => (
        item.id === session.id
          ? { ...item, outputPlugins: previousPlugins, askUserQuestionEnabled: previousAsk }
          : item
      )));
      setFeedback({
        ok: false,
        message: L(`保存当前会话交互插件失败：${error instanceof Error ? error.message : String(error)}`, `Failed to save session output plugins: ${error instanceof Error ? error.message : String(error)}`)
      });
    });
  }, [archived, qc, session]);

  const handleTogglePlugin = useCallback((plugin: ResolvedSessionOutputPluginItem, nextEnabled: boolean) => {
    const pluginName = localizeOutputPluginDisplay(plugin, locale).name;
    applySessionPatch(
      { [plugin.id]: nextEnabled },
      {
        activePluginId: plugin.id,
        successMessage: nextEnabled
          ? L(`已仅在当前会话开启「${pluginName}」，不影响全局默认与其他会话。`, `Enabled "${pluginName}" for this session only.`)
          : L(`已仅在当前会话关闭「${pluginName}」，不影响全局默认与其他会话。`, `Disabled "${pluginName}" for this session only.`)
      }
    );
  }, [applySessionPatch, locale, L]);

  const handleResetPlugin = useCallback((plugin: ResolvedSessionOutputPluginItem) => {
    const pluginName = localizeOutputPluginDisplay(plugin, locale).name;
    applySessionPatch(
      { [plugin.id]: null },
      {
        activePluginId: plugin.id,
        successMessage: L(`已将「${pluginName}」恢复为跟随全局默认（当前全局默认${plugin.globalEnabled ? '开启' : '关闭'}）。`, `Reset "${pluginName}" to follow global default (currently ${plugin.globalEnabled ? 'On' : 'Off'}).`)
      }
    );
  }, [applySessionPatch, locale, L]);

  const handleResetAll = useCallback(() => {
    const patch: Record<string, null> = {};
    for (const item of plugins) {
      if (item.override !== null) patch[item.id] = null;
    }
    if (!Object.keys(patch).length) return;
    applySessionPatch(patch, {
      isResetAll: true,
      successMessage: L("已清除本会话全部独立覆写，所有交互插件恢复跟随全局默认。", "Cleared all session overrides; all plugins now follow global defaults.")
    });
  }, [applySessionPatch, plugins]);

  return (
    <div
      className="ui-overlay ui-overlay-sheet fixed inset-0 z-[60] grid place-items-center bg-zinc-950/30 p-0 sm:p-4"
      onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={L("当前会话 · 交互插件", "Session · Output Plugins")}
        data-testid="session-output-plugins-dialog"
        data-session-id={session.id}
        className="ui-dialog flex h-[100dvh] w-full max-w-none flex-col overflow-hidden rounded-none border-0 border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)] sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-xl sm:rounded-[14px] sm:border"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-zinc-100 px-4 py-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-sky-200/80 bg-sky-50 text-sky-700 dark:text-sky-300">
            <Puzzle size={16}/>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="m-0 text-[15px] font-semibold leading-tight text-zinc-900">
                
                {L("当前会话 · 交互插件", "Session · Output Plugins")}
              </h2>
              <span className="rounded-full border border-sky-200 bg-sky-50 px-1.5 py-px text-[10.5px] font-medium text-sky-700 dark:text-sky-300">
                
                {L("仅本会话", "Session Only")}
              </span>
            </div>
            <p className="mb-0 mt-0.5 truncate text-[12px] text-zinc-500">
              
              {L("作用会话：", "Session: ")}{currentSessionLabel}
            </p>
          </div>
          <span className="shrink-0">
            <IconButton label={L("关闭", "Close")} onClick={onClose}><X size={16}/></IconButton>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="space-y-3">
            <div className="rounded-xl border border-sky-200/80 bg-sky-50/65 px-3.5 py-2.5">
              <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                <span className="inline-flex items-center gap-1.5 font-semibold text-sky-900 dark:text-sky-200">
                  <ShieldCheck size={13} className="shrink-0 text-sky-600 dark:text-sky-400"/>
                  <span>{L("仅影响当前会话，不改动全局默认与其他会话", "Affects only this session without altering global defaults or other sessions")}</span>
                </span>
                <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5 text-[11px]">
                  <span
                    data-testid="session-plugins-summary-count"
                    className="rounded-full border border-sky-200 bg-white px-2 py-0.5 font-medium tabular-nums text-sky-700 dark:text-sky-300"
                  >
                    {L(`${enabledCount}/${totalCount} 启用`, `${enabledCount}/${totalCount} enabled`)}
                  </span>
                  <span
                    data-testid="session-plugins-override-summary"
                    className={`rounded-full border px-2 py-0.5 font-medium tabular-nums ${
                      overriddenCount > 0
                        ? 'border-amber-200 bg-amber-50 text-amber-700 dark:text-amber-300'
                        : 'border-zinc-200 bg-white text-zinc-500'
                    }`}
                  >
                    {overriddenCount > 0 ? L(`已独立覆写 ${overriddenCount} 项`, `${overriddenCount} overridden`) : L("全部跟随全局默认", "All Following Global")}
                  </span>
                </div>
              </div>
              <p className="mb-0 mt-1 text-[11.5px] leading-5 text-zinc-600">
                
                {L("切换后立即以纯元数据方式保存，无需重启 Agent CLI；关闭的插件不再向本会话注入 XML 协议，零 Token 消耗。", "Saved immediately as metadata without restarting the Agent CLI; disabled plugins inject zero XML tokens.")}
              </p>
            </div>

            {archived && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
                
                {L("当前会话已归档，交互插件配置为只读状态。", "This session is archived; output plugin settings are read-only.")}
              </div>
            )}

            <div className="space-y-2.5">
              {plugins.map(plugin => (
                <SessionPluginItemCard
                  key={plugin.id}
                  plugin={plugin}
                  archived={archived}
                  pending={pendingPluginId === plugin.id}
                  disabled={resettingAll}
                  onToggle={next => handleTogglePlugin(plugin, next)}
                  onReset={() => handleResetPlugin(plugin)}
                />
              ))}
            </div>

            {overriddenCount > 0 && !archived && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-zinc-50/75 px-3.5 py-2.5 text-[12px] text-zinc-600">
                <span>{L("当前会话包含", "This session has ")} {overriddenCount}  {L("项独立覆写（修改全局默认时不会被强行覆盖）", " custom override(s) (preserved when global defaults change)")}</span>
                <button
                  type="button"
                  data-testid="session-plugins-reset-all"
                  disabled={resettingAll || Boolean(pendingPluginId)}
                  onClick={handleResetAll}
                  className="ui-press inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-[12px] font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {resettingAll ? <Spinner size={12}/> : <RotateCcw size={12}/>}
                  <span>{L("恢复跟随全局默认", "Reset to Global")}</span>
                </button>
              </div>
            )}

            {feedback && (
              <div
                role="status"
                data-testid="session-plugins-feedback"
                className={`ui-status-banner-in flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-5 ${
                  feedback.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:text-emerald-300'
                    : 'border-red-200 bg-red-50 text-red-700 dark:text-red-300'
                }`}
              >
                {feedback.ok
                  ? <Check size={13} className="ui-icon-pop mt-0.5 shrink-0"/>
                  : <AlertTriangle size={13} className="mt-0.5 shrink-0"/>}
                <span className="[overflow-wrap:anywhere]">{feedback.message}</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-zinc-100 bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {onOpenGlobalCenter ? (
            <button
              type="button"
              data-testid="session-plugins-open-global-center"
              onClick={onOpenGlobalCenter}
              className="ui-press inline-flex max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50/80 px-2.5 py-1.5 text-left text-[12px] font-medium text-zinc-600 hover:border-zinc-300 hover:bg-zinc-100 hover:text-zinc-900"
            >
              <Globe size={13} className="shrink-0 text-zinc-500"/>
              <span className="min-w-0 truncate">{L("前往全局插件中心管理默认开关与本地插件", "Manage global defaults & local plugins in Plugin Center")}</span>
              <ArrowRight size={12} className="shrink-0 text-zinc-400"/>
            </button>
          ) : <span/>}
          <button
            type="button"
            onClick={onClose}
            className="ui-press ml-auto shrink-0 rounded-lg bg-zinc-900 px-4 py-1.5 text-[12px] font-medium text-white hover:bg-zinc-700"
          >
            
            {L("完成", "Done")}
          </button>
        </div>
      </div>
    </div>
  );
}
