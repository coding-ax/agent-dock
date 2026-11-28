import { memo, useEffect, useMemo, useState } from 'react';

type KatexModule = typeof import('katex').default;

let cachedKatex: KatexModule | null = null;
let katexLoadPromise: Promise<KatexModule> | null = null;

function loadKatex(): Promise<KatexModule> {
  if (cachedKatex) return Promise.resolve(cachedKatex);
  if (!katexLoadPromise) {
    // 严格按需懒加载 KaTeX JS 与样式表（独立 chunk），纯文本对话零额外开销。
    katexLoadPromise = import('./katex-loader').then(mod => {
      cachedKatex = mod.default;
      return cachedKatex;
    });
  }
  return katexLoadPromise;
}

export function renderLatexSync(katex: KatexModule, expr: string, displayMode: boolean): string {
  return katex.renderToString(expr, {
    displayMode,
    throwOnError: false,
    strict: 'ignore',
    trust: false,
    output: 'htmlAndMathml'
  });
}

export const MathRenderer = memo(function MathRenderer({
  expr,
  displayMode = false,
  inlineContainer = false
}: {
  expr: string;
  displayMode?: boolean;
  /** 嵌在 <p> 内的 $$...$$ 块公式使用 span 容器（CSS block 展示），防止非法 <p><div> DOM 嵌套。 */
  inlineContainer?: boolean;
}) {
  const [katex, setKatex] = useState<KatexModule | null>(() => cachedKatex);

  useEffect(() => {
    if (katex) return;
    let active = true;
    void loadKatex()
      .then(mod => {
        if (active) setKatex(() => mod);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [katex]);

  const html = useMemo(() => {
    if (!katex) return null;
    try {
      return renderLatexSync(katex, expr, displayMode);
    } catch {
      return null;
    }
  }, [katex, expr, displayMode]);

  if (displayMode) {
    const className = inlineContainer ? 'ui-rich-math-block ui-rich-math-block--in-p' : 'ui-rich-math-block';
    const Wrapper = inlineContainer ? 'span' : 'div';
    if (html) {
      return (
        <Wrapper
          className={className}
          data-rich-math="block"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    return (
      <Wrapper className={className} data-rich-math="block">
        <code className="ui-rich-math-fallback">{expr}</code>
      </Wrapper>
    );
  }

  if (html) {
    return (
      <span
        className="ui-rich-math-inline"
        data-rich-math="inline"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <span className="ui-rich-math-inline" data-rich-math="inline">
      <code className="ui-rich-math-fallback">{expr}</code>
    </span>
  );
});
