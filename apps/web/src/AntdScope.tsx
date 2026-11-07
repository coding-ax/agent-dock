import type { ReactNode } from 'react';
import { StyleProvider } from '@ant-design/cssinjs';
import { ConfigProvider, theme as antdTheme } from 'antd';
import { useResolvedTheme } from './theme';
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
  const dark = useResolvedTheme() === 'dark';
  const c = dark
    ? { ink: '#f0f1f4', hover: '#d4d6dc', border: '#343740', placeholder: '#777c87', fill: '#272a31', fillHover: '#343740', mid: '#969ba6', outline: 'rgba(150, 155, 166, .25)', link: '#7daaff', surface: '#181a1f' }
    : { ink: '#18181b', hover: '#3f3f46', border: '#e4e4e7', placeholder: '#a1a1aa', fill: '#f4f4f5', fillHover: '#e4e4e7', mid: '#71717a', outline: 'rgba(161, 161, 170, .2)', link: '#2563eb', surface: '#ffffff' };
  return <StyleProvider hashPriority="high">
    <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }} theme={{
      algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: { colorPrimary: c.ink, colorTextLightSolid: dark ? '#0e0f12' : '#ffffff', colorLink: c.link, colorBorder: c.border, colorBgContainer: c.surface, colorBgElevated: c.surface, colorTextPlaceholder: c.placeholder, borderRadius: 8, fontSize: 12, controlHeight: 32, controlHeightLG: 36, fontSizeLG: 13, borderRadiusLG: 8, fontFamily: 'inherit', zIndexPopupBase: 1100, colorPrimaryHover: c.hover, controlOutline: c.outline, controlItemBgActive: c.fill, controlItemBgActiveHover: c.fillHover },
      components: { Segmented: { itemSelectedColor: c.ink, trackBg: c.fill }, DatePicker: { cellActiveWithRangeBg: c.fill, activeBorderColor: c.mid, hoverBorderColor: c.placeholder }, Input: { activeBorderColor: c.mid, hoverBorderColor: c.placeholder }, Select: { optionSelectedBg: c.fill, optionSelectedFontWeight: 500, activeBorderColor: c.mid, hoverBorderColor: c.placeholder } }
    }}>{children}</ConfigProvider>
  </StyleProvider>;
}

/** antd 浮层（下拉、日期面板）是否正开着：此时 Esc 只该关浮层，不该关外层弹窗。 */
export function antdPopupOpen() {
  return Boolean(document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden), .ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-dropdown:not(.ant-dropdown-hidden)'));
}
