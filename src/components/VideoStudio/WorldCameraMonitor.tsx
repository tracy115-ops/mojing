import { Button, Select } from 'antd';
import { CameraOutlined, CheckOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { worldMonitorCameraAt, worldMonitorSources } from '@/services/video-studio/world-monitor';
import type { WorldDocument } from '@/types/video-studio';
import type { WorldMonitorSource } from '@/services/video-studio/world-monitor';
import './WorldCameraMonitor.css';

export default function WorldCameraMonitor({ world, time, sources, disabled, onSelect, onApply, onCapture }: {
  world: WorldDocument; time: number; sources: string[]; disabled: boolean;
  onSelect: (index: number, sourceId: string) => void; onApply: (sourceId: string) => void; onCapture: (sourceId: string, name: string) => void;
}) {
  const { t } = useTranslation(), available = worldMonitorSources(world);
  const name = (source: WorldMonitorSource) => source.kind === 'program' || source.kind === 'main'
    ? t(`studio.world.monitor.${source.kind}`)
    : source.kind === 'bookmark' ? `${t('studio.world.monitor.bookmark')} · ${source.name}` : `#${source.index! + 1} · ${source.name}`;
  return <div className="world-camera-monitor-grid" data-testid="world-camera-monitor" data-count={sources.length}>
    {sources.map((sourceId, index) => {
      const frame = worldMonitorCameraAt(world, sourceId, time);
      return <section key={index} className={`world-camera-monitor-tile${frame?.phase === 'program' ? ' is-program' : ''}`} data-monitor-slot={index + 1}>
        <div className="world-camera-monitor-header"><Select size="small" aria-label={`${t('studio.world.monitor.source')} ${index + 1}`} value={frame ? sourceId : undefined} placeholder={t('studio.world.monitor.choose')} allowClear disabled={disabled} onChange={id => onSelect(index, id ?? '')} options={available.map(source => ({ value: source.id, label: name(source), disabled: sources.some((id, slot) => slot !== index && id === source.id) }))} /></div>
        {!frame ? <div className="world-camera-monitor-empty">{t('studio.world.monitor.empty')}</div> : <div className="world-camera-monitor-footer">
          <span data-testid="world-monitor-info">{Math.round(frame.pose.focalLength)}mm · {time.toFixed(2)}s{frame.source.kind === 'shot' && ` · ${t(`studio.world.monitor.${frame.phase}`)} ${frame.localTime.toFixed(2)}s`}</span>
          <div><Button size="small" icon={<CheckOutlined />} disabled={disabled || sourceId === 'program'} onClick={() => onApply(sourceId)}>{t('studio.world.monitor.apply')}</Button><Button size="small" icon={<CameraOutlined />} disabled={disabled} onClick={() => onCapture(sourceId, name(frame.source))}>{t('studio.world.monitor.capture')}</Button></div>
        </div>}
      </section>;
    })}
  </div>;
}
