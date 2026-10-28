import { memo } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { useAdaptiveTypewriter } from './typewriter-reveal';

/**
 * 流式输出的 Markdown 容器。
 *
 * 只有「正在流式输出的那一条消息」和它收尾 drain 的那一小段走动画；历史消息在
 * useAdaptiveTypewriter 里直接返回全文，不重播。光标 `ui-typewriter-caret` 挂在承载
 * markdown 块级元素的这一层，CSS 用 :last-child::after 定位到当前末尾。
 */
/**
 * 词级模糊入场的启用上限（字符数）。
 *
 * 每个字/词会变成一个 <span>，所以 DOM 节点数随文本线性增长。实测 1200 字 ≈ 1200 节点时
 * 每帧重组仍然流畅；超过这个量级后模糊入场带来的观感收益已经盖不过主线程开销，直接退回
 * 纯逐字。光标不受影响。
 */
const UNIT_ANIMATION_MAX_CHARS = 4000;

function useAnimatedText(text: string, active: boolean, replay: boolean) {
  const revealed = useAdaptiveTypewriter(text, active, undefined, replay);
  // 流结束后尾巴还要 drain 一小段，动画继续播完；光标却只跟 active。drain 期间下一段往往
  // 已经开始输出，两边都挂光标就会同时闪好几个。
  const animating = active || revealed.length < text.length;
  return { revealed, caret: active, animateUnits: animating && revealed.length <= UNIT_ANIMATION_MAX_CHARS };
}

/** 助手正文。只有正在流式输出时挂光标，历史/最终态与收尾 drain 都不挂。 */
export const AssistantMarkdown = memo(function AssistantMarkdown({ text, active, replay = false, final = false, assistantLabel = 'Agent', sessionId }: {
  text: string;
  active: boolean;
  /** 首屏 payload 渲染出来的行：已经显示过的文本不重播。 */
  replay?: boolean;
  final?: boolean;
  assistantLabel?: string;
  sessionId: string | undefined;
}) {
  const { revealed, caret, animateUnits } = useAnimatedText(text, active, replay);
  return <article
    aria-label={final ? `${assistantLabel} 最终输出` : undefined}
    className={`assistant-output markdown ui-timeline-item ${final ? 'my-4' : 'my-5'} max-w-[78ch] text-[14px] leading-6 text-zinc-800 ${caret ? 'ui-typewriter-caret' : ''}`}
  >
    <MarkdownContent sessionId={sessionId} animateUnits={animateUnits}>{revealed}</MarkdownContent>
  </article>;
}, (prev, next) => prev.text === next.text && prev.active === next.active && prev.replay === next.replay && prev.final === next.final && prev.assistantLabel === next.assistantLabel && prev.sessionId === next.sessionId);

/** 思考过程。折叠体里同样走逐字，只在 live 时挂光标。 */
export const ThinkingMarkdown = memo(function ThinkingMarkdown({ text, active, replay = false, sessionId }: { text: string; active: boolean; replay?: boolean; sessionId: string | undefined }) {
  const { revealed, caret, animateUnits } = useAnimatedText(text, active, replay);
  return <div className={`markdown pl-5 pt-1 text-[12px] leading-5 text-zinc-500 ${caret ? 'ui-typewriter-caret' : ''}`}>
    <MarkdownContent sessionId={sessionId} animateUnits={animateUnits}>{revealed}</MarkdownContent>
  </div>;
}, (prev, next) => prev.text === next.text && prev.active === next.active && prev.replay === next.replay && prev.sessionId === next.sessionId);
