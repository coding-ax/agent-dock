import { SuggestedValueInput } from './SuggestedValueInput';

export function WebBaseUrlInput({ value, onChange }: { value: string; onChange(value: string): void }) {
  return <SuggestedValueInput value={value} onChange={onChange} label="Web 访问地址" placeholder="留空不显示详情链接，可选择当前地址" suggestion={typeof window === 'undefined' ? undefined : window.location.origin} suggestionLabel="使用当前访问地址"/>;
}
