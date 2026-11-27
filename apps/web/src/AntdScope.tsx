import type { ReactNode } from 'react';
import { StyleProvider } from '@ant-design/cssinjs';
import { ConfigProvider, theme as antdTheme } from 'antd';
import { isAchromatic, mixHex, hexToRgb } from '@agent-dock/agent-dock-shared';
import { useActiveTheme } from './themes';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';

dayjs.locale('zh-cn');

/**
 * 全局 antd 主题：基础交互组件（下拉、输入、开关、日期、分段、按钮……）实时同步
 * 当前激活的语义化 CustomTheme，与全站 Tailwind / CSS 变量视觉浑然一体。
 *
 * hashPriority="high" 去掉 antd 样式外层的 :where()，把优先级抬到两个类；否则 Tailwind preflight 的
 * `button, [type='button'] { background-color: transparent }` 会把 Switch 等按钮类组件的底色刷掉。
 */
export function AntdScope({ children }: { children: ReactNode }) {
  const active = useActiveTheme();
  const dark = active.mode === 'dark';
  const t = active.tokens;
  const linkColor = isAchromatic(t.accent) ? t.info : t.accent;
  const primaryHover = dark ? mixHex(t.accent, '#ffffff', 0.14) : mixHex(t.accent, '#000000', 0.14);
  const [ar, ag, ab] = hexToRgb(t.accent);
  const controlOutline = `rgba(${ar}, ${ag}, ${ab}, ${dark ? 0.28 : 0.2})`;

  return <StyleProvider hashPriority="high">
    <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }} theme={{
      algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: t.accent,
        colorPrimaryHover: primaryHover,
        colorTextLightSolid: t.accentForeground,
        colorLink: linkColor,
        colorLinkHover: primaryHover,
        colorBorder: t.borderSubtle,
        colorBorderSecondary: t.borderSubtle,
        colorBgContainer: t.bgSurface,
        colorBgElevated: t.bgElevated,
        colorBgLayout: t.bgCanvas,
        colorText: t.textPrimary,
        colorTextSecondary: t.textSecondary,
        colorTextTertiary: t.textMuted,
        colorTextPlaceholder: t.textMuted,
        colorSuccess: t.success,
        colorWarning: t.warning,
        colorError: t.danger,
        colorInfo: t.info,
        borderRadius: 8,
        fontSize: 12,
        controlHeight: 32,
        controlHeightLG: 36,
        fontSizeLG: 13,
        borderRadiusLG: 8,
        fontFamily: 'inherit',
        zIndexPopupBase: 1100,
        controlOutline,
        controlItemBgActive: t.accentSoft,
        controlItemBgActiveHover: t.bgSurfaceHover
      },
      components: {
        Segmented: { itemSelectedColor: t.textPrimary, itemSelectedBg: t.bgSurface, trackBg: t.bgSurfaceHover },
        DatePicker: { cellActiveWithRangeBg: t.accentSoft, activeBorderColor: t.accent, hoverBorderColor: t.borderStrong },
        Input: { activeBorderColor: t.accent, hoverBorderColor: t.borderStrong },
        Select: { optionSelectedBg: t.accentSoft, optionSelectedFontWeight: 500, activeBorderColor: t.accent, hoverBorderColor: t.borderStrong }
      }
    }}>{children}</ConfigProvider>
  </StyleProvider>;
}

/** antd 浮层（下拉、日期面板）是否正开着：此时 Esc 只该关浮层，不该关外层弹窗。 */
export function antdPopupOpen() {
  return Boolean(document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden), .ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-dropdown:not(.ant-dropdown-hidden)'));
}
