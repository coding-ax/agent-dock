import type { ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

/**
 * 全局 hover 提示。
 *
 * 为什么用 Radix 而不是自己写定位：贴边翻转、碰撞检测、指针进出延迟、键盘聚焦可见、
 * `aria-describedby` 关联，这几件事自己写都容易错（本仓此前那版就在锚点布局与
 * transform-origin 上出过错，提示层停在了离图标很远的地方）。Radix 只管这些无样式行为，
 * 外观仍由下面的 Tailwind 类决定，所以界面不会多出一套设计语言。
 *
 * 不用原生 title：约 1 秒延迟、样式跟随系统、无法限宽，图标按钮上等于没有提示。
 */

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left';
export type TooltipAlign = 'start' | 'center' | 'end';

/** 传单个元素（按钮 / 已有布局类的外层）时用它：该元素自己当锚点，不额外包 DOM。 */
export function HoverTooltip({ content, children, side, align }: { content: ReactNode; children: ReactNode; side?: TooltipSide; align?: TooltipAlign }) {
  if (!content) return <>{children}</>;
  return <TooltipPrimitive.Root>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal><Content content={content} side={side} align={align}/></TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>;
}

/**
 * 传裸文本时用它：自己渲染一个带布局类的 span 当锚点。
 *
 * 两个组件分开是因为锚点必须是**有盒子的真实元素**：
 * - 不能省成 `display: contents`（那样元素没有盒子，getBoundingClientRect 全是 0，
 *   Radix 会把提示定位到视口原点，实测偏出上千像素）；
 * - 也不能让 Trigger 用 asChild 去接裸文本或多个子节点（asChild 要求单个能收 ref 的元素，
 *   接不了就静默失效，提示永远不弹且不报错）。
 *
 * 另外 Trigger 默认渲染 `<button>` 且不能嵌在按钮里（会变成非法的 <button><button>，
 * 浏览器重新嵌套后锚点塌成 0×0）。所以这里显式渲染成 span，调用方自己就是 button 时用
 * 上面那个 HoverTooltip。
 */
export function HoverTooltipText({ content, children, className = '' }: { content: ReactNode; children: ReactNode; className?: string }) {
  if (!content) return <span className={className}>{children}</span>;
  return <TooltipPrimitive.Root>
    <TooltipPrimitive.Trigger asChild><span className={className}>{children}</span></TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal><Content content={content}/></TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>;
}

/**
 * `content` 收 ReactNode 而不只是字符串：会话行的信息卡（SessionHoverCard）是结构化排版，
 * 拼成一个字符串再在渲染层拆开是本末倒置。传字符串的调用点行为不变。
 *
 * `side`/`align` 透传给 Radix，不传就是它自己的默认值（`top` + `center`）——绝大多数
 * 提示挂在图标上，往上弹最短、也不挡下面正在看的东西，所以保持默认。
 * 会话行那种**锚点就是整行、卡片又高又宽**的场景必须显式改：见 App.tsx 里的 `side="right"`。
 */
function Content({ content, side, align }: { content: ReactNode; side?: TooltipSide; align?: TooltipAlign }) {
  return <TooltipPrimitive.Content
    side={side}
    align={align}
    sideOffset={8}
    collisionPadding={8}
    className="ui-tooltip pointer-events-none z-[60] max-h-[46vh] max-w-[460px] overflow-hidden whitespace-pre-wrap break-words rounded-lg bg-zinc-900/95 px-2.5 py-2 text-[11.5px] leading-5 text-zinc-50 shadow-[0_10px_30px_rgba(24,24,27,.28)] ring-1 ring-white/10 backdrop-blur-sm"
  >{content}</TooltipPrimitive.Content>;
}

/** 应用根部的 Provider。Radix 用它统一管理「同一时刻只显示一个提示」与交错延迟。 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={120} skipDelayDuration={300}>{children}</TooltipPrimitive.Provider>;
}
