import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bell,
  BellOff,
  BellRing,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Info,
  Laptop,
  PauseCircle,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  SlidersHorizontal,
  Terminal,
  Trash2,
  Volume2,
  VolumeX,
  Webhook,
  X,
  XCircle
} from 'lucide-react';
import { Input, InputNumber, Select, Switch } from 'antd';
import {
  api,
  type LarkNotifyTargetMode,
  type NotificationChannelDeliveryStatus,
  type NotificationEventKind,
  type NotificationServerConfig,
  type NotificationTestResult,
  type NotificationWebhookConfig,
  type ScheduledNotifyMode,
  type WebhookPreset
} from './api';
import { DeferredMount, DeferredSkeleton } from './DeferredMount';
import { HoverTooltip } from './HoverTooltip';
import { Spinner } from './Loaders';
import { IconButton, SettingRow } from './ui-controls';
import { useModalFocusTrap } from './useModalFocusTrap';
import {
  DEFAULT_SERVER_NOTIFICATION_CONFIG,
  MASKED_SECRET_SENTINEL,
  WEBHOOK_PRESET_META,
  desktopNotificationsApi,
  detectBrowserNotificationEnv,
  playNotificationSound,
  requestBrowserNotificationPermission,
  useLocalNotificationPrefs,
  type NotificationSoundTheme
} from './notifications-local';
import { bi, useBi } from './i18n';

type DialogTab = 'rules' | 'local' | 'lark' | 'extensions';

const DURATION_PRESETS = [
  { value: 0, get label() { return bi("不限", "No min"); } },
  { value: 5, get label() { return bi("5 秒", "5s"); } },
  { value: 10, get label() { return bi("10 秒", "10s"); } },
  { value: 30, get label() { return bi("30 秒", "30s"); } },
  { value: 60, get label() { return bi("60 秒", "60s"); } }
] as const;

const SOUND_THEMES: Array<{ value: NotificationSoundTheme; label: string; hint: string }> = [
  { value: 'chime', get label() { return bi("清脆双音", "Crisp Chime"); }, get hint() { return bi("明快干净的轻叮声", "Clean, bright double chime"); } },
  { value: 'soft', get label() { return bi("温润木琴", "Warm Marimba"); }, get hint() { return bi("柔和低频、不打断思路", "Gentle low tone, non-intrusive"); } },
  { value: 'crystal', get label() { return bi("通透铃音", "Crystal Bell"); }, get hint() { return bi("轻盈高频泛音", "Light high-frequency shimmer"); } }
];

const WEBHOOK_PRESET_ORDER: WebhookPreset[] = [
  'generic',
  'lark_webhook',
  'dingtalk',
  'wecom',
  'bark',
  'ntfy',
  'slack',
  'discord'
];

const SHELL_HOOK_ENV_VARS = [
  { name: 'AGENTDOCK_NOTIFY_EVENT', get desc() { return bi("事件类型：completed / failed / waiting_approval / notify", "Event kind: completed / failed / waiting_approval / notify"); } },
  { name: 'AGENTDOCK_SESSION_ID', get desc() { return bi("触发通知的会话 ID", "Session ID that triggered the alert"); } },
  { name: 'AGENTDOCK_SESSION_TITLE', get desc() { return bi("会话标题（用于弹窗或消息抬头）", "Session title (used in notification headers)"); } },
  { name: 'AGENTDOCK_AGENT_ID', get desc() { return bi("执行的 Agent ID（如 claude / codex）", "Agent ID (e.g., claude / codex)"); } },
  { name: 'AGENTDOCK_STATUS', get desc() { return bi("当前状态标识", "Current status code"); } },
  { name: 'AGENTDOCK_DURATION_MS', get desc() { return bi("本轮运行耗时（毫秒）", "Turn duration in milliseconds"); } },
  { name: 'AGENTDOCK_SUMMARY', get desc() { return bi("最终回答摘要（纯文本）", "Plain-text summary of final reply"); } },
  { name: 'AGENTDOCK_ERROR', get desc() { return bi("失败原因（仅失败时有值）", "Error message (present only on failure)"); } },
  { name: 'AGENTDOCK_SESSION_URL', get desc() { return bi("会话直达链接（已配公网/Web 基址时有值）", "Direct session URL (when Web Base URL is configured)"); } }
] as const;

function StatusPill({ tone, children }: { tone: 'emerald' | 'amber' | 'red' | 'zinc' | 'blue'; children: ReactNode }) {
  const styles: Record<typeof tone, string> = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    red: 'border-red-200 bg-red-50 text-red-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    zinc: 'border-zinc-200 bg-zinc-50 text-zinc-500'
  };
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${styles[tone]}`}>
      {children}
    </span>
  );
}

function InlineTestFeedback({ result }: { result?: NotificationTestResult | { ok: boolean; durationMs?: number; detail?: string; error?: string; consoleUrl?: string } }) {
  const L = useBi();
  if (!result) return null;
  return (
    <div
      role="status"
      className={`mt-2.5 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-5 ${
        result.ok
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-red-200 bg-red-50 text-red-700'
      }`}
    >
      {result.ok
        ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600"/>
        : <XCircle size={14} className="mt-0.5 shrink-0 text-red-500"/>}
      <div className="min-w-0 flex-1 break-words">
        <div className="font-medium">
          {result.ok ? L("测试通知已送达", "Test notification delivered") : L("测试通知发送失败", "Test notification failed")}
          {typeof result.durationMs === 'number' && result.durationMs >= 0 && (
            <span className="ml-1.5 font-mono text-[11px] font-normal opacity-80">{result.durationMs}ms</span>
          )}
        </div>
        {(result.detail || result.error) && (
          <div className="mt-0.5 opacity-90">{result.ok ? result.detail : result.error}</div>
        )}
        {!result.ok && result.consoleUrl && (
          <a
            href={result.consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 font-medium underline underline-offset-2"
          >
            
            {L("前往飞书开放平台开通权限", "Enable permission in Lark Open Platform")}
            <ExternalLink size={11}/>
          </a>
        )}
      </div>
    </div>
  );
}

function SegmentedPills<T extends string | number>({
  value,
  options,
  onChange,
  disabled = false
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(value: T): void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-50 dark:ring-1 dark:ring-zinc-200/80">
      {options.map(option => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`h-7 rounded-md px-2.5 text-[12px] font-medium transition-all disabled:opacity-50 ${
              active
                ? 'bg-white text-zinc-900 shadow-[0_1px_2px_rgba(0,0,0,.07)] ring-1 ring-zinc-200/80 dark:bg-zinc-200 dark:ring-zinc-300/80'
                : 'text-zinc-500 hover:text-zinc-800'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function CompactSwitchRow({
  title,
  description,
  children
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3.5 border-t border-zinc-100 px-4 py-3.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] text-zinc-900">{title}</div>
        {description && <div className="mt-0.5 text-[12px] leading-5 text-zinc-500">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>
    </div>
  );
}

function SectionCard({
  title,
  description,
  icon,
  badge,
  action,
  children,
  muted = false,
  stackActionOnMobile = false
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  badge?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  muted?: boolean;
  stackActionOnMobile?: boolean;
}) {
  return (
    <section className={`overflow-hidden rounded-xl border border-zinc-200 bg-white transition-opacity ${muted ? 'opacity-60' : ''}`}>
      <div
        className={`flex gap-3 border-b border-zinc-100 px-4 py-3 ${
          stackActionOnMobile
            ? 'flex-col sm:flex-row sm:items-start sm:justify-between'
            : 'items-start justify-between'
        }`}
      >
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          {icon && (
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-zinc-200/80 bg-zinc-50 text-zinc-600">
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[14px] font-semibold text-zinc-900">{title}</h3>
              {badge}
            </div>
            {description && <p className="mt-0.5 text-[12px] leading-5 text-zinc-500">{description}</p>}
          </div>
        </div>
        {action && (
          <div className={`flex shrink-0 items-center gap-2 ${stackActionOnMobile ? 'pl-9 sm:pl-0' : ''}`}>
            {action}
          </div>
        )}
      </div>
      <div>{children}</div>
    </section>
  );
}

function createEmptyWebhook(): NotificationWebhookConfig {
  return {
    id: `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: bi("自定义 Webhook", "Custom Webhook"),
    enabled: true,
    preset: 'generic',
    url: '',
    headers: [],
    timeoutSec: 8
  };
}

function serializeDraftForSave(draft: NotificationServerConfig): NotificationServerConfig {
  return {
    ...draft,
    webhooks: draft.webhooks.map(hook => ({
      ...hook,
      // 保留密文语义：用户未主动编辑 secret 时传哨兵给后端保留原密文
      secret: hook.secret === undefined && hook.hasSecret ? MASKED_SECRET_SENTINEL : hook.secret
    }))
  };
}

function formatRecentDeliveryLabel(status?: NotificationChannelDeliveryStatus): string | undefined {
  if (!status) return undefined;
  return status.ok
    ? bi(`上次成功 · ${status.durationMs}ms`, `Last OK · ${status.durationMs}ms`)
    : bi(`上次失败 · ${status.error ? status.error.slice(0, 28) : '出错'}`, `Last failed · ${status.error ? status.error.slice(0, 28) : 'Error'}`);
}

export function NotificationSettingsDialog({
  onClose,
  onOpenLarkSettings,
  embedded = false
}: {
  onClose(): void;
  onOpenLarkSettings(): void;
  embedded?: boolean;
}) {
  const L = useBi();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: closeRef, dismissible: true, onDismiss: onClose, enabled: !embedded });
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<DialogTab>('rules');
  const [localPrefs, patchLocalPrefs] = useLocalNotificationPrefs();
  const [envState, setEnvState] = useState(() => detectBrowserNotificationEnv());
  const [desktopCaps, setDesktopCaps] = useState<{ supported: boolean; platform: string }>();

  const configQuery = useQuery({
    queryKey: ['notifications-config'],
    queryFn: api.notificationsConfig,
    refetchOnWindowFocus: false
  });
  const larkConfigQuery = useQuery({
    queryKey: ['lark-config'],
    queryFn: api.larkConfig,
    refetchOnWindowFocus: false
  });

  const [draft, setDraft] = useState<NotificationServerConfig>(DEFAULT_SERVER_NOTIFICATION_CONFIG);
  const [hydrated, setHydrated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveNotice, setSaveNotice] = useState<{ ok: boolean; text: string }>();

  // 本机试听 & 弹窗测试反馈
  const [soundTesting, setSoundTesting] = useState<NotificationEventKind | null>(null);
  const [localTestResult, setLocalTestResult] = useState<{ ok: boolean; durationMs?: number; detail?: string; error?: string }>();

  // 远端通道测试结果
  const [larkTestResult, setLarkTestResult] = useState<NotificationTestResult>();
  const [webhookTestResults, setWebhookTestResults] = useState<Record<string, NotificationTestResult>>({});
  const [commandTestResult, setCommandTestResult] = useState<NotificationTestResult>();
  const [testingKey, setTestingKey] = useState<string | null>(null);

  // Webhook 展开编辑态 & Hook 环境变量速查展开
  const [expandedWebhookId, setExpandedWebhookId] = useState<string | null>(null);
  const [envVarsOpen, setEnvVarsOpen] = useState(false);

  // 探测桌面原生能力与刷新浏览器权限状态
  useEffect(() => {
    const desktop = desktopNotificationsApi();
    if (desktop) {
      void desktop.getCapabilities().then(caps => setDesktopCaps(caps)).catch(() => undefined);
    }
    setEnvState(detectBrowserNotificationEnv());
  }, []);

  // 远端配置水合到表单草稿
  useEffect(() => {
    if (!configQuery.data || hydrated) return;
    setDraft(configQuery.data.config);
    setHydrated(true);
    setDirty(false);
  }, [configQuery.data, hydrated]);

  const larkBots = larkConfigQuery.data?.bots ?? [];
  const effectiveLarkAppId = draft.lark.appId || larkBots[0]?.appId || '';

  const larkChatsQuery = useQuery({
    queryKey: ['lark-bot-chats', effectiveLarkAppId],
    queryFn: () => api.larkBotChats(effectiveLarkAppId),
    enabled: Boolean(effectiveLarkAppId && tab === 'lark'),
    staleTime: 60_000,
    refetchOnWindowFocus: false
  });

  const larkOwnerQuery = useQuery({
    queryKey: ['lark-app-owner', effectiveLarkAppId],
    queryFn: () => api.larkAppOwner(effectiveLarkAppId),
    enabled: Boolean(effectiveLarkAppId && tab === 'lark'),
    staleTime: 60_000,
    refetchOnWindowFocus: false
  });

  const patchDraft = (updater: (current: NotificationServerConfig) => NotificationServerConfig) => {
    setDraft(current => updater(current));
    setDirty(true);
    setSaveNotice(undefined);
  };

  const saveMutation = useMutation({
    mutationFn: () => api.saveNotificationsConfig(serializeDraftForSave(draft)),
    onSuccess: result => {
      setDraft(result.config);
      setDirty(false);
      queryClient.setQueryData(['notifications-config'], result);
      setSaveNotice({ ok: true, text: L("通知设置已保存并立即生效", "Notification settings saved and active") });
    },
    onError: error => {
      setSaveNotice({ ok: false, text: error instanceof Error ? error.message : String(error) });
    }
  });

  const runRemoteTest = async (channel: 'lark' | 'webhook' | 'command', webhookId?: string) => {
    const key = webhookId ? `webhook:${webhookId}` : channel;
    setTestingKey(key);
    try {
      const result = await api.testNotificationChannel({
        channel,
        ...(webhookId ? { webhookId } : {}),
        draftConfig: serializeDraftForSave(draft)
      });
      if (channel === 'lark') setLarkTestResult(result);
      else if (channel === 'command') setCommandTestResult(result);
      else if (webhookId) setWebhookTestResults(prev => ({ ...prev, [webhookId]: result }));
      void queryClient.invalidateQueries({ queryKey: ['notifications-config'] });
    } catch (error) {
      const failure: NotificationTestResult = {
        channel: key,
        ok: false,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error)
      };
      if (channel === 'lark') setLarkTestResult(failure);
      else if (channel === 'command') setCommandTestResult(failure);
      else if (webhookId) setWebhookTestResults(prev => ({ ...prev, [webhookId]: failure }));
    } finally {
      setTestingKey(null);
    }
  };

  const handleRequestBrowserPermission = async () => {
    const permission = await requestBrowserNotificationPermission();
    const nextEnv = detectBrowserNotificationEnv();
    setEnvState(nextEnv);
    if (permission === 'granted') {
      patchLocalPrefs({ systemPopup: true });
      setLocalTestResult({ ok: true, detail: L("浏览器通知权限已开启，现在可以测试弹窗提醒。", "Browser notifications granted — click Test to preview.") });
    } else if (permission === 'denied') {
      patchLocalPrefs({ systemPopup: false });
      setLocalTestResult({ ok: false, error: L("浏览器拒绝了通知权限，请在地址栏左侧站点设置中手动允许。", "Browser blocked notifications. Enable them in site settings next to the address bar.") });
    } else {
      setLocalTestResult({ ok: false, error: L("当前页面未授予通知权限。", "Notification permission not granted for this page.") });
    }
  };

  const handleTestLocalPopup = async () => {
    const startedAt = Date.now();
    const desktop = desktopNotificationsApi();
    if (desktop) {
      const result = await desktop.show({
        id: `test-${Date.now()}`,
        title: L("AgentDock · 测试通知", "AgentDock · Test Notification"),
        body: L("桌面客户端原生通知已就绪，点击通知可直接拉起并定位会话。", "Native desktop notifications ready — clicking opens the session directly."),
        urgency: 'normal',
        silent: localPrefs.soundEnabled,
        bounce: localPrefs.desktopBounceAndBadge
      }).catch(error => ({ shown: false, reason: error instanceof Error ? error.message : String(error) }));
      if (localPrefs.soundEnabled) {
        void playNotificationSound(localPrefs.soundTheme, 'completed', localPrefs.soundVolume);
      }
      setLocalTestResult(result.shown
        ? { ok: true, durationMs: Date.now() - startedAt, detail: L("已发送系统原生通知（若未弹出请检查系统专注模式 / 勿扰设置）。", "Sent system notification (check OS Focus / Do Not Disturb if unseen).") }
        : { ok: false, durationMs: Date.now() - startedAt, error: result.reason || L("系统未能展示通知", "System could not display notification") });
      return;
    }

    const currentEnv = detectBrowserNotificationEnv();
    setEnvState(currentEnv);
    if (currentEnv.status === 'insecure_http') {
      if (localPrefs.soundEnabled) {
        void playNotificationSound(localPrefs.soundTheme, 'completed', localPrefs.soundVolume);
      }
      setLocalTestResult({
        ok: false,
        durationMs: Date.now() - startedAt,
        error: L("当前为非 HTTPS 局域网地址，浏览器禁止系统弹窗；已改用提示音反馈。", "Browser blocks system popups on non-HTTPS LAN URLs; played sound alert instead.")
      });
      return;
    }
    if (currentEnv.status === 'default') {
      const permission = await requestBrowserNotificationPermission();
      setEnvState(detectBrowserNotificationEnv());
      if (permission !== 'granted') {
        setLocalTestResult({ ok: false, error: L("请先在浏览器提示中点击「允许通知」后再测试。", "Click \"Allow\" in the browser permission prompt first.") });
        return;
      }
      patchLocalPrefs({ systemPopup: true });
    } else if (currentEnv.status !== 'granted') {
      setLocalTestResult({
        ok: false,
        error: currentEnv.status === 'denied'
          ? L("浏览器已禁用本站通知权限，请点击地址栏左侧图标重新允许。", "Notifications are blocked for this site. Re-enable them in the address bar icon.")
          : L("当前浏览器环境不支持 Web Notification API。", "This browser does not support the Web Notification API.")
      });
      return;
    }

    try {
      if (localPrefs.soundEnabled) {
        void playNotificationSound(localPrefs.soundTheme, 'completed', localPrefs.soundVolume);
      }
      const notification = new window.Notification(L("AgentDock · 测试通知", "AgentDock · Test Notification"), {
        body: L("浏览器通知已就绪，Agent 完成长任务或需要审批时将立即提醒你。", "Browser notifications ready — you'll be alerted on completions or approvals."),
        icon: '/pwa-192.png',
        silent: localPrefs.soundEnabled
      });
      notification.onclick = () => { window.focus(); notification.close(); };
      setLocalTestResult({ ok: true, durationMs: Date.now() - startedAt, detail: L("已弹出浏览器系统通知并播放提示音。", "Displayed browser notification and played chime.") });
    } catch (error) {
      setLocalTestResult({ ok: false, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const handlePreviewSound = async (kind: NotificationEventKind = 'completed') => {
    setSoundTesting(kind);
    const played = await playNotificationSound(localPrefs.soundTheme, kind, localPrefs.soundVolume);
    if (!played) {
      setLocalTestResult({ ok: false, error: L("当前浏览器未能初始化 Web Audio 音频上下文。", "Could not initialize Web Audio context in this browser.") });
    }
    window.setTimeout(() => setSoundTesting(current => (current === kind ? null : current)), 480);
  };

  const activeExtensionCount = useMemo(() => {
    const webhooks = draft.webhooks.filter(hook => hook.enabled).length;
    const command = draft.commandHook.enabled && draft.commandHook.command.trim() ? 1 : 0;
    return webhooks + command;
  }, [draft.webhooks, draft.commandHook]);

  const envBadge = useMemo(() => {
    if (envState.status === 'desktop') {
      return <StatusPill tone="emerald"><Laptop size={11}/>{L("桌面原生", "Desktop Native")}</StatusPill>;
    }
    if (envState.status === 'granted') {
      return <StatusPill tone="emerald"><Check size={11}/>{L("浏览器已授权", "Browser Allowed")}</StatusPill>;
    }
    if (envState.status === 'insecure_http') {
      return <StatusPill tone="amber"><AlertTriangle size={11}/>{L("局域网降级", "LAN Fallback")}</StatusPill>;
    }
    if (envState.status === 'denied') {
      return <StatusPill tone="red"><BellOff size={11}/>{L("浏览器已禁用", "Browser Blocked")}</StatusPill>;
    }
    if (envState.status === 'default') {
      return <StatusPill tone="zinc"><Bell size={11}/>{L("未授权弹窗", "Permission Needed")}</StatusPill>;
    }
    return <StatusPill tone="zinc"><BellOff size={11}/>{L("不支持弹窗", "Unsupported")}</StatusPill>;
  }, [envState.status]);

  const lastDelivery = configQuery.data?.lastDelivery ?? {};
  const isCustomDuration = !DURATION_PRESETS.some(preset => preset.value === draft.antiSpam.minDurationSec);

  const tabItems: Array<{ id: DialogTab; label: string; mobileLabel: string; icon: ReactNode; dot?: 'emerald' | 'amber' }> = [
    {
      id: 'rules',
      label: L("触发与降噪", "Triggers & Noise"),
      mobileLabel: L("触发降噪", "Triggers"),
      icon: <SlidersHorizontal size={13}/>,
      dot: draft.enabled ? 'emerald' : undefined
    },
    {
      id: 'local',
      label: L("本机提醒", "Local Alerts"),
      mobileLabel: L("本机提醒", "Local Alerts"),
      icon: <BellRing size={13}/>,
      dot: envState.status === 'insecure_http' || envState.status === 'denied'
        ? 'amber'
        : (localPrefs.systemPopup || localPrefs.soundEnabled) ? 'emerald' : undefined
    },
    {
      id: 'lark',
      label: L("飞书推送", "Lark Push"),
      mobileLabel: L("飞书推送", "Lark Push"),
      icon: <Send size={13}/>,
      dot: draft.lark.enabled ? 'emerald' : undefined
    },
    {
      id: 'extensions',
      label: activeExtensionCount > 0 ? L(`Webhook 与 Hook (${activeExtensionCount})`, `Webhooks & Hooks (${activeExtensionCount})`) : L("Webhook 与 Hook", "Webhooks & Hooks"),
      mobileLabel: activeExtensionCount > 0 ? L(`扩展(${activeExtensionCount})`, `Ext (${activeExtensionCount})`) : L("扩展", "Extensions"),
      icon: <Webhook size={13}/>,
      dot: activeExtensionCount > 0 ? 'emerald' : undefined
    }
  ];

  const updateWebhook = (id: string, updater: (hook: NotificationWebhookConfig) => NotificationWebhookConfig) => {
    patchDraft(current => ({
      ...current,
      webhooks: current.webhooks.map(item => (item.id === id ? updater(item) : item))
    }));
  };

  const addWebhook = () => {
    const created = createEmptyWebhook();
    patchDraft(current => ({ ...current, webhooks: [...current.webhooks, created] }));
    setExpandedWebhookId(created.id);
  };

  const removeWebhook = (id: string) => {
    patchDraft(current => ({ ...current, webhooks: current.webhooks.filter(item => item.id !== id) }));
    if (expandedWebhookId === id) setExpandedWebhookId(null);
  };

  const content = (
      <div
        ref={panelRef}
        role={embedded ? undefined : 'dialog'}
        aria-modal={embedded ? undefined : 'true'}
        aria-label={embedded ? undefined : L("通知设置", "Notification Settings")}
        className={embedded
          ? 'flex min-h-0 flex-1 flex-col overflow-hidden bg-white'
          : 'ui-dialog flex h-[100dvh] w-full max-w-none flex-col overflow-hidden rounded-none border-0 border-zinc-200 bg-white shadow-[0_24px_80px_rgba(0,0,0,.28)] sm:h-[min(740px,calc(100dvh-2.5rem))] sm:max-w-[760px] sm:rounded-[14px] sm:border'}
      >
        {/* 顶栏 */}
        <div className={`flex shrink-0 items-center justify-between gap-2.5 border-b border-zinc-100 ${embedded ? 'px-4 py-2.5 sm:px-5' : 'px-3.5 py-3 sm:px-5'}`}>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {!embedded && (
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-800">
                <Bell size={17} strokeWidth={1.9}/>
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className={`${embedded ? 'text-[14px]' : 'text-[16px]'} font-semibold tracking-[-.01em] text-zinc-900`}>{L("通知渠道与规则", "Notification Channels & Rules")}</h2>
                {envBadge}
              </div>
              <p className="mt-0.5 hidden text-[12px] leading-[1.45] text-zinc-500 sm:block">
                {L("Agent 完成、失败或等待审批时，通过本机、飞书或 Webhook 及时反馈", "Alerts via desktop, Lark, or Webhooks on completion, failure, or approval")}
              </p>
              <p className="mt-0.5 truncate text-[11.5px] text-zinc-500 sm:hidden">
                
                {L("完成、失败或等待审批时及时提醒", "Alerts on completion, failure, or approval")}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50/80 px-2.5 py-1 text-[12px] font-medium text-zinc-700">
              <span className="max-sm:hidden">{draft.enabled ? L("通知已开启", "Notifications On") : L("通知已暂停", "Notifications Paused")}</span>
              <Switch
                size="small"
                aria-label={L("通知总开关", "Master notification toggle")}
                checked={draft.enabled}
                onChange={checked => patchDraft(current => ({ ...current, enabled: checked }))}
              />
            </label>
            {!embedded && (
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label={L("关闭通知设置", "Close notification settings")}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
              >
                <X size={16}/>
              </button>
            )}
          </div>
        </div>

        {/* 导航分区栏 */}
        <div
          role="tablist"
          aria-label={L("通知设置分区", "Notification sections")}
          className="grid shrink-0 grid-cols-4 gap-1 border-b border-zinc-100 bg-zinc-50/70 px-2.5 py-2 sm:flex sm:items-center sm:gap-1 sm:px-5"
        >
          {tabItems.map(item => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className={`flex h-8 min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-1.5 text-[11.5px] font-medium transition-all sm:shrink-0 sm:justify-start sm:gap-1.5 sm:px-3 sm:text-[12.5px] ${
                  active
                    ? 'bg-white text-zinc-900 shadow-[0_1px_2px_rgba(0,0,0,.06)] ring-1 ring-zinc-200/90 dark:bg-zinc-100 dark:ring-zinc-300/75'
                    : 'text-zinc-500 hover:bg-white/60 hover:text-zinc-800 dark:hover:bg-zinc-100/50'
                }`}
              >
                <span className={`shrink-0 max-[360px]:hidden ${active ? 'text-zinc-800' : 'text-zinc-400'}`}>{item.icon}</span>
                <span className="truncate sm:hidden">{item.mobileLabel}</span>
                <span className="hidden sm:inline">{item.label}</span>
                {item.dot && (
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      item.dot === 'emerald' ? 'bg-emerald-500' : 'bg-amber-500'
                    }`}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* 主体滚动区 */}
        <DeferredMount placeholder={<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5"><DeferredSkeleton/></div>}>
          <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-50/40 px-3.5 py-4 sm:px-5">
            {configQuery.isLoading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-zinc-400">
                <Spinner size={14}/>{L("正在加载通知设置…", "Loading notification settings…")}
              </div>
            ) : (
              <div className="space-y-4">
                {!draft.enabled && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] leading-5 text-amber-800">
                    <PauseCircle size={15} className="mt-0.5 shrink-0 text-amber-600"/>
                    <div>{L("全局通知总开关已暂停，Agent 轮次结束将不再推送任何通道提醒；点击右上角开关可随时恢复。", "Global notifications are paused. Toggle the master switch above to resume alerts.")}</div>
                  </div>
                )}

                {/* ==================== TAB 1: 触发与降噪 ==================== */}
                {tab === 'rules' && (
                  <>
                    <SectionCard
                      title={L("触发事件", "Trigger Events")}
                      description={L("选择哪些运行状态变化需要通知；用户手动点击「停止 / 中断」永远不会触发打扰。", "Choose which state changes notify you; manual stops never trigger alerts.")}
                      icon={<Bell size={14}/>}
                      muted={!draft.enabled}
                    >
                      <div className="grid gap-2.5 p-4 sm:grid-cols-3">
                        {[
                          {
                            key: 'completed' as const,
                            checked: draft.events.completed,
                            title: L("正常完成", "Completed"),
                            desc: L("Agent 产出最终结果并结束本轮", "Agent produced final output and finished the turn"),
                            dot: 'bg-emerald-500',
                            onToggle: (v: boolean) => patchDraft(c => ({ ...c, events: { ...c.events, completed: v } }))
                          },
                          {
                            key: 'failed' as const,
                            checked: draft.events.failed,
                            title: L("失败报错", "Failed / Error"),
                            desc: L("运行出错、超时或异常退出（无视时长阈值）", "Errors, timeouts, or crashes (always alerts immediately)"),
                            dot: 'bg-red-500',
                            onToggle: (v: boolean) => patchDraft(c => ({ ...c, events: { ...c.events, failed: v } }))
                          },
                          {
                            key: 'waitingApproval' as const,
                            checked: draft.events.waitingApproval,
                            title: L("等待审批 / 拍板", "Approval / Input Needed"),
                            desc: L("高危工具请求授权，或小猫主动请你拍板", "High-risk permission request or companion needs your decision"),
                            dot: 'bg-orange-500',
                            onToggle: (v: boolean) => patchDraft(c => ({ ...c, events: { ...c.events, waitingApproval: v } }))
                          }
                        ].map(item => (
                          <button
                            key={item.key}
                            type="button"
                            aria-pressed={item.checked}
                            onClick={() => item.onToggle(!item.checked)}
                            className={`group flex flex-col items-start rounded-xl border p-3 text-left transition-all ${
                              item.checked
                                ? 'border-zinc-300 bg-zinc-50/90 shadow-[0_1px_2px_rgba(0,0,0,.04)] dark:border-zinc-300 dark:bg-zinc-100/70'
                                : 'border-zinc-200/80 bg-white opacity-65 hover:opacity-100'
                            }`}
                          >
                            <div className="flex w-full items-center justify-between gap-2">
                              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-zinc-900">
                                <span className={`h-2 w-2 rounded-full ${item.dot}`}/>
                                {item.title}
                              </span>
                              <span
                                className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors ${
                                  item.checked
                                    ? 'border-zinc-900 bg-zinc-900 text-white'
                                    : 'border-zinc-300 bg-white text-transparent'
                                }`}
                              >
                                <Check size={10} strokeWidth={3}/>
                              </span>
                            </div>
                            <p className="mt-1.5 text-[11.5px] leading-4 text-zinc-500">{item.desc}</p>
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-1.5 border-t border-zinc-100 bg-zinc-50/60 px-4 py-2 text-[11.5px] text-zinc-500">
                        <Info size={13} className="shrink-0 text-zinc-400"/>
                        <span>{L("已内置硬保护：你亲手点击「停止 / 中断」或归档会话时，绝不发送通知。", "Built-in safeguard: manually stopping or archiving a session never sends alerts.")}</span>
                      </div>
                    </SectionCard>

                    <SectionCard
                      title={L("防刷屏与降噪", "Anti-Spam & Quiet Rules")}
                      description={L("过滤 2 秒快问快答与密集批处理，只把真正值得关注的时刻送达给你。", "Filter quick 2-second exchanges and noisy bursts.")}
                      icon={<Clock size={14}/>}
                      muted={!draft.enabled}
                    >
                      <SettingRow
                        title={L("最短运行时长阈值", "Minimum Duration Threshold")}
                        description={L("仅运行超过该时长的「正常完成」才通知；失败报错与等待审批始终立即提醒。", "Only notify on completions longer than this duration; failures and approvals always alert.")}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <SegmentedPills
                            value={isCustomDuration ? -1 : draft.antiSpam.minDurationSec}
                            options={[...DURATION_PRESETS]}
                            onChange={val => patchDraft(c => ({ ...c, antiSpam: { ...c.antiSpam, minDurationSec: val } }))}
                          />
                          <InputNumber<number>
                            size="small"
                            min={0}
                            max={3600}
                            value={draft.antiSpam.minDurationSec}
                            suffix="s"
                            aria-label={L("自定义最短运行秒数", "Custom minimum seconds")}
                            className="!w-20 font-mono"
                            onChange={value => patchDraft(c => ({
                              ...c,
                              antiSpam: { ...c.antiSpam, minDurationSec: Math.max(0, Math.min(3600, Math.round(value ?? 0))) }
                            }))}
                          />
                        </div>
                      </SettingRow>

                      <SettingRow
                        title={L("短窗口合并节流", "Short-Window Coalescing")}
                        description={L("远程通道（飞书 / Webhook / Hook）在短窗口内收到多条同类完成事件时合并为一条摘要。", "Combines multiple remote alerts within a short window into one digest.")}
                      >
                        <SegmentedPills
                          value={draft.antiSpam.coalesceWindowMs}
                          options={[
                            { value: 0, label: L("不合并", "Off") },
                            { value: 3000, label: L("3 秒", "3s") },
                            { value: 8000, label: L("8 秒", "8s") }
                          ]}
                          onChange={val => patchDraft(c => ({ ...c, antiSpam: { ...c.antiSpam, coalesceWindowMs: val } }))}
                        />
                      </SettingRow>

                      <CompactSwitchRow
                        title={L("仅离开电脑时推送远程通道", "Remote Push Only When Away")}
                        description={L("开启后，只要桌面客户端或网页前台活跃，飞书 / Webhook / Hook 自动静默，避免在电脑前震动手机。", "Mutes Lark, Webhooks, and Hooks while AgentDock is active on your screen.")}
                      >
                        <div className="flex items-center gap-2">
                          {draft.antiSpam.remoteOnlyWhenAway && (
                            <InputNumber<number>
                              size="small"
                              min={5}
                              max={3600}
                              value={draft.antiSpam.awayAfterSec}
                              suffix="s"
                              aria-label={L("离机判定秒数", "Idle away threshold (seconds)")}
                              className="!w-[72px] font-mono"
                              onChange={value => patchDraft(c => ({
                                ...c,
                                antiSpam: { ...c.antiSpam, awayAfterSec: Math.max(5, Math.min(3600, Math.round(value ?? 30))) }
                              }))}
                            />
                          )}
                          <Switch
                            size="small"
                            aria-label={L("仅离开电脑时推送远程通道", "Remote Push Only When Away")}
                            checked={draft.antiSpam.remoteOnlyWhenAway}
                            onChange={checked => patchDraft(c => ({ ...c, antiSpam: { ...c.antiSpam, remoteOnlyWhenAway: checked } }))}
                          />
                        </div>
                      </CompactSwitchRow>
                    </SectionCard>

                    <SectionCard
                      title={L("会话范围", "Session Scopes")}
                      description={L("按会话来源细粒度控制，避免后台批处理或便签并发派活时消息刷屏。", "Control alerts per session source to prevent background noise.")}
                      icon={<SlidersHorizontal size={14}/>}
                      muted={!draft.enabled}
                    >
                      <CompactSwitchRow
                        title={L("普通会话与主会话", "Regular & Main Sessions")}
                        description={L("包括本地新建会话、外部导入会话、小猫主会话及手动打开的 /btw 侧边聊天。", "Local sessions, imported sessions, companion main session, and manual /btw side chats.")}
                      >
                        <Switch
                          size="small"
                          aria-label={L("通知普通会话与主会话", "Notify for regular & main sessions")}
                          checked={draft.scopes.normalSessions}
                          onChange={checked => patchDraft(c => ({ ...c, scopes: { ...c.scopes, normalSessions: checked } }))}
                        />
                      </CompactSwitchRow>
                      <CompactSwitchRow
                        title={
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span>{L("小猫派出的便签子会话", "Companion Delegated Side Sessions")}</span>
                            <StatusPill tone="zinc">{L("默认静音", "Muted by default")}</StatusPill>
                          </span>
                        }
                        description={L("小猫同时派多个侧边任务时，默认静默子会话、只由主会话统一验收汇报；如需逐个提醒可手动开启。", "Muted by default so only the main companion reports back; enable for per-subtask alerts.")}
                      >
                        <Switch
                          size="small"
                          aria-label={L("通知小猫派出的便签子会话", "Notify for companion subtasks")}
                          checked={draft.scopes.assistantSubtasks}
                          onChange={checked => patchDraft(c => ({ ...c, scopes: { ...c.scopes, assistantSubtasks: checked } }))}
                        />
                      </CompactSwitchRow>
                      <SettingRow
                        title={L("定时任务会话", "Scheduled Sessions")}
                        description={L("后台周期执行的定时任务；推荐设为「仅失败」，异常时第一时间知晓。", "Background recurring tasks — \"Failures Only\" is recommended.")}
                      >
                        <SegmentedPills<ScheduledNotifyMode>
                          value={draft.scopes.scheduledSessions}
                          options={[
                            { value: 'failed_only', label: L("仅失败", "Failures Only") },
                            { value: 'all', label: L("全部", "All") },
                            { value: 'off', label: L("关闭", "Off") }
                          ]}
                          onChange={val => patchDraft(c => ({ ...c, scopes: { ...c.scopes, scheduledSessions: val } }))}
                        />
                      </SettingRow>
                    </SectionCard>
                  </>
                )}

                {/* ==================== TAB 2: 本机提醒 ==================== */}
                {tab === 'local' && (
                  <>
                    {/* 非 HTTPS 局域网降级提示 */}
                    {envState.status === 'insecure_http' && (
                      <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] leading-5 text-amber-800">
                        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600"/>
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold">{L("当前处于非 HTTPS 局域网地址，浏览器禁止系统弹窗", "Browser blocks system popups on non-HTTPS LAN URLs")}</div>
                          <p className="mt-0.5">
                            
                            {L("受浏览器安全策略限制，", "Due to browser security rules, ")}<code className="rounded bg-white/70 px-1 font-mono text-[11px]">{envState.origin || 'http://'}</code>  {L("下无法调用 Web Notification API。", " cannot invoke Web Notification API.")}
                            <strong>{L("提示音、页签标题闪烁与侧边栏未读圆点已自动降级接管", "Sound chimes, tab title flashes, and sidebar unread dots work automatically instead")}</strong>{L("；如需原生系统弹窗，可使用 AgentDock 桌面客户端、通过 HTTPS 访问，或在「飞书推送」中开启手机提醒。", "; for native popups, use the desktop app, HTTPS, or Lark Push.")}
                          </p>
                        </div>
                      </div>
                    )}

                    {envState.status === 'denied' && (
                      <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12px] leading-5 text-red-700">
                        <BellOff size={15} className="mt-0.5 shrink-0 text-red-500"/>
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold">{L("浏览器已拒绝本站的通知权限", "Browser blocked notifications for this site")}</div>
                          <p className="mt-0.5">{L("请点击浏览器地址栏左侧的站点信息图标，将「通知」改为「允许」，然后刷新或重试。", "Click the site info icon in the address bar, set Notifications to Allow, then reload.")}</p>
                        </div>
                      </div>
                    )}

                    <SectionCard
                      title={envState.isDesktop ? L("桌面客户端原生通知", "Desktop Native Notifications") : L("浏览器系统通知", "Browser System Notifications")}
                      description={
                        envState.isDesktop
                          ? L(`复用 Electron 系统原生通知（${desktopCaps?.platform === 'darwin' ? 'macOS 通知中心' : desktopCaps?.platform === 'win32' ? 'Windows 通知中心' : '系统桌面通知'}），不受局域网 HTTP 限制，点击通知可直接唤起窗口定位会话。`, `Uses native OS notifications (${desktopCaps?.platform === 'darwin' ? 'macOS Notification Center' : desktopCaps?.platform === 'win32' ? 'Windows Notification Center' : 'Desktop Notifications'}) without HTTP LAN restrictions.`)
                          : L("当页面在后台或切到其他会话时弹出桌面横幅；点击横幅立即切回对应会话。偏好仅保存在本设备。", "Shows a desktop banner when in the background or another session; clicking jumps straight there. Saved per device.")
                      }
                      icon={envState.isDesktop ? <Laptop size={14}/> : <BellRing size={14}/>}
                      badge={envBadge}
                      stackActionOnMobile
                      action={
                        <div className="flex flex-wrap items-center gap-2">
                          {envState.status === 'default' && (
                            <button
                              type="button"
                              onClick={() => void handleRequestBrowserPermission()}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-[12px] font-medium text-white transition-colors hover:bg-zinc-700"
                            >
                              <Bell size={12}/>{L("一键授权", "Grant Access")}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleTestLocalPopup()}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
                          >
                            <Send size={12}/>{L("发送测试", "Send Test")}
                          </button>
                        </div>
                      }
                    >
                      <CompactSwitchRow
                        title={envState.isDesktop ? L("开启桌面系统弹窗", "Enable Desktop Popups") : L("开启浏览器系统弹窗", "Enable Browser Popups")}
                        description={
                          envState.status === 'insecure_http'
                            ? L("当前局域网 HTTP 环境已自动降级为提示音与页签角标", "Auto-degraded to chimes & tab badges on HTTP LAN")
                            : L("仅对当前设备生效；多个标签页同时打开时自动去重，不重复弹窗", "Per-device setting; deduplicated automatically across multiple open tabs")
                        }
                      >
                        <Switch
                          size="small"
                          aria-label={L("开启系统弹窗通知", "Enable system popup notifications")}
                          disabled={envState.status === 'insecure_http' || envState.status === 'unsupported'}
                          checked={localPrefs.systemPopup && envState.status !== 'insecure_http' && envState.status !== 'denied'}
                          onChange={checked => {
                            if (checked && envState.status === 'default') {
                              void handleRequestBrowserPermission();
                            } else {
                              patchLocalPrefs({ systemPopup: checked });
                            }
                          }}
                        />
                      </CompactSwitchRow>

                      <SettingRow
                        title={L("触发时机（前台智能抑制）", "When to Notify (Foreground Suppression)")}
                        description={L("正在当前窗口查看该会话时永远静默；可选择切到别的会话时是否弹窗。", "Always muted for the session currently on screen.")}
                      >
                        <SegmentedPills
                          value={localPrefs.popupWhen}
                          options={[
                            { value: 'inactive_session', label: L("后台或看其他会话", "Background or Other Session") },
                            { value: 'background_only', label: L("仅窗口在后台", "Background Window Only") }
                          ]}
                          onChange={val => patchLocalPrefs({ popupWhen: val })}
                        />
                      </SettingRow>

                      {envState.isDesktop && (
                        <CompactSwitchRow
                          title={L("Dock 弹跳与未读角标", "Dock Bounce & Unread Badge")}
                          description={L("窗口未聚焦时在 macOS Dock / Windows 任务栏轻跳提示并显示未读数量，回到窗口自动清除。", "Bounces the Dock / taskbar icon and shows unread count while unfocused.")}
                        >
                          <Switch
                            size="small"
                            aria-label={L("开启 Dock 弹跳与角标", "Enable Dock bounce & badge")}
                            checked={localPrefs.desktopBounceAndBadge}
                            onChange={checked => patchLocalPrefs({ desktopBounceAndBadge: checked })}
                          />
                        </CompactSwitchRow>
                      )}

                      {localTestResult && (
                        <div className="border-t border-zinc-100 px-4 pb-3.5 pt-1">
                          <InlineTestFeedback result={localTestResult}/>
                        </div>
                      )}
                    </SectionCard>

                    <SectionCard
                      title={L("轻柔提示音", "Subtle Notification Chime")}
                      description={L("内置 Web Audio 实时合成，零外部音频加载延迟；自动区分完成、失败与等待审批音色。", "Zero-latency Web Audio synthesis with distinct tones for done, failed, and approval.")}
                      icon={localPrefs.soundEnabled ? <Volume2 size={14}/> : <VolumeX size={14}/>}
                      badge={localPrefs.soundEnabled ? <StatusPill tone="emerald">{L("已开启", "On")}</StatusPill> : <StatusPill tone="zinc">{L("已静音", "Muted")}</StatusPill>}
                      action={
                        <Switch
                          size="small"
                          aria-label={L("开启提示音", "Enable notification sound")}
                          checked={localPrefs.soundEnabled}
                          onChange={checked => patchLocalPrefs({ soundEnabled: checked })}
                        />
                      }
                    >
                      <div className={`space-y-4 p-4 transition-opacity ${localPrefs.soundEnabled ? '' : 'pointer-events-none opacity-50'}`}>
                        <div className="grid gap-2 sm:grid-cols-3">
                          {SOUND_THEMES.map(theme => {
                            const active = localPrefs.soundTheme === theme.value;
                            return (
                              <button
                                key={theme.value}
                                type="button"
                                onClick={() => {
                                  patchLocalPrefs({ soundTheme: theme.value });
                                  void playNotificationSound(theme.value, 'completed', localPrefs.soundVolume);
                                }}
                                className={`flex flex-col items-start rounded-xl border px-3 py-2.5 text-left transition-all ${
                                  active
                                    ? 'border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900/10 dark:bg-zinc-100/70'
                                    : 'border-zinc-200 bg-white hover:border-zinc-300'
                                }`}
                              >
                                <span className="text-[13px] font-medium text-zinc-900">{theme.label}</span>
                                <span className="mt-0.5 text-[11.5px] text-zinc-500">{theme.hint}</span>
                              </button>
                            );
                          })}
                        </div>

                        <div className="flex flex-col gap-2.5 rounded-xl border border-zinc-200/80 bg-zinc-50/70 px-3.5 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                          <div className="flex flex-1 items-center gap-3">
                            <span className="shrink-0 text-[12px] font-medium text-zinc-600">{L("音量", "Volume")}</span>
                            <input
                              type="range"
                              min={0.1}
                              max={1}
                              step={0.05}
                              aria-label={L("提示音音量", "Chime volume")}
                              value={localPrefs.soundVolume}
                              onChange={event => patchLocalPrefs({ soundVolume: Number(event.target.value) })}
                              className="h-1.5 min-w-[96px] flex-1 cursor-pointer accent-zinc-900"
                            />
                            <span className="w-9 shrink-0 text-right font-mono text-[12px] tabular-nums text-zinc-500">
                              {Math.round(localPrefs.soundVolume * 100)}%
                            </span>
                          </div>
                          <div className="grid grid-cols-3 gap-1.5 sm:flex sm:shrink-0 sm:items-center">
                            {([
                              { kind: 'completed' as const, label: L("试听完成", "Test Done") },
                              { kind: 'waiting_approval' as const, label: L("审批", "Approval") },
                              { kind: 'failed' as const, label: L("失败", "Failed") }
                            ]).map(sample => (
                              <button
                                key={sample.kind}
                                type="button"
                                onClick={() => void handlePreviewSound(sample.kind)}
                                className={`inline-flex h-7 items-center justify-center gap-1 rounded-md border px-2 text-[11.5px] font-medium transition-colors ${
                                  soundTesting === sample.kind
                                    ? 'border-zinc-900 bg-zinc-900 text-white'
                                    : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100'
                                }`}
                              >
                                <Play size={10} className="fill-current"/>
                                {sample.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </SectionCard>

                    <SectionCard
                      title={L("页面角标与侧边栏轻提示", "Tab Badge & Sidebar Indicators")}
                      description={L("零权限依赖，在所有浏览器与局域网环境下均稳定生效。", "Requires zero permissions and works in every browser and LAN setup.")}
                      icon={<Bell size={14}/>}
                    >
                      <CompactSwitchRow
                        title={L("侧边栏未读完成点", "Sidebar Unread Dot")}
                        description={L("其他会话完成或需要审批时，在侧边栏会话行右侧亮起柔和圆点，点进即消。", "Highlights inactive sessions with a subtle dot until opened.")}
                      >
                        <Switch
                          size="small"
                          aria-label={L("开启侧边栏未读完成点", "Enable sidebar unread dot")}
                          checked={localPrefs.sidebarUnreadDot}
                          onChange={checked => patchLocalPrefs({ sidebarUnreadDot: checked })}
                        />
                      </CompactSwitchRow>
                      <CompactSwitchRow
                        title={L("浏览器标签页标题提醒", "Browser Tab Title Alert")}
                        description={L("标签页处于后台时显示 (N) 未读计数并温和交替提示，切回页面即恢复。", "Displays (N) unread count in the tab title while in the background.")}
                      >
                        <Switch
                          size="small"
                          aria-label={L("开启标签页标题提醒", "Enable tab title alerts")}
                          checked={localPrefs.tabTitleBadge}
                          onChange={checked => patchLocalPrefs({ tabTitleBadge: checked })}
                        />
                      </CompactSwitchRow>
                    </SectionCard>
                  </>
                )}

                {/* ==================== TAB 3: 飞书机器人推送 ==================== */}
                {tab === 'lark' && (
                  <SectionCard
                    title={L("飞书机器人主动推送", "Lark Bot Push Notifications")}
                    description={L("复用已绑定的飞书自建机器人，向本人私聊、指定群或当前托管群发送状态卡片与会话直达链接，离开电脑也能用手机掌握进度。", "Uses a configured Lark bot to push status cards and direct session links to your DM or group.")}
                    icon={<Send size={14}/>}
                    stackActionOnMobile
                    badge={
                      !larkBots.length
                        ? <StatusPill tone="zinc">{L("未绑定机器人", "No Bot Bound")}</StatusPill>
                        : draft.lark.enabled
                          ? <StatusPill tone="emerald"><Check size={11}/>{L("已启用", "Enabled")}</StatusPill>
                          : <StatusPill tone="zinc">{L("未开启", "Off")}</StatusPill>
                    }
                    action={
                      larkBots.length > 0 ? (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={testingKey === 'lark'}
                            onClick={() => void runRemoteTest('lark')}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
                          >
                            {testingKey === 'lark' ? <Spinner size={12}/> : <Send size={12}/>}
                            
                            {L("发送测试", "Send Test")}
                          </button>
                          <Switch
                            size="small"
                            aria-label={L("启用飞书机器人推送", "Enable Lark bot push")}
                            checked={draft.lark.enabled}
                            onChange={checked => patchDraft(c => ({
                              ...c,
                              lark: { ...c.lark, enabled: checked, appId: c.lark.appId || larkBots[0]?.appId }
                            }))}
                          />
                        </div>
                      ) : undefined
                    }
                  >
                    {!larkBots.length ? (
                      <div>
                        <div className="flex flex-col items-start gap-3.5 p-5 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <div className="text-[13.5px] font-semibold text-zinc-900">{L("尚未绑定飞书自建机器人", "No Lark Bot Configured Yet")}</div>
                            <p className="mt-1 text-[12px] leading-5 text-zinc-500">
                              
                              {L("绑定后即可自动向本人私聊或托管群推送状态卡片；如果你只需向飞书群发提醒，也可直接配置飞书自定义群机器人 Webhook。", "Configure a Lark bot to push status cards to DMs or hosted groups, or use a Lark Group Webhook instead.")}
                            </p>
                          </div>
                          <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">
                            <button
                              type="button"
                              onClick={onOpenLarkSettings}
                              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-zinc-700"
                            >
                              
                              {L("前往飞书设置", "Go to Lark Settings")}
                              <ExternalLink size={12}/>
                            </button>
                            <button
                              type="button"
                              onClick={() => setTab('extensions')}
                              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
                            >
                              <Webhook size={12}/>
                              
                              {L("改用飞书群 Webhook", "Use Lark Webhook Instead")}
                            </button>
                          </div>
                        </div>

                        <div className="grid gap-2.5 border-t border-zinc-100 bg-zinc-50/50 p-4 sm:grid-cols-3">
                          {[
                            {
                              title: L("智能跟随原群", "Smart Group Routing"),
                              desc: L("已托管给飞书群的会话自动回推原群，未托管会话直达本人私聊或指定提醒群。", "Routes hosted sessions back to their group; others go to your DM or fallback target.")
                            },
                            {
                              title: L("卡片摘要 + 直达按钮", "Summary Card + Direct Link"),
                              desc: L("包含状态、耗时、最终回答前 200 字纯文本摘要，并附自动签名的直达会话链接。", "Includes status, duration, 200-char reply preview, and a signed session link.")
                            },
                            {
                              title: L("离机推送防打扰", "Away-Only Quiet Mode"),
                              desc: L("配合「仅离开电脑时推送」在桌前自动静默，原群已有机器人回复时自动去重。", "Stays silent while you're active at the keyboard and avoids duplicate group cards.")
                            }
                          ].map(feature => (
                            <div
                              key={feature.title}
                              className="rounded-xl border border-zinc-200/80 bg-white px-3 py-2.5"
                            >
                              <div className="text-[12.5px] font-medium text-zinc-900">{feature.title}</div>
                              <p className="mt-1 text-[11.5px] leading-4 text-zinc-500">{feature.desc}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <>
                        <SettingRow
                          title={L("发送机器人", "Sender Bot")}
                          description={formatRecentDeliveryLabel(lastDelivery.lark) ?? L("选择用于主动发消息的飞书应用机器人", "Select the Lark bot used to deliver notifications")}
                        >
                          <Select
                            className="w-full min-[520px]:w-56"
                            size="middle"
                            value={effectiveLarkAppId}
                            onChange={appId => patchDraft(c => ({ ...c, lark: { ...c.lark, appId } }))}
                            options={larkBots.map(bot => ({
                              value: bot.appId,
                              label: bot.tabLabel || bot.name || bot.appId
                            }))}
                          />
                        </SettingRow>

                        <SettingRow
                          title={L("推送目标策略", "Delivery Target Policy")}
                          description={L("推荐「智能跟随」：已托管给飞书群的会话发往原托管群，其余会话走兜底目标。", "Recommended: Smart Follow routes hosted sessions to their group and others to your fallback target.")}
                        >
                          <SegmentedPills<LarkNotifyTargetMode>
                            value={draft.lark.mode}
                            options={[
                              { value: 'auto_handover_then_fallback', label: L("智能跟随", "Smart Follow") },
                              { value: 'direct_user', label: L("私聊本人", "DM Me") },
                              { value: 'chat', label: L("指定群聊", "Specific Group") }
                            ]}
                            onChange={mode => patchDraft(c => ({
                              ...c,
                              lark: {
                                ...c.lark,
                                mode,
                                fallbackReceiveIdType: mode === 'chat' ? 'chat_id' : 'open_id'
                              }
                            }))}
                          />
                        </SettingRow>

                        {draft.lark.mode === 'chat' ? (
                          <SettingRow
                            title={L("目标飞书群", "Target Lark Group")}
                            description={L("从机器人已加入的群聊中选择；也可直接粘贴 oc_ 开头的群 ID。", "Pick from groups the bot joined or paste an oc_ chat ID.")}
                          >
                            <div className="flex w-full items-center gap-1.5 min-[520px]:w-72">
                              <Select
                                showSearch
                                allowClear
                                className="min-w-0 flex-1"
                                size="middle"
                                loading={larkChatsQuery.isFetching}
                                placeholder={L("选择或搜索群聊", "Select or search groups")}
                                optionFilterProp="label"
                                value={draft.lark.fallbackReceiveId?.startsWith('oc_') ? draft.lark.fallbackReceiveId : undefined}
                                onChange={chatId => patchDraft(c => ({
                                  ...c,
                                  lark: { ...c.lark, fallbackReceiveId: chatId || undefined, fallbackReceiveIdType: 'chat_id' }
                                }))}
                                options={(larkChatsQuery.data?.items ?? []).map(chat => ({
                                  value: chat.chatId,
                                  label: chat.name || chat.chatId
                                }))}
                              />
                              <IconButton
                                label={L("刷新群列表", "Refresh groups")}
                                disabled={larkChatsQuery.isFetching}
                                onClick={() => void larkChatsQuery.refetch()}
                              >
                                <RefreshCw size={13} className={larkChatsQuery.isFetching ? 'animate-spin' : ''}/>
                              </IconButton>
                            </div>
                          </SettingRow>
                        ) : (
                          <SettingRow
                            title={draft.lark.mode === 'direct_user' ? L("私聊接收人（open_id）", "DM Recipient (open_id)") : L("未托管会话的兜底目标", "Fallback Target for Non-Hosted Sessions")}
                            description={
                              larkOwnerQuery.data?.owner
                                ? L(`留空将自动私聊机器人创建者：${larkOwnerQuery.data.owner.name}（${larkOwnerQuery.data.owner.openId.slice(0, 12)}…）`, `Leave blank to auto-DM bot creator: ${larkOwnerQuery.data.owner.name} (${larkOwnerQuery.data.owner.openId.slice(0, 12)}…)`)
                                : L("留空将自动识别机器人创建者并发送私聊，也可手动填写 ou_（私聊）或 oc_（群聊）ID。", "Leave blank to auto-DM the bot creator, or paste an ou_ / oc_ ID.")
                            }
                          >
                            <div className="flex w-full items-center gap-1.5 min-[520px]:w-72">
                              <Input
                                size="middle"
                                allowClear
                                className="font-mono text-[12px]"
                                placeholder={larkOwnerQuery.data?.owner ? L(`自动：${larkOwnerQuery.data.owner.name}`, `Auto: ${larkOwnerQuery.data.owner.name}`) : L("ou_xxx 或 oc_xxx（可留空）", "ou_xxx or oc_xxx (optional)")}
                                value={draft.lark.fallbackReceiveId ?? ''}
                                onChange={event => {
                                  const val = event.target.value.trim();
                                  patchDraft(c => ({
                                    ...c,
                                    lark: {
                                      ...c.lark,
                                      fallbackReceiveId: val || undefined,
                                      fallbackReceiveIdType: val.startsWith('oc_') ? 'chat_id' : 'open_id'
                                    }
                                  }));
                                }}
                              />
                              {larkOwnerQuery.data?.owner && draft.lark.fallbackReceiveId !== larkOwnerQuery.data.owner.openId && (
                                <button
                                  type="button"
                                  onClick={() => patchDraft(c => ({
                                    ...c,
                                    lark: {
                                      ...c.lark,
                                      fallbackReceiveId: larkOwnerQuery.data!.owner!.openId,
                                      fallbackReceiveIdType: 'open_id'
                                    }
                                  }))}
                                  className="h-8 shrink-0 rounded-md border border-zinc-200 bg-white px-2 text-[11.5px] font-medium text-zinc-600 hover:bg-zinc-50"
                                >
                                  
                                  {L("填本人", "Use Me")}
                                </button>
                              )}
                            </div>
                          </SettingRow>
                        )}

                        <CompactSwitchRow
                          title={L("附带任务摘要与会话直达链接", "Include Summary & Direct Session Link")}
                          description={L("卡片内展示最终回复前 200 字纯文本摘要，并附带自动签名的「在 AgentDock 查看」按钮。", "Includes a 200-char reply preview and signed \"Open in AgentDock\" button.")}
                        >
                          <Switch
                            size="small"
                            aria-label={L("飞书卡片附带摘要", "Include summary in Lark card")}
                            checked={draft.lark.includeSummary}
                            onChange={checked => patchDraft(c => ({ ...c, lark: { ...c.lark, includeSummary: checked } }))}
                          />
                        </CompactSwitchRow>

                        <CompactSwitchRow
                          title={L("跳过飞书原群防重复", "Skip Original Lark Group (Dedupe)")}
                          description={L("飞书群聊直接发起的会话原群已有卡片或回复，推送目标同为该群时自动跳过。", "Skips pushing if the turn already posted a card to that same Lark group.")}
                        >
                          <Switch
                            size="small"
                            aria-label={L("跳过飞书原群防重复", "Skip Original Lark Group (Dedupe)")}
                            checked={draft.lark.skipOriginalLarkChat}
                            onChange={checked => patchDraft(c => ({ ...c, lark: { ...c.lark, skipOriginalLarkChat: checked } }))}
                          />
                        </CompactSwitchRow>

                        {larkTestResult && (
                          <div className="border-t border-zinc-100 px-4 pb-3.5 pt-1">
                            <InlineTestFeedback result={larkTestResult}/>
                          </div>
                        )}
                      </>
                    )}
                  </SectionCard>
                )}

                {/* ==================== TAB 4: Webhook 与本地 Hook ==================== */}
                {tab === 'extensions' && (
                  <>
                    <SectionCard
                      title={L("通用 Webhook", "Universal Webhooks")}
                      description={L("一键适配飞书群机器人、钉钉、企微、Bark、ntfy、Slack、Discord 或自建接口；所有密钥在后端加密/脱敏管理，绝不回显明文。", "Presets for Lark, DingTalk, WeCom, Bark, ntfy, Slack, Discord, or custom JSON endpoints. Secrets stay masked server-side.")}
                      icon={<Webhook size={14}/>}
                      stackActionOnMobile
                      badge={draft.webhooks.length > 0 ? <StatusPill tone="zinc">{draft.webhooks.length}  {L("条", "")}</StatusPill> : undefined}
                      action={
                        <button
                          type="button"
                          onClick={addWebhook}
                          className="inline-flex h-8 items-center gap-1 rounded-lg bg-zinc-900 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-zinc-700"
                        >
                          <Plus size={13}/>{L("添加 Webhook", "Add Webhook")}
                        </button>
                      }
                    >
                      {draft.webhooks.length === 0 ? (
                        <div className="px-4 py-6 text-center">
                          <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-xl border border-dashed border-zinc-300 bg-zinc-50 text-zinc-400">
                            <Webhook size={17}/>
                          </div>
                          <div className="text-[13px] font-medium text-zinc-700">{L("还没有配置 Webhook", "No Webhooks Configured")}</div>
                          <p className="mx-auto mt-1 max-w-md text-[12px] leading-5 text-zinc-500">
                            
                            {L("支持钉钉、企业微信、Bark（iOS）、ntfy、Slack、飞书群自定义机器人及任意自定义 JSON 接收端。", "Supports DingTalk, WeCom, Bark, ntfy, Slack, Discord, Lark Group Bot, and custom JSON hooks.")}
                          </p>
                        </div>
                      ) : (
                        <div className="divide-y divide-zinc-100">
                          {draft.webhooks.map(hook => {
                            const expanded = expandedWebhookId === hook.id;
                            const presetMeta = WEBHOOK_PRESET_META[hook.preset];
                            const delivery = lastDelivery[`webhook:${hook.id}`];
                            const testResult = webhookTestResults[hook.id];
                            const hostLabel = (() => {
                              try { return new URL(hook.url).host; } catch { return hook.url || L("尚未填写 URL", "URL not set"); }
                            })();
                            return (
                              <div key={hook.id} className="bg-white">
                                <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                                  <button
                                    type="button"
                                    onClick={() => setExpandedWebhookId(expanded ? null : hook.id)}
                                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                  >
                                    {expanded
                                      ? <ChevronDown size={14} className="shrink-0 text-zinc-400"/>
                                      : <ChevronRight size={14} className="shrink-0 text-zinc-400"/>}
                                    <div className="min-w-0 flex-1">
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <span className="truncate text-[13.5px] font-medium text-zinc-900">{hook.name || L("未命名 Webhook", "Untitled Webhook")}</span>
                                        <StatusPill tone="blue">{presetMeta.shortLabel}</StatusPill>
                                        {delivery && (
                                          <StatusPill tone={delivery.ok ? 'emerald' : 'red'}>
                                            {delivery.ok ? `${delivery.durationMs}ms` : L("上次失败", "Last failed")}
                                          </StatusPill>
                                        )}
                                      </div>
                                      <div className="mt-0.5 truncate font-mono text-[11.5px] text-zinc-400">{hostLabel}</div>
                                    </div>
                                  </button>

                                  <div className="flex shrink-0 items-center gap-1.5">
                                    <button
                                      type="button"
                                      disabled={!hook.url.trim() || testingKey === `webhook:${hook.id}`}
                                      onClick={() => void runRemoteTest('webhook', hook.id)}
                                      className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 text-[11.5px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                                    >
                                      {testingKey === `webhook:${hook.id}` ? <Spinner size={11}/> : <Send size={11}/>}
                                      
                                      {L("测试", "Test")}
                                    </button>
                                    <Switch
                                      size="small"
                                      aria-label={L(`启用 ${hook.name}`, `Enable ${hook.name}`)}
                                      checked={hook.enabled}
                                      onChange={checked => updateWebhook(hook.id, item => ({ ...item, enabled: checked }))}
                                    />
                                    <IconButton label={L("删除 Webhook", "Delete Webhook")} onClick={() => removeWebhook(hook.id)}>
                                      <Trash2 size={13} className="text-zinc-400 hover:text-red-500"/>
                                    </IconButton>
                                  </div>
                                </div>

                                {expanded && (
                                  <div className="space-y-3 border-t border-zinc-100 bg-zinc-50/50 px-4 py-3.5">
                                    <div>
                                      <div className="mb-1.5 text-[12px] font-medium text-zinc-700">{L("快速预设模板", "Preset")}</div>
                                      <div className="flex flex-wrap gap-1.5">
                                        {WEBHOOK_PRESET_ORDER.map(preset => {
                                          const active = hook.preset === preset;
                                          return (
                                            <button
                                              key={preset}
                                              type="button"
                                              onClick={() => updateWebhook(hook.id, item => ({
                                                ...item,
                                                preset,
                                                name: !item.name || item.name === '自定义 Webhook' || item.name === 'Custom Webhook' || Object.values(WEBHOOK_PRESET_META).some(m => m.label === item.name)
                                                  ? WEBHOOK_PRESET_META[preset].label
                                                  : item.name
                                              }))}
                                              className={`h-7 rounded-md border px-2.5 text-[11.5px] font-medium transition-colors ${
                                                active
                                                  ? 'border-zinc-900 bg-zinc-900 text-white'
                                                  : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-900'
                                              }`}
                                            >
                                              {WEBHOOK_PRESET_META[preset].shortLabel}
                                            </button>
                                          );
                                        })}
                                      </div>
                                      <p className="mt-1.5 text-[11.5px] leading-4 text-zinc-500">{presetMeta.hint}</p>
                                    </div>

                                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
                                      <label className="block">
                                        <span className="text-[12px] font-medium text-zinc-700">{L("名称", "Name")}</span>
                                        <Input
                                          size="middle"
                                          className="mt-1"
                                          maxLength={80}
                                          value={hook.name}
                                          placeholder={L("例如：个人 Bark 推送", "e.g., Personal Bark Push")}
                                          onChange={event => updateWebhook(hook.id, item => ({ ...item, name: event.target.value }))}
                                        />
                                      </label>
                                      <label className="block">
                                        <span className="text-[12px] font-medium text-zinc-700">{L("超时（秒）", "Timeout (s)")}</span>
                                        <InputNumber<number>
                                          size="middle"
                                          min={1}
                                          max={30}
                                          className="mt-1 !w-full font-mono"
                                          value={hook.timeoutSec}
                                          onChange={val => updateWebhook(hook.id, item => ({ ...item, timeoutSec: Math.max(1, Math.min(30, Math.round(val ?? 8))) }))}
                                        />
                                      </label>
                                    </div>

                                    <label className="block">
                                      <span className="text-[12px] font-medium text-zinc-700">{L("Webhook 地址", "Webhook URL")}</span>
                                      <Input
                                        size="middle"
                                        className="mt-1 font-mono text-[12px]"
                                        value={hook.url}
                                        placeholder={presetMeta.placeholderUrl}
                                        onChange={event => updateWebhook(hook.id, item => ({ ...item, url: event.target.value }))}
                                      />
                                    </label>

                                    <label className="block">
                                      <span className="flex items-center justify-between text-[12px] font-medium text-zinc-700">
                                        <span>
                                          
                                          {L("签名密钥（可选 · HMAC-SHA256）", "Signing Secret (Optional · HMAC-SHA256)")}
                                          {hook.hasSecret && hook.secret === undefined && (
                                            <span className="ml-1.5 font-normal text-emerald-600">{L("已安全保存，留空不修改", "Saved securely — leave blank to keep")}</span>
                                          )}
                                        </span>
                                        {hook.hasSecret && hook.secret !== '' && (
                                          <button
                                            type="button"
                                            onClick={() => updateWebhook(hook.id, item => ({ ...item, secret: '', hasSecret: false }))}
                                            className="text-[11px] font-normal text-zinc-400 hover:text-red-600"
                                          >
                                            
                                            {L("清除密钥", "Clear Secret")}
                                          </button>
                                        )}
                                      </span>
                                      <Input.Password
                                        size="middle"
                                        autoComplete="new-password"
                                        className="mt-1 font-mono text-[12px]"
                                        value={hook.secret ?? ''}
                                        placeholder={hook.hasSecret ? L("已保存（输入新密钥可覆盖）", "Saved (enter new secret to overwrite)") : L("可选，发送 X-AgentDock-Signature 请求头", "Optional; sends X-AgentDock-Signature header")}
                                        onChange={event => updateWebhook(hook.id, item => ({ ...item, secret: event.target.value }))}
                                      />
                                    </label>

                                    <div>
                                      <div className="mb-1.5 flex items-center justify-between">
                                        <span className="text-[12px] font-medium text-zinc-700">{L("自定义请求头（可选）", "Custom Headers (Optional)")}</span>
                                        <button
                                          type="button"
                                          onClick={() => updateWebhook(hook.id, item => ({
                                            ...item,
                                            headers: [...item.headers, { key: '', value: '' }]
                                          }))}
                                          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-zinc-600 hover:text-zinc-900"
                                        >
                                          <Plus size={12}/>{L("添加请求头", "Add Header")}
                                        </button>
                                      </div>
                                      {hook.headers.length > 0 && (
                                        <div className="space-y-1.5">
                                          {hook.headers.map((header, idx) => (
                                            <div key={idx} className="flex items-center gap-1.5">
                                              <Input
                                                size="small"
                                                className="w-28 shrink-0 font-mono text-[11.5px] sm:w-44"
                                                placeholder={L("Header 名", "Header Name")}
                                                value={header.key}
                                                onChange={event => updateWebhook(hook.id, item => ({
                                                  ...item,
                                                  headers: item.headers.map((h, i) => (i === idx ? { ...h, key: event.target.value } : h))
                                                }))}
                                              />
                                              <Input
                                                size="small"
                                                className="min-w-0 flex-1 font-mono text-[11.5px]"
                                                placeholder={header.masked ? L("已脱敏（输入新值覆盖）", "Masked (enter new value to overwrite)") : L("Header 值", "Header Value")}
                                                value={header.value}
                                                onChange={event => updateWebhook(hook.id, item => ({
                                                  ...item,
                                                  headers: item.headers.map((h, i) => (i === idx ? { ...h, value: event.target.value, masked: false } : h))
                                                }))}
                                              />
                                              <IconButton
                                                label={L("移除请求头", "Remove header")}
                                                onClick={() => updateWebhook(hook.id, item => ({
                                                  ...item,
                                                  headers: item.headers.filter((_, i) => i !== idx)
                                                }))}
                                              >
                                                <X size={12}/>
                                              </IconButton>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}

                                {testResult && (
                                  <div className="border-t border-zinc-100 px-4 pb-3 pt-0.5">
                                    <InlineTestFeedback result={testResult}/>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </SectionCard>

                    <SectionCard
                      title={L("本地命令 Hook（Shell 回调）", "Local Command Hook (Shell Callback)")}
                      description={L("通知触发时在本机异步执行自定义命令或脚本（如 osascript / terminal-notifier / say / 自动化脚本），超时自动清理进程组，不阻塞 Agent。", "Runs a local command or script asynchronously on alert (e.g., osascript, terminal-notifier, say) with automatic timeout cleanup.")}
                      icon={<Terminal size={14}/>}
                      stackActionOnMobile
                      badge={
                        draft.commandHook.enabled
                          ? <StatusPill tone="emerald">{L("已启用", "Enabled")}</StatusPill>
                          : <StatusPill tone="zinc">{L("默认关闭", "Off by default")}</StatusPill>
                      }
                      action={
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={!draft.commandHook.trustConfirmed || !draft.commandHook.command.trim() || testingKey === 'command'}
                            onClick={() => void runRemoteTest('command')}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                          >
                            {testingKey === 'command' ? <Spinner size={12}/> : <Play size={11}/>}
                            
                            {L("发送测试", "Send Test")}
                          </button>
                          <Switch
                            size="small"
                            aria-label={L("启用本地命令 Hook", "Enable local command hook")}
                            disabled={!draft.commandHook.trustConfirmed}
                            checked={draft.commandHook.enabled && draft.commandHook.trustConfirmed}
                            onChange={checked => patchDraft(c => ({ ...c, commandHook: { ...c.commandHook, enabled: checked } }))}
                          />
                        </div>
                      }
                    >
                      <div className="space-y-3.5 p-4">
                        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] leading-5 text-amber-800">
                          <div className="flex items-start gap-2">
                            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-600"/>
                            <div>
                              <div className="font-semibold">{L("本机命令执行安全提示", "Local Command Execution Security Notice")}</div>
                              <p className="mt-0.5">
                                
                                {L("命令将以当前守护进程权限在本机 Shell 中执行。为防止命令注入，会话标题和摘要", "Runs with daemon shell permissions. To prevent injection, titles and summaries are ")}<strong>{L("不会拼接到命令行", "never interpolated into command arguments")}</strong>{L("，而是全部通过只读环境变量与标准输入 JSON 传入。", " — they are passed via read-only environment variables and stdin JSON.")}
                              </p>
                              <label className="mt-2 inline-flex cursor-pointer items-center gap-2 font-medium text-amber-900">
                                <input
                                  type="checkbox"
                                  checked={draft.commandHook.trustConfirmed}
                                  onChange={event => {
                                    const trusted = event.target.checked;
                                    patchDraft(c => ({
                                      ...c,
                                      commandHook: {
                                        ...c.commandHook,
                                        trustConfirmed: trusted,
                                        enabled: trusted ? c.commandHook.enabled : false
                                      }
                                    }));
                                  }}
                                  className="h-3.5 w-3.5 rounded border-amber-400 accent-zinc-900"
                                />
                                
                                {L("我了解风险，仅配置自己信任的本地命令或脚本", "I understand the risks and only run commands/scripts I trust")}
                              </label>
                            </div>
                          </div>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
                          <label className="block">
                            <span className="text-[12px] font-medium text-zinc-700">{L("执行命令", "Command")}</span>
                            <Input
                              size="middle"
                              className="mt-1 font-mono text-[12px]"
                              disabled={!draft.commandHook.trustConfirmed}
                              value={draft.commandHook.command}
                              placeholder={L("例如：say \"$AGENTDOCK_SESSION_TITLE 完成\" 或 ~/.agentdock/notify.sh", "e.g., say \"$AGENTDOCK_SESSION_TITLE done\" or ~/.agentdock/notify.sh")}
                              onChange={event => patchDraft(c => ({ ...c, commandHook: { ...c.commandHook, command: event.target.value } }))}
                            />
                          </label>
                          <label className="block">
                            <span className="text-[12px] font-medium text-zinc-700">{L("超时（秒）", "Timeout (s)")}</span>
                            <InputNumber<number>
                              size="middle"
                              min={1}
                              max={30}
                              disabled={!draft.commandHook.trustConfirmed}
                              className="mt-1 !w-full font-mono"
                              value={draft.commandHook.timeoutSec}
                              onChange={val => patchDraft(c => ({
                                ...c,
                                commandHook: { ...c.commandHook, timeoutSec: Math.max(1, Math.min(30, Math.round(val ?? 10))) }
                              }))}
                            />
                          </label>
                        </div>

                        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50/70">
                          <button
                            type="button"
                            onClick={() => setEnvVarsOpen(open => !open)}
                            className="flex w-full items-center justify-between px-3 py-2 text-left text-[12px] font-medium text-zinc-600 hover:bg-zinc-100/60"
                          >
                            <span>{L("可用环境变量与 stdin JSON 速查", "Environment Variables & Stdin JSON Reference")}</span>
                            {envVarsOpen ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
                          </button>
                          {envVarsOpen && (
                            <div className="divide-y divide-zinc-200/70 border-t border-zinc-200/70 bg-white px-3 py-1.5 text-[11.5px]">
                              {SHELL_HOOK_ENV_VARS.map(item => (
                                <div key={item.name} className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:items-center sm:gap-3">
                                  <code className="shrink-0 font-mono font-medium text-zinc-800">{item.name}</code>
                                  <span className="text-zinc-500">{item.desc}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {lastDelivery.command && !commandTestResult && (
                          <div className="text-[11.5px] text-zinc-500">{formatRecentDeliveryLabel(lastDelivery.command)}</div>
                        )}
                        <InlineTestFeedback result={commandTestResult}/>
                      </div>
                    </SectionCard>
                  </>
                )}

                {saveNotice && (
                  <div
                    role="status"
                    className={`flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-[12px] font-medium ${
                      saveNotice.ok
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border-red-200 bg-red-50 text-red-700'
                    }`}
                  >
                    {saveNotice.ok ? <CheckCircle2 size={14}/> : <AlertTriangle size={14}/>}
                    <span>{saveNotice.text}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </DeferredMount>

        {/* 底栏 */}
        <div className="flex shrink-0 flex-col gap-2.5 border-t border-zinc-100 bg-white px-3.5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:px-5 sm:pb-3">
          <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-zinc-500 sm:text-[12px]">
            {dirty ? (
              <>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"/>
                <span className="truncate">{L("有未保存的服务端配置更改", "Unsaved server configuration changes")}</span>
              </>
            ) : (
              <>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"/>
                <span className="truncate">{L("本机偏好即时生效；飞书与扩展点击保存后全端同步", "Local prefs apply immediately; click Save to sync Lark & extension settings")}</span>
              </>
            )}
          </div>

          <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
            {!embedded && (
              <HoverTooltip content={L("关闭弹窗", "Close")}>
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 rounded-lg px-3.5 text-[12.5px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
                >
                  
                  {L("关闭", "Off")}
                </button>
              </HoverTooltip>
            )}
            <button
              type="button"
              disabled={!dirty || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
              className="inline-flex h-9 min-w-[92px] items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-4 text-[12.5px] font-medium text-white transition-colors hover:bg-zinc-700 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saveMutation.isPending ? <><Spinner size={12} className="text-white"/>{L("保存中", "Saving")}</> : L("保存设置", "Save Settings")}
            </button>
          </div>
        </div>
      </div>
  );

  if (embedded) return content;

  return (
    <div
      className="ui-overlay ui-overlay-sheet fixed inset-0 z-[60] grid place-items-center bg-black/40 p-0 sm:p-4"
      onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}
    >
      {content}
    </div>
  );
}
