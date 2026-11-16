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
      width={580}
      styles={{ body: { maxHeight: '72vh', overflowY: 'auto', paddingRight: 8 } }}
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
            <Radio value="1080">1080p</Radio>
            <Radio value="1440">1440p</Radio>
          </Radio.Group>
        </div>

        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('video.export.hint')}
          </Text>
        </div>

        {busy && (
          <Progress percent={progress} status="active" />
        )}
      </Space>
    </Modal>
  );
};

export default ExportVideoModal;
