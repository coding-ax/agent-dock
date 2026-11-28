import { parseSvgDimensions } from './svg-sanitize';

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    if (typeof document === 'undefined') return false;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function ensureSvgXmlns(svgMarkup: string): string {
  if (/\bxmlns\s*=/i.test(svgMarkup)) return svgMarkup;
  return svgMarkup.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

function triggerDownloadUrl(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** 触发下载 SVG 文件并安全释放 ObjectURL。 */
export function downloadSvgMarkup(svgMarkup: string, filename = 'diagram.svg'): void {
  if (typeof window === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return;
  const normalized = ensureSvgXmlns(svgMarkup);
  const blob = new Blob([normalized], { type: 'image/svg+xml;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  try {
    triggerDownloadUrl(objectUrl, filename.endsWith('.svg') ? filename : `${filename}.svg`);
  } finally {
    // 延迟释放确保浏览器接管下载流，不泄漏内存
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
}

/** 将 SVG 矢量图光栅化为 2x 高清 PNG 并下载（含主题背景填充与安全释放所有 ObjectURL）。 */
export async function downloadSvgAsPng(
  svgMarkup: string,
  filename = 'diagram.png',
  backgroundColor = '#ffffff',
  scale = 2
): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const normalized = ensureSvgXmlns(svgMarkup);
  const { width, height } = parseSvgDimensions(normalized);
  const safeW = Math.max(64, Math.min(4096, Math.round(width)));
  const safeH = Math.max(64, Math.min(4096, Math.round(height)));

  // 为离屏光栅化显式赋予像素宽高，确保 Safari/Chrome 均按目标分辨率绘制
  const sizedSvg = normalized.replace(/<svg\b[^>]*>/i, openTag => {
    let next = openTag
      .replace(/\s+width\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
      .replace(/\s+height\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
    if (!/\bviewBox\s*=/i.test(next)) {
      next = next.replace(/>$/, ` viewBox="0 0 ${safeW} ${safeH}">`);
    }
    return next.replace(/>$/, ` width="${safeW}" height="${safeH}">`);
  });

  const svgBlob = new Blob([sizedSvg], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to rasterize SVG'));
      el.src = svgUrl;
    });

    const pad = 24;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round((safeW + pad * 2) * scale);
    canvas.height = Math.round((safeH + pad * 2) * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    ctx.scale(scale, scale);
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, safeW + pad * 2, safeH + pad * 2);
    ctx.drawImage(img, pad, pad, safeW, safeH);

    const pngBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!pngBlob) throw new Error('Failed to encode PNG blob');

    const pngUrl = URL.createObjectURL(pngBlob);
    try {
      triggerDownloadUrl(pngUrl, filename.endsWith('.png') ? filename : `${filename}.png`);
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(pngUrl), 1_000);
    }
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

/** 下载普通图片资源（优先转 Blob 下载以支持自定义文件名，跨域时优雅回退为直接下载，并安全释放 ObjectURL）。 */
export async function downloadImageSource(src: string, filename = 'image.png'): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !src) return;

  if (src.startsWith('data:') || src.startsWith('blob:')) {
    triggerDownloadUrl(src, filename);
    return;
  }

  try {
    const resp = await fetch(src);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      triggerDownloadUrl(objectUrl, filename);
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    }
  } catch {
    triggerDownloadUrl(src, filename);
  }
}
