import { Button, Space, Table, Tag, Typography, message } from 'antd';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { cancelStudioMediaUpload, retryStudioMediaUpload } from '@/services/video-studio/media-upload';

export default function StudioUploadTasks() {
  const { t } = useTranslation(), tasks = useVideoStudioStore(state => state.uploadTasks), assets = useVideoStudioStore(state => state.assets);
  if (!tasks.length) return null;
  return <section className="studio-upload-tasks" data-testid="studio-upload-tasks"><Typography.Title level={4}>{t('studio.upload.tasks')}</Typography.Title><Table rowKey="id" size="small" dataSource={[...tasks].reverse()} pagination={{ pageSize: 8 }} scroll={{ x: 700 }} columns={[
    { title: t('studio.rename'), dataIndex: 'name', ellipsis: true },
    { title: t('studio.upload.destination'), render: (_,task) => task.target.bucket },
    { title: t('studio.page.tasks'), render: (_,task) => <Space direction="vertical" size={2}><Tag color={task.status === 'completed' ? 'success' : task.status === 'failed' ? 'error' : 'default'}>{t(`studio.upload.status.${task.status}`)}</Tag>{task.status === 'uploading' && <Typography.Text type="secondary">{t(`studio.upload.stage.${task.stage}`)}</Typography.Text>}{task.error && <Typography.Text type="danger">{t(`studio.upload.error.${task.error}`)}</Typography.Text>}</Space> },
    { title: t('studio.open'), width: 150, render: (_,task) => task.status === 'uploading' ? <Button size="small" onClick={() => cancelStudioMediaUpload(task.id)}>{t('studio.cancel')}</Button> : <Button size="small" data-testid="studio-retry-upload" disabled={!assets.some(asset => asset.id === task.assetId)} onClick={() => { try { retryStudioMediaUpload(task.id); } catch (error) { message.error(t(`studio.upload.error.${error instanceof Error ? error.message : 'network'}`)); } }}>{t(task.status === 'completed' ? 'studio.upload.renew' : 'studio.upload.retry')}</Button> },
  ]} /></section>;
}
