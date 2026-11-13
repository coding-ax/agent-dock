import { useEffect, useState } from 'react';
import { Select } from 'antd';
import { AgentIcon } from './AgentIcon';

export type CompactOption = { value: string; label: string; meta?: string; agentId?: string };

/**
 * 带 meta 的单选下拉。底层是 antd Select（键盘导航、贴边翻转、滚动容器内定位都由它管），
 * 这里只统一选项渲染：Agent 图标 + 标题 + 右侧等宽 meta。
 *
 * Agent 可能上报多个 value 相同、label 不同的选项（同一 model id 的不同别名）。antd 用 value 做身份，
 * 重复时 React key 冲突且回填成第一条，所以按位置生成内部 key，只把原 value 回传给调用方。
 */
export function CompactSelect({ options, value, placeholder, disabledText, disabled = false, size = 'default', popupWidth, onChange }: { options: CompactOption[]; value: string; placeholder: string; disabledText: string; disabled?: boolean; size?: 'default' | 'sm'; /** 下拉层宽度：false 跟随内容，数字固定像素；不传则和触发器同宽。 */ popupWidth?: number | false; onChange(value: string): void }) {
  const rows = options.map((option, index) => ({ option, key: `${index}:${option.value}` }));
  const selectedKey = rows.find(row => row.option.value === value)?.key;
  // 固定宽度是桌面值（360/380 等），窄屏会超出视口。这里按视口封顶后再交给 antd，
  // 让它按真实宽度做翻转/贴边；只靠 CSS max-width 会让弹层位置仍按旧宽度算，向左溢出。
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1024 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // 窄屏下固定宽弹层会被 antd 右对齐到触发器右缘，向左溢出（例如 360 宽的弹层放在 320 屏上）。
  // 手机上直接跟随触发器宽度，位置和宽度都必然在视口内；桌面仍用配置的宽弹层展示完整名称。
  const resolvedPopupWidth = typeof popupWidth === 'number'
    ? (viewportWidth < 640 ? true : Math.min(popupWidth, viewportWidth - 16))
    : popupWidth;
  return <div className={size === 'sm' ? 'min-w-0 max-w-full' : 'mt-1.5 min-w-0 max-w-full'}>
    <Select
      className="w-full min-w-0 max-w-full"
      size={size === 'sm' ? 'middle' : 'large'}
      value={selectedKey}
      disabled={disabled || !options.length}
      placeholder={options.length ? placeholder : disabledText}
      showSearch={options.length > 8}
      optionFilterProp="title"
      popupMatchSelectWidth={resolvedPopupWidth ?? true}
      listHeight={240}
      onChange={(key: string) => { const row = rows.find(item => item.key === key); if (row) onChange(row.option.value); }}
      options={rows.map(({ option, key }) => ({
        value: key,
        title: `${option.label} ${option.meta ?? ''}`,
        label: <span className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden">
          {option.agentId && <AgentIcon agentId={option.agentId} agentName={option.label} size={15}/>}
          {/* 标题给原生 tooltip 兜底：下拉层再宽也可能被超长模型名撑满，hover 时要能看到全名。 */}
          <span className="min-w-0 flex-1 truncate" title={option.label}>{option.label}</span>
          {/* 窄屏弹层只能跟随触发器宽度，meta 会挤掉主标题；手机上先只显示主标题。 */}
          {option.meta && <span className="hidden max-w-[50%] min-w-0 shrink truncate font-mono text-[12px] text-zinc-400 sm:inline">{option.meta}</span>}
        </span>
      }))}
    />
  </div>;
}
