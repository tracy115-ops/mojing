import { useState } from 'react';
import { Button, Empty, Input, InputNumber, Select, Switch, Tag, Tooltip } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CopyOutlined, DeleteOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { studioId } from '@/services/video-studio/document';
import { CAMERA_MOVES, cameraWithMove } from '@/services/video-studio/world-animation';
import { retimeWorldCamera, worldCameraContextAt, worldSequenceSpans, WORLD_SEQUENCE_MAX_DURATION, WORLD_SEQUENCE_MAX_SHOTS, WORLD_SEQUENCE_MIN_SHOT_DURATION } from '@/services/video-studio/world-sequence';
import type { WorldCameraShot, WorldDocument } from '@/types/video-studio';
import './WorldCameraSequence.css';

export default function WorldCameraSequence({ world, time, disabled, canTransfer, onChange, onSeek, onTransfer }: {
  world: WorldDocument; time: number; disabled: boolean; canTransfer: boolean;
  onChange: (world: WorldDocument) => void; onSeek: (time: number) => void; onTransfer: () => void;
}) {
  const { t } = useTranslation(), [sourceId, setSourceId] = useState('main');
  const shots = world.cameraSequence?.shots ?? [], spans = worldSequenceSpans(world), total = spans[spans.length - 1]?.end ?? 0;
  const active = worldCameraContextAt(world, time).shot?.id;
  const effectiveSourceId = sourceId === 'main' || world.cameraBookmarks?.some((item) => item.id === sourceId) ? sourceId : 'main';
  const change = (next: WorldCameraShot[], enabled = world.cameraSequence?.enabled ?? true) => onChange({ ...world, cameraSequence: { enabled: !!next.length && enabled, shots: next } });
  const patch = (id: string, updates: Partial<WorldCameraShot>) => change(shots.map((shot) => shot.id === id ? { ...shot, ...updates } : shot));
  const move = (index: number, direction: number) => {
    const next = [...shots]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; change(next);
  };
  const add = () => {
    const source = world.cameraBookmarks?.find((item) => item.id === effectiveSourceId);
    const duration = Math.min(3, world.duration, WORLD_SEQUENCE_MAX_DURATION - total);
    change([...shots, { id: studioId(), name: source?.name ?? `${t('studio.world.sequence.mainCamera')} ${shots.length + 1}`, duration, camera: retimeWorldCamera(source?.camera ?? world.camera, world.duration, duration) }], true);
  };
  return <section className="world-camera-sequence" data-testid="world-camera-sequence">
    <div className="world-camera-sequence-heading"><strong>{t('studio.world.sequence.title')}</strong><Tag>{t('studio.world.sequence.total', { count: shots.length, duration: Number(total.toFixed(2)) })}</Tag><label><Switch size="small" aria-label={t('studio.world.sequence.enabled')} checked={!!world.cameraSequence?.enabled} disabled={disabled || !shots.length} onChange={(enabled) => change(shots, enabled)} />{t('studio.world.sequence.enabled')}</label><Button size="small" disabled={disabled || !canTransfer || !shots.length} onClick={onTransfer}>{t('studio.world.sequence.transfer')}</Button></div>
    <div className="world-camera-sequence-tools"><Select aria-label={t('studio.world.sequence.source')} value={effectiveSourceId} disabled={disabled} onChange={setSourceId} options={[{ value: 'main', label: t('studio.world.sequence.mainCamera') }, ...(world.cameraBookmarks ?? []).map((item) => ({ value: item.id, label: item.name }))]} /><Tooltip title={t('studio.world.sequence.limit')}><Button icon={<PlusOutlined />} disabled={disabled || shots.length >= WORLD_SEQUENCE_MAX_SHOTS || total > WORLD_SEQUENCE_MAX_DURATION - WORLD_SEQUENCE_MIN_SHOT_DURATION} onClick={add}>{t('studio.world.sequence.add')}</Button></Tooltip><span>{t('studio.world.sequence.hint')}</span></div>
    {!shots.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('studio.world.sequence.empty')} /> : <div className="world-camera-sequence-shots">{spans.map(({ shot, index, start, end }) => <article key={shot.id} data-world-sequence-shot={shot.id} className={active === shot.id ? 'is-active' : ''}>
      <div className="world-camera-sequence-shot-heading"><Button size="small" icon={<PlayCircleOutlined />} aria-label={`${t('studio.world.sequence.preview')} ${index + 1}`} disabled={disabled} onClick={() => { if (!world.cameraSequence?.enabled) change(shots, true); onSeek(start); }}>{index + 1}</Button><span>{Number(start.toFixed(2))}–{Number(end.toFixed(2))}s</span><Tag>{t('studio.world.sequence.cut')}</Tag></div>
      <Input key={`${shot.id}:${shot.name}`} size="small" aria-label={`${t('studio.world.sequence.name')} ${index + 1}`} maxLength={120} defaultValue={shot.name} disabled={disabled} onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== shot.name) patch(shot.id, { name }); else event.target.value = shot.name; }} />
      <div className="world-camera-sequence-shot-settings"><InputNumber size="small" aria-label={`${t('studio.world.sequence.duration')} ${index + 1}`} value={shot.duration} min={WORLD_SEQUENCE_MIN_SHOT_DURATION} max={Math.min(WORLD_SEQUENCE_MAX_DURATION, WORLD_SEQUENCE_MAX_DURATION - total + shot.duration)} step={0.25} precision={2} suffix="s" disabled={disabled} onChange={(duration) => { if (duration !== null && duration >= WORLD_SEQUENCE_MIN_SHOT_DURATION && total - shot.duration + duration <= WORLD_SEQUENCE_MAX_DURATION) patch(shot.id, { duration, camera: retimeWorldCamera(shot.camera, shot.duration, duration) }); }} /><Select<typeof CAMERA_MOVES[number]> size="small" aria-label={`${t('studio.world.cameraMove')} ${index + 1}`} placeholder={t('studio.world.cameraMove')} value={undefined} disabled={disabled} options={CAMERA_MOVES.map((value) => ({ value, label: t(`studio.world.cameraMove.${value}`) }))} onChange={(value) => patch(shot.id, { camera: cameraWithMove(shot.camera, value, shot.duration) })} /></div>
      <div className="world-camera-sequence-shot-actions"><Button size="small" icon={<ArrowUpOutlined />} aria-label={`${t('studio.world.sequence.up')} ${index + 1}`} disabled={disabled || index === 0} onClick={() => move(index, -1)} /><Button size="small" icon={<ArrowDownOutlined />} aria-label={`${t('studio.world.sequence.down')} ${index + 1}`} disabled={disabled || index === shots.length - 1} onClick={() => move(index, 1)} /><Button size="small" icon={<CopyOutlined />} aria-label={`${t('studio.duplicate')} ${index + 1}`} disabled={disabled || shots.length >= WORLD_SEQUENCE_MAX_SHOTS || total + shot.duration > WORLD_SEQUENCE_MAX_DURATION} onClick={() => { const next = [...shots]; next.splice(index + 1, 0, { ...structuredClone(shot), id: studioId(), name: `${shot.name} +` }); change(next); }} /><Button size="small" danger icon={<DeleteOutlined />} aria-label={`${t('studio.delete')} ${index + 1}`} disabled={disabled} onClick={() => change(shots.filter((item) => item.id !== shot.id))} /></div>
    </article>)}</div>}
  </section>;
}
