import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from 'lucide-react';
import Lightbox from 'yet-another-react-lightbox';
import { Zoom } from 'yet-another-react-lightbox/plugins';
import 'yet-another-react-lightbox/styles.css';
import './ImageLightbox.css';

export interface ImageLightboxSlide {
  src: string;
  alt?: string;
}

export interface ImageLightboxProps {
  src?: string;
  alt?: string;
  slides?: ImageLightboxSlide[];
  index?: number;
  open: boolean;
  onClose(): void;
}

export function resolveLightboxSlides(
  slides: ImageLightboxSlide[] | undefined,
  src: string | undefined,
  alt: string | undefined
): ImageLightboxSlide[] {
  if (slides && slides.length > 0) return slides;
  return src ? [{ src, alt }] : [];
}

export function clampLightboxIndex(index: number, total: number): number {
  if (total <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), total - 1);
}

const LIGHTBOX_LABELS = {
  Previous: '上一张',
  Next: '下一张',
  Close: '关闭',
  'Zoom in': '放大',
  'Zoom out': '缩小'
} as const;

/**
 * 图片放大预览。单独成模块并由 MarkdownContent / FileExplorerPanel 用 React.lazy 动态加载：
 * lightbox 及其样式约 288KB（未压缩），但只在用户点开图片时才需要，
 * 不应计入首屏。把 import 'yet-another-react-lightbox/styles.css' 和 './ImageLightbox.css'
 * 都留在本模块，确保不计入主 chunk 且自定义样式稳定覆盖库默认样式。
 */
export default function ImageLightbox({ src, alt, slides, index = 0, open, onClose }: ImageLightboxProps) {
  const resolvedSlides = useMemo(() => resolveLightboxSlides(slides, src, alt), [slides, src, alt]);
  const initialIndex = clampLightboxIndex(index, resolvedSlides.length);
  const [activeIndex, setActiveIndex] = useState(initialIndex);

  useEffect(() => {
    if (open) setActiveIndex(initialIndex);
  }, [open, initialIndex]);

  const hasMultiple = resolvedSlides.length > 1;
  const safeActiveIndex = clampLightboxIndex(activeIndex, resolvedSlides.length);
  const caption = resolvedSlides[safeActiveIndex]?.alt?.trim() || '';
  const showMetaPill = hasMultiple || Boolean(caption);

  return (
    <Lightbox
      className="ad-lightbox"
      open={open}
      close={onClose}
      index={initialIndex}
      slides={resolvedSlides}
      plugins={[Zoom]}
      labels={LIGHTBOX_LABELS}
      carousel={{ finite: true, padding: '4%', spacing: '24px' }}
      controller={{ closeOnBackdropClick: true }}
      zoom={{ scrollToZoom: true, maxZoomPixelRatio: 5 }}
      on={{ view: ({ index: nextIndex }) => setActiveIndex(nextIndex) }}
      render={{
        buttonPrev: hasMultiple ? undefined : () => null,
        buttonNext: hasMultiple ? undefined : () => null,
        iconPrev: () => <ChevronLeft size={20} strokeWidth={1.85} aria-hidden="true" className="ad-lightbox-icon ad-lightbox-icon--prev" />,
        iconNext: () => <ChevronRight size={20} strokeWidth={1.85} aria-hidden="true" className="ad-lightbox-icon ad-lightbox-icon--next" />,
        iconZoomIn: () => <ZoomIn size={17} strokeWidth={1.85} aria-hidden="true" className="ad-lightbox-icon" />,
        iconZoomOut: () => <ZoomOut size={17} strokeWidth={1.85} aria-hidden="true" className="ad-lightbox-icon" />,
        iconClose: () => <X size={18} strokeWidth={1.9} aria-hidden="true" className="ad-lightbox-icon" />,
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
