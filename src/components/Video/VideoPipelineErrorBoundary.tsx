import React from 'react';
import { Result, Button } from 'antd';

interface Props {
  children: React.ReactNode;
  /** 当用户点"重置"时,清空外部状态(pipeline id 等) */
  onReset?: () => void;
}
interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
}

/**
 * VideoPipelinePanel 专用的局部错误边界。
 * 渲染异常时显示具体错误(而不是让整个应用卡住或被全局边界吞掉),
 * 提供"重置流水线"按钮让用户清掉脏状态重新开始。
 */
export class VideoPipelineErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[VideoPipelineErrorBoundary]', error, info);
    this.setState({ errorInfo: info });
  }

  handleReset = () => {
    this.props.onReset?.();
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
  };

  render() {
    if (this.state.hasError) {
      // class component 不能用 useTranslation,这里用固定文案兜底
      // —— 出错时 i18n 模块本身可能也已经坏了
      return (
        <div style={{ padding: 24 }}>
          <Result
            status="error"
            title="执行过程面板渲染失败"
            subTitle={this.state.error?.message ?? 'Unknown render error'}
            extra={[
              <Button key="reset" type="primary" onClick={this.handleReset}>
                清空流水线状态并重试
              </Button>,
            ]}
          >
            <pre
              style={{
                textAlign: 'left',
                background: 'var(--bg-secondary, #f5f5f5)',
                padding: 12,
                overflow: 'auto',
                fontSize: 12,
                maxHeight: 200,
                color: 'var(--text-secondary)',
              }}
            >
              {this.state.error?.stack ?? ''}
            </pre>
            {this.state.errorInfo?.componentStack && (
              <pre
                style={{
                  textAlign: 'left',
                  background: 'var(--bg-tertiary, #fafafa)',
                  padding: 12,
                  overflow: 'auto',
                  fontSize: 12,
                  maxHeight: 200,
                  color: 'var(--text-tertiary)',
                }}
              >
                {this.state.errorInfo.componentStack}
              </pre>
            )}
          </Result>
        </div>
      );
    }
    return this.props.children;
  }
}
