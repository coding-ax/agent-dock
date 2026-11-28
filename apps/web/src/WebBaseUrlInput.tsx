import { SuggestedValueInput } from './SuggestedValueInput';
import { useBi } from './i18n';

export function WebBaseUrlInput({ value, onChange }: { value: string; onChange(value: string): void }) {
  const L = useBi();
  return <SuggestedValueInput value={value} onChange={onChange} label={L("Web 访问地址", "Web Base URL")} placeholder={L("留空不显示详情链接，可选择当前地址", "Leave blank to hide detail links, or pick current URL")} suggestion={typeof window === 'undefined' ? undefined : window.location.origin} suggestionLabel={L("使用当前访问地址", "Use Current URL")}/>;
}
