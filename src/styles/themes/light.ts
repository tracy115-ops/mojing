import type { ThemeConfig } from 'antd';

const lightTheme: ThemeConfig = {
  token: {
    colorPrimary: '#1890FF',
    colorSuccess: '#52C41A',
    colorWarning: '#FAAD14',
    colorError: '#FF4D4F',
    colorInfo: '#1677FF',
    colorBgBase: '#FFFFFF',
    colorBgContainer: '#FFFFFF',
    colorBgElevated: '#FFFFFF',
    colorBgLayout: '#F5F5F5',
    colorBgSpotlight: 'rgba(0, 0, 0, 0.85)',
    colorBorder: '#D9D9D9',
    colorBorderSecondary: '#F0F0F0',
    colorText: '#333333',
    colorTextSecondary: 'rgba(0, 0, 0, 0.65)',
    colorTextTertiary: 'rgba(0, 0, 0, 0.45)',
    colorTextDisabled: 'rgba(0, 0, 0, 0.25)',
    colorLink: '#1890FF',
    colorLinkHover: '#40A9FF',
    colorLinkActive: '#096DD9',
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
      headerBg: '#FFFFFF',
      siderBg: '#FFFFFF',
      bodyBg: '#F5F5F5',
    },
    Menu: {
      itemBorderRadius: 8,
      subMenuItemBorderRadius: 8,
      itemMarginInline: 4,
      itemHeight: 40,
    },
    Card: {
      borderRadiusLG: 12,
    },
    Modal: {
      contentBg: '#FFFFFF',
      headerBg: '#FFFFFF',
    },
    Input: {
      colorBgContainer: '#FFFFFF',
      activeBorderColor: '#1890FF',
      hoverBorderColor: 'rgba(24, 144, 255, 0.5)',
    },
    Select: {
      colorBgContainer: '#FFFFFF',
      colorBgElevated: '#FFFFFF',
      optionActiveBg: '#F0F5FF',
      optionSelectedBg: '#E6F7FF',
    },
    Tabs: {
      inkBarColor: '#1890FF',
      itemActiveColor: '#1890FF',
      itemSelectedColor: '#1890FF',
      itemHoverColor: '#40A9FF',
    },
    Tooltip: {
      colorBgSpotlight: 'rgba(0, 0, 0, 0.85)',
    },
    Popover: {
      colorBgElevated: '#FFFFFF',
    },
    Dropdown: {
      colorBgElevated: '#FFFFFF',
    },
    Button: {
      defaultBg: '#FFFFFF',
      defaultBorderColor: '#D9D9D9',
      defaultHoverBg: '#FFFFFF',
      defaultHoverBorderColor: '#1890FF',
    },
    Divider: {
      colorBorder: '#E8E8E8',
    },
  },
  algorithm: undefined,
};

export default lightTheme;
