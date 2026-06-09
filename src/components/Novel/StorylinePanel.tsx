// ============================================================================
// Storyline Panel — Manage main/sub/hidden storylines with git-style graph
// ============================================================================

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Button, Card, Empty, Form, Input, Modal, Select, Space, Tag, Popconfirm,
  message, Tabs, Badge, Progress,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, EditOutlined,
  BranchesOutlined, UnorderedListOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import type { Storyline, StorylineType, StorylineStatus, StorylineMilestone } from '@/types/narrative';

interface StorylinePanelProps {
  novelId: string;
  totalChapters: number;
}

const LINE_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e'];

const typeColor: Record<StorylineType, string> = { main: 'red', sub: 'blue', hidden: 'default' };
const statusColor: Record<StorylineStatus, string> = { active: 'green', paused: 'orange', completed: 'default' };

const StorylinePanel: React.FC<StorylinePanelProps> = ({ novelId, totalChapters }) => {
  const { t } = useTranslation();
  const [repo] = useState(() => new NarrativeRepository(novelId));

  const [lines, setLines] = useState<Storyline[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Storyline | null>(null);
  const [form] = Form.useForm();

  const refresh = useCallback(() => {
    setLines(repo.loadStorylines());
  }, [repo]);

  useEffect(() => { refresh(); }, [refresh]);

  const openModal = (line?: Storyline) => {
    if (line) {
      setEditing(line);
      form.setFieldsValue({
        name: line.name,
        type: line.type,
        status: line.status,
        description: line.description,
        chapterStart: line.chapterRange[0],
        chapterEnd: line.chapterRange[1],
      });
    } else {
      setEditing(null);
      form.resetFields();
    }
    setModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    const id = editing?.id ?? `sl_${Date.now()}`;
    const milestones = editing?.milestones ?? [];

    const line: Storyline = {
      id,
      novelId,
      name: values.name,
      type: values.type,
      status: values.status,
      description: values.description,
      chapterRange: [values.chapterStart, values.chapterEnd],
      milestones,
      color: editing?.color ?? LINE_COLORS[lines.length % LINE_COLORS.length],
    };

    repo.upsertStoryline(line);
    refresh();
    setModalOpen(false);
    message.success(t('common.saved'));
  };

  const handleDelete = (id: string) => {
    repo.deleteStoryline(id);
    refresh();
  };

  // SVG Git-style graph
  const graphSvg = useMemo(() => {
    if (lines.length === 0) return null;
    const maxCh = Math.max(totalChapters, ...lines.map((l) => l.chapterRange[1]), 10);
    const width = Math.max(600, maxCh * 40);
    const rowH = 36;
    const headerH = 20;
    const svgH = headerH + lines.length * rowH + 10;

    const chapterMarkers = Array.from({ length: maxCh }, (_, i) => (
      <g key={`ch${i}`}>
        <text x={60 + i * 40} y={14} fontSize={9} fill="var(--text-secondary)" textAnchor="middle">
          {i + 1}
        </text>
        <line x1={60 + i * 40} y1={headerH} x2={60 + i * 40} y2={svgH} stroke="var(--border-secondary)" strokeWidth={0.5} />
      </g>
    ));

    const lineTracks = lines.map((line, idx) => {
      const y = headerH + idx * rowH + rowH / 2;
      const x1 = 60 + (line.chapterRange[0]) * 40;
      const x2 = 60 + (line.chapterRange[1]) * 40;
      const milestones = line.milestones.map((m) => (
        <circle
          key={m.chapter}
          cx={60 + m.chapter * 40}
          cy={y}
          r={5}
          fill={m.completed ? line.color : '#fff'}
          stroke={line.color}
          strokeWidth={2}
        />
      ));

      return (
        <g key={line.id}>
          <text x={4} y={y + 4} fontSize={10} fill={line.color} fontWeight={500}>{line.name}</text>
          <line x1={x1} y1={y} x2={x2} y2={y} stroke={line.color} strokeWidth={3} strokeLinecap="round" />
          {milestones}
          <circle cx={x1} cy={y} r={3} fill={line.color} />
          {line.status === 'completed' && (
            <text x={x2 + 6} y={y + 4} fontSize={9} fill={line.color}>✓</text>
          )}
        </g>
      );
    });

    return (
      <svg width={width} height={svgH} style={{ minWidth: '100%' }}>
        {chapterMarkers}
        {lineTracks}
      </svg>
    );
  }, [lines, totalChapters]);

  const listTab = (
    <div>
      <div style={{ marginBottom: 8 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()} size="small">
          {t('storyline.add')}
        </Button>
      </div>
      {lines.length === 0 ? (
        <Empty description={t('storyline.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {lines.map((line) => {
            const progress = line.chapterRange[1] > line.chapterRange[0]
              ? Math.round(((totalChapters - line.chapterRange[0]) / (line.chapterRange[1] - line.chapterRange[0])) * 100)
              : 0;
            return (
              <Card
                key={line.id}
                size="small"
                style={{ borderLeft: `3px solid ${line.color}`, background: 'var(--bg-secondary, rgba(0,0,0,0.02))' }}
                title={
                  <Space>
                    <span style={{ fontWeight: 600 }}>{line.name}</span>
                    <Tag color={typeColor[line.type]} style={{ fontSize: 10 }}>
                      {t(`storyline.type.${line.type}`)}
                    </Tag>
                    <Tag color={statusColor[line.status]} style={{ fontSize: 10 }}>
                      {t(`storyline.status.${line.status}`)}
                    </Tag>
                  </Space>
                }
                extra={
                  <Space size={4}>
                    <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openModal(line)} />
                    <Popconfirm title={t('common.confirm')} onConfirm={() => handleDelete(line.id)}>
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                }
              >
                {line.description && <p style={{ margin: '0 0 4px', fontSize: 12 }}>{line.description}</p>}
                <Space size={8}>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    Ch.{line.chapterRange[0] + 1} → Ch.{line.chapterRange[1] + 1}
                  </span>
                  {line.milestones.length > 0 && (
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {line.milestones.filter((m) => m.completed).length}/{line.milestones.length} {t('storyline.milestones').toLowerCase()}
                    </span>
                  )}
                </Space>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );

  const graphTab = lines.length === 0 ? (
    <Empty description={t('storyline.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
  ) : (
    <div style={{ overflow: 'auto' }}>{graphSvg}</div>
  );

  const tabItems = [
    { key: 'list', label: <span><UnorderedListOutlined /> {t('storyline.listView')}</span>, children: listTab },
    { key: 'graph', label: <span><BranchesOutlined /> {t('storyline.graphView')}</span>, children: graphTab },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '4px 12px', fontWeight: 600, fontSize: 13, borderBottom: '1px solid var(--border-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span><BranchesOutlined style={{ marginRight: 6 }} />{t('storyline.title')} ({lines.length})</span>
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 8px' }}>
        <Tabs items={tabItems} size="small" />
      </div>

      <Modal
        title={editing ? t('storyline.edit') : t('storyline.add')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        width={480}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item name="name" label={t('storyline.name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="type" label={t('storyline.typeLabel')} style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={[
                { value: 'main', label: t('storyline.type.main') },
                { value: 'sub', label: t('storyline.type.sub') },
                { value: 'hidden', label: t('storyline.type.hidden') },
              ]} />
            </Form.Item>
            <Form.Item name="status" label={t('common.status')} style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={[
                { value: 'active', label: t('storyline.status.active') },
                { value: 'paused', label: t('storyline.status.paused') },
                { value: 'completed', label: t('storyline.status.completed') },
              ]} />
            </Form.Item>
          </div>
          <Form.Item name="description" label={t('common.description')}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="chapterStart" label={t('storyline.chapterStart')} style={{ flex: 1 }} rules={[{ required: true }]}>
              <Input type="number" min={0} />
            </Form.Item>
            <Form.Item name="chapterEnd" label={t('storyline.chapterEnd')} style={{ flex: 1 }} rules={[{ required: true }]}>
              <Input type="number" min={0} />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </div>
  );
};

export default StorylinePanel;
