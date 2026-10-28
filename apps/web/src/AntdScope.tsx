import type { ReactNode } from 'react';
import { StyleProvider } from '@ant-design/cssinjs';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';

dayjs.locale('zh-cn');

/**
 * 全局 antd 主题：基础交互组件（下拉、输入、开关、日期、分段……）用 antd，外观对齐应用自己的设计语言。
 * 布局、弹窗外壳、卡片仍用 Tailwind。挂在应用根部（main.tsx）。
 *
 * hashPriority="high" 去掉 antd 样式外层的 :where()，把优先级抬到两个类；否则 Tailwind preflight 的
 * `button, [type='button'] { background-color: transparent }` 会把 Switch 等按钮类组件的底色刷掉。
 * 主题色和字号对齐现有的 zinc 色板与 12px 表单字号。
 */
export function AntdScope({ children }: { children: ReactNode }) {
  return <StyleProvider hashPriority="high">
    <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }} theme={{
      token: { colorPrimary: '#18181b', colorLink: '#2563eb', colorBorder: '#e4e4e7', colorTextPlaceholder: '#a1a1aa', borderRadius: 6, fontSize: 12, controlHeight: 32, controlHeightLG: 36, fontSizeLG: 13, borderRadiusLG: 6, fontFamily: 'inherit', zIndexPopupBase: 1100, colorPrimaryHover: '#3f3f46', controlOutline: 'rgba(161, 161, 170, .2)', controlItemBgActive: '#f4f4f5', controlItemBgActiveHover: '#e4e4e7' },
      components: { Segmented: { itemSelectedColor: '#18181b', trackBg: '#f4f4f5' }, DatePicker: { cellActiveWithRangeBg: '#f4f4f5', activeBorderColor: '#71717a', hoverBorderColor: '#a1a1aa' }, Input: { activeBorderColor: '#71717a', hoverBorderColor: '#a1a1aa' }, Select: { optionSelectedBg: '#f4f4f5', optionSelectedFontWeight: 500, activeBorderColor: '#71717a', hoverBorderColor: '#a1a1aa' } }
    }}>{children}</ConfigProvider>
  </StyleProvider>;
}

/** antd 浮层（下拉、日期面板）是否正开着：此时 Esc 只该关浮层，不该关外层弹窗。 */
export function antdPopupOpen() {
  return Boolean(document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden), .ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-dropdown:not(.ant-dropdown-hidden)'));
}
