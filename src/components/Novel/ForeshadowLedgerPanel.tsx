// ============================================================================
// Foreshadow Ledger Panel — Full CRUD with status filtering
// Inspired by PlotPilot's ForeshadowLedgerPanel.vue
// ============================================================================

import React, { useState, useMemo, useCallback } from 'react';
import { Tag, Button, Space, Modal, Form, Input, Select, List, Typography, Tooltip, Empty, message } from 'antd';
import {
  PlusOutlined, DeleteOutlined, EditOutlined, CheckCircleOutlined,
  ExclamationCircleOutlined, PushpinOutlined, AimOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { panelHeader, statsRow, statItem } from './PanelStyles';
import type { Foreshadowing, ForeshadowingStatus } from '@/types/narrative';

const { TextArea } = Input;
const { Text } = Typography;

interface ForeshadowLedgerPanelProps {
  novelId: string;
}

type FilterStatus = 'all' | 'planted' | 'resolved' | 'abandoned';

const URGENCY_COLOR: Record<string, string> = {
  critical: '#ef4444',
  high: '#f59e0b',
  medium: '#3b82f6',
  low: '#6b7280',
};

const ForeshadowLedgerPanel: React.FC<ForeshadowLedgerPanelProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [repo] = useState(() => new NarrativeRepository(novelId));

  const [items, setItems] = useState<Foreshadowing[]>(() => repo.loadForeshadowing());
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Foreshadowing | null>(null);
  const [form] = Form.useForm();

  const STATUS_TAG = useMemo<Record<ForeshadowingStatus, { color: string; label: string }>>(() => ({
    planted: { color: 'blue', label: t('foreshadow.status.planted') },
    resolved: { color: 'green', label: t('foreshadow.status.resolved') },
    abandoned: { color: 'default', label: t('foreshadow.status.abandoned') },
  }), [t]);

  const refresh = useCallback(() => setItems(repo.loadForeshadowing()), [repo]);

  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    return items.filter((f) => f.status === filter);
  }, [items, filter]);

  const stats = useMemo(() => {
    // Estimate current chapter from foreshadowing data
    const allChapters = items.map((f) => Math.max(f.plantedInChapter, f.resolvedInChapter ?? 0));
    const currentChapter = allChapters.length > 0 ? Math.max(...allChapters) : 0;
    return {
      total: items.length,
      planted: items.filter((f) => f.status === 'planted').length,
      resolved: items.filter((f) => f.status === 'resolved').length,
      abandoned: items.filter((f) => f.status === 'abandoned').length,
      overdue: items.filter((f) =>
        f.status === 'planted' && f.suggestedResolveChapter !== undefined && f.suggestedResolveChapter <= currentChapter,
      ).length,
    };
  }, [items]);

  const openModal = (item?: Foreshadowing) => {
    if (item) {
      setEditingItem(item);
      form.setFieldsValue({
        description: item.description,
        urgency: item.urgency,
        suggestedResolveChapter: item.suggestedResolveChapter,
        relatedCharacters: item.relatedCharacters.join(', '),
        narrativeWeight: item.narrativeWeight,
      });
    } else {
      setEditingItem(null);
      form.resetFields();
    }
    setModalOpen(true);
  };

  const saveItem = async () => {
    const values = await form.validateFields();
    const id = editingItem?.id ?? `fs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const item: Foreshadowing = {
      id,
      novelId,
      description: values.description,
      plantedInChapter: editingItem?.plantedInChapter ?? 0,
      suggestedResolveChapter: values.suggestedResolveChapter || undefined,
      resolvedInChapter: editingItem?.resolvedInChapter,
      status: editingItem?.status ?? 'planted',
      relatedCharacters: (values.relatedCharacters ?? '').split(/[,，、]/).map((s: string) => s.trim()).filter(Boolean),
      urgency: values.urgency,
      narrativeWeight: values.narrativeWeight ?? 5,
    };

    const all = repo.loadForeshadowing();
    const idx = all.findIndex((f) => f.id === id);
    if (idx >= 0) { all[idx] = item; } else { all.push(item); }
    repo.saveForeshadowing(all);
    refresh();
    setModalOpen(false);
    message.success(t('common.save'));
  };

  const markResolved = (itemId: string) => {
    const all = repo.loadForeshadowing();
    const item = all.find((f) => f.id === itemId);
    if (item) {
      item.status = 'resolved';
      item.resolvedInChapter = item.resolvedInChapter ?? 0;
      repo.saveForeshadowing(all);
      refresh();
      message.success(t('foreshadow.resolvedMsg'));
    }
  };

  const markAbandoned = (itemId: string) => {
    const all = repo.loadForeshadowing();
    const item = all.find((f) => f.id === itemId);
    if (item) {
      item.status = 'abandoned';
      repo.saveForeshadowing(all);
      refresh();
    }
  };

  const deleteItem = (itemId: string) => {
    const all = repo.loadForeshadowing().filter((f) => f.id !== itemId);
    repo.saveForeshadowing(all);
    refresh();
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={panelHeader()}>
        <span><AimOutlined style={{ marginRight: 6 }} />{t('foreshadow.title')}</span>
        <Space>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
            {t('foreshadow.add')}
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
        </Space>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Stats row */}
      <div style={statsRow}>
        <span style={statItem('#3b82f6')}>● {stats.planted} {t('foreshadow.status.planted')}</span>
        <span style={statItem('#22c55e')}>● {stats.resolved} {t('foreshadow.status.resolved')}</span>
        <span style={statItem('#9ca3af')}>● {stats.abandoned} {t('foreshadow.status.abandoned')}</span>
        <span style={{ ...statItem(), marginLeft: 'auto', fontWeight: 600 }}>{t('foreshadow.total', { count: stats.total })}</span>
      </div>

      {/* Filter strip */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {(['all', 'planted', 'resolved', 'abandoned'] as FilterStatus[]).map((s) => (
          <Button
            key={s}
            size="small"
            type={filter === s ? 'primary' : 'default'}
            onClick={() => setFilter(s)}
          >
            {s === 'all' ? t('foreshadow.status.all') : STATUS_TAG[s]?.label ?? s}
          </Button>
        ))}
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <Empty
          description={
            <Space direction="vertical" size={4}>
              <Text type="secondary">{t('foreshadow.empty')}</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>{t('foreshadow.emptyHint')}</Text>
              <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openModal()}>
                {t('foreshadow.add')}
              </Button>
            </Space>
          }
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (
        <List
          size="small"
          dataSource={filtered}
          renderItem={(item) => (
            <List.Item
              style={{
                padding: '8px 10px',
                borderLeft: `3px solid ${URGENCY_COLOR[item.urgency]}`,
                background: item.status === 'resolved' ? 'rgba(34,197,94,0.04)' : 'transparent',
              }}
              actions={[
                item.status === 'planted' && (
                  <Tooltip title={t('foreshadow.markResolved')} key="resolve">
                    <Button type="text" size="small" icon={<CheckCircleOutlined />} onClick={() => markResolved(item.id)} />
                  </Tooltip>
                ),
                <Tooltip title={t('common.edit')} key="edit">
                  <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openModal(item)} />
                </Tooltip>,
                <Tooltip title={t('foreshadow.markAbandoned')} key="abandon">
                  <Button type="text" size="small" onClick={() => markAbandoned(item.id)}>
                    <PushpinOutlined />
                  </Button>
                </Tooltip>,
                <Tooltip title={t('common.delete')} key="del">
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => deleteItem(item.id)} />
                </Tooltip>,
              ].filter(Boolean)}
            >
              <List.Item.Meta
                title={
                  <Space size={4}>
                    <Text style={{ fontSize: 12, fontWeight: 500 }}>{item.description}</Text>
                    <Tag color={STATUS_TAG[item.status].color} style={{ fontSize: 9, lineHeight: '16px' }}>
                      {STATUS_TAG[item.status].label}
                    </Tag>
                    <Tag color={URGENCY_COLOR[item.urgency]} style={{ fontSize: 9, lineHeight: '16px' }}>
                      {item.urgency}
                    </Tag>
                  </Space>
                }
                description={
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary, #999)' }}>
                    {t('foreshadow.plantedIn', { chapter: item.plantedInChapter })}
                    {item.suggestedResolveChapter && ` ${t('foreshadow.suggestResolve', { chapter: item.suggestedResolveChapter })}`}
                    {item.resolvedInChapter && ` ${t('foreshadow.resolvedAt', { chapter: item.resolvedInChapter })}`}
                    {item.relatedCharacters.length > 0 && ` ${t('foreshadow.relatedTo', { chars: item.relatedCharacters.join(', ') })}`}
                    {` ${t('foreshadow.weightLabel', { weight: item.narrativeWeight })}`}
                  </div>
                }
              />
            </List.Item>
          )}
        />
      )}

      {/* Add/Edit Modal */}
      <Modal
        title={editingItem ? t('foreshadow.edit') : t('foreshadow.add')}
        open={modalOpen}
        onOk={saveItem}
        onCancel={() => setModalOpen(false)}
        width={480}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item name="description" label={t('foreshadow.description')} rules={[{ required: true, message: t('foreshadow.descriptionRequired') }]}>
            <TextArea rows={2} placeholder={t('foreshadow.descriptionPlaceholder')} />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="urgency" label={t('foreshadow.urgency')} style={{ flex: 1 }}>
              <Select options={[
                { value: 'low', label: t('foreshadow.urgency.low') },
                { value: 'medium', label: t('foreshadow.urgency.medium') },
                { value: 'high', label: t('foreshadow.urgency.high') },
                { value: 'critical', label: t('foreshadow.urgency.critical') },
              ]} />
            </Form.Item>
            <Form.Item name="narrativeWeight" label={t('foreshadow.weight')} style={{ flex: 1 }}>
              <Input type="number" min={0} max={10} />
            </Form.Item>
          </div>
          <Form.Item name="suggestedResolveChapter" label={t('foreshadow.suggestChapter')}>
            <Input type="number" placeholder={t('foreshadow.suggestChapterPlaceholder')} />
          </Form.Item>
          <Form.Item name="relatedCharacters" label={t('foreshadow.relatedChars')}>
            <Input placeholder="..." />
          </Form.Item>
        </Form>
      </Modal>
      </div></div>
    </div>
  );
};

export default ForeshadowLedgerPanel;
