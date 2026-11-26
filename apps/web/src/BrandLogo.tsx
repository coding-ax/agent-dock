/**
 * AgentDock 品牌图形：与官网（agent-dock-site）及 README 保持一致的像素风小猫图标 + 像素字标。
 * 字标按 html[data-theme="dark"] 自动切换亮/暗配色，两张图同步加载避免切换主题时闪烁。
 */
export function KittenMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <img
      src="/brand/kitten-mark.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`ui-pixelated shrink-0 object-contain select-none ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

export function BrandWordmark({ height = 14, className = '' }: { height?: number; className?: string }) {
  const width = Math.round((height * 234) / 32);
  return (
    <span
      className={`relative inline-block shrink-0 select-none ${className}`}
      style={{ height, width }}
      role="img"
      aria-label="AgentDock"
    >
      <img
        src="/brand/wordmark-light.svg"
        alt=""
        aria-hidden="true"
        draggable={false}
        className="ui-pixelated ui-wordmark-light absolute inset-0 h-full w-full object-contain"
        style={{ objectPosition: 'left center' }}
      />
      <img
        src="/brand/wordmark-dark.svg"
        alt=""
        aria-hidden="true"
        draggable={false}
        className="ui-pixelated ui-wordmark-dark absolute inset-0 h-full w-full object-contain"
        style={{ objectPosition: 'left center' }}
      />
    </span>
  );
}

export function BrandLogo({ iconSize = 28, wordmarkHeight = 14, className = '' }: { iconSize?: number; wordmarkHeight?: number; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-2.5 ${className}`}>
      <KittenMark size={iconSize}/>
      <BrandWordmark height={wordmarkHeight}/>
    </span>
  );
}
