import React from 'react';
import { Result, Button } from 'antd';

interface Props {
  children: React.ReactNode;
}
interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
  errorCount: number;
}

/**
 * Top-level error boundary. Catches render-time exceptions and shows a
 * readable message instead of a blank/black screen so the user can report
 * what actually went wrong.
 *
 * Includes a retry-count guard so that "throw on first render → recovery →
 * throw again" cycles don't loop forever (which manifests as React #185
 * "Maximum update depth exceeded").
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, errorCount: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
    this.setState((s) => ({
      errorInfo: info,
      errorCount: s.errorCount + 1,
    }));
  }

  handleReload = () => {
    window.location.reload();
  };

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
  };

  render() {
    if (this.state.hasError) {
      const isLoop = this.state.errorCount > 3;
      return (
        <div style={{ padding: 24, background: '#fff', minHeight: '100vh', color: '#000' }}>
          <Result
            status="error"
            title={isLoop ? 'MoJing 反复崩溃（已停止重试）' : 'MoJing 启动失败'}
            subTitle={this.state.error?.message ?? 'Unknown error'}
            extra={
              isLoop
                ? [
                    <Button key="reload" type="primary" onClick={this.handleReload}>
                      重启应用
                    </Button>,
                  ]
                : [
                    <Button key="retry" type="primary" onClick={this.handleRetry}>
                      重试
                    </Button>,
                    <Button key="reload" onClick={this.handleReload}>
                      重启
                    </Button>,
                  ]
            }
          >
            <pre
              style={{
                textAlign: 'left',
                background: '#f5f5f5',
                padding: 12,
                overflow: 'auto',
                fontSize: 12,
                maxHeight: 200,
                color: '#000',
              }}
            >
              {this.state.error?.stack ?? ''}
            </pre>
            {this.state.errorInfo?.componentStack && (
              <pre
                style={{
                  textAlign: 'left',
                  background: '#fafafa',
                  padding: 12,
                  overflow: 'auto',
                  fontSize: 12,
                  maxHeight: 200,
                  color: '#666',
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
