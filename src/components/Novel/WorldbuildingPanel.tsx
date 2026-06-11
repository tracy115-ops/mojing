// ============================================================================
// Worldbuilding Panel — 5-dimension structured world editor
// Dimensions: Core Rules, Geography, Society, Culture, Daily Life
// ============================================================================

import React, { useState, useCallback, useEffect } from 'react';
import { Collapse, Input, Button, Space, Tag, Progress, message, Typography } from 'antd';
import {
  ThunderboltOutlined, GlobalOutlined, TeamOutlined, ReloadOutlined,
  ReadOutlined, CoffeeOutlined, SaveOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import type { Worldbuilding, WorldbuildingDimension } from '@/types/narrative';

const { TextArea } = Input;

interface WorldbuildingPanelProps {
  novelId: string;
}

type DimensionKey = keyof Worldbuilding['dimensions'];

const DIMENSION_META: { key: DimensionKey; icon: React.ReactNode; fields: string[] }[] = [
  {
    key: 'coreRules',
    icon: <ThunderboltOutlined />,
    fields: ['powerSystem', 'coreLaws', 'limitations', 'costs'],
  },
  {
    key: 'geography',
    icon: <GlobalOutlined />,
    fields: ['regions', 'landmarks', 'climate', 'ecology'],
  },
  {
    key: 'society',
    icon: <TeamOutlined />,
    fields: ['socialStructure', 'factions', 'powerDynamics', 'taboos'],
  },
  {
    key: 'culture',
    icon: <ReadOutlined />,
    fields: ['history', 'beliefs', 'customs', 'arts'],
  },
  {
    key: 'dailyLife',
    icon: <CoffeeOutlined />,
    fields: ['economy', 'food', 'transport', 'entertainment'],
  },
];

const WorldbuildingPanel: React.FC<WorldbuildingPanelProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(v => v + 1), []);
  useEffect(() => { const i = setInterval(refresh, 10000); return () => clearInterval(i); }, [refresh]);

  const [repo] = useState(() => new NarrativeRepository(novelId));

  const [wb, setWb] = useState<Worldbuilding>(() => repo.loadWorldbuilding());
  const [dirty, setDirty] = useState(false);

  // Reload data on tick (skip if user has unsaved edits)
  useEffect(() => {
    if (dirty) return;
    const fresh = repo.loadWorldbuilding();
    setWb(fresh);
  }, [tick, repo, dirty]);

  const handleSave = useCallback(() => {
    repo.saveWorldbuilding(wb);
    setDirty(false);
    message.success(t('common.saved'));
  }, [repo, wb, t]);

  // Ctrl+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (dirty) handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dirty, handleSave]);

  const updateField = (dimKey: DimensionKey, field: string, value: string) => {
    setWb((prev) => ({
      ...prev,
      dimensions: {
        ...prev.dimensions,
        [dimKey]: {
          ...prev.dimensions[dimKey],
          fields: { ...prev.dimensions[dimKey].fields, [field]: value },
        },
      },
    }));
    setDirty(true);
  };

  const filledCount = DIMENSION_META.reduce((acc, dim) => {
    const fields = wb.dimensions[dim.key].fields;
    const hasContent = Object.values(fields).some((v) => v.trim());
    return acc + (hasContent ? 1 : 0);
  }, 0);

  const items = DIMENSION_META.map((dim) => {
    const fields = wb.dimensions[dim.key].fields;
    const fieldFilled = Object.values(fields).filter((v) => v.trim()).length;

    return {
      key: dim.key,
      label: (
        <Space>
          {dim.icon}
          <span style={{ fontWeight: 500 }}>{t(`worldbuilding.dim.${dim.key}`)}</span>
          <Tag style={{ fontSize: 10 }}>{fieldFilled}/{dim.fields.length}</Tag>
        </Space>
      ),
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {dim.fields.map((field) => (
            <div key={field}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 2 }}>
                {t(`worldbuilding.field.${dim.key}.${field}`)}
              </div>
              <TextArea
                rows={2}
                value={fields[field] ?? ''}
                onChange={(e) => updateField(dim.key, field, e.target.value)}
                placeholder={t(`worldbuilding.field.${dim.key}.${field}Placeholder`)}
                style={{ fontSize: 12 }}
              />
            </div>
          ))}
        </div>
      ),
    };
  });

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><GlobalOutlined style={{ marginRight: 6 }} />{t('worldbuilding.title')}</span>
        <Space>
          <Progress
            type="circle" size={24} percent={(filledCount / 5) * 100}
            format={() => `${filledCount}/5`}
            style={{ marginRight: 4 }}
          />
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={refresh} />
          <Button
            type="primary" size="small" icon={<SaveOutlined />}
            disabled={!dirty} onClick={handleSave}
          >
            {t('common.save')}
          </Button>
        </Space>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        <Collapse items={items} size="small" defaultActiveKey={['coreRules']} />
      </div>
    </div>
  );
};

export default WorldbuildingPanel;
