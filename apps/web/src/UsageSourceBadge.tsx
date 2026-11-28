import { AlertTriangle, ShieldCheck, Waypoints } from 'lucide-react';
import type { UsageMatchedBy, UsageSourceMeta, UsageUnavailableCode } from './api';
import { HoverTooltip } from './HoverTooltip';
import { bi, useBi } from './i18n';

function matchedByText(matchedBy: UsageMatchedBy, matchedModel?: string, providerName?: string): string {
  switch (matchedBy) {
    case 'session_model':
      return matchedModel ? bi(`匹配依据：当前会话模型 ${matchedModel}`, `Matched by: session model ${matchedModel}`) : bi("匹配依据：当前会话模型前缀", "Matched by: session model prefix");
    case 'magpie_route':
      return matchedModel ? bi(`匹配依据：Magpie 动态路由实际落点 ${matchedModel}`, `Matched by: Magpie dynamic route ${matchedModel}`) : bi("匹配依据：Magpie 会话动态路由", "Matched by: Magpie dynamic route");
    case 'agent_config':
      return matchedModel ? bi(`匹配依据：Agent 本机配置模型 ${matchedModel}`, `Matched by: local Agent config ${matchedModel}`) : bi("匹配依据：Agent 本机代理配置", "Matched by: local Agent proxy config");
    case 'magpie_applied':
      return matchedModel ? bi(`匹配依据：Magpie 已应用配置 ${matchedModel}`, `Matched by: applied Magpie config ${matchedModel}`) : bi("匹配依据：Magpie 已应用配置", "Matched by: applied Magpie config");
    case 'official_direct':
      return bi(`匹配依据：未检测到代理路由，直连 ${providerName ?? '官方接口'}`, `Matched by: direct connection to ${providerName ?? 'Official API'}`);
  }
}

function isLocalOrigin(endpoint?: string): boolean {
  if (!endpoint) return false;
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(endpoint);
}

export interface UsageSourceBadgeProps {
  agentDisplayName: string;
  sourceMeta?: UsageSourceMeta;
  unavailableCode?: UsageUnavailableCode;
  fallbackSourceLabel?: string;
}

/**
 * 额度来源显式提示徽标（Provenance UI）：
 * 明确区分「已识别本机 Magpie 供应商」「Magpie 未连接/需授权」「官方直连」，
 * 悬停展示完整识别依据，克制融入顶栏小面板与 Agent 设置页。
 */
export function UsageSourceBadge({
  agentDisplayName,
  sourceMeta,
  unavailableCode,
  fallbackSourceLabel
}: UsageSourceBadgeProps) {
  const L = useBi();
  const isMagpie = sourceMeta?.service === 'magpie';
  const isMagpieIssue = isMagpie && (unavailableCode === 'magpie_unreachable' || unavailableCode === 'magpie_auth_required');
  const providerName = sourceMeta?.providerName || fallbackSourceLabel;

  let badgeLabel: string;
  let badgeTone: 'magpie' | 'magpie_warn' | 'official';
  if (isMagpieIssue) {
    badgeTone = 'magpie_warn';
    badgeLabel = unavailableCode === 'magpie_auth_required' ? L("Magpie · 需授权", "Magpie · Auth Needed") : L("Magpie · 未连接", "Magpie · Offline");
  } else if (isMagpie) {
    badgeTone = 'magpie';
    badgeLabel = providerName ? L(`来源：Magpie · ${providerName}`, `Source: Magpie · ${providerName}`) : L("来源：Magpie", "Source: Magpie");
  } else {
    badgeTone = 'official';
    badgeLabel = L("来源：官方直连", "Source: Official");
  }

  const badgeClass = badgeTone === 'magpie'
    ? 'border-sky-200 bg-sky-50/90 text-sky-700'
    : badgeTone === 'magpie_warn'
      ? 'border-amber-200 bg-amber-50/90 text-amber-700'
      : 'border-zinc-200 bg-white text-zinc-500';

  const endpointText = sourceMeta?.endpoint;
  const localPrefix = isLocalOrigin(endpointText) ? L("本机 ", "Local ") : '';

  const tooltipContent = isMagpie ? (
    <div className="space-y-1">
      <div className="font-medium text-zinc-900">
        {isMagpieIssue
          ? (unavailableCode === 'magpie_auth_required' ? L("Magpie 网关需要读取权限", "Magpie gateway requires read permission") : L("Magpie 网关暂未连接", "Magpie gateway is offline"))
          : providerName
            ? L(`已识别 Magpie 供应商：${providerName}`, `Detected Magpie provider: ${providerName}`)
            : L("已识别本机 Magpie 网关", "Local Magpie gateway detected")}
      </div>
      <div className="text-[11px] leading-4 text-zinc-600">
        
        {L("检测到当前", "Detected ")} {agentDisplayName}  {L("经由", " routed via ")}{localPrefix}Magpie{endpointText ? `（${endpointText}）` : ''}{L("路由", "")}
      </div>
      <div className="text-[11px] leading-4 text-zinc-500">
        {matchedByText(sourceMeta!.matchedBy, sourceMeta!.matchedModel, providerName)}
      </div>
      {sourceMeta!.accountCount && sourceMeta!.accountCount > 1 && (
        <div className="text-[11px] leading-4 text-zinc-500">
          
          {L("账号池：共", "Account pool: ")} {sourceMeta!.accountCount}  {L("个启用账号汇总", " active account(s)")}
          {sourceMeta!.activeAccount ? L(` · 当前活跃 ${sourceMeta!.activeAccount}`, ` · Active: ${sourceMeta!.activeAccount}`) : ''}
        </div>
      )}
      {sourceMeta!.gatewayVersion && (
        <div className="text-[10.5px] text-zinc-400">Magpie v{sourceMeta!.gatewayVersion}</div>
      )}
    </div>
  ) : (
    <div className="space-y-1">
      <div className="font-medium text-zinc-900">{L("官方直连额度", "Official Direct Quota")}</div>
      <div className="text-[11px] leading-4 text-zinc-600">
        
        {L("当前", "")} {agentDisplayName}  {L("未经 Magpie 代理，直接读取", " connects directly to ")} {providerName ?? L("官方", "official")}  {L("额度。", " quota.")}
      </div>
    </div>
  );

  return (
    <HoverTooltip content={tooltipContent}>
      <span
        tabIndex={0}
        data-usage-source-badge={badgeTone}
        className={`inline-flex max-w-full cursor-default items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-zinc-400/50 ${badgeClass}`}
      >
        {badgeTone === 'magpie'
          ? <Waypoints size={11} className="shrink-0"/>
          : badgeTone === 'magpie_warn'
            ? <AlertTriangle size={11} className="shrink-0"/>
            : <ShieldCheck size={11} className="shrink-0 text-zinc-400"/>}
        <span className="truncate">{badgeLabel}</span>
      </span>
    </HoverTooltip>
  );
}
