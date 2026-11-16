import { useState } from 'react';
import { Button, Empty, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { useVideoStore } from '@/stores/videoStore';
import { useProjectStore } from '@/stores/projectStore';
import { retryStudioImageComposition, submitStudioJob } from '@/services/video-studio/generation';
import type { StudioAsset, StudioJob } from '@/types/video-studio';
import StudioMedia from './StudioMedia';
import StudioImageEditor from './StudioImageEditor';
import StudioUploadTasks from './StudioUploadTasks';

export default function StudioTasks() {
  const { t } = useTranslation();
  const store = useVideoStudioStore();
  const projects = useVideoStore((state) => state.projects);
  const [filter, setFilter] = useState('all'), [search, setSearch] = useState(''), [detailId, setDetailId] = useState<string>();
  const [editing, setEditing] = useState<StudioAsset>();
  const detail = store.jobs.find((job) => job.id === detailId);
  const jobs = [...store.jobs].reverse().filter((job) => (filter === 'all' || job.status === filter) && `${job.name} ${job.input.prompt} ${job.input.model}`.toLowerCase().includes(search.toLowerCase()));
  const localRetry = (job: StudioJob) => !!job.input.imageEdit && !!job.rawOutputAssetId && ['failed', 'interrupted', 'cancelled'].includes(job.status);
  const retry = (job: StudioJob) => { try {
    if (localRetry(job)) retryStudioImageComposition(job.id);
    else submitStudioJob(job.input, job.canvasId && job.nodeId ? { canvasId: job.canvasId, nodeId: job.nodeId } : undefined);
    message.success(t('studio.creator.queued'));
  } catch (error) { message.error(String(error)); } };
  const edit = (job: StudioJob) => {
    if (job.input.imageEdit) {
      const source = store.assets.find((asset) => asset.id === job.input.imageEdit!.sourceAssetId);
      if (!source) { message.warning(t('studio.edit.mask.restoreSource')); return; }
      setDetailId(undefined); setEditing(source);
    } else { store.setDraft(job.input); store.setPage(job.input.kind === 'image' ? 'image' : job.input.kind === 'video' ? 'video' : 'home'); }
  };
  const projectRecords = Object.values(projects).flatMap((project) =>
    Object.values(project.stages).flatMap((stage) =>
      (stage.invocations ?? []).map((invocation, index) => ({
        ...invocation, key: `${project.novelProjectId}:${stage.stage}:${index}`,
        projectId: project.novelProjectId, projectTitle: project.title || project.novelProjectId, stage: stage.stage,
      })),
    ),
  );
  return <div className="video-studio-content" data-testid="studio-tasks">
    <div className="video-studio-toolbar"><Input.Search allowClear placeholder={t('studio.search')} value={search} onChange={(event) => setSearch(event.target.value)} /><Select value={filter} onChange={setFilter} options={['all', 'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].map((value) => ({ value, label: t(value === 'all' ? 'studio.all' : `studio.task.${value}`) }))} /></div>
    <Table rowKey="id" size="small" dataSource={jobs} scroll={{ x: 760 }} pagination={{ pageSize: 15 }} columns={[
      { title: t('studio.creator.prompt'), dataIndex: 'name', ellipsis: true },
      { title: t('studio.creator.models'), render: (_, job) => job.input.model },
      { title: t('studio.page.tasks'), render: (_, job) => <Tag color={job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : 'processing'}>{t(`studio.task.${job.status}`)}</Tag> },
      { title: t('studio.task.time'), render: (_, job) => new Date(job.createdAt).toLocaleString(), width: 180 },
      { title: t('studio.open'), width: 240, render: (_, job) => <Space wrap><Button size="small" onClick={() => setDetailId(job.id)}>{t('studio.task.details')}</Button>{job.status === 'queued' ? <Button size="small" onClick={() => store.updateJob(job.id, { status: 'cancelled' })}>{t('studio.cancel')}</Button> : job.status !== 'running' && !(job.input.imageEdit && job.status === 'completed') && <Button size="small" data-testid={localRetry(job) ? 'studio-retry-composition' : undefined} onClick={() => retry(job)}>{t(localRetry(job) ? 'studio.edit.mask.localRetry' : job.input.imageEdit ? 'studio.edit.mask.regenerate' : 'studio.task.retry')}</Button>}</Space> },
    ]} />
    <StudioUploadTasks />
    <Typography.Title level={4}>{t('studio.task.project')}</Typography.Title>
    {projectRecords.length ? <Table size="small" rowKey="key" pagination={{ pageSize: 10 }} dataSource={projectRecords.reverse()} scroll={{ x: 650 }} columns={[
      { title: t('studio.page.projects'), dataIndex: 'projectTitle' }, { title: t('studio.creator.models'), dataIndex: 'model' },
      { title: t('studio.creator.result'), render: (_, record) => `${record.stage} · ${record.executionStatus ?? ''}` },
      { title: t('studio.open'), render: (_, record) => <Button size="small" onClick={() => { useProjectStore.getState().setActiveProject(record.projectId); useVideoStore.getState().setActivePipelineId(record.projectId); store.setPage('projects'); }}>{t('studio.asset.openProject')}</Button> },
    ]} /> : <Empty description={t('studio.empty')} />}
    <Modal open={!!detail} onCancel={() => setDetailId(undefined)} footer={null} title={t('studio.task.details')} width={720} destroyOnClose>
      {detail && <Space direction="vertical" style={{ width: '100%' }}><Tag>{t(`studio.task.${detail.status}`)}</Tag><Typography.Paragraph>{detail.input.imageEdit?.instruction ?? detail.input.prompt}</Typography.Paragraph>{detail.status === 'interrupted' && <Typography.Text type="secondary">{t('studio.task.interruptedHint')}</Typography.Text>}{detail.error && <Typography.Text type="danger">{detail.error}</Typography.Text>}
        {localRetry(detail) && <Typography.Text type="secondary">{t('studio.edit.mask.localRetryHint')}</Typography.Text>}
        {detail.rawOutputAssetId && <><Typography.Text strong>{t('studio.edit.mask.candidate')}</Typography.Text><StudioMedia asset={store.assets.find((asset) => asset.id === detail.rawOutputAssetId)} /></>}
        {detail.outputAssetId && <>{detail.input.imageEdit && <Typography.Text strong>{t('studio.edit.mask.result')}</Typography.Text>}<StudioMedia asset={store.assets.find((asset) => asset.id === detail.outputAssetId)} /></>}
        <Button onClick={() => edit(detail)}>{t(detail.input.imageEdit ? 'studio.edit.mask.reopen' : 'studio.task.edit')}</Button><details><summary>{t('studio.task.details')}</summary><pre className="video-studio-text-preview">{JSON.stringify(detail.input, null, 2)}</pre></details></Space>}
    </Modal>
    {editing && <StudioImageEditor asset={editing} onClose={() => setEditing(undefined)} />}
  </div>;
}
