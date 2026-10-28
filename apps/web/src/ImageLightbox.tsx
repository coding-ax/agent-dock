import Lightbox from 'yet-another-react-lightbox';
import { Zoom } from 'yet-another-react-lightbox/plugins';
import 'yet-another-react-lightbox/styles.css';

export interface ImageLightboxProps { src: string; alt?: string; open: boolean; onClose(): void }

/**
 * 图片放大预览。单独成模块并由 MarkdownContent 用 React.lazy 动态加载：
 * lightbox 及其样式约 288KB（未压缩），但只在用户点开图片时才需要，
 * 不应计入首屏。把 import 'yet-another-react-lightbox/styles.css' 也留在本模块，
 * 否则 CSS 仍会被打进主 chunk。
 */
export default function ImageLightbox({ src, alt, open, onClose }: ImageLightboxProps) {
  return (
    <Lightbox
      open={open}
      close={onClose}
      slides={[{ src, alt }]}
      plugins={[Zoom]}
      zoom={{ scrollToZoom: true, maxZoomPixelRatio: 5 }}
      styles={{
        container: { backgroundColor: 'rgba(0, 0, 0, 0.85)', backdropFilter: 'blur(8px)' },
        toolbar: { background: 'transparent', padding: '16px' },
        button: {
          backgroundColor: 'rgba(255, 255, 255, 0.1)',
          borderRadius: '9999px',
          color: '#fff',
          width: 40,
          height: 40
        },
        icon: { width: 20, height: 20 }
      }}
      animation={{ fade: 200 }}
    />
  );
}
