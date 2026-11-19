import { useEffect, useState } from 'react';
import { Button, Card, Empty, Input, List, Modal, Select, Space, Steps, Table, Tag, Typography, message } from 'antd';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { useVideoStore } from '@/stores/videoStore';
import { useProjectStore } from '@/stores/projectStore';
import { retryStudioImageComposition, submitStudioJob } from '@/services/video-studio/generation';
import type { StudioAsset, StudioJob } from '@/types/video-studio';
import VideoProjectProgress from '@/components/Video/VideoProjectProgress';
import StudioMedia from './StudioMedia';
import StudioImageEditor from './StudioImageEditor';
import StudioUploadTasks from './StudioUploadTasks';
import { useShortDramaTasks } from './useShortDramaTasks';
import './StudioTasks.css';

function elapsedSeconds(startedAt?: string, now = Date.now()): number | undefined {
  if (!startedAt) return undefined;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return undefined;
  return Math.max(0, Math.floor((now - started) / 1000));
}

function progressForStatus(status: StudioJob['status']): { current: number; stepStatus?: 'error' | 'finish' | 'process' } {
  if (status === 'completed') return { current: 3, stepStatus: 'finish' };
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') return { current: 2, stepStatus: 'error' };
  if (status === 'running') return { current: 2, stepStatus: 'process' };
  return { current: 1, stepStatus: 'process' };
}

export default function StudioTasks() {
  const { t } = useTranslation();
  const store = useVideoStudioStore();
  const projects = useVideoStore((state) => state.projects);
  const dramaTasks = useShortDramaTasks();
  const [filter, setFilter] = useState('all'), [search, setSearch] = useState(''), [detailId, setDetailId] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const [editing, setEditing] = useState<StudioAsset>();
  const detail = store.jobs.find((job) => job.id === detailId);
  const latestJob = [...store.jobs].reverse()[0];
  const latestProgress = latestJob ? progressForStatus(latestJob.status) : undefined;
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
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
  const openProject = (projectId: string) => {
    useProjectStore.getState().setActiveProject(projectId);
    useVideoStore.getState().setActivePipelineId(projectId);
    store.setPage('projects');
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
    {dramaTasks.length > 0 && (
      <Card size="small" className="studio-task-progress-card" data-testid="studio-short-drama-tasks" title={t('studio.task.shortDramas')}>
        <List
          dataSource={dramaTasks}
          rowKey="projectId"
          pagination={dramaTasks.length > 6 ? { pageSize: 6, size: 'small' } : false}
          renderItem={(task) => (
            <List.Item className="studio-short-drama-task" data-project-id={task.projectId}>
              <div className="studio-short-drama-task-copy">
                <Typography.Text strong>{task.title}</Typography.Text>
                {task.series && <Typography.Text type="secondary">{task.series}</Typography.Text>}
                <VideoProjectProgress project={task.pipeline} />
              </div>
              <Button size="small" data-testid="studio-short-drama-open" onClick={() => openProject(task.projectId)}>
                {t('studio.asset.openProject')}
              </Button>
            </List.Item>
          )}
        />
      </Card>
    )}
    {(latestJob || dramaTasks.length === 0) && <>
    <Card size="small" className="studio-task-progress-card" data-testid="studio-task-progress-panel" title={t('studio.task.progressTitle')}>
      {latestJob && latestProgress ? <>
        <div className="studio-task-progress-heading"><Typography.Text strong ellipsis>{latestJob.name}</Typography.Text><Tag color={latestJob.status === 'completed' ? 'success' : latestJob.status === 'failed' ? 'error' : 'processing'}>{t(`studio.task.${latestJob.status}`)}</Tag></div>
        <Steps size="small" current={latestProgress.current} status={latestProgress.stepStatus} items={[
          { title: t('studio.task.stepSubmitted') },
          { title: t('studio.task.stepWaiting') },
          { title: t(latestJob.input.kind === 'image' ? 'studio.task.stepGeneratingImage' : 'studio.task.stepGenerating') },
          { title: t(latestJob.status === 'failed' || latestJob.status === 'cancelled' || latestJob.status === 'interrupted' ? 'studio.task.stepFailure' : 'studio.task.stepResult') },
        ]} />
        <Space wrap className="studio-task-progress-meta"><Typography.Text type="secondary">{latestJob.input.model}</Typography.Text>{latestJob.status === 'running' && elapsedSeconds(latestJob.startedAt, now) !== undefined && <Typography.Text type="secondary">{t('studio.task.runningFor', { seconds: elapsedSeconds(latestJob.startedAt, now)! })}</Typography.Text>}{latestJob.status === 'queued' && <Typography.Text type="secondary">{t('studio.task.waiting')}</Typography.Text>}{latestJob.error && <Typography.Text type="danger">{latestJob.error}</Typography.Text>}{latestJob.status === 'completed' && <Button size="small" type="primary" data-testid="studio-progress-view-result" onClick={() => setDetailId(latestJob.id)}>{t('studio.task.viewResult')}</Button>}{['failed', 'cancelled', 'interrupted'].includes(latestJob.status) && <Button size="small" data-testid="studio-progress-retry" onClick={() => retry(latestJob)}>{t('studio.task.retry')}</Button>}</Space>
      </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('studio.task.noActive')} />}
    </Card>
    <div className="video-studio-toolbar"><Input.Search allowClear placeholder={t('studio.search')} value={search} onChange={(event) => setSearch(event.target.value)} /><Select value={filter} onChange={setFilter} options={['all', 'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].map((value) => ({ value, label: t(value === 'all' ? 'studio.all' : `studio.task.${value}`) }))} /></div>
    <Table rowKey="id" size="small" dataSource={jobs} scroll={{ x: 760 }} pagination={{ pageSize: 15 }} columns={[
      { title: t('studio.creator.prompt'), dataIndex: 'name', ellipsis: true },
      { title: t('studio.creator.models'), render: (_, job) => job.input.model },
      { title: t('studio.page.tasks'), render: (_, job) => <Space size={6} wrap><Tag data-testid={`studio-task-status-${job.status}`} color={job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : 'processing'}>{t(`studio.task.${job.status}`)}</Tag>{job.status === 'running' && elapsedSeconds(job.startedAt, now) !== undefined && <Typography.Text type="secondary">{t('studio.task.runningFor', { seconds: elapsedSeconds(job.startedAt, now)! })}</Typography.Text>}{job.status === 'queued' && <Typography.Text type="secondary">{t('studio.task.waiting')}</Typography.Text>}</Space> },
      { title: t('studio.task.time'), render: (_, job) => new Date(job.createdAt).toLocaleString(), width: 180 },
      { title: t('studio.open'), width: 240, render: (_, job) => <Space wrap><Button size="small" data-testid={job.status === 'completed' ? 'studio-view-result' : 'studio-view-details'} onClick={() => setDetailId(job.id)}>{job.status === 'completed' ? t('studio.task.viewResult') : t('studio.task.details')}</Button>{job.status === 'queued' ? <Button size="small" onClick={() => store.updateJob(job.id, { status: 'cancelled' })}>{t('studio.cancel')}</Button> : job.status !== 'running' && !(job.input.imageEdit && job.status === 'completed') && <Button size="small" data-testid={localRetry(job) ? 'studio-retry-composition' : undefined} onClick={() => retry(job)}>{t(localRetry(job) ? 'studio.edit.mask.localRetry' : job.input.imageEdit ? 'studio.edit.mask.regenerate' : 'studio.task.retry')}</Button>}</Space> },
    ]} />
    </>}
    <StudioUploadTasks />
    <Typography.Title level={4}>{t('studio.task.project')}</Typography.Title>
    {projectRecords.length ? <Table size="small" rowKey="key" pagination={{ pageSize: 10 }} dataSource={projectRecords.reverse()} scroll={{ x: 650 }} columns={[
      { title: t('studio.page.projects'), dataIndex: 'projectTitle' }, { title: t('studio.creator.models'), dataIndex: 'model' },
      { title: t('studio.creator.result'), render: (_, record) => `${record.stage} · ${record.executionStatus ?? ''}` },
      { title: t('studio.open'), render: (_, record) => <Button size="small" onClick={() => openProject(record.projectId)}>{t('studio.asset.openProject')}</Button> },
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
