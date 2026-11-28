// ============================================================================
// Props Panel — Prop lifecycle management with event timeline
// Inspired by PlotPilot's ManuscriptPropsPanel + PropDetailDrawer
// ============================================================================

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Card, Table, Tag, Button, Space, Modal, Form, Input, Select, Typography, Tooltip, Badge, Timeline, Empty, message, Popconfirm,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, EditOutlined, HistoryOutlined,
  ToolOutlined, SwapOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import ContinuityEvidence from './ContinuityEvidence';
import { PropManager, type Prop, type PropCategory, type PropEvent, type LifecycleState } from '@/services/novel/prop-manager';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { panelHeader, statsRow, statItem } from './PanelStyles';

const { TextArea } = Input;
const { Text } = Typography;

interface PropsPanelProps {
  novelId: string;
}

const LIFECYCLE_COLOR: Record<LifecycleState, string> = {
  dormant: 'default',
  introduced: 'blue',
  active: 'green',
  damaged: 'red',
  resolved: 'default',
};

const CATEGORY_COLOR: Record<PropCategory, string> = {
  weapon: 'var(--accent-danger)', artifact: 'var(--accent-primary)', tool: 'var(--accent-info)',
  consumable: 'var(--accent-warning)', token: 'var(--accent-primary)', clothing: 'var(--accent-info)',
  mount: 'var(--accent-success)', other: 'var(--text-secondary)',
};

const CATEGORY_LABEL: Record<PropCategory, string> = {
  weapon: 'weapon', artifact: 'artifact', tool: 'tool',
  consumable: 'consumable', token: 'token', clothing: 'clothing',
  mount: 'mount', other: 'other',
};

const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  dormant: 'dormant',
  introduced: 'introduced',
  active: 'active',
  damaged: 'damaged',
  resolved: 'resolved',
};

const PropsPanel: React.FC<PropsPanelProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [manager] = useState(() => new PropManager(novelId));
  const [repo] = useState(() => new NarrativeRepository(novelId));
  const [bibleCharacters, setBibleCharacters] = useState(() => repo.loadBible().characters ?? []);

  const [props, setProps] = useState<Prop[]>(() => manager.loadAll());
  const [events, setEvents] = useState<PropEvent[]>(() => manager.loadEvents());
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProp, setEditingProp] = useState<Prop | null>(null);
  const [detailProp, setDetailProp] = useState<Prop | null>(null);
  const [form] = Form.useForm();

  const refresh = useCallback(() => {
    setProps(manager.loadAll());
    setEvents(manager.loadEvents());
    setBibleCharacters(repo.loadBible().characters ?? []);
  }, [manager, repo]);
  useEffect(() => repo.subscribe(['bible', 'props', 'prop-events'], refresh), [repo, refresh]);

  const openModal = (prop?: Prop) => {
    if (prop) {
      setEditingProp(prop);
      form.setFieldsValue({
        name: prop.name, description: prop.description,
        aliases: prop.aliases.join(', '),
        category: prop.category,
        holderCharacterId: bibleCharacters.find(c => c.id === prop.holderCharacterId || c.name === prop.holderCharacterId)?.id ?? prop.holderCharacterId,
        lifecycleState: prop.lifecycleState,
        introducedChapter: prop.introducedChapter,
        stateAsOfChapter: prop.stateAsOfChapter,
      });
    } else {
      setEditingProp(null);
      form.resetFields();
      form.setFieldsValue({ category: 'other', lifecycleState: 'dormant' });
    }
    setModalOpen(true);
  };

  const saveProp = async () => {
    let values;
    try { values = await form.validateFields(); } catch { return; }
    const state = {
      lifecycleState: values.lifecycleState as LifecycleState,
      introducedChapter: values.introducedChapter ? Number(values.introducedChapter) : undefined,
      stateAsOfChapter: values.stateAsOfChapter ? Number(values.stateAsOfChapter) : undefined,
    };
    if (editingProp) {
      manager.updateProp(editingProp.id, {
        name: values.name,
        description: values.description,
        aliases: (values.aliases ?? '').split(/[,，、]/).map((s: string) => s.trim()).filter(Boolean),
        category: values.category,
        holderCharacterId: values.holderCharacterId || undefined,
        ...state,
      });
    } else {
      const prop = manager.createProp({
        novelId,
        name: values.name,
        description: values.description,
        aliases: (values.aliases ?? '').split(/[,，、]/).map((s: string) => s.trim()).filter(Boolean),
        category: values.category,
        holderCharacterId: values.holderCharacterId || undefined,
      });
      manager.updateProp(prop.id, state);
    }
    refresh();
    setModalOpen(false);
    message.success(t('common.save'));
  };

  const propEvents = useMemo(() => {
    if (!detailProp) return [];
    return events.filter((e) => e.propId === detailProp.id)
      .sort((a, b) => b.chapterNumber - a.chapterNumber);
  }, [detailProp, events]);

  const categoryOptions = useMemo(() =>
    (Object.entries(CATEGORY_LABEL) as [PropCategory, string][]).map(([k, v]) => ({
      value: k, label: t(`props.category.${v}`),
    })),
  [t]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={panelHeader()}>
        <span><ToolOutlined style={{ marginRight: 6 }} />{t('props.title')}</span>
        <Space>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>
            {t('props.add')}
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
        </Space>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ContinuityEvidence novelId={novelId} kind="prop" />
      {/* Stats */}
      <div style={statsRow}>
        {(['active', 'introduced', 'dormant', 'damaged'] as LifecycleState[]).map(state => (
          <span key={state} style={statItem()}>● {props.filter(p => p.lifecycleState === state).length} {t('props.lifecycle.' + state)}</span>
        ))}
      </div>

      {/* Props table */}
      {props.length === 0 ? (
        <Empty
          description={
            <Space direction="vertical" size={4}>
              <Text type="secondary">{t('props.empty')}</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>{t('props.emptyHint')}</Text>
              <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openModal()}>
                {t('props.add')}
              </Button>
            </Space>
          }
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (
        <Table<Prop>
          dataSource={props}
          rowKey="id"
          size="small"
          pagination={false}
          onRow={(record) => ({
            onClick: () => setDetailProp(record),
            style: { cursor: 'pointer', background: detailProp?.id === record.id ? 'var(--bg-active, rgba(59,130,246,0.08))' : 'transparent' },
          })}
          columns={[
            {
              title: t('props.col.name'), dataIndex: 'name', key: 'name', width: 100,
              render: (v, r) => (
                <Space size={4}>
                  <span style={{ color: CATEGORY_COLOR[r.category], fontSize: 12 }}>●</span>
                  <Text strong style={{ fontSize: 12 }}>{v}</Text>
                </Space>
              ),
            },
            {
              title: t('props.col.category'), dataIndex: 'category', key: 'category', width: 70,
              render: (v: PropCategory) => <Tag style={{ fontSize: 9 }}>{t(`props.category.${v}`)}</Tag>,
            },
            {
              title: t('props.col.status'), dataIndex: 'lifecycleState', key: 'state', width: 70,
              render: (v: LifecycleState) => <Tag color={LIFECYCLE_COLOR[v]} style={{ fontSize: 9 }}>{t(`props.lifecycle.${v}`)}</Tag>,
            },
            {
              title: t('props.col.holder'), dataIndex: 'holderCharacterId', key: 'holder', width: 80,
              render: (v) => v ? <Text style={{ fontSize: 11 }}>{bibleCharacters.find(c => c.id === v)?.name || v}</Text> : <Text type="secondary" style={{ fontSize: 10 }}>{t('props.col.holderNone')}</Text>,
            },
            {
              title: t('props.col.intro'), dataIndex: 'introducedChapter', key: 'intro', width: 50,
              render: (v) => v ? t('novel.chapterOrder', { order: v }) : '-',
            },
            {
              title: '', key: 'actions', width: 80, align: 'center',
              render: (_, r) => (
                <Space size={2}>
                  <Tooltip title={t('common.edit')}><Button type="text" size="small" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); openModal(r); }} /></Tooltip>
                  <Popconfirm title={t('common.confirm')} onConfirm={() => { manager.deleteProp(r.id); refresh(); }}>
                    <Tooltip title={t('common.delete')}><Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} /></Tooltip>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      )}

      {/* Detail: Event Timeline */}
      {detailProp && (
        <Card key={detailProp.id}
          size="small"
          title={<Space><HistoryOutlined /> {t('props.events.title', { name: props.find(p => p.id === detailProp.id)?.name || detailProp.name })}</Space>}
          style={{ marginTop: 4 }}
        >
          {propEvents.length === 0 ? (
            <Text type="secondary" style={{ fontSize: 11 }}>{t('props.events.empty')}</Text>
          ) : (
            <Timeline
              items={propEvents.map((e) => ({
                color: e.eventType === 'damaged' ? 'red' : e.eventType === 'resolved' ? 'gray' : 'blue',
                children: (
                  <div style={{ fontSize: 11 }}>
                    <Space>
                      <Tag style={{ fontSize: 9 }}>{t('novel.chapterOrder', { order: e.chapterNumber })}</Tag>
                      <Tag color={e.eventType === 'damaged' ? 'red' : e.eventType === 'resolved' ? 'default' : 'blue'} style={{ fontSize: 9 }}>
                        {e.eventType}
                      </Tag>
                    </Space>
                    <div style={{ marginTop: 2 }}>{e.description}</div>
                    {e.fromHolderId && e.toHolderId && (
                      <div style={{ color: 'var(--text-tertiary, #999)', fontSize: 10 }}>
                        <SwapOutlined /> {t('props.transfer', { from: e.fromHolderId, to: e.toHolderId })}
                      </div>
                    )}
                  </div>
                ),
              }))}
            />
          )}
        </Card>
      )}

      {/* Add/Edit Modal */}
      <Modal
        title={editingProp ? t('props.edit') : t('props.add')}
        open={modalOpen}
        onOk={saveProp}
        onCancel={() => setModalOpen(false)}
        width={460}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item name="name" label={t('props.nameLabel')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="category" label={t('props.categoryLabel')} style={{ flex: 1 }}>
              <Select options={categoryOptions} />
            </Form.Item>
            <Form.Item name="holderCharacterId" label={t('props.holderLabel')} style={{ flex: 1 }}>
              <Select
                placeholder={t('props.holderPlaceholder')}
                allowClear
                showSearch
                options={bibleCharacters.map((c) => ({ value: c.id, label: c.name }))}
              />
            </Form.Item>
          </div>
          <Form.Item name="description" label={t('props.descriptionLabel')}>
            <TextArea rows={2} />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="lifecycleState" label={t('common.status')} style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={(Object.keys(LIFECYCLE_LABEL) as LifecycleState[]).map(value => ({ value, label: t('props.lifecycle.' + value) }))} />
            </Form.Item>
            <Form.Item name="introducedChapter" label={t('workbench.props.introducedChapter')} style={{ flex: 1 }}>
              <Input type="number" min={1} />
            </Form.Item>
          </div>
          <Form.Item name="stateAsOfChapter" label={t('workbench.props.stateChapter')}
            extra={t('workbench.props.stateChapterHint')} dependencies={['introducedChapter']}
            rules={[({ getFieldValue }) => ({ validator: (_, value) => {
              if (!value || (Number.isInteger(Number(value)) && Number(value) >= Math.max(1, Number(getFieldValue('introducedChapter')) || 1))) {
                return Promise.resolve();
              }
              return Promise.reject(new Error(t('workbench.props.stateChapterInvalid')));
            } })]}>
            <Input type="number" min={1} step={1} />
          </Form.Item>
          <Form.Item name="aliases" label={t('props.aliasesLabel')}>
            <Input placeholder={t('props.aliasesPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>
      </div></div>
    </div>
  );
};

export default PropsPanel;
