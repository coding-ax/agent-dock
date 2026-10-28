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
export function CompactSelect({ options, value, placeholder, disabledText, disabled = false, size = 'default', onChange }: { options: CompactOption[]; value: string; placeholder: string; disabledText: string; disabled?: boolean; size?: 'default' | 'sm'; onChange(value: string): void }) {
  const rows = options.map((option, index) => ({ option, key: `${index}:${option.value}` }));
  const selectedKey = rows.find(row => row.option.value === value)?.key;
  return <div className={size === 'sm' ? undefined : 'mt-1.5'}>
    <Select
      className="w-full"
      size={size === 'sm' ? 'middle' : 'large'}
      value={selectedKey}
      disabled={disabled || !options.length}
      placeholder={options.length ? placeholder : disabledText}
      showSearch={options.length > 8}
      optionFilterProp="title"
      listHeight={240}
      onChange={(key: string) => { const row = rows.find(item => item.key === key); if (row) onChange(row.option.value); }}
      options={rows.map(({ option, key }) => ({
        value: key,
        title: `${option.label} ${option.meta ?? ''}`,
        label: <span className="flex min-w-0 items-center gap-2">
          {option.agentId && <AgentIcon agentId={option.agentId} agentName={option.label} size={15}/>}
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {option.meta && <span className="max-w-[50%] shrink-0 truncate font-mono text-[10px] text-zinc-400">{option.meta}</span>}
        </span>
      }))}
    />
  </div>;
}
