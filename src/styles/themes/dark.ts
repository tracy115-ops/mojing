import type { ThemeConfig } from 'antd';

const darkTheme: ThemeConfig = {
  token: {
    colorPrimary: '#3b82f6',
    colorSuccess: '#22c55e',
    colorWarning: '#f59e0b',
    colorError: '#ef4444',
    colorInfo: '#06b6d4',
    colorBgBase: '#1a1a2e',
    colorBgContainer: 'rgba(255, 255, 255, 0.04)',
    colorBgElevated: '#16213e',
    colorBgLayout: '#1a1a2e',
    colorBgSpotlight: '#0f3460',
    colorBorderBg: 'rgba(255, 255, 255, 0.06)',
    colorBorder: 'rgba(255, 255, 255, 0.12)',
    colorBorderSecondary: 'rgba(255, 255, 255, 0.06)',
    colorText: '#e0e0e0',
    colorTextSecondary: 'rgba(255, 255, 255, 0.65)',
    colorTextTertiary: 'rgba(255, 255, 255, 0.45)',
    colorTextDisabled: 'rgba(255, 255, 255, 0.25)',
    colorLink: '#60a5fa',
    colorLinkHover: '#93c5fd',
    colorLinkActive: '#3b82f6',
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 6,
    fontFamily: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans SC', sans-serif`,
    fontSize: 14,
    fontSizeSM: 12,
    fontSizeLG: 16,
    fontSizeXL: 20,
    controlHeight: 36,
    controlHeightLG: 44,
    controlHeightSM: 28,
    lineWidth: 1,
    lineType: 'solid',
    motion: true,
  },
  components: {
    Layout: {
      headerBg: 'rgba(0, 0, 0, 0.15)',
      siderBg: 'rgba(0, 0, 0, 0.1)',
      bodyBg: '#1a1a2e',
    },
    Menu: {
      darkItemBg: 'transparent',
      darkSubMenuItemBg: 'rgba(0, 0, 0, 0.1)',
      darkItemSelectedBg: 'rgba(59, 130, 246, 0.15)',
      darkItemHoverBg: 'rgba(255, 255, 255, 0.06)',
      itemBorderRadius: 8,
      subMenuItemBorderRadius: 8,
      itemMarginInline: 4,
      itemHeight: 40,
    },
    Card: {
      colorBgContainer: 'rgba(255, 255, 255, 0.04)',
      borderRadiusLG: 12,
    },
    Modal: {
      contentBg: '#16213e',
      headerBg: '#16213e',
    },
    Input: {
      colorBgContainer: 'rgba(255, 255, 255, 0.04)',
      activeBorderColor: '#3b82f6',
      hoverBorderColor: 'rgba(59, 130, 246, 0.5)',
    },
    Select: {
      colorBgContainer: 'rgba(255, 255, 255, 0.04)',
      colorBgElevated: '#16213e',
      optionActiveBg: 'rgba(255, 255, 255, 0.08)',
      optionSelectedBg: 'rgba(59, 130, 246, 0.15)',
    },
    Tabs: {
      inkBarColor: '#3b82f6',
      itemActiveColor: '#3b82f6',
      itemSelectedColor: '#3b82f6',
      itemHoverColor: '#60a5fa',
    },
    Tooltip: {
      colorBgSpotlight: '#0f3460',
    },
    Popover: {
      colorBgElevated: '#16213e',
    },
    Dropdown: {
      colorBgElevated: '#16213e',
    },
    Button: {
      defaultBg: 'rgba(255, 255, 255, 0.06)',
      defaultBorderColor: 'rgba(255, 255, 255, 0.12)',
      defaultHoverBg: 'rgba(255, 255, 255, 0.1)',
      defaultHoverBorderColor: 'rgba(255, 255, 255, 0.2)',
    },
    Divider: {
      colorBorder: 'rgba(255, 255, 255, 0.06)',
    },
  },
  algorithm: undefined,
};

export default darkTheme;
