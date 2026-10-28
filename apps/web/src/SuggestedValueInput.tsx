import { AutoComplete, Input } from 'antd';

/**
 * 可自由输入、带一个建议值的输入框（工作区路径等）。底层是 antd AutoComplete：聚焦即弹出建议，
 * 移动端点选不会被 blur 抢先关掉。输入框下方用小字完整展示当前值，等宽字体被截断时也看得清。
 */
export function SuggestedValueInput({ value, onChange, label, placeholder, suggestion, suggestionLabel }: {
  value: string;
  onChange(value: string): void;
  label: string;
  placeholder: string;
  suggestion?: string;
  suggestionLabel: string;
}) {
  return <div className="mt-1.5">
    <AutoComplete
      className="w-full"
      value={value}
      onChange={onChange}
      options={suggestion ? [{ value: suggestion, label: <span className="block py-0.5"><span className="block text-[11px] font-medium text-zinc-700">{suggestionLabel}</span><span className="mt-0.5 block break-all font-mono text-[11px] text-zinc-500">{suggestion}</span></span> }] : []}
      filterOption={false}
    >
      <Input size="large" aria-label={label} placeholder={placeholder} allowClear className="font-mono text-[12px]"/>
    </AutoComplete>
    {value.trim() && <p className="mt-1 break-all font-mono text-[10px] leading-4 text-zinc-400" title={value}>{value}</p>}
  </div>;
}
