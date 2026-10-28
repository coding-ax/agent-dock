import { useEffect } from 'react';

const BASE_TITLE = 'AgentDock';

/**
 * 把浏览器标签页标题跟着当前会话走：`<会话名> - AgentDock`，没有选中会话时回到 `AgentDock`。
 *
 * 会话名在前、应用名在后当后缀：标签页一窄就从**右边**截断，应用名放前面等于每开几个会话
 * 后满屏都是长得一样的「AgentDock…」，分辨不出哪个是哪个——放后缀后截掉的正好是所有人都
 * 相同的部分。
 *
 * 单独封成具名 hook 而不是在 App 里写裸 `useEffect`：这是「与 React 之外的系统（document）同步」，
 * 正好是 effect 该干的事，但它只有一个职责，散在 App 的组件体里会被淹没在几十个 effect 中间。
 *
 * 这里刻意用 `useEffect` 而不是 `useUpdateEffect`：后者跳过首帧，而首帧恰恰是最需要它的场合
 * ——URL 里带着 `?session=` 直接打开时，首帧就已经有会话了，跳过首帧会让标签页一直停在
 * `AgentDock`。多赋一次同值代价可以忽略，标题不对却很难发现。
 */
export function useDocumentTitle(sessionLabel?: string) {
  useEffect(() => {
    document.title = sessionLabel ? `${sessionLabel} - ${BASE_TITLE}` : BASE_TITLE;
  }, [sessionLabel]);
}
