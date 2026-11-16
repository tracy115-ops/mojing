import { Button, InputNumber, Select, Typography } from 'antd';
import { useTranslation } from '@/i18n';
import type { WorldAnimationPlayback, WorldObject } from '@/types/video-studio';
import { defaultWorldAnimationPlayback, worldAnimationRange } from '@/services/video-studio/world-model-animation';
import './WorldModelAnimation.css';

export interface WorldModelClip { name: string; duration: number }

export default function WorldModelAnimation({ object, clips, disabled, onChange }: {
  object: WorldObject; clips: WorldModelClip[]; disabled: boolean; onChange: (patch: Partial<WorldObject>) => void;
}) {
  const { t } = useTranslation();
  const clip = object.animationClip !== undefined ? clips[object.animationClip] : undefined;
  const playback = object.animationPlayback ?? defaultWorldAnimationPlayback();
  const range = worldAnimationRange(object.animationPlayback, clip?.duration ?? 0);
  const change = (patch: Partial<WorldAnimationPlayback>) => onChange({ animationPlayback: { ...playback, ...patch } });
  return <section className="world-model-animation" data-testid="world-model-animation">
    <Select<number> aria-label={t('studio.world.animationClip')} disabled={disabled} value={object.animationClip ?? -1} onChange={value => onChange({ animationClip: value < 0 ? undefined : value, animationPlayback: undefined })} options={[{ value: -1, label: t('studio.world.restPose') }, ...clips.map((item, index) => ({ value: index, label: `${item.name || index + 1} · ${item.duration.toFixed(1)}s` }))]} />
    {clip && clip.duration > 0 && <>
      <div className="world-model-animation-fields">
        <label>{t('studio.world.animation.in')}<InputNumber aria-label={t('studio.world.animation.in')} value={range.inPoint} disabled={disabled} min={0} max={Math.min(3600, Math.max(0, range.outPoint - 0.001))} step={0.01} precision={3} onChange={value => { if (value !== null && value >= 0 && value <= 3600 && value < range.outPoint) change({ inPoint: value }); }} /></label>
        <label>{t('studio.world.animation.out')}<InputNumber aria-label={t('studio.world.animation.out')} value={range.outPoint} disabled={disabled} min={range.inPoint + 0.001} max={Math.min(3600, clip.duration)} step={0.01} precision={3} onChange={value => { if (value !== null && value > range.inPoint && value <= Math.min(3600, clip.duration)) change({ outPoint: value }); }} /></label>
        <label>{t('studio.world.animation.start')}<InputNumber aria-label={t('studio.world.animation.start')} value={playback.startTime} disabled={disabled} min={0} max={60} step={0.1} precision={3} onChange={value => { if (value !== null && value >= 0 && value <= 60) change({ startTime: value }); }} /></label>
        <label>{t('studio.world.animation.speed')}<InputNumber aria-label={t('studio.world.animation.speed')} value={playback.speed} disabled={disabled} min={0.1} max={4} step={0.1} precision={2} onChange={value => { if (value !== null && value >= 0.1 && value <= 4) change({ speed: value }); }} /></label>
      </div>
      <Select aria-label={t('studio.world.animation.loop')} value={playback.loop} disabled={disabled} onChange={value => change({ loop: value })} options={(['repeat', 'once'] as const).map(value => ({ value, label: t(`studio.world.animation.${value}`) }))} />
      <Typography.Text type="secondary" data-testid="world-animation-duration">{t('studio.world.animation.cycle')}: {(range.span / playback.speed).toFixed(2)}s</Typography.Text>
      <Typography.Text type="secondary">{t('studio.world.animation.hint')}</Typography.Text>
      <Button size="small" disabled={disabled || !object.animationPlayback} onClick={() => onChange({ animationPlayback: undefined })}>{t('studio.world.animation.reset')}</Button>
    </>}
  </section>;
}

export function WorldModelAnimationTrack({ object, clip, duration, disabled, onSeek }: {
  object: WorldObject; clip: WorldModelClip; duration: number; disabled: boolean; onSeek: (time: number) => void;
}) {
  const { t } = useTranslation(), playback = object.animationPlayback ?? defaultWorldAnimationPlayback();
  const range = worldAnimationRange(object.animationPlayback, clip.duration);
  const end = playback.loop === 'repeat' ? duration : Math.min(duration, playback.startTime + range.span / playback.speed);
  if (playback.startTime >= duration || end <= playback.startTime) return null;
  const label = `${object.name} · ${t('studio.world.animationClip')} · ${clip.name} · ${playback.startTime.toFixed(2)}–${end.toFixed(2)}s`;
  return <div className="world-engine-track world-model-animation-track" data-world-animation-track={object.id}>
    <button type="button" title={label} disabled={disabled} onClick={() => onSeek(playback.startTime)}>{object.name} · {t('studio.world.animationClip')}</button>
    <div><button type="button" className="world-model-animation-span" disabled={disabled} aria-label={label} title={label} style={{ left: `${playback.startTime / duration * 100}%`, width: `${(end - playback.startTime) / duration * 100}%` }} onClick={() => onSeek(playback.startTime)}>{clip.name}</button></div>
  </div>;
}
