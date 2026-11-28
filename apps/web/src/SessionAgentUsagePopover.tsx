import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, ChevronDown, ChevronRight, Zap } from 'lucide-react';
import type { SessionUsageDetail } from './api';
import { AgentIcon } from './AgentIcon';
import { AgentQuotaSection } from './AgentUsagePanel';
import { ExitGate } from './ExitGate';
import { HoverTooltip } from './HoverTooltip';
import { formatTokens, type ContextStats } from './composer-utils';
import { openAppDialog } from './dialog-store';
import type { LiveStreamTpsResult } from './live-tps';
import {
  clampPercent,
  quotaUsageTone,
  resolveQuotaTarget,
  summarizeQuotaTooltip,
  useAgentUsage,
  type QuotaTone
} from './agent-usage-cache';
import { useBi } from './i18n';

const contextBarToneClass: Record<QuotaTone, string> = {
  normal: 'bg-blue-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500'
};

const contextTextToneClass: Record<QuotaTone, string> = {
  normal: 'text-zinc-700',
  warning: 'text-amber-600',
  danger: 'text-red-600'
};

const ringStrokeToneClass: Record<QuotaTone, string> = {
  normal: 'text-zinc-500',
  warning: 'text-amber-500',
  danger: 'text-red-500'
};

function MiniContextRing({ percentage }: { percentage: number }) {
  const clamped = clampPercent(percentage);
  const tone = quotaUsageTone(clamped);
  const radius = 4.6;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={`shrink-0 -rotate-90 ${ringStrokeToneClass[tone]}`}>
      <circle cx="6" cy="6" r={radius} fill="none" stroke="rgb(var(--zinc-200))" strokeWidth="1.5"/>
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={`${(circumference * clamped) / 100} ${circumference}`}
      />
    </svg>
  );
}

function formatUsd(costUsd?: number | null): string | undefined {
  if (!costUsd || !Number.isFinite(costUsd) || costUsd <= 0) return undefined;
  return `$${costUsd.toFixed(costUsd >= 1 ? 2 : 4)}`;
}

export interface SessionUsagePopoverBodyProps {
  agentId: string;
  agentName?: string;
  currentModel?: string;
  context: ContextStats;
  sessionUsage?: SessionUsageDetail;
  liveTps?: LiveStreamTpsResult;
  quotaAgentId?: string;
  quotaSlot?: ReactNode;
  onOpenDashboard(): void;
}

/**
 * 顶栏 Agent 聚合弹出小面板内容：
 * - 第一层：本会话 Token / 上下文（上下文进度条 + 压缩回收 + Token 拆分 + TPS）
 * - 第二层：账号额度（复用 AgentQuotaSection；不支持额度查询的 Agent 优雅展示 Token 用量并在底栏克制提示）
 */
export function SessionUsagePopoverBody({
  agentId,
  agentName,
  currentModel,
  context,
  sessionUsage,
  liveTps,
  quotaAgentId,
  quotaSlot,
  onOpenDashboard
}: SessionUsagePopoverBodyProps) {
  const L = useBi();
  const displayName = agentName ?? agentId;
  const totals = sessionUsage?.totals;
  const hasTokens = Boolean(totals && totals.totalTokens > 0);
  const isLive = liveTps?.tps !== null && liveTps?.tps !== undefined;
  const displayTps = isLive ? liveTps!.tps : (totals?.lastTps ?? totals?.avgTps ?? null);
  const hasContext = context.used !== undefined;
  const hasAnySessionMetric = hasContext || hasTokens || displayTps !== null;
  const contextPct = context.percentage !== undefined ? clampPercent(context.percentage) : undefined;
  const contextTone = contextPct !== undefined ? quotaUsageTone(contextPct) : 'normal';
  const costText = formatUsd(totals?.costUsd);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部：Agent 身份与当前模型 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-100 px-3.5 py-2.5">
        <AgentIcon agentId={agentId} agentName={agentName} size={15}/>
        <span className="min-w-0 truncate text-[13px] font-semibold text-zinc-900">{displayName}</span>
        {currentModel && (
          <span className="ml-auto max-w-[160px] truncate rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-500">
            {currentModel}
          </span>
        )}
      </div>

      {/* 中间滚动区：第一层（本会话 Token/上下文）+ 第二层（账号额度） */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* 第一层：本会话 Token 与上下文 */}
        <div className="space-y-2 px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-zinc-800">{L("本会话用量", "Session Usage")}</span>
            {isLive ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium tabular-nums text-amber-700">
                <Zap size={10} className="animate-pulse text-amber-500"/>
                ~{liveTps!.tps!.toFixed(1)} t/s
              </span>
            ) : totals && totals.turnCount > 0 ? (
              <span className="text-[11px] tabular-nums text-zinc-400">{L(`${totals.turnCount} 轮统计`, `${totals.turnCount} turns`)}</span>
            ) : null}
          </div>

          {hasContext && (
            <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/75 px-2.5 py-2" data-session-context-card="">
              <div className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="font-medium text-zinc-700">{L("上下文窗口", "Context Window")}</span>
                <span className={`font-semibold tabular-nums ${contextTextToneClass[contextTone]}`}>
                  {formatTokens(context.used)}
                  {context.size !== undefined ? ` / ${formatTokens(context.size)}` : ''}
                  {contextPct !== undefined ? ` · ${Math.round(contextPct)}%` : ''}
                </span>
              </div>
              {contextPct !== undefined && (
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ease-out ${contextBarToneClass[contextTone]}`}
                    style={{ width: `${contextPct > 0 ? Math.max(2, contextPct) : 0}%` }}
                  />
                </div>
              )}
              {context.compacted !== undefined && context.compacted > 0 && (
                <div className="mt-1 text-[11px] tabular-nums text-zinc-400">
                  
                  {L("已累计压缩回收", "Compacted ")} {formatTokens(context.compacted)} tokens
                </div>
              )}
            </div>
          )}

          {(hasTokens || displayTps !== null) && (
            <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/75 px-2.5 py-2" data-session-tokens-card="">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] font-medium text-zinc-700">
                  {hasTokens ? L("累计 Token", "Total Tokens") : L("本轮生成中", "Streaming")}
                </span>
                <div className="flex items-baseline gap-1.5 tabular-nums">
                  {hasTokens && (
                    <span className="text-[13px] font-semibold text-zinc-900">
                      {formatTokens(totals!.totalTokens)}
                    </span>
                  )}
                  {costText && (
                    <span className="rounded bg-white px-1.5 py-px text-[10.5px] text-zinc-500 ring-1 ring-inset ring-zinc-200/80">
                      {costText}
                    </span>
                  )}
                </div>
              </div>

              {hasTokens && (
                <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] tabular-nums">
                  <div className="flex items-center justify-between gap-1 text-zinc-500">
                    <span>{L("输入", "Input")}</span>
                    <span className="font-medium text-zinc-700">{formatTokens(totals!.inputTokens)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-1 text-zinc-500">
                    <span>{L("输出", "Output")}</span>
                    <span className="font-medium text-zinc-700">{formatTokens(totals!.outputTokens)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-1 text-zinc-500">
                    <span>{L("缓存读", "Cache Read")}</span>
                    <span className="font-medium text-zinc-700">{formatTokens(totals!.cacheReadTokens)}</span>
                  </div>
                  {totals!.thoughtTokens > 0 ? (
                    <div className="flex items-center justify-between gap-1 text-zinc-500">
                      <span>{L("思考", "Thinking")}</span>
                      <span className="font-medium text-zinc-700">{formatTokens(totals!.thoughtTokens)}</span>
                    </div>
                  ) : displayTps !== null ? (
                    <div className="flex items-center justify-between gap-1 text-zinc-500">
                      <span>{L("速率", "Speed")}</span>
                      <span className={`inline-flex items-center gap-0.5 font-medium ${isLive ? 'text-amber-600' : 'text-zinc-700'}`}>
                        {isLive && <Zap size={10} className="text-amber-500"/>}
                        {isLive ? '~' : ''}{displayTps.toFixed(1)} t/s
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-1 text-zinc-500">
                      <span>{L("轮次", "Turns")}</span>
                      <span className="font-medium text-zinc-700">{totals!.turnCount}</span>
                    </div>
                  )}
                  {totals!.thoughtTokens > 0 && displayTps !== null && (
                    <div className="col-span-2 flex items-center justify-between gap-1 border-t border-zinc-200/60 pt-1 text-zinc-500">
                      <span>{isLive ? L("实时速率", "Live Speed") : L("生成速率", "Output Speed")}</span>
                      <span className={`inline-flex items-center gap-0.5 font-medium ${isLive ? 'text-amber-600' : 'text-zinc-700'}`}>
                        {isLive && <Zap size={10} className="text-amber-500"/>}
                        {isLive ? '~' : ''}{displayTps.toFixed(1)} t/s
                      </span>
                    </div>
                  )}
                </div>
              )}

              {isLive && (
                <div className="mt-1.5 text-[11px] text-zinc-400">
                  {liveTps?.activeTool ? L("工具执行中，速率保持；结束后按真实用量校准", "Held during tool execution; calibrated on completion") : L("实时估算速率，轮次结束后以真实上报校准", "Live estimate; calibrated with reported usage on completion")}
                </div>
              )}
            </div>
          )}

          {!hasAnySessionMetric && (
            <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/50 px-3 py-2.5 text-[12px] leading-5 text-zinc-500">
              
              {L("暂无本会话 Token 记录，发送消息后将自动统计。", "No token telemetry yet — stats appear after your first turn.")}
            </div>
          )}
        </div>

        {/* 第二层：账号额度（仅支持的 Agent 渲染独立分区；不支持时不留空占位） */}
        {quotaAgentId && quotaSlot && (
          <div className="border-t border-zinc-100 px-3.5 py-2.5">
            {quotaSlot}
          </div>
        )}
      </div>

      {/* 底部操作条（固定底边，不随中间内容裁切） */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-100 bg-zinc-50/50 px-3.5 py-2">
        <span className="min-w-0 truncate text-[11px] text-zinc-400">
          {quotaAgentId ? L("点击刷新可实时同步额度", "Click refresh to sync live quota") : L("当前 Agent 暂不支持账号额度查询", "Account quota query not supported for this Agent")}
        </span>
        <button
          type="button"
          onClick={onOpenDashboard}
          className="ui-press inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
        >
          <BarChart3 size={12}/>
          <span>{L("消耗看板", "Usage Dashboard")}</span>
          <ChevronRight size={11} className="text-zinc-400"/>
        </button>
      </div>
    </div>
  );
}

/**
 * 会话顶栏 Agent 处的轻巧入口与「Token 用量 + 账号额度」聚合小面板。
 *
 * 弹层通过 Portal 挂在 body 下并动态对齐触发器坐标：
 * - 顶栏标题容器仍保持 overflow-hidden 防止窄屏文字溢出，弹层不会被裁切；
 * - 390×844 移动端下自动贴合左右安全边距（left/right 12px），绝不超出视口。
 */
export function SessionAgentUsagePopover({
  sessionId,
  agentId,
  agentName,
  currentModel,
  context,
  sessionUsage,
  liveTps
}: {
  sessionId: string;
  agentId: string;
  agentName?: string;
  currentModel?: string;
  context: ContextStats;
  sessionUsage?: SessionUsageDetail;
  liveTps?: LiveStreamTpsResult;
}) {
  const L = useBi();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const displayName = agentName ?? agentId;
  const quotaTarget = resolveQuotaTarget(agentId, currentModel);
  // 关闭且未悬停态只读 5 分钟缓存（不发网络请求），悬停或打开时才按需拉取/刷新。
  const quotaPreview = useAgentUsage(quotaTarget, {
    enabled: hovered || open,
    model: currentModel,
    sessionId
  });

  const close = useCallback(() => setOpen(false), []);

  // 切会话或切换 Agent 自动收起弹层并重置悬停态。
  useEffect(() => {
    setOpen(false);
    setHovered(false);
  }, [sessionId, agentId]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const top = Math.min(Math.max(rect.bottom + 8, 56), Math.max(56, vh - 180));
    const maxHeight = Math.max(220, vh - top - 16);
    if (vw < 640) {
      setPanelStyle({ position: 'fixed', top, left: 12, right: 12, maxHeight });
      return;
    }
    const width = Math.min(344, vw - 24);
    const left = Math.max(12, Math.min(rect.left, vw - width - 12));
    setPanelStyle({ position: 'fixed', top, left, width, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
      triggerRef.current?.focus();
    };
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close, updatePosition]);

  const totals = sessionUsage?.totals;
  const hasTokens = Boolean(totals && totals.totalTokens > 0);
  const isLive = liveTps?.tps !== null && liveTps?.tps !== undefined;
  const quotaSummary = summarizeQuotaTooltip(quotaPreview.data);
  const magpieMeta = quotaPreview.data?.sourceMeta?.service === 'magpie' ? quotaPreview.data.sourceMeta : undefined;
  const isMagpieIssue = Boolean(
    magpieMeta && (quotaPreview.data?.unavailableCode === 'magpie_unreachable' || quotaPreview.data?.unavailableCode === 'magpie_auth_required')
  );

  const summaryBits = [
    context.percentage !== undefined ? L(`上下文 ${Math.round(clampPercent(context.percentage))}%`, `Context ${Math.round(clampPercent(context.percentage))}%`) : '',
    hasTokens ? L(`本会话 ${formatTokens(totals!.totalTokens)} tok`, `Session ${formatTokens(totals!.totalTokens)} tok`) : '',
    quotaSummary ? L(`额度 ${quotaSummary}`, `Quota ${quotaSummary}`) : ''
  ].filter(Boolean);

  const tooltipContent = (
    <div className="space-y-0.5">
      <div className="font-medium text-zinc-900">
        {displayName} · {quotaTarget ? L("Token 用量与账号额度", "Token Usage & Quota") : L("本会话 Token 用量", "Session Token Usage")}
      </div>
      {magpieMeta && (
        <div className={`text-[11px] font-medium ${isMagpieIssue ? 'text-amber-700' : 'text-sky-700'}`}>
          {isMagpieIssue
            ? L(`已检测到 Magpie 代理（${quotaPreview.data?.unavailableCode === 'magpie_auth_required' ? '需授权' : '未连接'}）`, `Magpie proxy detected (${quotaPreview.data?.unavailableCode === 'magpie_auth_required' ? 'Auth needed' : 'Offline'})`)
            : L(`来源：Magpie${magpieMeta.providerName ? ` · ${magpieMeta.providerName}` : ''}`, `Source: Magpie${magpieMeta.providerName ? ` · ${magpieMeta.providerName}` : ''}`)}
        </div>
      )}
      {summaryBits.length > 0 ? (
        <div className="text-[11px] tabular-nums text-zinc-500">{summaryBits.join(' · ')}</div>
      ) : (
        <div className="text-[11px] text-zinc-400">
          {quotaTarget ? L("点击展开上下文统计与订阅额度", "Click for context stats & subscription quota") : L("点击展开上下文与 Token 明细", "Click for context & token breakdown")}
        </div>
      )}
    </div>
  );

  const popoverNode = (
    <ExitGate open={open} ms={160}>
      <div
        ref={popoverRef}
        role="dialog"
        aria-label={L(`${displayName} 用量与额度`, `${displayName} Usage & Quota`)}
        data-agent-usage-popover=""
        data-placement="bottom-start"
        style={panelStyle}
        className="ui-popover z-50 flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_18px_50px_rgba(12,13,16,.16)]"
      >
        <SessionUsagePopoverBody
          agentId={agentId}
          agentName={agentName}
          currentModel={currentModel}
          context={context}
          sessionUsage={sessionUsage}
          liveTps={liveTps}
          quotaAgentId={quotaTarget}
          quotaSlot={quotaTarget ? <AgentQuotaSection agentId={quotaTarget} model={currentModel} sessionId={sessionId} variant="embedded" active={open}/> : undefined}
          onOpenDashboard={() => {
            close();
            openAppDialog('usage');
          }}
        />
      </div>
    </ExitGate>
  );

  return (
    <>
      <HoverTooltip content={open ? undefined : tooltipContent} hoverOnly>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={L(`${displayName}：${quotaTarget ? '查看本会话 Token 用量与账号额度' : '查看本会话 Token 用量'}`, `${displayName}: ${quotaTarget ? 'View token usage & quota' : 'View token usage'}`)}
          data-agent-usage-trigger=""
          onPointerEnter={() => { if (quotaTarget && !hovered) setHovered(true); }}
          onClick={() => {
            if (!open) updatePosition();
            setOpen(value => !value);
          }}
          className={`ui-press group/agent inline-flex h-[22px] min-w-0 max-w-full shrink items-center gap-1 rounded-md px-1.5 -ml-1.5 text-[12px] hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 ${open ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-600'}`}
        >
          <AgentIcon agentId={agentId} agentName={agentName} size={13}/>
          <span className="min-w-0 max-w-[110px] truncate font-medium sm:max-w-[160px]">{displayName}</span>
          {magpieMeta && (
            <>
              <span
                aria-hidden="true"
                data-magpie-trigger-dot=""
                className={`h-1.5 w-1.5 shrink-0 rounded-full sm:hidden ${isMagpieIssue ? 'bg-amber-500' : 'bg-sky-500'}`}
              />
              <span
                data-magpie-trigger-badge=""
                className={`hidden shrink-0 items-center rounded border px-1 py-px text-[10px] font-medium leading-3.5 sm:inline-flex ${
                  isMagpieIssue
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                    : 'border-sky-200 bg-sky-50 text-sky-700'
                }`}
              >
                Magpie
              </span>
            </>
          )}
          {context.percentage !== undefined && <MiniContextRing percentage={context.percentage}/>}
          {isLive ? (
            <span className="hidden shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-amber-600 sm:inline-flex">
              <Zap size={10} className="animate-pulse text-amber-500"/>
              ~{liveTps!.tps!.toFixed(1)} t/s
            </span>
          ) : hasTokens ? (
            <span className="hidden shrink-0 text-[11px] tabular-nums text-zinc-400 sm:inline">
              {formatTokens(totals!.totalTokens)}
            </span>
          ) : null}
          <ChevronDown
            size={11}
            className={`shrink-0 text-zinc-400 transition-transform duration-150 ${open ? 'rotate-180 text-zinc-700' : 'group-hover/agent:text-zinc-600'}`}
          />
        </button>
      </HoverTooltip>
      {typeof document !== 'undefined' ? createPortal(popoverNode, document.body) : popoverNode}
    </>
  );
}
