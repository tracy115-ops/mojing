import type { ThemeConfig } from 'antd';

const anchorTheme: ThemeConfig = {
  token: {
    colorPrimary: '#d4af37',
    colorSuccess: '#c4a035',
    colorWarning: '#e8c84a',
    colorError: '#c0392b',
    colorInfo: '#b8960d',
    colorBgBase: '#0a0a0f',
    colorBgContainer: 'rgba(212, 175, 55, 0.04)',
    colorBgElevated: '#1a1a26',
    colorBgLayout: '#0a0a0f',
    colorBgSpotlight: '#1a1a26',
    colorBorderBg: 'rgba(212, 175, 55, 0.08)',
    colorBorder: 'rgba(212, 175, 55, 0.15)',
    colorBorderSecondary: 'rgba(212, 175, 55, 0.08)',
    colorText: '#e8e0cc',
    colorTextSecondary: 'rgba(255, 255, 255, 0.60)',
    colorTextTertiary: 'rgba(255, 255, 255, 0.40)',
    colorTextDisabled: 'rgba(255, 255, 255, 0.20)',
    colorLink: '#d4af37',
    colorLinkHover: '#e8c84a',
    colorLinkActive: '#b8960d',
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
    Button: {
      defaultBorderColor: 'rgba(212, 175, 55, 0.2)',
      defaultColor: '#d4af37',
      primaryShadow: '0 2px 0 rgba(212, 175, 55, 0.1)',
    },
    Menu: {
      darkItemBg: 'transparent',
      darkItemSelectedBg: 'rgba(212, 175, 55, 0.12)',
      darkItemColor: 'rgba(255, 255, 255, 0.65)',
      darkItemSelectedColor: '#d4af37',
      darkItemHoverColor: '#e8c84a',
    },
    Input: {
      colorBgContainer: '#1a1a26',
      colorBorder: 'rgba(212, 175, 55, 0.15)',
    },
    Card: {
      colorBgContainer: '#12121a',
      colorBorderSecondary: 'rgba(212, 175, 55, 0.08)',
    },
    Table: {
      colorBgContainer: '#12121a',
      headerBg: '#1a1a26',
      rowHoverBg: 'rgba(212, 175, 55, 0.06)',
    },
    Tabs: {
      inkBarColor: '#d4af37',
      itemActiveColor: '#e8c84a',
      itemSelectedColor: '#d4af37',
    },
    Tag: {
      defaultBg: 'rgba(212, 175, 55, 0.08)',
      defaultColor: '#d4af37',
    },
    Tooltip: {
      colorBgSpotlight: '#1a1a26',
    },
    Modal: {
      contentBg: '#12121a',
      headerBg: '#12121a',
    },
  },
};

export default anchorTheme;
