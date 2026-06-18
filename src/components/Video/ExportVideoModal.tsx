// ExportVideoModal.tsx — Phase 4:成片导出对话框
// 选保存路径 + 目标分辨率 + 是否烧录字幕(后者由 compose 决定,这里只做转码/复制)
//
// Tauri 环境用 @tauri-apps/plugin-dialog 的 save();非 Tauri(纯浏览器开发)
// 直接降级到 <a download>,只支持远程 URL 或 data URI。

import React, { useState } from 'react';
import { Modal, Radio, Space, Typography, message, Progress, Alert } from 'antd';
import { useTranslation } from '@/i18n';
import { exportVideo, probeFFmpeg } from '@/services/video/ffmpeg-bridge';

const { Text } = Typography;

type Resolution = 'original' | '720' | '1080' | '1440';

export interface ExportVideoModalProps {
  open: boolean;
  onClose: () => void;
  /** 成片本地路径或远程 URL;远程 URL 不支持转码导出。 */
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

  const isRemote = /^https?:\/\//.test(sourcePath);
  const isDataUri = sourcePath.startsWith('data:');

  const handleOk = async () => {
    if (isRemote || isDataUri) {
      message.warning(t('video.export.remoteOnly'));
      return;
    }
    setBusy(true);
    setProgress(10);
    try {
      const probe = await probeFFmpeg().catch(() => null);
      if (!probe?.available) {
        message.error(t('video.export.ffmpegMissing'));
        return;
      }

      const { save } = await import('@tauri-apps/plugin-dialog');
      setProgress(30);
      const filePath = await save({
        defaultPath: `${suggestedName}.mp4`,
        filters: [{ name: 'MP4', extensions: ['mp4'] }],
      });
      if (!filePath) {
        setBusy(false);
        setProgress(0);
        return;
      }

      setProgress(50);
      const targetHeight = resolution === 'original' ? 0 : parseInt(resolution, 10);
      const result = await exportVideo({
        sourcePath,
        outputPath: filePath,
        targetHeight,
      });
      setProgress(100);

      const sizeMb = result.sizeBytes ? (result.sizeBytes / 1024 / 1024).toFixed(1) : '?';
      const durStr = result.durationSeconds ? `${result.durationSeconds.toFixed(1)}s` : '';
      message.success(
        t('video.export.success', { size: sizeMb, duration: durStr }),
      );
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
      onCancel={onClose}
      okText={t('video.export.ok')}
      cancelText={t('common.cancel')}
      okButtonProps={{ loading: busy, disabled: isRemote || isDataUri }}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {(isRemote || isDataUri) && (
          <Alert
            type="warning"
            showIcon
            message={t('video.export.remoteOnlyTitle')}
            description={t('video.export.remoteOnly')}
          />
        )}

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

        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('video.export.hint')}
        </Text>

        {busy && (
          <Progress percent={progress} status="active" />
        )}
      </Space>
    </Modal>
  );
};

export default ExportVideoModal;
