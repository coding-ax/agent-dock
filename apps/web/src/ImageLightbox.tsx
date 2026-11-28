import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, ImageDown, Scan, X, ZoomIn, ZoomOut } from 'lucide-react';
import Lightbox, { type GenericSlide, type Slide, type ZoomRef } from 'yet-another-react-lightbox';
import { Zoom } from 'yet-another-react-lightbox/plugins';
import 'yet-another-react-lightbox/styles.css';
import './ImageLightbox.css';
import { bi, useT } from './i18n';
import { HoverTooltip } from './HoverTooltip';
import { useActiveTheme } from './themes';
import { downloadImageSource, downloadSvgAsPng, downloadSvgMarkup } from './rich-markdown/export-utils';
import { parseSvgDimensions } from './rich-markdown/svg-sanitize';

declare module 'yet-another-react-lightbox' {
  export interface SvgDiagramSlide extends GenericSlide {
    type: 'svg-diagram';
    svgMarkup: string;
    alt?: string;
    downloadName?: string;
    diagramKind?: 'mermaid' | 'svg';
    width?: number;
    height?: number;
  }
  interface SlideTypes {
    'svg-diagram': SvgDiagramSlide;
  }
}

export interface ImageLightboxSlide {
  src?: string;
  alt?: string;
  svgMarkup?: string;
  downloadName?: string;
  kind?: 'image' | 'mermaid' | 'svg';
}

export interface ImageLightboxProps {
  src?: string;
  alt?: string;
  svgMarkup?: string;
  downloadName?: string;
  kind?: 'image' | 'mermaid' | 'svg';
  slides?: ImageLightboxSlide[];
  index?: number;
  open: boolean;
  onClose(): void;
}

export function resolveLightboxSlides(
  slides: ImageLightboxSlide[] | undefined,
  src: string | undefined,
  alt: string | undefined,
  svgMarkup?: string,
  downloadName?: string,
  kind?: 'image' | 'mermaid' | 'svg'
): ImageLightboxSlide[] {
  if (slides && slides.length > 0) return slides;
  if (svgMarkup) return [{ svgMarkup, alt, downloadName, kind }];
  return src ? [{ src, alt, downloadName, kind }] : [];
}

export function clampLightboxIndex(index: number, total: number): number {
  if (total <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), total - 1);
}

const LIGHTBOX_LABELS = {
  get Previous() { return bi("上一张", "Previous"); },
  get Next() { return bi("下一张", "Next"); },
  get Close() { return bi("关闭", "Close"); },
  get 'Zoom in'() { return bi("放大", "Zoom In"); },
  get 'Zoom out'() { return bi("缩小", "Zoom Out"); }
} as const;

function toYarlSlide(item: ImageLightboxSlide): Slide {
  if (item.svgMarkup) {
    const dims = parseSvgDimensions(item.svgMarkup);
    return {
      type: 'svg-diagram',
      svgMarkup: item.svgMarkup,
      alt: item.alt,
      downloadName: item.downloadName,
      diagramKind: item.kind === 'mermaid' ? 'mermaid' : 'svg',
      width: dims.width,
      height: dims.height
    };
  }
  return {
    src: item.src ?? '',
    alt: item.alt
  };
}

function deriveBaseName(slide: ImageLightboxSlide | undefined): string {
  const raw = slide?.downloadName?.trim() || slide?.alt?.trim() || 'agentdock-media';
  const cleaned = raw
    .replace(/\.(png|svg|jpe?g|webp|gif)$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .trim();
  return cleaned || 'agentdock-media';
}

/**
 * 统一全屏 Lightbox（图片、Mermaid 图表、SVG 矢量图共用）。
 * 单独成模块并由 MarkdownContent / FileExplorerPanel 用 React.lazy 动态加载：
 * lightbox 及其样式约 288KB（未压缩），只在用户点开媒体时才加载，绝不计入首屏。
 */
export default function ImageLightbox({
  src,
  alt,
  svgMarkup,
  downloadName,
  kind,
  slides,
  index = 0,
  open,
  onClose
}: ImageLightboxProps) {
  const t = useT();
  const activeTheme = useActiveTheme();
  const zoomRef = useRef<ZoomRef>(null);

  const resolvedSlides = useMemo(
    () => resolveLightboxSlides(slides, src, alt, svgMarkup, downloadName, kind),
    [slides, src, alt, svgMarkup, downloadName, kind]
  );
  const yarlSlides = useMemo(() => resolvedSlides.map(toYarlSlide), [resolvedSlides]);
  const initialIndex = clampLightboxIndex(index, resolvedSlides.length);
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [zoomLevel, setZoomLevel] = useState(1);

  useEffect(() => {
    if (open) {
      setActiveIndex(initialIndex);
      setZoomLevel(1);
    }
  }, [open, initialIndex]);

  const hasMultiple = resolvedSlides.length > 1;
  const safeActiveIndex = clampLightboxIndex(activeIndex, resolvedSlides.length);
  const currentSlide = resolvedSlides[safeActiveIndex];
  const caption = currentSlide?.alt?.trim() || '';
  const showMetaPill = hasMultiple || Boolean(caption);
  const isSvgSlide = Boolean(currentSlide?.svgMarkup);
  const isSvgImageUrl = Boolean(!isSvgSlide && currentSlide?.src && /\.svg(?:$|\?)/i.test(currentSlide.src));

  const handleDownloadPng = () => {
    if (!currentSlide) return;
    const baseName = deriveBaseName(currentSlide);
    if (currentSlide.svgMarkup) {
      void downloadSvgAsPng(currentSlide.svgMarkup, `${baseName}.png`, activeTheme.tokens.bgSurface, 2);
    } else if (currentSlide.src) {
      void downloadImageSource(currentSlide.src, `${baseName}.png`);
    }
  };

  const handleDownloadSvg = () => {
    if (!currentSlide) return;
    const baseName = deriveBaseName(currentSlide);
    if (currentSlide.svgMarkup) {
      downloadSvgMarkup(currentSlide.svgMarkup, `${baseName}.svg`);
    } else if (currentSlide.src) {
      void downloadImageSource(currentSlide.src, `${baseName}.svg`);
    }
  };

  const zoomPercent = Math.round(zoomLevel * 100);

  return (
    <Lightbox
      className="ad-lightbox"
      open={open}
      close={onClose}
      index={initialIndex}
      slides={yarlSlides}
      plugins={[Zoom]}
      labels={LIGHTBOX_LABELS}
      carousel={{ finite: true, padding: '5%', spacing: '24px' }}
      controller={{ closeOnBackdropClick: true }}
      zoom={{
        ref: zoomRef,
        minZoom: 0.5,
        scrollToZoom: true,
        maxZoomPixelRatio: 5,
        maxZoom: 6,
        supports: ['svg-diagram']
      }}
      on={{
        view: ({ index: nextIndex }) => {
          setActiveIndex(nextIndex);
          setZoomLevel(1);
        },
        zoom: ({ zoom }) => setZoomLevel(zoom)
      }}
      toolbar={{
        buttons: [
          'zoom',
          <HoverTooltip
            key="download-png"
            content={isSvgSlide ? t('markdown.lightbox.downloadPng') : t('markdown.lightbox.downloadImage')}
          >
            <button
              type="button"
              onClick={handleDownloadPng}
              className="yarl__button ad-lightbox-pill-btn"
              aria-label={isSvgSlide ? t('markdown.lightbox.downloadPng') : t('markdown.lightbox.downloadImage')}
              data-testid="lightbox-download-png"
            >
              <ImageDown size={15} strokeWidth={1.85} aria-hidden="true" className="ad-lightbox-icon" />
              <span className="ad-lightbox-pill-label">PNG</span>
            </button>
          </HoverTooltip>,
          ...(isSvgSlide || isSvgImageUrl
            ? [
                <HoverTooltip key="download-svg" content={t('markdown.lightbox.downloadSvg')}>
                  <button
                    type="button"
                    onClick={handleDownloadSvg}
                    className="yarl__button ad-lightbox-pill-btn"
                    aria-label={t('markdown.lightbox.downloadSvg')}
                    data-testid="lightbox-download-svg"
                  >
                    <Download size={15} strokeWidth={1.85} aria-hidden="true" className="ad-lightbox-icon" />
                    <span className="ad-lightbox-pill-label">SVG</span>
                  </button>
                </HoverTooltip>
              ]
            : []),
          'close'
        ]
      }}
      render={{
        buttonPrev: hasMultiple ? undefined : () => null,
        buttonNext: hasMultiple ? undefined : () => null,
        iconPrev: () => <ChevronLeft size={20} strokeWidth={1.85} aria-hidden="true" className="ad-lightbox-icon ad-lightbox-icon--prev" />,
        iconNext: () => <ChevronRight size={20} strokeWidth={1.85} aria-hidden="true" className="ad-lightbox-icon ad-lightbox-icon--next" />,
        iconZoomIn: () => <ZoomIn size={17} strokeWidth={1.85} aria-hidden="true" className="ad-lightbox-icon" />,
        iconZoomOut: () => <ZoomOut size={17} strokeWidth={1.85} aria-hidden="true" className="ad-lightbox-icon" />,
        iconClose: () => <X size={18} strokeWidth={1.9} aria-hidden="true" className="ad-lightbox-icon" />,
        buttonZoom: (ref) => (
          <div className="ad-lightbox-zoom-group" data-testid="lightbox-zoom-controls">
            <HoverTooltip content={t('markdown.lightbox.zoomOut')}>
              <button
                type="button"
                disabled={ref.disabled || ref.zoom <= ref.minZoom + 0.01}
                onClick={() => ref.zoomOut()}
                className="yarl__button"
                aria-label={t('markdown.lightbox.zoomOut')}
                data-testid="lightbox-zoom-out"
              >
                <ZoomOut size={16} strokeWidth={1.85} aria-hidden="true" className="ad-lightbox-icon" />
              </button>
            </HoverTooltip>
            <HoverTooltip content={t('markdown.lightbox.zoomReset')}>
              <button
                type="button"
                disabled={ref.disabled}
                onClick={() => ref.changeZoom(1)}
                className="yarl__button ad-lightbox-zoom-pct"
                aria-label={t('markdown.lightbox.zoomReset')}
                data-testid="lightbox-zoom-reset"
              >
                {zoomPercent}%
              </button>
            </HoverTooltip>
            <HoverTooltip content={t('markdown.lightbox.zoomIn')}>
              <button
                type="button"
                disabled={ref.disabled || ref.zoom >= ref.maxZoom - 0.01}
                onClick={() => ref.zoomIn()}
                className="yarl__button"
                aria-label={t('markdown.lightbox.zoomIn')}
                data-testid="lightbox-zoom-in"
              >
                <ZoomIn size={16} strokeWidth={1.85} aria-hidden="true" className="ad-lightbox-icon" />
              </button>
            </HoverTooltip>
            <HoverTooltip content={t('markdown.lightbox.fit')}>
              <button
                type="button"
                disabled={ref.disabled}
                onClick={() => ref.changeZoom(1)}
                className="yarl__button"
                aria-label={t('markdown.lightbox.fit')}
                data-testid="lightbox-zoom-fit"
              >
                <Scan size={15} strokeWidth={1.85} aria-hidden="true" className="ad-lightbox-icon" />
              </button>
            </HoverTooltip>
          </div>
        ),
        slide: ({ slide, rect }) => {
          if (slide.type !== 'svg-diagram') return undefined;
          const natW = slide.width && slide.width > 0 ? slide.width : 800;
          const natH = slide.height && slide.height > 0 ? slide.height : 480;
          const availW = Math.max(240, rect.width - 80);
          const availH = Math.max(180, rect.height - 128);
          const fitScale = Math.min((availW - 56) / natW, (availH - 48) / natH, 1.55);
          const stageW = Math.max(240, Math.round(natW * fitScale));
          const stageH = Math.max(140, Math.round(natH * fitScale));
          return (
            <div
              className="ad-lightbox-diagram-stage"
              data-testid="lightbox-diagram-stage"
              onClick={event => event.stopPropagation()}
              style={{
                width: `${Math.min(availW, stageW + 56)}px`,
                height: `${Math.min(availH, stageH + 48)}px`
              }}
            >
              <div
                className="ad-lightbox-diagram-svg"
                dangerouslySetInnerHTML={{ __html: slide.svgMarkup }}
              />
            </div>
          );
        },
        controls: showMetaPill
          ? () => (
              <div className="ad-lightbox-meta" data-testid="lightbox-meta">
                {hasMultiple && (
                  <span className="ad-lightbox-counter">
                    {safeActiveIndex + 1} / {resolvedSlides.length}
                  </span>
                )}
                {hasMultiple && caption && <span className="ad-lightbox-meta-sep" aria-hidden="true" />}
                {caption && <span className="ad-lightbox-caption">{caption}</span>}
              </div>
            )
          : undefined
      }}
      animation={{ fade: 200 }}
    />
  );
}
