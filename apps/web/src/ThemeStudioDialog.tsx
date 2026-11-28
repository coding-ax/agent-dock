import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  FolderArchive,
  Globe,
  Moon,
  Palette,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  Wand2,
  X
} from 'lucide-react';
import {
  BUILTIN_DARK_THEME_ID,
  BUILTIN_LIGHT_THEME_ID,
  ensureReadableThemeTokens,
  evaluateThemeContrast,
  getDefaultThemeForMode,
  isBuiltinThemeId,
  localizeThemeDisplay,
  normalizeHexColor,
  type CustomTheme,
  type CustomThemeMode,
  type CustomThemeSource,
  type CustomThemeTokenKey,
  type CustomThemeTokens,
  type ThemeContrastReport
} from '@agent-dock/agent-dock-shared';
import { api, type ImportVsCodeThemeResponse, type ParsedVsCodeThemeVariant } from './api';
import { useLlmAvailability } from './AiTextAssist';
import { HoverTooltip } from './HoverTooltip';
import { useBi, useLocale } from './i18n';
import { Spinner } from './Loaders';
import { SlidingSegmented } from './ui-controls';
import { useModalFocusTrap } from './useModalFocusTrap';
import {
  activateThemeById,
  resetThemePreferences,
  setPreviewTheme,
  syncThemesSnapshot,
  useThemesState
} from './themes';

type StudioTab = 'gallery' | 'ai' | 'vscode' | 'editor';
type GalleryFilter = 'all' | 'light' | 'dark';
type VsCodeInputMode = 'file' | 'source' | 'json';

type BiFn = (zh: string, en: string) => string;

function getSourceBadge(source: CustomThemeSource, L: BiFn): { label: string; className: string } {
  switch (source) {
    case 'builtin': return { label: L('内置', 'Built-in'), className: 'border-zinc-200 bg-zinc-50 text-zinc-600' };
    case 'custom': return { label: L('自定义', 'Custom'), className: 'border-sky-200 bg-sky-50 text-sky-700' };
    case 'ai': return { label: L('AI 生成', 'AI'), className: 'border-amber-200 bg-amber-50 text-amber-800' };
    case 'vscode': return { label: 'VS Code', className: 'border-blue-200 bg-blue-50 text-blue-700' };
  }
}

function getAiQuickPrompts(L: BiFn): Array<{ id: string; label: string; prompt: string; mode: 'auto' | CustomThemeMode }> {
  return [
    {
      id: 'tokyo-rain',
      label: L('东京雨夜赛博', 'Tokyo Rain Cyber'),
      prompt: L(
        '雨夜东京街头的霓虹靛蓝与湿润柏油黑，护眼低眩光、电光青蓝点缀',
        'Rainy Tokyo night with wet asphalt charcoal, low-glare deep blue surfaces, and crisp electric cyan accents'
      ),
      mode: 'dark'
    },
    {
      id: 'kyoto-matcha',
      label: L('京都抹茶和纸', 'Kyoto Matcha Paper'),
      prompt: L(
        '午后京都宇治抹茶与宣纸清透感，淡雅护眼绿灰画布与温润墨绿交互色',
        'Calm afternoon Uji matcha on washi paper, soft sage-tinted canvas with warm deep forest green accents'
      ),
      mode: 'light'
    },
    {
      id: 'nordic-cedar',
      label: L('北欧雪松清晨', 'Nordic Cedar Dawn'),
      prompt: L(
        '冬日北欧冷调雪松与雾蓝岩石，通透极简的理性工程氛围',
        'Crisp winter Nordic cedar and misty blue stone, calm minimalist engineering aesthetic'
      ),
      mode: 'dark'
    },
    {
      id: 'warm-coffee',
      label: L('暖冬手冲咖啡', 'Warm Pour-Over'),
      prompt: L(
        '温暖复古的手冲咖啡馆奶油纸张与烘焙焦糖褐，久看不累',
        'Warm vintage pour-over cafe cream paper with roasted caramel brown accents, easy on the eyes'
      ),
      mode: 'light'
    },
    {
      id: 'sunset-amber',
      label: L('晚霞琥珀微醺', 'Amber Dusk'),
      prompt: L(
        '深沉暮色紫褐底色搭配温暖落日琥珀金与玫瑰珊瑚点缀',
        'Deep twilight espresso canvas paired with warm sunset amber gold and soft coral accents'
      ),
      mode: 'dark'
    },
    {
      id: 'geek-terminal',
      label: L('极客终端高对比', 'High-Contrast Terminal'),
      prompt: L(
        '极客终端低噪音炭黑底色，极高正文对比度搭配清爽翡翠绿高亮',
        'Clean low-noise charcoal terminal theme with ultra-crisp text contrast and fresh emerald green highlights'
      ),
      mode: 'dark'
    }
  ];
}

function getTokenGroups(L: BiFn): Array<{
  id: string;
  title: string;
  description: string;
  items: Array<{ key: CustomThemeTokenKey; label: string }>;
}> {
  return [
    {
      id: 'surfaces',
      title: L('表面与层次', 'Surfaces & Elevation'),
      description: L('侧栏、主画布、卡片、浮层、用户气泡与代码块背景', 'Sidebar, main canvas, cards, popovers, user bubble, and code blocks'),
      items: [
        { key: 'bgCanvas', label: L('主画布背景', 'Main Canvas') },
        { key: 'bgSidebar', label: L('侧边栏背景', 'Sidebar') },
        { key: 'bgSurface', label: L('卡片 / 输入框', 'Card / Input') },
        { key: 'bgSurfaceHover', label: L('悬停 / 次级底', 'Hover / Secondary') },
        { key: 'bgElevated', label: L('弹窗 / 浮层底', 'Modal / Popover') },
        { key: 'bgBubbleUser', label: L('用户消息气泡', 'User Message Bubble') },
        { key: 'bgCode', label: L('代码块背景', 'Code Block') }
      ]
    },
    {
      id: 'text-borders',
      title: L('文字与边框', 'Text & Borders'),
      description: L('主正文、次级说明、弱提示与分割边框层次', 'Primary copy, secondary text, muted hints, and border hierarchy'),
      items: [
        { key: 'textPrimary', label: L('主正文文字', 'Primary Text') },
        { key: 'textSecondary', label: L('次要文字', 'Secondary Text') },
        { key: 'textMuted', label: L('弱提示文字', 'Muted Text') },
        { key: 'textInverse', label: L('反色文字', 'Inverse Text') },
        { key: 'borderSubtle', label: L('细腻分割线', 'Subtle Border') },
        { key: 'borderStrong', label: L('清晰控件边框', 'Strong Border') }
      ]
    },
    {
      id: 'accent',
      title: L('强调与交互', 'Accent & Interaction'),
      description: L('主按钮、链接、选中态与柔光浅底', 'Primary buttons, links, active states, and soft tints'),
      items: [
        { key: 'accent', label: L('核心强调色', 'Primary Accent') },
        { key: 'accentSoft', label: L('强调柔和浅底', 'Soft Accent Tint') },
        { key: 'accentForeground', label: L('强调按钮文字', 'Accent Foreground') }
      ]
    },
    {
      id: 'status',
      title: L('状态语义', 'Semantic Status'),
      description: L('成功、提醒、危险报错与信息提示', 'Success, warning, error, and info indicators'),
      items: [
        { key: 'success', label: L('成功状态色', 'Success') },
        { key: 'warning', label: L('警告提醒色', 'Warning') },
        { key: 'danger', label: L('错误危险色', 'Danger') },
        { key: 'info', label: L('信息高亮色', 'Info') }
      ]
    }
  ];
}

/** 将二进制 ArrayBuffer 转为 base64（分块处理避免大 .vsix 爆栈）。 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function downloadThemeJson(theme: CustomTheme): void {
  const blob = new Blob([`${JSON.stringify(theme, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const slug = theme.name.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || theme.id;
  anchor.href = url;
  anchor.download = `${slug}.agentdock-theme.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 精致 Mini UI 缩略图：用主题真实语义 Token 还原侧栏、画布、气泡、代码块与强调按钮。 */
export function ThemeMiniPreview({
  tokens,
  compact = false
}: {
  tokens: CustomThemeTokens;
  compact?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={`relative flex w-full overflow-hidden rounded-xl border ${compact ? 'h-[86px]' : 'h-[108px]'}`}
      style={{
        backgroundColor: tokens.bgCanvas,
        borderColor: tokens.borderSubtle
      }}
    >
      {/* 迷你侧栏 */}
      <div
        className="flex w-[30%] shrink-0 flex-col gap-1.5 border-r p-2"
        style={{
          backgroundColor: tokens.bgSidebar,
          borderColor: tokens.borderSubtle
        }}
      >
        <div className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tokens.accent }}/>
          <span className="h-1.5 w-8 rounded-full" style={{ backgroundColor: tokens.textPrimary, opacity: 0.78 }}/>
        </div>
        <div
          className="flex items-center gap-1 rounded-md px-1.5 py-1"
          style={{ backgroundColor: tokens.accentSoft }}
        >
          <span className="h-1.5 w-full rounded-full" style={{ backgroundColor: tokens.accent }}/>
        </div>
        <div className="h-1.5 w-4/5 rounded-full" style={{ backgroundColor: tokens.textMuted, opacity: 0.5 }}/>
        <div className="h-1.5 w-3/5 rounded-full" style={{ backgroundColor: tokens.textMuted, opacity: 0.35 }}/>
        <div className="mt-auto flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tokens.success }}/>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tokens.warning }}/>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tokens.danger }}/>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tokens.info }}/>
        </div>
      </div>

      {/* 迷你主对话画布 */}
      <div className="flex min-w-0 flex-1 flex-col justify-between p-2">
        {/* 用户气泡 */}
        <div className="flex justify-end">
          <div
            className="flex w-[64%] flex-col gap-1 rounded-lg px-2 py-1.5"
            style={{ backgroundColor: tokens.bgBubbleUser }}
          >
            <div className="h-1.5 w-full rounded-full" style={{ backgroundColor: tokens.textPrimary, opacity: 0.82 }}/>
            <div className="h-1.5 w-2/3 rounded-full" style={{ backgroundColor: tokens.textSecondary, opacity: 0.72 }}/>
          </div>
        </div>

        {/* AI 卡片 + 代码块 */}
        <div
          className="rounded-lg border px-2 py-1.5"
          style={{
            backgroundColor: tokens.bgCode,
            borderColor: tokens.borderSubtle
          }}
        >
          <div className="flex items-center gap-1">
            <span className="h-1.5 w-6 rounded-full" style={{ backgroundColor: tokens.accent }}/>
            <span className="h-1.5 w-10 rounded-full" style={{ backgroundColor: tokens.textSecondary, opacity: 0.8 }}/>
            <span className="ml-auto h-1.5 w-4 rounded-full" style={{ backgroundColor: tokens.info }}/>
          </div>
          {!compact && (
            <div className="mt-1.5 flex items-center gap-1">
              <span className="h-1.5 w-9 rounded-full" style={{ backgroundColor: tokens.success }}/>
              <span className="h-1.5 w-12 rounded-full" style={{ backgroundColor: tokens.textMuted, opacity: 0.7 }}/>
            </div>
          )}
        </div>

        {/* 底部输入框 + 强调发送钮 */}
        <div
          className="flex items-center gap-1.5 rounded-lg border px-1.5 py-1"
          style={{
            backgroundColor: tokens.bgSurface,
            borderColor: tokens.borderStrong
          }}
        >
          <span className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: tokens.textMuted, opacity: 0.45 }}/>
          <span
            className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full"
            style={{ backgroundColor: tokens.accent, color: tokens.accentForeground }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tokens.accentForeground }}/>
          </span>
        </div>
      </div>
    </div>
  );
}

function ContrastBadge({ report }: { report: ThemeContrastReport }) {
  const tone = report.allPassed
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : 'border-amber-200 bg-amber-50 text-amber-800';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums ${tone}`}>
      <ShieldCheck size={11} className="shrink-0"/>
      <span>WCAG {report.grade}</span>
      <span className="opacity-75">· {report.textOnCanvas.ratio.toFixed(1)}:1</span>
    </span>
  );
}

export interface ThemeStudioDialogProps {
  onClose(): void;
  onOpenLlmSettings?: () => void;
  initialTab?: StudioTab;
  embedded?: boolean;
}

export function ThemeStudioDialog({
  onClose,
  onOpenLlmSettings,
  initialTab = 'gallery',
  embedded = false
}: ThemeStudioDialogProps) {
  const L = useBi();
  const locale = useLocale();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { themes, preferences, activeTheme, previewTheme } = useThemesState();
  const activeLocalizedTheme = localizeThemeDisplay(activeTheme, locale);
  const llm = useLlmAvailability();

  const [tab, setTab] = useState<StudioTab>(initialTab);
  const [galleryFilter, setGalleryFilter] = useState<GalleryFilter>('all');
  const [galleryQuery, setGalleryQuery] = useState('');
  const [statusMessage, setStatusMessage] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // ---- AI 定制态 ----
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiMode, setAiMode] = useState<'auto' | CustomThemeMode>('auto');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiResult, setAiResult] = useState<{
    theme: CustomTheme;
    report: ThemeContrastReport;
    adjustmentCount: number;
    model: string;
  } | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);

  // ---- VS Code 导入态 ----
  const [vscInputMode, setVscInputMode] = useState<VsCodeInputMode>('file');
  const [vscSourceText, setVscSourceText] = useState('');
  const [vscJsonText, setVscJsonText] = useState('');
  const [vscDragActive, setVscDragActive] = useState(false);
  const [vscParsing, setVscParsing] = useState(false);
  const [vscImporting, setVscImporting] = useState(false);
  const [vscPayloadRef, setVscPayloadRef] = useState<{
    source?: string;
    fileBase64?: string;
    fileName?: string;
    jsonText?: string;
  } | null>(null);
  const [vscBundle, setVscBundle] = useState<ImportVsCodeThemeResponse | null>(null);
  const [vscSelectedLabel, setVscSelectedLabel] = useState<string>('');

  // ---- 色板微调态 ----
  const [editId, setEditId] = useState<string | undefined>(() => (isBuiltinThemeId(activeTheme.id) ? undefined : activeTheme.id));
  const [editName, setEditName] = useState<string>(() => (isBuiltinThemeId(activeTheme.id) ? L(`${activeLocalizedTheme.name} · 定制`, `${activeLocalizedTheme.name} · Custom`) : activeTheme.name));
  const [editDescription, setEditDescription] = useState<string>(() => activeLocalizedTheme.description ?? '');
  const [editMode, setEditMode] = useState<CustomThemeMode>(() => activeTheme.mode);
  const [editTokens, setEditTokens] = useState<CustomThemeTokens>(() => ({ ...activeTheme.tokens }));
  const [hexDrafts, setHexDrafts] = useState<Partial<Record<CustomThemeTokenKey, string>>>({});
  const [livePreviewEditor, setLivePreviewEditor] = useState(false);
  const [savingEditor, setSavingEditor] = useState(false);

  const handleClose = useCallback(() => {
    aiAbortRef.current?.abort();
    setPreviewTheme(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    return () => {
      aiAbortRef.current?.abort();
      setPreviewTheme(null);
    };
  }, []);

  useModalFocusTrap({ panel: panelRef, initial: closeBtnRef, dismissible: true, onDismiss: handleClose, enabled: !embedded });

  // 当色板微调开启实时预览时同步到全站
  useEffect(() => {
    if (tab === 'editor' && livePreviewEditor) {
      setPreviewTheme({
        id: editId || 'preview-editor',
        name: editName.trim() || L("实时预览", "Live Preview"),
        description: editDescription.trim() || undefined,
        mode: editMode,
        source: 'custom',
        tokens: editTokens
      });
    } else if (tab === 'editor' && !livePreviewEditor && previewTheme?.id === (editId || 'preview-editor')) {
      setPreviewTheme(null);
    }
  }, [tab, livePreviewEditor, editId, editName, editDescription, editMode, editTokens, previewTheme?.id]);

  const editorContrast = useMemo(() => evaluateThemeContrast(editTokens), [editTokens]);

  const filteredThemes = useMemo(() => {
    const q = galleryQuery.trim().toLowerCase();
    return themes.filter(theme => {
      if (galleryFilter !== 'all' && theme.mode !== galleryFilter) return false;
      if (!q) return true;
      const enDisplay = localizeThemeDisplay(theme, 'en-US');
      const haystack = `${theme.name} ${theme.description ?? ''} ${enDisplay.name} ${enDisplay.description ?? ''} ${theme.id} ${theme.source}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [themes, galleryFilter, galleryQuery]);

  const customThemes = useMemo(() => filteredThemes.filter(theme => theme.source !== 'builtin'), [filteredThemes]);
  const builtinThemes = useMemo(() => filteredThemes.filter(theme => theme.source === 'builtin'), [filteredThemes]);

  const loadThemeIntoEditor = (theme: CustomTheme, asCopy = false) => {
    const editableId = !asCopy && !isBuiltinThemeId(theme.id) ? theme.id : undefined;
    const localized = localizeThemeDisplay(theme, locale);
    setEditId(editableId);
    setEditName(editableId ? theme.name : L(`${localized.name} · 定制`, `${localized.name} · Custom`));
    setEditDescription(editableId ? (theme.description ?? '') : (localized.description ?? ''));
    setEditMode(theme.mode);
    setEditTokens({ ...theme.tokens });
    setHexDrafts({});
    setStatusMessage(null);
    setTab('editor');
  };

  const handleActivate = async (theme: CustomTheme) => {
    setBusyId(theme.id);
    setStatusMessage(null);
    try {
      await activateThemeById(theme.id);
      const localized = localizeThemeDisplay(theme, locale);
      setStatusMessage({ tone: 'success', text: L(`已切换到「${localized.name}」`, `Switched to "${localized.name}"`) });
    } catch (error) {
      setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  const handleResetDefault = async () => {
    setBusyId('reset');
    setStatusMessage(null);
    try {
      await resetThemePreferences();
      setStatusMessage({ tone: 'info', text: L("已恢复默认外观（跟随系统 · 默认浅色 / 默认深色）", "Restored default appearance (System · Default Light / Default Dark)") });
    } catch (error) {
      setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (theme: CustomTheme) => {
    if (confirmDeleteId !== theme.id) {
      setConfirmDeleteId(theme.id);
      return;
    }
    setBusyId(theme.id);
    setConfirmDeleteId(null);
    setStatusMessage(null);
    try {
      const res = await api.deleteTheme(theme.id);
      syncThemesSnapshot(res.state);
      if (editId === theme.id) setEditId(undefined);
      setStatusMessage({ tone: 'info', text: L(`已删除自定义主题「${theme.name}」`, `Deleted custom theme "${theme.name}"`) });
    } catch (error) {
      setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  // ---- AI 生成 ----
  const handleAiGenerate = async () => {
    const prompt = aiPrompt.trim();
    if (!prompt || !llm.configured || aiGenerating) return;
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setAiGenerating(true);
    setStatusMessage(null);
    try {
      const res = await api.generateTheme(
        { prompt, mode: aiMode, save: false, apply: false },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      setAiResult({
        theme: res.theme,
        report: res.report,
        adjustmentCount: res.adjustments.length,
        model: res.model
      });
      setStatusMessage({
        tone: 'success',
        text: L(`AI 已生成「${res.theme.name}」（WCAG ${res.report.grade}${res.adjustments.length ? ` · 自动护眼校准 ${res.adjustments.length} 项` : ''}）`, `AI generated "${res.theme.name}" (WCAG ${res.report.grade}${res.adjustments.length ? ` · ${res.adjustments.length} auto-adjusted` : ''})`)
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
        setAiGenerating(false);
      }
    }
  };

  const handleSaveAiTheme = async () => {
    if (!aiResult) return;
    setBusyId('ai-save');
    setStatusMessage(null);
    try {
      const res = await api.saveTheme({
        name: aiResult.theme.name,
        description: aiResult.theme.description,
        mode: aiResult.theme.mode,
        source: 'ai',
        tokens: aiResult.theme.tokens,
        apply: true
      });
      setPreviewTheme(null);
      syncThemesSnapshot(res.state);
      setStatusMessage({ tone: 'success', text: L(`已保存并实时应用「${res.theme.name}」`, `Saved and applied "${res.theme.name}"`) });
      setTab('gallery');
    } catch (error) {
      setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  // ---- VS Code 解析与导入 ----
  const parseVsCodePayload = async (payload: { source?: string; fileBase64?: string; fileName?: string; jsonText?: string }) => {
    setVscParsing(true);
    setStatusMessage(null);
    setPreviewTheme(null);
    try {
      const res = await api.importVsCodeTheme({ ...payload, previewOnly: true });
      setVscPayloadRef(payload);
      setVscBundle(res);
      setVscSelectedLabel(res.variants[0]?.label ?? '');
      setStatusMessage({
        tone: 'success',
        text: L(`已从「${res.sourceLabel}」解析出 ${res.variants.length} 套主题变体，选择后点击导入即可生效`, `Parsed ${res.variants.length} theme variant(s) from "${res.sourceLabel}"; pick one to import`)
      });
    } catch (error) {
      setVscBundle(null);
      setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setVscParsing(false);
    }
  };

  const handleVsCodeFile = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) {
      setStatusMessage({ tone: 'error', text: L("文件超过 50MB 限制", "File exceeds 50MB limit") });
      return;
    }
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.json') || lower.endsWith('.jsonc')) {
      const text = await file.text();
      await parseVsCodePayload({ jsonText: text, fileName: file.name });
      return;
    }
    const buf = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    await parseVsCodePayload({ fileBase64: base64, fileName: file.name });
  };

  const handleVsCodeDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setVscDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void handleVsCodeFile(file);
  };

  const handleConfirmVsCodeImport = async (importAll: boolean) => {
    if (!vscPayloadRef || !vscBundle) return;
    setVscImporting(true);
    setStatusMessage(null);
    try {
      const res = await api.importVsCodeTheme({
        ...vscPayloadRef,
        ...(importAll ? { all: true } : {}),
        ...(vscSelectedLabel ? { variant: vscSelectedLabel } : {}),
        apply: true
      });
      setPreviewTheme(null);
      syncThemesSnapshot(res.state);
      setStatusMessage({
        tone: 'success',
        text: L(`已导入 ${res.imported.length} 套 VS Code 主题，并立即应用「${res.appliedTheme?.name ?? res.imported[0]?.name}」`, `Imported ${res.imported.length} VS Code theme(s) and applied "${res.appliedTheme?.name ?? res.imported[0]?.name}"`)
      });
      setTab('gallery');
    } catch (error) {
      setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setVscImporting(false);
    }
  };

  // ---- 调色板编辑 ----
  const updateEditorToken = (key: CustomThemeTokenKey, value: string) => {
    setHexDrafts(prev => ({ ...prev, [key]: value }));
    const normalized = normalizeHexColor(value);
    if (normalized) {
      setEditTokens(prev => ({ ...prev, [key]: normalized }));
    }
  };

  const handleAutoHealEditor = () => {
    const healed = ensureReadableThemeTokens(editTokens, editMode);
    setEditTokens(healed.tokens);
    setHexDrafts({});
    setStatusMessage({
      tone: 'success',
      text: healed.adjustments.length > 0
        ? L(`已自动护眼校准 ${healed.adjustments.length} 项色值（当前 WCAG ${healed.report.grade}）`, `Auto-adjusted ${healed.adjustments.length} token(s) (WCAG ${healed.report.grade})`)
        : L(`当前色板已全部满足 WCAG ${healed.report.grade} 对比度标准，无需调整`, `All tokens already meet WCAG ${healed.report.grade} contrast standards`)
    });
  };

  const handleSaveEditor = async (saveAsNew: boolean) => {
    const trimmedName = editName.trim();
    if (!trimmedName) {
      setStatusMessage({ tone: 'error', text: L("请输入主题名称", "Please enter a theme name") });
      return;
    }
    setSavingEditor(true);
    setStatusMessage(null);
    try {
      const targetId = saveAsNew ? undefined : editId;
      const res = targetId
        ? await api.updateTheme(targetId, {
            name: trimmedName,
            description: editDescription.trim(),
            mode: editMode,
            tokens: editTokens,
            apply: true
          })
        : await api.saveTheme({
            name: trimmedName,
            description: editDescription.trim() || undefined,
            mode: editMode,
            source: 'custom',
            tokens: editTokens,
            apply: true
          });
      setLivePreviewEditor(false);
      setPreviewTheme(null);
      setEditId(res.theme.id);
      setEditTokens(res.theme.tokens);
      setHexDrafts({});
      syncThemesSnapshot(res.state);
      setStatusMessage({
        tone: 'success',
        text: L(`已保存并实时应用「${res.theme.name}」（WCAG ${res.report.grade}）`, `Saved and applied "${res.theme.name}" (WCAG ${res.report.grade})`)
      });
    } catch (error) {
      setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSavingEditor(false);
    }
  };

  const isPreviewingTheme = (themeId: string) => previewTheme?.id === themeId;
  const toggleThemePreview = (theme: CustomTheme) => {
    if (previewTheme?.id === theme.id) setPreviewTheme(null);
    else setPreviewTheme(theme);
  };

  const modePrefText = preferences.modePreference === 'system'
    ? L("跟随系统", "System")
    : preferences.modePreference === 'dark'
      ? L("锁定深色", "Dark Locked")
      : L("锁定浅色", "Light Locked");

  const studioContent = (
      <div
        ref={panelRef}
        role={embedded ? undefined : 'dialog'}
        aria-modal={embedded ? undefined : 'true'}
        aria-labelledby={embedded ? undefined : 'theme-studio-title'}
        data-testid="theme-studio-dialog"
        className={embedded
          ? 'flex min-h-0 flex-1 flex-col overflow-hidden bg-white text-zinc-900'
          : 'ui-dialog flex h-[100dvh] w-full flex-col overflow-hidden bg-white text-zinc-900 shadow-[0_28px_90px_rgba(0,0,0,.28)] sm:h-[min(86dvh,760px)] sm:max-w-[940px] sm:rounded-2xl sm:border sm:border-zinc-200'}
      >
        {/* 顶栏 */}
        <div className={`flex shrink-0 flex-wrap items-center gap-2.5 border-b ${embedded ? 'border-zinc-100 px-4 py-2.5 sm:px-5' : 'border-zinc-200 px-4 py-3 sm:px-5'}`}>
          {!embedded && (
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent ring-1 ring-inset ring-zinc-200/70">
              <Palette size={17}/>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={embedded ? undefined : 'theme-studio-title'} className={embedded ? 'text-[14px] font-semibold tracking-[-.01em] text-zinc-900' : 'text-[15px] font-semibold tracking-[-.01em] text-zinc-900'}>{L("主题工坊", "Theme Studio")}</h2>
              <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11.5px] font-medium text-zinc-700">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-zinc-300" style={{ backgroundColor: activeTheme.tokens.accent }}/>
                <span className="truncate">{activeLocalizedTheme.name}</span>
              </span>
              {previewTheme && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                  <Eye size={11}/>{L("正在预览", "Previewing")}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[12px] text-zinc-500">
              {L("语义化配色引擎 · WCAG 对比度守护 · 支持 AI 定制、VS Code 插件导入与 CLI 实时热切换", "Semantic palettes · WCAG contrast guard · AI creator, VS Code import & CLI live switch")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <HoverTooltip content={L("恢复跟随系统的默认浅色 / 深色主题", "Restore system-following Default Light / Dark themes")}>
              <button
                type="button"
                disabled={busyId === 'reset'}
                onClick={() => void handleResetDefault()}
                aria-label={L("恢复默认主题", "Reset to Default Theme")}
                className="ui-press inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50"
              >
                <RotateCcw size={13}/>
                <span className="hidden sm:inline">{L("恢复默认", "Reset")}</span>
              </button>
            </HoverTooltip>
            {!embedded && (
              <HoverTooltip content={L("关闭主题工坊（Esc）", "Close Theme Studio (Esc)")} hoverOnly>
                <button
                  ref={closeBtnRef}
                  type="button"
                  onClick={handleClose}
                  aria-label={L("关闭主题工坊", "Close Theme Studio")}
                  className="ui-press grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                >
                  <X size={16}/>
                </button>
              </HoverTooltip>
            )}
          </div>
        </div>

        {/* 四大功能工作区标签条 */}
        <div className="flex shrink-0 flex-col gap-2 border-b border-zinc-200/80 bg-zinc-50/60 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <SlidingSegmented<StudioTab>
            ariaLabel={L("主题工坊工作区", "Theme Studio tabs")}
            role="tablist"
            size="sm"
            value={tab}
            onChange={next => {
              if (next !== 'editor' && livePreviewEditor) {
                setLivePreviewEditor(false);
                setPreviewTheme(null);
              }
              setStatusMessage(null);
              setTab(next);
            }}
            className="w-full sm:w-auto"
            itemClassName="px-2 sm:px-3"
            options={[
              { value: 'gallery', label: <><Palette size={13}/><span>{L("画廊", "Gallery")}</span></> },
              { value: 'ai', label: <><Sparkles size={13}/><span>{L("AI 定制", "AI Creator")}</span></> },
              { value: 'vscode', label: <><FolderArchive size={13}/><span>VS Code</span></> },
              { value: 'editor', label: <><SlidersHorizontal size={13}/><span>{L("调色板", "Palette")}</span></> }
            ]}
          />
          <div className="hidden items-center gap-2 text-[11.5px] text-zinc-500 sm:flex">
            <span>{L("偏好：", "Mode: ")}{modePrefText}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{L("共", "")} {themes.length}  {L("套主题", " themes")}</span>
          </div>
        </div>

        {/* 状态通知条 */}
        {statusMessage && (
          <div
            role={statusMessage.tone === 'error' ? 'alert' : 'status'}
            className={`ui-status-banner-in mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-[12.5px] sm:mx-5 ${
              statusMessage.tone === 'error'
                ? 'border-red-200 bg-red-50 text-red-700'
                : statusMessage.tone === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-sky-200 bg-sky-50 text-sky-700'
            }`}
          >
            {statusMessage.tone === 'error' ? <AlertCircle size={14} className="shrink-0"/> : <CheckCircle2 size={14} className="shrink-0"/>}
            <span className="min-w-0 flex-1 break-words">{statusMessage.text}</span>
            <HoverTooltip content={L("关闭提示", "Dismiss notice")}>
              <button
                type="button"
                aria-label={L("关闭状态提示", "Dismiss status notice")}
                onClick={() => setStatusMessage(null)}
                className="grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-zinc-200/50"
              >
                <X size={12}/>
              </button>
            </HoverTooltip>
          </div>
        )}

        {/* 主滚动内容区 */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-5">
          {/* ============ 1. 主题画廊 ============ */}
          {tab === 'gallery' && (
            <div className="ui-view-fade space-y-5">
              <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-1.5">
                  {([
                    { value: 'all', label: L(`全部 (${themes.length})`, `All (${themes.length})`) },
                    { value: 'light', label: L(`浅色 (${themes.filter(t => t.mode === 'light').length})`, `Light (${themes.filter(t => t.mode === 'light').length})`) },
                    { value: 'dark', label: L(`深色 (${themes.filter(t => t.mode === 'dark').length})`, `Dark (${themes.filter(t => t.mode === 'dark').length})`) }
                  ] as const).map(item => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setGalleryFilter(item.value)}
                      className={`ui-press h-7 rounded-full border px-3 text-[12px] font-medium ${
                        galleryFilter === item.value
                          ? 'border-accent bg-accent text-accent-fg'
                          : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
                    <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400"/>
                    <input
                      type="text"
                      value={galleryQuery}
                      onChange={event => setGalleryQuery(event.target.value)}
                      placeholder={L("筛选主题…", "Filter themes…")}
                      aria-label={L("筛选主题", "Filter themes")}
                      className="ui-field h-7 w-full rounded-lg border border-zinc-200 bg-white pl-7 pr-6 text-[12px] text-zinc-900 placeholder:text-zinc-400"
                    />
                    {galleryQuery && (
                      <HoverTooltip content={L("清空搜索", "Clear search")}>
                        <button
                          type="button"
                          aria-label={L("清空主题搜索", "Clear theme search")}
                          onClick={() => setGalleryQuery('')}
                          className="absolute right-1.5 top-1/2 grid h-4 w-4 -translate-y-1/2 place-items-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                        >
                          <X size={11}/>
                        </button>
                      </HoverTooltip>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setTab('ai')}
                    className="ui-press inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-100"
                  >
                    <Sparkles size={12} className="text-amber-600"/>{L("AI 定制", "AI Creator")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab('vscode')}
                    className="ui-press inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-100"
                  >
                    <Upload size={12} className="text-blue-600"/>{L("导入 VS Code", "Import VS Code")}
                  </button>
                </div>
              </div>

              {filteredThemes.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/50 px-4 py-10 text-center">
                  <div className="text-[13px] font-medium text-zinc-700">{L("没有找到匹配的主题", "No matching themes found")}</div>
                  <p className="text-[12px] text-zinc-500">{L("试试切换浅色/深色筛选，或直接使用「AI 定制」生成你想要的风格。", "Try switching light/dark filters or use AI Creator to generate a custom style.")}</p>
                  <button
                    type="button"
                    onClick={() => { setGalleryFilter('all'); setGalleryQuery(''); }}
                    className="ui-press mt-1 h-7 rounded-lg border border-zinc-200 bg-white px-3 text-[12px] font-medium text-zinc-700 hover:bg-zinc-100"
                  >
                    
                    {L("清空筛选", "Clear Filters")}
                  </button>
                </div>
              )}

              {customThemes.length > 0 && (
                <section className="space-y-2.5">
                  <div className="flex items-center gap-2 text-[12px] font-semibold text-zinc-500">
                    <span>{L("我的自定义主题", "My Custom Themes")}</span>
                    <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] tabular-nums">{customThemes.length}</span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {customThemes.map(theme => (
                      <ThemeCard
                        key={theme.id}
                        theme={theme}
                        active={activeTheme.id === theme.id}
                        busy={busyId === theme.id}
                        confirmingDelete={confirmDeleteId === theme.id}
                        onActivate={() => void handleActivate(theme)}
                        onEdit={() => loadThemeIntoEditor(theme)}
                        onExport={() => downloadThemeJson(theme)}
                        onDelete={() => void handleDelete(theme)}
                        onCancelDelete={() => setConfirmDeleteId(null)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {builtinThemes.length > 0 && (
                <section className="space-y-2.5">
                  <div className="flex items-center gap-2 text-[12px] font-semibold text-zinc-500">
                    <span>{L("精选内置预设", "Built-in Presets")}</span>
                    <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] tabular-nums">{builtinThemes.length}</span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {builtinThemes.map(theme => (
                      <ThemeCard
                        key={theme.id}
                        theme={theme}
                        active={activeTheme.id === theme.id}
                        busy={busyId === theme.id}
                        confirmingDelete={false}
                        onActivate={() => void handleActivate(theme)}
                        onEdit={() => loadThemeIntoEditor(theme, true)}
                        onExport={() => downloadThemeJson(theme)}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {/* ============ 2. AI 一句话定制 ============ */}
          {tab === 'ai' && (
            <div className="ui-view-fade space-y-4">
              {!llm.configured && (
                <div
                  data-testid="theme-ai-unconfigured-banner"
                  className="flex flex-col gap-2.5 rounded-xl border border-amber-200 bg-amber-50/80 p-3.5 text-[12.5px] text-amber-900 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="font-semibold">{L("尚未配置 LLM 模型端点", "LLM Model Endpoint Not Configured")}</div>
                    <p className="text-[12px] leading-5 text-amber-800/90">
                      
                      {L("配置模型端点后，即可在这里用一句话生成定制配色；你也可以随时直接让小猫或会话里的 Agent 调用", "Configure an LLM endpoint to generate themes in one sentence, or ask any Agent to run")} <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[11px]">agent-dock theme create --apply</code>  {L("为你生成主题。", "for you.")}
                    </p>
                  </div>
                  {onOpenLlmSettings && (
                    <button
                      type="button"
                      onClick={() => { handleClose(); onOpenLlmSettings(); }}
                      className="ui-press h-8 shrink-0 rounded-lg border border-amber-300 bg-white px-3 text-[12px] font-medium text-amber-900 hover:bg-amber-100/70"
                    >
                      
                      {L("前往配置模型端点", "Configure Model Endpoint")}
                    </button>
                  )}
                </div>
              )}

              <div className="rounded-2xl border border-zinc-200 bg-zinc-50/40 p-4 space-y-3.5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-[13.5px] font-semibold text-zinc-900">{L("一句话描述你想要的主题氛围", "Describe your ideal theme vibe in one sentence")}</div>
                    <p className="mt-0.5 text-[12px] text-zinc-500">{L("AI 将生成完整 20 项语义色板，并自动通过 WCAG 对比度守护校准。", "AI generates all 20 semantic color tokens and auto-calibrates them with WCAG contrast checks.")}</p>
                  </div>
                  <SlidingSegmented<'auto' | CustomThemeMode>
                    ariaLabel={L("AI 生成明暗倾向", "AI theme polarity")}
                    size="xs"
                    value={aiMode}
                    onChange={setAiMode}
                    className="w-full sm:w-auto"
                    options={[
                      { value: 'auto', label: L("自动", "Auto") },
                      { value: 'light', label: <><Sun size={11}/>{L("浅色", "Light")}</> },
                      { value: 'dark', label: <><Moon size={11}/>{L("深色", "Dark")}</> }
                    ]}
                  />
                </div>

                <textarea
                  rows={3}
                  value={aiPrompt}
                  onChange={event => setAiPrompt(event.target.value)}
                  onKeyDown={event => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && llm.configured && aiPrompt.trim()) {
                      event.preventDefault();
                      void handleAiGenerate();
                    }
                  }}
                  placeholder={L("例如：雨夜东京霓虹赛博感，深靛蓝底色配柔和青蓝高亮，适合深夜长时间写代码…", "e.g., Rainy Tokyo cyberpunk indigo canvas with soft cyan accents, comfortable for late-night coding…")}
                  aria-label={L("主题配色诉求描述", "Theme palette prompt")}
                  className="ui-field w-full resize-none rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-[13px] leading-6 text-zinc-900 placeholder:text-zinc-400"
                />

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11.5px] text-zinc-400">{L("灵感速填：", "Quick ideas:")}</span>
                  {getAiQuickPrompts(L).map(item => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => { setAiPrompt(item.prompt); setAiMode(item.mode); }}
                      className="ui-press rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11.5px] text-zinc-600 hover:border-zinc-300 hover:bg-zinc-100 hover:text-zinc-900"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <span className="text-[11.5px] text-zinc-400">
                    {llm.configured && llm.model ? L(`当前模型：${llm.model}`, `Model: ${llm.model}`) : L("未配置模型端点时按钮自动置灰", "Disabled until an LLM endpoint is configured")}
                  </span>
                  <div className="flex items-center gap-2">
                    {aiGenerating && (
                      <button
                        type="button"
                        onClick={() => { aiAbortRef.current?.abort(); setAiGenerating(false); }}
                        className="ui-press h-8 rounded-lg border border-zinc-200 bg-white px-3 text-[12px] font-medium text-zinc-600 hover:bg-zinc-100"
                      >
                        
                        {L("取消", "Cancel")}
                      </button>
                    )}
                    {!llm.configured ? (
                      <HoverTooltip content={L('请先在「设置 → Agent 与能力 → 模型端点」配置 LLM 模型端点', 'Configure an LLM endpoint in Settings → Agents & Capabilities → Model Endpoints')} side="top">
                        <span
                          tabIndex={0}
                          data-testid="theme-ai-generate-unconfigured"
                          className="inline-flex cursor-not-allowed rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50"
                        >
                          <button
                            type="button"
                            disabled
                            aria-disabled="true"
                            aria-label={L("AI 生成配色主题（需先配置 LLM 模型端点）", "Generate AI Theme (Configure LLM endpoint first)")}
                            className="pointer-events-none inline-flex h-9 items-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-100 px-4 text-[12.5px] font-medium text-zinc-400 opacity-65"
                          >
                            <Sparkles size={14}/>
                            <span>{L("AI 生成配色", "Generate Theme")}</span>
                          </button>
                        </span>
                      </HoverTooltip>
                    ) : (
                      <button
                        type="button"
                        disabled={!aiPrompt.trim() || aiGenerating}
                        onClick={() => void handleAiGenerate()}
                        data-testid="theme-ai-generate-btn"
                        className="ui-press inline-flex h-9 items-center gap-1.5 rounded-xl bg-accent px-4 text-[12.5px] font-medium text-accent-fg shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {aiGenerating ? <Spinner size={13} label={L("正在生成主题", "Generating theme")}/> : <Wand2 size={14}/>}
                        <span>{aiGenerating ? L("正在构思色板…", "Crafting palette…") : L("AI 生成配色", "Generate Theme")}</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {aiResult && (
                <div className="ui-status-banner-in rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm space-y-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-[14.5px] font-semibold text-zinc-900">{aiResult.theme.name}</h3>
                        <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-600">
                          {aiResult.theme.mode === 'dark' ? L("深色", "Dark") : L("浅色", "Light")}
                        </span>
                        <ContrastBadge report={aiResult.report}/>
                      </div>
                      {aiResult.theme.description && (
                        <p className="mt-1 text-[12px] text-zinc-500">{aiResult.theme.description}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleThemePreview(aiResult.theme)}
                      className={`ui-press inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium ${
                        isPreviewingTheme(aiResult.theme.id)
                          ? 'border-amber-300 bg-amber-50 text-amber-800'
                          : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100'
                      }`}
                    >
                      {isPreviewingTheme(aiResult.theme.id) ? <EyeOff size={13}/> : <Eye size={13}/>}
                      <span>{isPreviewingTheme(aiResult.theme.id) ? L("退出全站预览", "Exit Live Preview") : L("预览整站效果", "Preview Across App")}</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
                    <ThemeMiniPreview tokens={aiResult.theme.tokens}/>
                    <div className="flex flex-col justify-between gap-2.5">
                      <div className="flex flex-wrap gap-1.5">
                        {(['bgCanvas', 'bgSidebar', 'bgSurface', 'bgBubbleUser', 'bgCode', 'textPrimary', 'accent', 'success', 'warning', 'danger', 'info'] as const).map(key => (
                          <span
                            key={key}
                            className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600"
                          >
                            <span className="h-2.5 w-2.5 rounded-sm ring-1 ring-zinc-300/80" style={{ backgroundColor: aiResult.theme.tokens[key] }}/>
                            {aiResult.theme.tokens[key]}
                          </span>
                        ))}
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => loadThemeIntoEditor(aiResult.theme, true)}
                          className="ui-press inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-[12px] font-medium text-zinc-700 hover:bg-zinc-100"
                        >
                          <SlidersHorizontal size={12.5}/>{L("进入调色板微调", "Fine-Tune Palette")}
                        </button>
                        <button
                          type="button"
                          disabled={busyId === 'ai-save'}
                          onClick={() => void handleSaveAiTheme()}
                          className="ui-press inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
                        >
                          <Check size={13}/>{L("保存并立即应用", "Save & Apply")}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ============ 3. VS Code 主题插件导入 ============ */}
          {tab === 'vscode' && (
            <div className="ui-view-fade space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SlidingSegmented<VsCodeInputMode>
                  ariaLabel={L("VS Code 导入来源", "VS Code import source")}
                  size="xs"
                  value={vscInputMode}
                  onChange={setVscInputMode}
                  className="w-full sm:w-auto"
                  options={[
                    { value: 'file', label: <><Upload size={11}/>{L("上传 .vsix / JSON", "Upload .vsix / JSON")}</> },
                    { value: 'source', label: <><Globe size={11}/>{L("Marketplace / 路径", "Marketplace / Path")}</> },
                    { value: 'json', label: <><FileCode2 size={11}/>{L("粘贴 JSONC", "Paste JSONC")}</> }
                  ]}
                />
                <span className="text-[11.5px] text-zinc-400">{L("支持多变体 .vsix、include 继承与 JSONC 注释", "Supports multi-variant .vsix, include inheritance & JSONC comments")}</span>
              </div>

              {vscInputMode === 'file' && (
                <div
                  onDrop={handleVsCodeDrop}
                  onDragOver={event => { event.preventDefault(); setVscDragActive(true); }}
                  onDragLeave={() => setVscDragActive(false)}
                  onClick={() => fileInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInputRef.current?.click(); } }}
                  data-testid="vscode-dropzone"
                  className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
                    vscDragActive
                      ? 'border-accent bg-accent-soft/60'
                      : 'border-zinc-300 bg-zinc-50/50 hover:border-zinc-400 hover:bg-zinc-50'
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".vsix,.json,.jsonc,.zip"
                    className="hidden"
                    onChange={event => {
                      const file = event.target.files?.[0];
                      if (file) void handleVsCodeFile(file);
                      event.target.value = '';
                    }}
                  />
                  <div className="grid h-11 w-11 place-items-center rounded-2xl bg-white text-accent shadow-sm ring-1 ring-zinc-200">
                    {vscParsing ? <Spinner size={18} label={L("正在解析主题包", "Parsing theme package")}/> : <FolderArchive size={20}/>}
                  </div>
                  <div className="mt-3 text-[13.5px] font-semibold text-zinc-900">
                    {vscParsing ? L("正在解压并映射主题色板…", "Extracting and mapping theme palette…") : L("拖入或点击选择 .vsix / .json / .jsonc 主题文件", "Drop or click to select a .vsix / .json / .jsonc theme file")}
                  </div>
                  <p className="mt-1 max-w-[440px] text-[12px] leading-5 text-zinc-500">
                    
                    {L("自动读取", "Automatically reads")} <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px]">extension/package.json</code>{L("、合并相对路径", ", resolves relative")} <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px]">include</code>  {L("继承并预览全部亮暗变体", "includes, and previews all light/dark variants")}
                  </p>
                </div>
              )}

              {vscInputMode === 'source' && (
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50/40 p-4 space-y-3">
                  <div className="text-[13px] font-semibold text-zinc-900">{L("Marketplace 链接、扩展 ID 或本机扩展目录", "Marketplace URL, extension ID, or local extension directory")}</div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      value={vscSourceText}
                      onChange={event => setVscSourceText(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' && vscSourceText.trim() && !vscParsing) {
                          void parseVsCodePayload({ source: vscSourceText.trim() });
                        }
                      }}
                      placeholder={L("enkia.tokyo-night 或 https://marketplace.visualstudio.com/items?itemName=... 或 ~/.vscode/extensions/...", "enkia.tokyo-night or https://marketplace.visualstudio.com/items?itemName=... or ~/.vscode/extensions/...")}
                      aria-label={L("VS Code Marketplace 链接、扩展 ID 或本机路径", "VS Code Marketplace URL, extension ID, or local path")}
                      spellCheck={false}
                      className="ui-field h-9 min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 font-mono text-[12.5px] text-zinc-900 placeholder:text-zinc-400"
                    />
                    <button
                      type="button"
                      disabled={!vscSourceText.trim() || vscParsing}
                      onClick={() => void parseVsCodePayload({ source: vscSourceText.trim() })}
                      className="ui-press inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 text-[12.5px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-45"
                    >
                      {vscParsing ? <Spinner size={13} label={L("解析中", "Parsing")}/> : <Globe size={13.5}/>}
                      <span>{vscParsing ? L("解析中…", "Parsing…") : L("解析主题", "Parse Theme")}</span>
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-zinc-500">
                    <span>{L("常用示例：", "Examples:")}</span>
                    {['enkia.tokyo-night', 'Catppuccin.catppuccin-vsc', 'GitHub.github-vscode-theme', 'dracula-theme.theme-dracula'].map(id => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setVscSourceText(id)}
                        className="rounded-md border border-zinc-200 bg-white px-2 py-0.5 font-mono text-[11px] text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                      >
                        {id}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {vscInputMode === 'json' && (
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50/40 p-4 space-y-3">
                  <div className="text-[13px] font-semibold text-zinc-900">{L("粘贴 VS Code 主题 JSON / JSONC 内容", "Paste VS Code Theme JSON / JSONC")}</div>
                  <textarea
                    rows={6}
                    value={vscJsonText}
                    onChange={event => setVscJsonText(event.target.value)}
                    placeholder={L("{\n  // 支持注释与尾逗号\n  \"name\": \"My Theme\",\n  \"type\": \"dark\",\n  \"colors\": {\n    \"editor.background\": \"#1a1b26\",\n    \"editor.foreground\": \"#c0caf5\",\n    \"button.background\": \"#7aa2f7\",\n  }\n}", "{\n  // Comments and trailing commas supported\n  \"name\": \"My Theme\",\n  \"type\": \"dark\",\n  \"colors\": {\n    \"editor.background\": \"#1a1b26\",\n    \"editor.foreground\": \"#c0caf5\",\n    \"button.background\": \"#7aa2f7\",\n  }\n}")}
                    aria-label={L("VS Code 主题 JSONC 内容", "VS Code theme JSONC content")}
                    spellCheck={false}
                    className="ui-field w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2.5 font-mono text-[12px] leading-5 text-zinc-900 placeholder:text-zinc-400"
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      disabled={!vscJsonText.trim() || vscParsing}
                      onClick={() => void parseVsCodePayload({ jsonText: vscJsonText.trim(), fileName: 'pasted-theme.jsonc' })}
                      className="ui-press inline-flex h-9 items-center gap-1.5 rounded-xl bg-accent px-4 text-[12.5px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-45"
                    >
                      {vscParsing ? <Spinner size={13} label={L("解析中", "Parsing")}/> : <FileCode2 size={14}/>}
                      <span>{L("解析 JSONC", "Parse JSONC")}</span>
                    </button>
                  </div>
                </div>
              )}

              {/* 解析出的多变体预览列表 */}
              {vscBundle && vscBundle.variants.length > 0 && (
                <div data-testid="vscode-variants-preview" className="ui-status-banner-in space-y-3 rounded-2xl border border-zinc-200 bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-semibold text-zinc-900">{vscBundle.extensionName || vscBundle.sourceLabel}</span>
                        {vscBundle.version && (
                          <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-500">v{vscBundle.version}</span>
                        )}
                        <span className="text-[12px] text-zinc-500">{L("共", "")} {vscBundle.variants.length}  {L("个变体", " variant(s)")}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {vscBundle.variants.length > 1 && (
                        <button
                          type="button"
                          disabled={vscImporting}
                          onClick={() => void handleConfirmVsCodeImport(true)}
                          className="ui-press inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-[12px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
                        >
                          
                          {L("导入全部并应用选中", "Import All & Apply Selected")}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={vscImporting || !vscSelectedLabel}
                        onClick={() => void handleConfirmVsCodeImport(false)}
                        data-testid="vscode-import-apply-btn"
                        className="ui-press inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
                      >
                        {vscImporting ? <Spinner size={12} label={L("导入中", "Importing")}/> : <Check size={13}/>}
                        <span>{L("导入并立即应用", "Import & Apply")}</span>
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {vscBundle.variants.map((variant: ParsedVsCodeThemeVariant) => {
                      const selected = vscSelectedLabel === variant.label;
                      const previewing = isPreviewingTheme(variant.theme.id);
                      return (
                        <div
                          key={variant.label}
                          onClick={() => setVscSelectedLabel(variant.label)}
                          role="radio"
                          aria-checked={selected}
                          tabIndex={0}
                          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setVscSelectedLabel(variant.label); } }}
                          className={`cursor-pointer rounded-xl border p-3 transition-all ${
                            selected
                              ? 'border-accent bg-accent-soft/45 ring-1 ring-accent'
                              : 'border-zinc-200 bg-white hover:border-zinc-300'
                          }`}
                        >
                          <ThemeMiniPreview tokens={variant.theme.tokens} compact/>
                          <div className="mt-2.5 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-[13px] font-semibold text-zinc-900">{variant.label}</span>
                                <span className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10.5px] text-zinc-600">
                                  {variant.theme.mode === 'dark' ? L("深色", "Dark") : L("浅色", "Light")}
                                </span>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                <ContrastBadge report={variant.report}/>
                                <span className="text-[11px] text-zinc-400">{L("提取", "Extracted ")} {variant.colorCount}  {L("项色值", " tokens")}</span>
                              </div>
                            </div>
                            <HoverTooltip content={previewing ? L("退出全站预览", "Exit Live Preview") : L("预览整站效果", "Preview Across App")}>
                              <button
                                type="button"
                                aria-label={previewing ? L(`退出预览 ${variant.label}`, `Stop previewing ${variant.label}`) : L(`预览 ${variant.label}`, `Preview ${variant.label}`)}
                                onClick={event => { event.stopPropagation(); toggleThemePreview(variant.theme); }}
                                className={`ui-press grid h-7 w-7 shrink-0 place-items-center rounded-lg border ${
                                  previewing
                                    ? 'border-amber-300 bg-amber-50 text-amber-800'
                                    : 'border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
                                }`}
                              >
                                {previewing ? <EyeOff size={13}/> : <Eye size={13}/>}
                              </button>
                            </HoverTooltip>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/70 px-3.5 py-2.5 text-[12px] leading-5 text-zinc-600">
                <strong className="font-semibold text-zinc-800">{L("会话直发快捷方式：", "Chat shortcut: ")}</strong>
                
                {L("也可以直接把", "You can also drag a")} <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px]">.vsix</code> / <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px]">.json</code> / <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px]">.jsonc</code>  {L("拖进任意会话输入框发给小猫或 Agent，它会直接运行", "file into any chat composer and the Agent will run")} <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px]">{L("agent-dock theme import-vscode &lt;路径&gt; --apply", "agent-dock theme import-vscode <path> --apply")}</code>  {L("为你实时换肤。", "to apply it live.")}
              </div>
            </div>
          )}

          {/* ============ 4. 实时色板微调 ============ */}
          {tab === 'editor' && (
            <div className="ui-view-fade space-y-4">
              {/* 顶部元信息 + 实时 Mini UI + 对比度仪表盘 */}
              <div className="grid grid-cols-1 gap-4 rounded-2xl border border-zinc-200 bg-zinc-50/40 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
                <div className="space-y-3 min-w-0">
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <div>
                      <label htmlFor="theme-edit-name" className="mb-1 block text-[11.5px] font-medium text-zinc-500">{L("主题名称", "Theme Name")}</label>
                      <input
                        id="theme-edit-name"
                        value={editName}
                        onChange={event => setEditName(event.target.value)}
                        placeholder={L("给你的专属主题起个名字", "Name your custom theme")}
                        className="ui-field h-9 w-full rounded-xl border border-zinc-200 bg-white px-3 text-[13px] text-zinc-900 placeholder:text-zinc-400"
                      />
                    </div>
                    <div>
                      <span className="mb-1 block text-[11.5px] font-medium text-zinc-500">{L("主题极性", "Theme Polarity")}</span>
                      <SlidingSegmented<CustomThemeMode>
                        ariaLabel={L("编辑主题极性", "Edit theme polarity")}
                        size="sm"
                        value={editMode}
                        onChange={next => setEditMode(next)}
                        className="h-9"
                        options={[
                          { value: 'light', label: <><Sun size={12}/>{L("浅色", "Light")}</> },
                          { value: 'dark', label: <><Moon size={12}/>{L("深色", "Dark")}</> }
                        ]}
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="theme-edit-desc" className="mb-1 block text-[11.5px] font-medium text-zinc-500">{L("主题简介（可选）", "Description (Optional)")}</label>
                    <input
                      id="theme-edit-desc"
                      value={editDescription}
                      onChange={event => setEditDescription(event.target.value)}
                      placeholder={L("例如：低蓝光护眼深夜工作台", "e.g., Low-blue-light dark desk for late nights")}
                      className="ui-field h-8 w-full rounded-xl border border-zinc-200 bg-white px-3 text-[12.5px] text-zinc-900 placeholder:text-zinc-400"
                    />
                  </div>

                  {/* WCAG 对比度实时体检 */}
                  <div className="rounded-xl border border-zinc-200 bg-white p-3 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-semibold text-zinc-800">{L("WCAG 对比度实时校验", "Live WCAG Contrast Check")}</span>
                        <ContrastBadge report={editorContrast}/>
                      </div>
                      <button
                        type="button"
                        onClick={handleAutoHealEditor}
                        className="ui-press inline-flex h-7 items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 text-[11.5px] font-medium text-zinc-700 hover:bg-zinc-100"
                      >
                        <ShieldCheck size={12} className="text-emerald-600"/>{L("一键护眼修正", "Auto-Fix Contrast")}
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                      {([
                        { label: L("正文/画布", "Text / Bg"), check: editorContrast.textOnCanvas },
                        { label: L("次文/画布", "Sub / Bg"), check: editorContrast.textSecondaryOnCanvas },
                        { label: L("弱文/画布", "Muted / Bg"), check: editorContrast.textMutedOnCanvas },
                        { label: L("按钮字/强调", "Accent"), check: editorContrast.accentForegroundOnAccent }
                      ] as const).map(item => (
                        <div
                          key={item.label}
                          className={`rounded-lg border px-2 py-1.5 text-[11px] ${
                            item.check.pass
                              ? 'border-emerald-200/80 bg-emerald-50/70 text-emerald-800'
                              : 'border-amber-200 bg-amber-50/90 text-amber-900'
                          }`}
                        >
                          <div className="truncate opacity-80">{item.label}</div>
                          <div className="mt-0.5 font-mono font-semibold tabular-nums">
                            {item.check.ratio.toFixed(1)}:1 {item.check.pass ? '✓' : `< ${item.check.target}`}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 右侧实时预览卡 */}
                <div className="flex flex-col justify-between gap-2.5">
                  <ThemeMiniPreview tokens={editTokens}/>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setLivePreviewEditor(v => !v)}
                      className={`ui-press inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium ${
                        livePreviewEditor
                          ? 'border-amber-300 bg-amber-50 text-amber-800'
                          : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100'
                      }`}
                    >
                      {livePreviewEditor ? <EyeOff size={13}/> : <Eye size={13}/>}
                      <span>{livePreviewEditor ? L("关闭整站实时预览", "Stop live preview") : L("实时预览到整站", "Live preview across app")}</span>
                    </button>
                    <HoverTooltip content={L("重置为当前极性默认色板", "Reset to default polarity palette")}>
                      <button
                        type="button"
                        aria-label={L("重置当前色板", "Reset Palette")}
                        onClick={() => {
                          setEditTokens({ ...getDefaultThemeForMode(editMode).tokens });
                          setHexDrafts({});
                        }}
                        className="ui-press grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                      >
                        <RotateCcw size={13}/>
                      </button>
                    </HoverTooltip>
                  </div>
                </div>
              </div>

              {/* 20 个语义色块分组调色 */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {getTokenGroups(L).map(group => (
                  <div key={group.id} className="rounded-2xl border border-zinc-200 bg-white p-3.5 space-y-2.5">
                    <div>
                      <div className="text-[13px] font-semibold text-zinc-900">{group.title}</div>
                      <div className="text-[11.5px] text-zinc-400">{group.description}</div>
                    </div>
                    <div className="space-y-1.5">
                      {group.items.map(({ key, label }) => {
                        const currentHex = editTokens[key];
                        const draftVal = hexDrafts[key] ?? currentHex;
                        const invalid = draftVal !== currentHex && normalizeHexColor(draftVal) === null;
                        return (
                          <div key={key} className="flex items-center gap-2 rounded-lg px-1 py-0.5 hover:bg-zinc-50">
                            <label className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-zinc-300 shadow-inner">
                              <input
                                type="color"
                                value={currentHex}
                                aria-label={L(`选择${label}颜色`, `Pick ${label} color`)}
                                onChange={event => updateEditorToken(key, event.target.value)}
                                className="absolute -inset-2 h-12 w-12 cursor-pointer border-0 bg-transparent p-0"
                              />
                            </label>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[12.5px] font-medium text-zinc-800">{label}</div>
                              <div className="truncate font-mono text-[10.5px] text-zinc-400">{key}</div>
                            </div>
                            <input
                              value={draftVal}
                              aria-label={L(`${label} Hex 色值`, `${label} hex value`)}
                              aria-invalid={invalid || undefined}
                              spellCheck={false}
                              onChange={event => updateEditorToken(key, event.target.value)}
                              onBlur={() => setHexDrafts(prev => { const next = { ...prev }; delete next[key]; return next; })}
                              className="ui-field h-7 w-[90px] shrink-0 rounded-lg border border-zinc-200 bg-white px-2 font-mono text-[11.5px] text-zinc-800"
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 调色板底栏操作条 */}
        {tab === 'editor' && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-zinc-200 bg-zinc-50/70 px-4 py-3 sm:px-5">
            <div className="text-[11.5px] text-zinc-500">
              
              {L("保存时会自动经过 WCAG 对比度守护并同步广播到所有已打开窗口", "Saving runs WCAG contrast guards and syncs across all open windows")}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {editId && (
                <button
                  type="button"
                  disabled={savingEditor}
                  onClick={() => void handleSaveEditor(true)}
                  className="ui-press h-8 rounded-lg border border-zinc-200 bg-white px-3 text-[12px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
                >
                  
                  {L("另存为新主题", "Save as Copy")}
                </button>
              )}
              <button
                type="button"
                disabled={savingEditor || !editName.trim()}
                onClick={() => void handleSaveEditor(false)}
                data-testid="theme-editor-save-btn"
                className="ui-press inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-4 text-[12px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-45"
              >
                {savingEditor ? <Spinner size={12} label={L("保存中", "Saving")}/> : <Check size={13}/>}
                <span>{editId ? L("保存修改并应用", "Save & Apply") : L("保存主题并应用", "Save & Apply")}</span>
              </button>
            </div>
          </div>
        )}
      </div>
  );

  if (embedded) return studioContent;

  return (
    <div
      className="ui-overlay ui-overlay-sheet fixed inset-0 z-50 grid place-items-center bg-zinc-950/35 p-0 sm:p-4"
      onMouseDown={event => { if (event.currentTarget === event.target) handleClose(); }}
    >
      {studioContent}
    </div>
  );
}

function ThemeCard({
  theme,
  active,
  busy,
  confirmingDelete,
  onActivate,
  onEdit,
  onExport,
  onDelete,
  onCancelDelete
}: {
  theme: CustomTheme;
  active: boolean;
  busy: boolean;
  confirmingDelete: boolean;
  onActivate(): void;
  onEdit(): void;
  onExport(): void;
  onDelete?(): void;
  onCancelDelete?(): void;
}) {
  const L = useBi();
  const locale = useLocale();
  const badge = getSourceBadge(theme.source, L);
  const localized = localizeThemeDisplay(theme, locale);
  const isDefaultBuiltin = theme.id === BUILTIN_LIGHT_THEME_ID || theme.id === BUILTIN_DARK_THEME_ID;

  return (
    <div
      data-testid={`theme-card-${theme.id}`}
      data-active={active ? 'true' : 'false'}
      className={`group relative flex flex-col rounded-2xl border p-2.5 transition-all ${
        active
          ? 'border-accent bg-accent-soft/45 ring-1 ring-accent shadow-sm'
          : 'border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-sm'
      }`}
    >
      <button
        type="button"
        disabled={busy}
        onClick={onActivate}
        className="w-full text-left focus-visible:rounded-xl"
      >
        <ThemeMiniPreview tokens={theme.tokens}/>
        <div className="mt-2.5 flex items-start justify-between gap-2 px-0.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13.5px] font-semibold text-zinc-900">{localized.name}</span>
              {active && (
                <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-accent px-1.5 py-0.5 text-[10.5px] font-semibold text-accent-fg">
                  <Check size={10} strokeWidth={2.6}/>{L("生效中", "Active")}
                </span>
              )}
            </div>
            {localized.description && (
              <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-zinc-500">{localized.description}</p>
            )}
          </div>
        </div>
      </button>

      <div className="mt-2.5 flex items-center justify-between gap-1.5 border-t border-zinc-100 px-0.5 pt-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10.5px] text-zinc-600">
            {theme.mode === 'dark' ? <Moon size={10}/> : <Sun size={10}/>}
            {theme.mode === 'dark' ? L("深色", "Dark") : L("浅色", "Light")}
          </span>
          <span className={`rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium ${badge.className}`}>
            {badge.label}
          </span>
          {isDefaultBuiltin && (
            <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">{L("默认", "Default")}</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {confirmingDelete && onDelete && onCancelDelete ? (
            <>
              <button
                type="button"
                onClick={onDelete}
                className="ui-press h-6 rounded-md bg-red-600 px-2 text-[11px] font-medium text-white hover:bg-red-700"
              >
                
                {L("确认删除", "Confirm Delete")}
              </button>
              <button
                type="button"
                onClick={onCancelDelete}
                className="ui-press h-6 rounded-md px-1.5 text-[11px] text-zinc-500 hover:bg-zinc-100"
              >
                
                {L("取消", "Cancel")}
              </button>
            </>
          ) : (
            <>
              <HoverTooltip content={theme.source === 'builtin' ? L("基于此主题微调色板", "Duplicate & edit palette") : L("编辑此主题色板", "Edit theme palette")}>
                <button
                  type="button"
                  aria-label={L(`编辑主题 ${localized.name}`, `Edit theme ${localized.name}`)}
                  onClick={onEdit}
                  className="ui-press grid h-7 w-7 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                >
                  <SlidersHorizontal size={13}/>
                </button>
              </HoverTooltip>
              <HoverTooltip content={L("导出主题 JSON", "Export theme JSON")}>
                <button
                  type="button"
                  aria-label={L(`导出主题 ${localized.name}`, `Export theme ${localized.name}`)}
                  onClick={onExport}
                  className="ui-press grid h-7 w-7 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                >
                  <Download size={13}/>
                </button>
              </HoverTooltip>
              {onDelete && theme.source !== 'builtin' && (
                <HoverTooltip content={L("删除此自定义主题", "Delete custom theme")}>
                  <button
                    type="button"
                    aria-label={L(`删除主题 ${localized.name}`, `Delete theme ${localized.name}`)}
                    onClick={onDelete}
                    className="ui-press grid h-7 w-7 place-items-center rounded-lg text-zinc-500 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 size={13}/>
                  </button>
                </HoverTooltip>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
