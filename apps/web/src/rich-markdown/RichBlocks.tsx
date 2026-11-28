import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTimeout } from 'ahooks';
import { Highlight, Prism, themes } from 'prism-react-renderer';
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Download,
  Eye,
  Info,
  Lightbulb,
  Maximize2,
  MessageSquareWarning,
  OctagonAlert,
  Table2
} from 'lucide-react';
import type { CalloutKind, MetricItem, StepItem } from '@agent-dock/agent-dock-shared';
import { HoverTooltip } from '../HoverTooltip';
import { useT } from '../i18n';
import { useActiveTheme, useResolvedTheme } from '../themes';
import { copyTextToClipboard, downloadSvgMarkup } from './export-utils';
import { getCachedMermaidSvg, renderMermaidSvg } from './mermaid-theme';
import { sanitizeSvgMarkup } from './svg-sanitize';

export interface DiagramLightboxRequest {
  svgMarkup: string;
  alt: string;
  downloadName: string;
  kind: 'mermaid' | 'svg';
}

const CALLOUT_LABEL_KEYS = {
  note: 'markdown.callout.note',
  tip: 'markdown.callout.tip',
  important: 'markdown.callout.important',
  warning: 'markdown.callout.warning',
  caution: 'markdown.callout.caution'
} as const;

function CalloutIcon({ kind }: { kind: CalloutKind }) {
  switch (kind) {
    case 'note':
      return <Info size={14} strokeWidth={2} className="ui-rich-callout-icon" aria-hidden="true" />;
    case 'tip':
      return <Lightbulb size={14} strokeWidth={2} className="ui-rich-callout-icon" aria-hidden="true" />;
    case 'important':
      return <MessageSquareWarning size={14} strokeWidth={2} className="ui-rich-callout-icon" aria-hidden="true" />;
    case 'warning':
      return <AlertTriangle size={14} strokeWidth={2} className="ui-rich-callout-icon" aria-hidden="true" />;
    case 'caution':
      return <OctagonAlert size={14} strokeWidth={2} className="ui-rich-callout-icon" aria-hidden="true" />;
  }
}

/** 5 级无框 GFM Alert Callout：无常驻灰顶栏，极淡语义融底 + 细左色条。 */
export const RichCallout = memo(function RichCallout({
  kind,
  title,
  children
}: {
  kind: CalloutKind;
  title?: string;
  children: ReactNode;
}) {
  const t = useT();
  const heading = title?.trim() || t(CALLOUT_LABEL_KEYS[kind]);
  return (
    <aside
      className="ui-rich-callout"
      data-callout={kind}
      role="note"
      aria-label={heading}
    >
      <div className="ui-rich-callout-header">
        <CalloutIcon kind={kind} />
        <span className="ui-rich-callout-title">{heading}</span>
      </div>
      <div className="ui-rich-callout-body">{children}</div>
    </aside>
  );
});

/** 无框 KPI 指标条：桌面端横向无框排布，窄屏/390px 移动端自动折为 2×2 细线网格。 */
export const RichMetricsBlock = memo(function RichMetricsBlock({ items }: { items: MetricItem[] }) {
  const desktopCols = Math.min(Math.max(items.length, 1), 4);
  return (
    <div
      className="ui-rich-metrics"
      data-testid="rich-metrics"
      data-cols={desktopCols}
      style={{ '--ui-metrics-cols': String(desktopCols) } as React.CSSProperties}
    >
      {items.map((item, idx) => (
        <div key={`${item.label}-${idx}`} className="ui-rich-metric-item">
          <div className="ui-rich-metric-label">{item.label}</div>
          <div className="ui-rich-metric-value">{item.value}</div>
          {item.sub ? (
            <div className="ui-rich-metric-sub" data-tone={item.tone}>
              {item.sub}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
});

/** 步进时间轴：已完成（实心勾）、进行中（高亮圆点）、待开始（淡灰空心圆）+ 竖向连接细线。 */
export const RichStepsBlock = memo(function RichStepsBlock({ items }: { items: StepItem[] }) {
  return (
    <ol className="ui-rich-steps" data-testid="rich-steps">
      {items.map((step, idx) => (
        <li key={`${step.title}-${idx}`} className="ui-rich-step" data-status={step.status}>
          <span className="ui-rich-step-marker" aria-hidden="true">
            {step.status === 'done' ? (
              <Check size={11} strokeWidth={2.75} />
            ) : (
              <span className="ui-rich-step-dot" />
            )}
          </span>
          <div className="ui-rich-step-content">
            <div className="ui-rich-step-title">{step.title}</div>
            {step.detail ? <div className="ui-rich-step-detail">{step.detail}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
});

export type StreamingBlockKind = 'mermaid' | 'svg' | 'metrics' | 'steps';

const STREAMING_LABELS: Record<StreamingBlockKind, Parameters<ReturnType<typeof useT>>[0]> = {
  mermaid: 'markdown.diagram.mermaidStreaming',
  svg: 'markdown.diagram.svgStreaming',
  metrics: 'markdown.diagram.metricsStreaming',
  steps: 'markdown.diagram.stepsStreaming'
};

/**
 * 流式未闭合富文本块平稳占位：
 * 固定轻量骨架高度，避免代码块尚未闭合时每帧触发语法报错框闪烁或页面布局剧烈抖动。
 */
export const StreamingBlockPlaceholder = memo(function StreamingBlockPlaceholder({
  kind,
  code
}: {
  kind: StreamingBlockKind;
  code: string;
}) {
  const t = useT();
  const previewLines = useMemo(() => {
    const trimmed = code.trim();
    if (!trimmed) return '';
    const lines = trimmed.split('\n');
    return lines.slice(-4).join('\n');
  }, [code]);

  return (
    <div
      className="ui-rich-streaming-placeholder"
      data-testid="rich-streaming-placeholder"
      data-rich-kind={kind}
      role="status"
    >
      <div className="ui-rich-streaming-head">
        <span className="ui-rich-streaming-dot" aria-hidden="true" />
        <span>{t(STREAMING_LABELS[kind])}</span>
      </div>
      {previewLines ? (
        <pre className="ui-rich-streaming-preview">
          <code>{previewLines}</code>
        </pre>
      ) : (
        <div className="ui-rich-streaming-bars" aria-hidden="true">
          <span className="ui-rich-streaming-bar ui-rich-streaming-bar--lg" />
          <span className="ui-rich-streaming-bar ui-rich-streaming-bar--md" />
        </div>
      )}
    </div>
  );
});

/** 供表格 MD 视图、Mermaid/SVG 源码视图复用的无顶栏语法高亮源码块。 */
const FramelessSourceBlock = memo(function FramelessSourceBlock({
  code,
  language
}: {
  code: string;
  language: string;
}) {
  const dark = useResolvedTheme() === 'dark';
  const prismLang = language && Prism.languages[language] ? language : 'plain';
  return (
    <div className="ui-rich-source-box">
      <Highlight theme={dark ? themes.vsDark : themes.vsLight} code={code} language={prismLang}>
        {({ className: prismClassName, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={`${prismClassName} code-renderer-scroll ui-rich-source-pre`}
            style={{ ...style, backgroundColor: 'transparent' }}
          >
            <code>
              {tokens.map((line, lineIndex) => (
                <span key={lineIndex} {...getLineProps({ line })} className="block min-h-5">
                  {line.map((token, tokenIndex) => (
                    <span key={tokenIndex} {...getTokenProps({ token })} />
                  ))}
                </span>
              ))}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  );
});

/** 从已渲染的 HTML 表格节点重建 GFM Markdown 表格（仅在 AST 未能提供原始切片时兜底）。 */
function serializeTableElementToMarkdown(tableEl: HTMLTableElement | null): string {
  if (!tableEl) return '';
  const rows: string[][] = [];
  for (const tr of Array.from(tableEl.querySelectorAll('tr'))) {
    const cells = Array.from(tr.children)
      .filter(el => el.tagName === 'TH' || el.tagName === 'TD')
      .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'));
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';
  const colCount = Math.max(...rows.map(r => r.length));
  const formatRow = (r: string[]) =>
    `| ${Array.from({ length: colCount }, (_, idx) => r[idx] ?? '').join(' | ')} |`;
  const header = formatRow(rows[0]!);
  const sep = `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`;
  const body = rows.slice(1).map(formatRow);
  return [header, sep, ...body].join('\n');
}

/** 无框紧凑表格：极简细横线 + 右上角轻量化「复制表格」「MD / 表格」切换，窄屏横向滚动零溢出。 */
export const RichTableBlock = memo(function RichTableBlock({
  rawMarkdown,
  children
}: {
  rawMarkdown?: string;
  children: ReactNode;
}) {
  const t = useT();
  const tableRef = useRef<HTMLTableElement>(null);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  useTimeout(() => setCopied(false), copied ? 1_500 : undefined);

  const resolveMarkdown = () => rawMarkdown?.trim() || serializeTableElementToMarkdown(tableRef.current);

  const handleCopy = async () => {
    const md = resolveMarkdown();
    if (!md) return;
    const ok = await copyTextToClipboard(md);
    if (ok) setCopied(true);
  };

  const mdText = showSource ? resolveMarkdown() : '';

  return (
    <div className="ui-rich-table-wrap" data-testid="rich-table">
      <div className="ui-rich-table-actions">
        <HoverTooltip content={copied ? t('markdown.table.copied') : t('markdown.table.copyTooltip')}>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className={`ui-rich-action-btn ${copied ? 'is-copied' : ''}`}
            aria-label={copied ? t('markdown.table.copied') : t('markdown.table.copyTooltip')}
            data-testid="rich-table-copy"
          >
            {copied ? <Check size={12} className="ui-icon-pop" /> : <Copy size={12} />}
            <span>{copied ? t('markdown.table.copied') : t('markdown.table.copy')}</span>
          </button>
        </HoverTooltip>
        <HoverTooltip
          content={showSource ? t('markdown.table.toggleTableTooltip') : t('markdown.table.toggleMdTooltip')}
        >
          <button
            type="button"
            onClick={() => setShowSource(prev => !prev)}
            className={`ui-rich-action-btn ${showSource ? 'is-active' : ''}`}
            aria-pressed={showSource}
            aria-label={showSource ? t('markdown.table.toggleTableTooltip') : t('markdown.table.toggleMdTooltip')}
            data-testid="rich-table-toggle-md"
          >
            {showSource ? <Table2 size={12} /> : null}
            <span>{showSource ? t('markdown.table.viewTable') : t('markdown.table.viewMd')}</span>
          </button>
        </HoverTooltip>
      </div>
      {showSource ? (
        <FramelessSourceBlock code={mdText || rawMarkdown || ''} language="markdown" />
      ) : (
        <div className="markdown-table-scroll">
          <table ref={tableRef}>{children}</table>
        </div>
      )}
    </div>
  );
});

/** 安全消毒 SVG 原生矢量渲染块（右上角轻量悬浮操作，点击画布进全屏 Lightbox）。 */
export const SvgDiagramBlock = memo(function SvgDiagramBlock({
  code,
  onOpenLightbox
}: {
  code: string;
  onOpenLightbox: (req: DiagramLightboxRequest) => void;
}) {
  const t = useT();
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  useTimeout(() => setCopied(false), copied ? 1_500 : undefined);

  const sanitized = useMemo(() => sanitizeSvgMarkup(code), [code]);
  if (!sanitized) return null;

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(code);
    if (ok) setCopied(true);
  };

  const openLightbox = () => {
    onOpenLightbox({
      svgMarkup: sanitized,
      alt: t('markdown.diagram.svgAlt'),
      downloadName: 'diagram.svg',
      kind: 'svg'
    });
  };

  return (
    <div className="ui-rich-media-block" data-testid="rich-svg-block">
      <div className="ui-rich-floating-actions">
        <HoverTooltip
          content={showSource ? t('markdown.diagram.togglePreviewTooltip') : t('markdown.diagram.toggleSourceTooltip')}
        >
          <button
            type="button"
            onClick={() => setShowSource(prev => !prev)}
            className={`ui-rich-action-btn ${showSource ? 'is-active' : ''}`}
            aria-pressed={showSource}
            aria-label={showSource ? t('markdown.diagram.togglePreviewTooltip') : t('markdown.diagram.toggleSourceTooltip')}
            data-testid="rich-svg-toggle-source"
          >
            {showSource ? <Eye size={12} /> : <Code2 size={12} />}
            <span>{showSource ? t('markdown.diagram.viewPreview') : t('markdown.diagram.viewSource')}</span>
          </button>
        </HoverTooltip>
        <HoverTooltip content={copied ? t('markdown.diagram.copied') : t('markdown.diagram.copySvg')}>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className={`ui-rich-action-btn ${copied ? 'is-copied' : ''}`}
            aria-label={copied ? t('markdown.diagram.copied') : t('markdown.diagram.copySvg')}
          >
            {copied ? <Check size={12} className="ui-icon-pop" /> : <Copy size={12} />}
          </button>
        </HoverTooltip>
        <HoverTooltip content={t('markdown.diagram.downloadSvg')}>
          <button
            type="button"
            onClick={() => downloadSvgMarkup(sanitized, 'diagram.svg')}
            className="ui-rich-action-btn"
            aria-label={t('markdown.diagram.downloadSvg')}
          >
            <Download size={12} />
          </button>
        </HoverTooltip>
        <HoverTooltip content={t('markdown.diagram.fullscreen')}>
          <button
            type="button"
            onClick={openLightbox}
            className="ui-rich-action-btn"
            aria-label={t('markdown.diagram.fullscreen')}
            data-testid="rich-svg-fullscreen"
          >
            <Maximize2 size={12} />
          </button>
        </HoverTooltip>
      </div>
      {showSource ? (
        <FramelessSourceBlock code={code} language="markup" />
      ) : (
        <button
          type="button"
          onClick={openLightbox}
          className="ui-rich-diagram-canvas"
          aria-label={t('markdown.diagram.fullscreen')}
        >
          <div className="ui-rich-svg-stage" dangerouslySetInnerHTML={{ __html: sanitized }} />
        </button>
      )}
    </div>
  );
});

/**
 * Mermaid 原生渲染块：
 * - 按需 `import('mermaid')`，绝不进入首屏主 chunk；
 * - 实时跟随 AgentDock 20 套亮/暗自定义主题动态初始化与重绘；
 * - 语法错误时安静回退为源码视图，绝不弹出刺眼报错炸弹框。
 */
export const MermaidDiagramBlock = memo(function MermaidDiagramBlock({
  code,
  onOpenLightbox
}: {
  code: string;
  onOpenLightbox: (req: DiagramLightboxRequest) => void;
}) {
  const t = useT();
  const activeTheme = useActiveTheme();
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [svg, setSvg] = useState<string | null>(() => getCachedMermaidSvg(code, activeTheme) ?? null);
  const [failed, setFailed] = useState(false);
  useTimeout(() => setCopied(false), copied ? 1_500 : undefined);

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedMermaidSvg(code, activeTheme);
    if (cached) {
      setSvg(cached);
      setFailed(false);
      return;
    }

    setFailed(false);
    void renderMermaidSvg(code, activeTheme)
      .then(rendered => {
        if (!cancelled) {
          setSvg(rendered);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code, activeTheme]);

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(code);
    if (ok) setCopied(true);
  };

  const openLightbox = () => {
    if (!svg) return;
    onOpenLightbox({
      svgMarkup: svg,
      alt: t('markdown.diagram.mermaidAlt'),
      downloadName: 'mermaid-diagram.svg',
      kind: 'mermaid'
    });
  };

  if (failed) {
    return (
      <div className="ui-rich-media-block ui-rich-media-block--fallback" data-testid="rich-mermaid-fallback">
        <div className="ui-rich-fallback-row">
          <span className="ui-rich-fallback-note">{t('markdown.diagram.mermaidFallback')}</span>
          <HoverTooltip content={copied ? t('markdown.diagram.copied') : t('markdown.diagram.copySource')}>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className={`ui-rich-action-btn ${copied ? 'is-copied' : ''}`}
              aria-label={copied ? t('markdown.diagram.copied') : t('markdown.diagram.copySource')}
            >
              {copied ? <Check size={12} className="ui-icon-pop" /> : <Copy size={12} />}
              <span>{copied ? t('markdown.diagram.copied') : t('markdown.diagram.copySource')}</span>
            </button>
          </HoverTooltip>
        </div>
        <FramelessSourceBlock code={code} language="plain" />
      </div>
    );
  }

  return (
    <div className="ui-rich-media-block" data-testid="rich-mermaid-block">
      <div className="ui-rich-floating-actions">
        <HoverTooltip
          content={showSource ? t('markdown.diagram.toggleDiagramTooltip') : t('markdown.diagram.toggleSourceTooltip')}
        >
          <button
            type="button"
            onClick={() => setShowSource(prev => !prev)}
            className={`ui-rich-action-btn ${showSource ? 'is-active' : ''}`}
            aria-pressed={showSource}
            aria-label={showSource ? t('markdown.diagram.toggleDiagramTooltip') : t('markdown.diagram.toggleSourceTooltip')}
            data-testid="rich-mermaid-toggle-source"
          >
            {showSource ? <Eye size={12} /> : <Code2 size={12} />}
            <span>{showSource ? t('markdown.diagram.viewDiagram') : t('markdown.diagram.viewSource')}</span>
          </button>
        </HoverTooltip>
        <HoverTooltip content={copied ? t('markdown.diagram.copied') : t('markdown.diagram.copySource')}>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className={`ui-rich-action-btn ${copied ? 'is-copied' : ''}`}
            aria-label={copied ? t('markdown.diagram.copied') : t('markdown.diagram.copySource')}
          >
            {copied ? <Check size={12} className="ui-icon-pop" /> : <Copy size={12} />}
          </button>
        </HoverTooltip>
        {svg ? (
          <>
            <HoverTooltip content={t('markdown.diagram.downloadSvg')}>
              <button
                type="button"
                onClick={() => downloadSvgMarkup(svg, 'mermaid-diagram.svg')}
                className="ui-rich-action-btn"
                aria-label={t('markdown.diagram.downloadSvg')}
              >
                <Download size={12} />
              </button>
            </HoverTooltip>
            <HoverTooltip content={t('markdown.diagram.fullscreen')}>
              <button
                type="button"
                onClick={openLightbox}
                className="ui-rich-action-btn"
                aria-label={t('markdown.diagram.fullscreen')}
                data-testid="rich-mermaid-fullscreen"
              >
                <Maximize2 size={12} />
              </button>
            </HoverTooltip>
          </>
        ) : null}
      </div>
      {showSource ? (
        <FramelessSourceBlock code={code} language="plain" />
      ) : svg ? (
        <button
          type="button"
          onClick={openLightbox}
          className="ui-rich-diagram-canvas"
          aria-label={t('markdown.diagram.fullscreen')}
        >
          <div className="ui-rich-svg-stage ui-rich-mermaid-stage" dangerouslySetInnerHTML={{ __html: svg }} />
        </button>
      ) : (
        <div className="ui-rich-streaming-placeholder" data-testid="rich-mermaid-loading" role="status">
          <div className="ui-rich-streaming-head">
            <span className="ui-rich-streaming-dot" aria-hidden="true" />
            <span>{t('markdown.diagram.mermaidLoading')}</span>
          </div>
          <div className="ui-rich-streaming-bars" aria-hidden="true">
            <span className="ui-rich-streaming-bar ui-rich-streaming-bar--lg" />
            <span className="ui-rich-streaming-bar ui-rich-streaming-bar--md" />
          </div>
        </div>
      )}
    </div>
  );
});
