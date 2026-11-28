import { isAchromatic, mixHex, type CustomTheme } from '@agent-dock/agent-dock-shared';

export interface MermaidInitConfig {
  startOnLoad: false;
  securityLevel: 'strict';
  theme: 'base';
  darkMode: boolean;
  fontFamily: string;
  flowchart: {
    htmlLabels: boolean;
    curve: 'basis';
    padding: number;
    nodeSpacing: number;
    rankSpacing: number;
  };
  sequence: {
    useMaxWidth: boolean;
    actorMargin: number;
    messageMargin: number;
  };
  themeVariables: Record<string, string | boolean>;
}

/**
 * 将 AgentDock 的任意一套主题（含 20 套内置亮/暗主题、AI 生成主题、VS Code 导入主题）
 * 精确映射为 Mermaid v12 `base` 主题变量，确保图表原生融入当前画布底色且保证对比度。
 */
export function buildMermaidConfig(theme: CustomTheme): MermaidInitConfig {
  const t = theme.tokens;
  const dark = theme.mode === 'dark';
  const accentStroke = isAchromatic(t.accent) ? t.info : t.accent;
  const primaryNodeBg = mixHex(t.bgSurface, accentStroke, dark ? 0.16 : 0.08);
  const secondaryNodeBg = mixHex(t.bgSurface, t.info, dark ? 0.14 : 0.07);
  const tertiaryNodeBg = t.bgCode;
  const noteBg = mixHex(t.bgSurface, t.warning, dark ? 0.18 : 0.12);
  const fontFamily = '"Fira Code", -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif';

  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    darkMode: dark,
    fontFamily,
    flowchart: {
      htmlLabels: false,
      curve: 'basis',
      padding: 14,
      nodeSpacing: 44,
      rankSpacing: 46
    },
    sequence: {
      useMaxWidth: true,
      actorMargin: 42,
      messageMargin: 32
    },
    themeVariables: {
      darkMode: dark,
      background: 'transparent',
      fontFamily,
      fontSize: '13px',
      primaryColor: primaryNodeBg,
      primaryTextColor: t.textPrimary,
      primaryBorderColor: mixHex(t.borderStrong, accentStroke, dark ? 0.55 : 0.45),
      secondaryColor: secondaryNodeBg,
      secondaryTextColor: t.textPrimary,
      secondaryBorderColor: t.borderStrong,
      tertiaryColor: tertiaryNodeBg,
      tertiaryTextColor: t.textSecondary,
      tertiaryBorderColor: t.borderSubtle,
      lineColor: t.textMuted,
      textColor: t.textPrimary,
      mainBkg: primaryNodeBg,
      nodeBkg: t.bgSurface,
      nodeBorder: t.borderStrong,
      clusterBkg: mixHex(t.bgCanvas, t.bgCode, 0.72),
      clusterBorder: t.borderSubtle,
      defaultLinkColor: t.textMuted,
      titleColor: t.textPrimary,
      edgeLabelBackground: t.bgCanvas,
      actorBkg: t.bgSurface,
      actorBorder: t.borderStrong,
      actorTextColor: t.textPrimary,
      actorLineColor: t.borderStrong,
      signalColor: t.textSecondary,
      signalTextColor: t.textPrimary,
      labelBoxBkgColor: t.bgElevated,
      labelBoxBorderColor: t.borderSubtle,
      labelTextColor: t.textPrimary,
      loopTextColor: t.textSecondary,
      noteBkgColor: noteBg,
      noteBorderColor: mixHex(t.borderStrong, t.warning, 0.6),
      noteTextColor: t.textPrimary,
      activationBkgColor: primaryNodeBg,
      activationBorderColor: accentStroke,
      sectionBkgColor: t.bgSurface,
      altSectionBkgColor: t.bgCode,
      gridColor: t.borderSubtle,
      doneTaskBkgColor: mixHex(t.bgSurface, t.success, dark ? 0.25 : 0.16),
      doneTaskBorderColor: t.success,
      activeTaskBkgColor: primaryNodeBg,
      activeTaskBorderColor: accentStroke,
      critBkgColor: mixHex(t.bgSurface, t.danger, dark ? 0.25 : 0.16),
      critBorderColor: t.danger,
      pie1: accentStroke,
      pie2: t.info,
      pie3: t.success,
      pie4: t.warning,
      pie5: t.danger,
      pie6: mixHex(t.info, t.success, 0.5),
      pie7: mixHex(accentStroke, t.warning, 0.5),
      pieStrokeColor: t.bgCanvas,
      pieTitleTextColor: t.textPrimary,
      pieSectionTextColor: t.textInverse,
      pieLegendTextColor: t.textSecondary,
      git0: accentStroke,
      git1: t.info,
      git2: t.success,
      git3: t.warning,
      git4: t.danger,
      gitBranchLabel0: t.textInverse,
      gitBranchLabel1: t.textInverse,
      gitBranchLabel2: t.textInverse,
      gitBranchLabel3: t.textInverse
    }
  };
}

export function themeSignature(theme: CustomTheme): string {
  const t = theme.tokens;
  return `${theme.id}:${theme.mode}:${t.bgCanvas}:${t.bgSurface}:${t.textPrimary}:${t.accent}:${t.borderStrong}`;
}

const MAX_CACHE_ENTRIES = 64;
const svgCache = new Map<string, string>();
let renderCounter = 0;
let renderQueue: Promise<unknown> = Promise.resolve();
let mermaidModulePromise: Promise<typeof import('mermaid')> | null = null;

function loadMermaid() {
  if (!mermaidModulePromise) {
    // 严格按需动态懒加载：纯文本对话零首屏开销
    mermaidModulePromise = import('mermaid');
  }
  return mermaidModulePromise;
}

export function getCachedMermaidSvg(code: string, theme: CustomTheme): string | undefined {
  return svgCache.get(`${themeSignature(theme)}\0${code}`);
}

export function clearMermaidCacheForTest(): void {
  svgCache.clear();
}

/**
 * 串行化 Mermaid `initialize` + `render`，避免多张图表同时渲染或切换主题时全局状态竞态。
 * 自动缓存 `(code, themeSignature) -> svg`，并清理 Mermaid 报错时可能残留在 body 的临时节点。
 */
export function renderMermaidSvg(code: string, theme: CustomTheme): Promise<string> {
  const cacheKey = `${themeSignature(theme)}\0${code}`;
  const cached = svgCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  const job = async (): Promise<string> => {
    const again = svgCache.get(cacheKey);
    if (again) return again;

    const mod = await loadMermaid();
    const mermaid = mod.default;
    const config = buildMermaidConfig(theme);
    mermaid.initialize(config as any);

    const id = `ad-mermaid-${++renderCounter}`;
    try {
      const result = await mermaid.render(id, code);
      const svg = result?.svg?.trim() ?? '';
      if (!svg || !/<svg[\s>]/i.test(svg)) {
        throw new Error('Empty Mermaid SVG output');
      }
      if (svgCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = svgCache.keys().next().value;
        if (oldest !== undefined) svgCache.delete(oldest);
      }
      svgCache.set(cacheKey, svg);
      return svg;
    } finally {
      // Mermaid 语法报错时偶尔会在 body 留下 `#d<id>` 错误提示节点，立即清理避免污染页面
      if (typeof document !== 'undefined') {
        document.getElementById(`d${id}`)?.remove();
      }
    }
  };

  const next = renderQueue.then(job, job);
  renderQueue = next.catch(() => undefined);
  return next;
}
