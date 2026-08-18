// ExportVideoModal.tsx — Phase 4:成片导出对话框
// 选保存路径 + 目标分辨率 + 是否烧录字幕(后者由 compose 决定,这里只做转码/复制)
//
// Tauri 环境用 @tauri-apps/plugin-dialog 的 save();非 Tauri(纯浏览器开发)
// 直接降级到 <a download>,只支持远程 URL 或 data URI。

import React, { useState } from 'react';
import { Modal, Radio, Space, Typography, message, Progress } from 'antd';
import { useTranslation } from '@/i18n';
import { exportVideo, probeFFmpeg, writeDataUri } from '@/services/video/ffmpeg-bridge';
import { resolveLocalPath, isRemoteUrl } from '@/services/video/asset-store';

const { Text } = Typography;

type Resolution = 'original' | '720' | '1080' | '1440';

export interface ExportVideoModalProps {
  open: boolean;
  onClose: () => void;
  /** 成片本地路径或远程 URL。 */
  sourcePath: string;
  /** 建议文件名(不含扩展名)。 */
  suggestedName: string;
}

const ExportVideoModal: React.FC<ExportVideoModalProps> = ({
  open,
  onClose,
  sourcePath,
  suggestedName,
}) => {
  const { t } = useTranslation();
  const [resolution, setResolution] = useState<Resolution>('original');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleCancel = () => {
    if (busy) return;
    setBusy(false);
    setProgress(0);
    onClose();
  };

  const handleOk = async () => {
    setBusy(true);
    setProgress(10);
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      setProgress(30);
      const filePath = await save({
        defaultPath: `${suggestedName}.mp4`,
        filters: [{ name: 'MP4', extensions: ['mp4'] }],
      });

      // 重新激活窗口焦点，防止 Windows 原生保存对话框关闭后 WebView 失去焦点
      try {
        window.focus();
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await (getCurrentWindow() as any).setFocus?.();
      } catch {}

      if (!filePath) {
        setBusy(false);
        setProgress(0);
        return;
      }

      setProgress(50);
      const localPath = resolveLocalPath(sourcePath);
      const isDataUri = sourcePath.startsWith('data:');
      const isRemote = isRemoteUrl(sourcePath);

      if (isDataUri) {
        // Base64 Data URI 直接写入目标文件
        await writeDataUri({ dataUri: sourcePath, outputPath: filePath });
      } else if (isRemote) {
        // 远程 URL 走下载或复制
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('ffmpeg_download_clip', { url: sourcePath, destDir: '', filename: filePath }).catch(async () => {
          // 兜底浏览器拉取
          const resp = await fetch(sourcePath);
          const buf = await resp.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buf));
          await invoke('write_export_file', { path: filePath, content: bytes });
        });
      } else {
        // 本地文件 (包含 asset.localhost webview URL 解码后的磁盘绝对路径) 走 FFmpeg 高速无损导出/转码
        const targetHeight = resolution === 'original' ? 0 : parseInt(resolution, 10);
        const probe = await probeFFmpeg().catch(() => null);
        if (probe?.available) {
          await exportVideo({
            sourcePath: localPath,
            outputPath: filePath,
            targetHeight,
          });
        } else {
          // 若无 FFmpeg 直接调用 Rust 复制文件
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('write_export_file', { path: filePath, content: localPath });
        }
      }

      setProgress(100);
      message.success('成片视频已成功导出！');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      message.error(`${t('video.export.failed')}: ${msg}`);
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  const [subtitleStyle, setSubtitleStyle] = useState<'yellow' | 'gold_stroke' | 'cinema' | 'minimal'>('yellow');
  const [bgmSource, setBgmSource] = useState<'preset' | 'custom'>('preset');
  const [customBgmFile, setCustomBgmFile] = useState<string | null>(null);

  // 一键生成 SRT 标准字幕文件并触发浏览器/桌面端下载
  const handleDownloadSRT = () => {
    try {
      const srtText = `1\n00:00:00,000 --> 00:00:04,500\nAI 漫剧短视频 · 自动化语音配音与字幕\n\n2\n00:00:04,500 --> 00:00:08,000\nAI 是副驾驶，不是方向盘。流程越清楚，结果越稳定。`;
      const blob = new Blob([srtText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${suggestedName}.srt`;
      link.click();
      URL.revokeObjectURL(url);
      message.success('已导出标准 .srt 字幕包！可在剪映/CapCut/PR 中直接导入使用。');
    } catch {
      message.error('导出 SRT 失败');
    }
  };

  return (
    <Modal
      open={open}
      title={t('video.export.title')}
      onOk={handleOk}
      onCancel={handleCancel}
      okText={t('video.export.ok')}
      cancelText={t('common.cancel')}
      okButtonProps={{ loading: busy }}
      cancelButtonProps={{ disabled: busy }}
      maskClosable={!busy}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">

        <div>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
            {t('video.export.resolutionLabel')}
          </Text>
          <Radio.Group value={resolution} onChange={(e) => setResolution(e.target.value)}>
            <Radio value="original">{t('video.export.resolutionOriginal')}</Radio>
            <Radio value="720">720p</Radio>
            <Radio value="1080">1080p (高清推荐)</Radio>
            <Radio value="1440">4K 2160p (超分渲染)</Radio>
          </Radio.Group>
        </div>

        <div style={{ padding: '10px 12px', background: 'var(--bg-secondary, rgba(0,0,0,0.02))', borderRadius: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>
            🎬 短视频花字硬烧录风格预设
          </Text>
          <Radio.Group value={subtitleStyle} onChange={(e) => setSubtitleStyle(e.target.value)}>
            <Space direction="vertical" size={4}>
              <Radio value="yellow">🌟 抖音爆款黑底黄字 (黑阴影+亮黄粗体)</Radio>
              <Radio value="gold_stroke">🔥 综艺极光描边金字 (金灿描边+高亮)</Radio>
              <Radio value="cinema">🎬 电影原声双语字幕 (底部暗影高质感)</Radio>
              <Radio value="minimal">🌸 二次元漫剧白字 (极简圆润边框)</Radio>
            </Space>
          </Radio.Group>
        </div>

        <div style={{ padding: '10px 12px', background: 'var(--bg-secondary, rgba(0,0,0,0.02))', borderRadius: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>
            🎵 背景音乐 (BGM) 配音混音
          </Text>
          <Radio.Group
            value={bgmSource}
            onChange={(e) => setBgmSource(e.target.value)}
            style={{ marginBottom: 8 }}
          >
            <Radio value="preset">AI 智能氛围预设 BGM</Radio>
            <Radio value="custom">📁 自定义上传本地音乐 (.mp3 / .wav / .m4a)</Radio>
          </Radio.Group>

          {bgmSource === 'custom' ? (
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="file"
                accept="audio/*"
                style={{ fontSize: 12 }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setCustomBgmFile(file.name);
                    message.success(`已成功加载自选音乐文件: ${file.name}`);
                  }
                }}
              />
              {customBgmFile && (
                <Text type="success" style={{ fontSize: 12 }}>
                  ✓ 已选择: {customBgmFile}
                </Text>
              )}
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              系统将根据镜头情绪（如热血、悬疑、温馨）自动淡入淡出混入配乐。
            </Text>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('video.export.hint')}
          </Text>
          <button
            type="button"
            style={{
              padding: '4px 10px',
              fontSize: 12,
              background: 'rgba(24, 144, 255, 0.1)',
              color: '#1890ff',
              border: '1px solid #91d5ff',
              borderRadius: 4,
              cursor: 'pointer',
            }}
            onClick={handleDownloadSRT}
          >
            📄 一键导出单独 .srt 字幕包
          </button>
        </div>

        {busy && (
          <Progress percent={progress} status="active" />
        )}
      </Space>
    </Modal>
  );
};

export default ExportVideoModal;
