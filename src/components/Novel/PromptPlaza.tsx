// ============================================================================
// Prompt Plaza — Prompt template marketplace with categories, search, import/export
// ============================================================================

import React, { useState, useMemo } from 'react';
import {
  Typography, Card, Input, Tag, List, Space, Empty, Button,
  Tabs, message, Tooltip, Badge, Drawer, Form, Select, Modal,
} from 'antd';
import {
  BulbOutlined, SearchOutlined, DownloadOutlined, UploadOutlined,
  PlusOutlined, EditOutlined, DeleteOutlined, CopyOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';

const { Text } = Typography;
const { TextArea } = Input;

interface PromptPlazaProps {
  novelId: string;
}

interface PromptNode {
  id: string;
  name: string;
  category: string;
  description: string;
  template: string;
  tags: string[];
  version: number;
  isBuiltIn: boolean;
  createdAt: string;
}

const STORAGE_KEY = 'mojing-prompt-plaza';

const BUILTIN_PROMPTS: PromptNode[] = [
  {
    id: 'bp-macro-plan',
    name: '宏观规划',
    category: 'planning',
    description: '为下一章生成宏观规划（标题、方向、节奏）',
    template: `你是一位资深小说编辑。请为第{chapter}章生成宏观规划。

当前故事阶段：{phase}
前几章概要：{prevChapters}
活跃伏笔：{foreshadowing}
叙事合同：{contract}

输出JSON：{ "title": "...", "direction": "...", "targetWords": ..., "pacingNote": "..." }`,
    tags: ['规划', '大纲'],
    version: 1,
    isBuiltIn: true,
    createdAt: '2025-01-01',
  },
  {
    id: 'bp-chapter-gen',
    name: '章节生成',
    category: 'generation',
    description: '根据节拍计划生成章节正文',
    template: `你是一位专业小说家。请根据以下信息写一段{words}字左右的正文。

角色声纹锚点：{voiceAnchor}
场景目标：{sceneGoal}
节拍描述：{beatDesc}
文风要求：{styleConstraint}

要求：紧扣节拍目标，自然推进剧情，保持角色性格一致。`,
    tags: ['生成', '正文'],
    version: 1,
    isBuiltIn: true,
    createdAt: '2025-01-01',
  },
  {
    id: 'bp-tension-score',
    name: '张力评分',
    category: 'analysis',
    description: '评估章节的五个维度张力',
    template: `请评估以下章节内容的张力水平（0-10分）。

评估维度：
1. 情节张力（plot）：情节推进的紧张程度
2. 角色张力（character）：角色间的冲突和矛盾
3. 情感张力（emotional）：读者情感起伏
4. 悬念张力（mystery）：未解之谜的吸引力
5. 动作张力（action）：动作场面的紧张感

输出JSON：{ "plot": N, "character": N, "emotional": N, "mystery": N, "action": N }

章节内容：
{content}`,
    tags: ['分析', '张力'],
    version: 1,
    isBuiltIn: true,
    createdAt: '2025-01-01',
  },
  {
    id: 'bp-foreshadow-detect',
    name: '伏笔检测',
    category: 'analysis',
    description: '从章节内容中检测已埋设和已闭合的伏笔',
    template: `请分析以下章节内容，识别其中的伏笔元素。

已知伏笔列表：{existingForeshadowing}

请输出JSON：
{
  "planted": [{ "description": "...", "relatedCharacters": [...], "urgency": "low|medium|high|critical" }],
  "resolved": [{ "description": "..." }],
  "detected": [{ "description": "...", "confidence": 0.0-1.0 }]
}`,
    tags: ['分析', '伏笔'],
    version: 1,
    isBuiltIn: true,
    createdAt: '2025-01-01',
  },
  {
    id: 'bp-dialogue',
    name: '对话生成',
    category: 'generation',
    description: '基于角色心理档案生成符合性格的对话',
    template: `你是角色"{characterName}"。
核心信念：{coreBelief}
禁忌：{taboo}
口头禅：{verbalTic}
说话风格：{speechStyle}

场景：{sceneDescription}

请以{characterName}的口吻说出2-5句话。只输出对话内容。`,
    tags: ['生成', '对话'],
    version: 1,
    isBuiltIn: true,
    createdAt: '2025-01-01',
  },
];

const CATEGORIES = [
  { key: 'all', label: '全部' },
  { key: 'planning', label: '规划' },
  { key: 'generation', label: '生成' },
  { key: 'analysis', label: '分析' },
  { key: 'review', label: '审校' },
  { key: 'custom', label: '自定义' },
];

function loadCustomPrompts(): PromptNode[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveCustomPrompts(prompts: PromptNode[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
}

const PromptPlaza: React.FC<PromptPlazaProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [customPrompts, setCustomPrompts] = useState<PromptNode[]>(loadCustomPrompts);
  const [selectedPrompt, setSelectedPrompt] = useState<PromptNode | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<PromptNode | null>(null);
  const [form] = Form.useForm();

  const allPrompts = useMemo(() => [...BUILTIN_PROMPTS, ...customPrompts], [customPrompts]);

  const filtered = useMemo(() => {
    let result = allPrompts;
    if (activeCategory !== 'all') {
      result = result.filter((p) => p.category === activeCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    }
    return result;
  }, [allPrompts, activeCategory, searchQuery]);

  const openEditModal = (prompt?: PromptNode) => {
    if (prompt && !prompt.isBuiltIn) {
      setEditingPrompt(prompt);
      form.setFieldsValue({
        name: prompt.name,
        category: prompt.category,
        description: prompt.description,
        template: prompt.template,
        tags: prompt.tags.join(', '),
      });
    } else {
      setEditingPrompt(null);
      form.resetFields();
    }
    setEditModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    const id = editingPrompt?.id ?? `custom-${Date.now()}`;
    const newPrompt: PromptNode = {
      id,
      name: values.name,
      category: values.category,
      description: values.description,
      template: values.template,
      tags: values.tags.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean),
      version: (editingPrompt?.version ?? 0) + 1,
      isBuiltIn: false,
      createdAt: editingPrompt?.createdAt ?? new Date().toISOString(),
    };
    const updated = editingPrompt
      ? customPrompts.map((p) => p.id === id ? newPrompt : p)
      : [...customPrompts, newPrompt];
    setCustomPrompts(updated);
    saveCustomPrompts(updated);
    setEditModalOpen(false);
    message.success(t('common.saved'));
  };

  const handleDelete = (id: string) => {
    const updated = customPrompts.filter((p) => p.id !== id);
    setCustomPrompts(updated);
    saveCustomPrompts(updated);
    if (selectedPrompt?.id === id) setSelectedPrompt(null);
  };

  const handleCopy = (template: string) => {
    navigator.clipboard.writeText(template);
    message.success(t('common.copiedToClipboard'));
  };

  const handleExport = () => {
    const json = JSON.stringify(customPrompts, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mojing-prompts.json';
    a.click();
    URL.revokeObjectURL(url);
    message.success(t('promptPlaza.exported'));
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const imported = JSON.parse(ev.target?.result as string) as PromptNode[];
          const merged = [...customPrompts];
          for (const p of imported) {
            if (!merged.some((m) => m.id === p.id)) {
              merged.push({ ...p, isBuiltIn: false });
            }
          }
          setCustomPrompts(merged);
          saveCustomPrompts(merged);
          message.success(t('promptPlaza.imported', { count: imported.length }));
        } catch {
          message.error(t('promptPlaza.importFailed'));
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const categoryColor: Record<string, string> = {
    planning: 'blue',
    generation: 'green',
    analysis: 'orange',
    review: 'purple',
    custom: 'cyan',
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><BulbOutlined style={{ marginRight: 6 }} />{t('promptPlaza.title')}</span>
        <Space>
          <Badge count={filtered.length} style={{ backgroundColor: '#3b82f6' }} />
          <Button size="small" icon={<UploadOutlined />} onClick={handleImport}>{t('common.import')}</Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={handleExport}>{t('common.export')}</Button>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openEditModal()}>
            {t('promptPlaza.add')}
          </Button>
        </Space>
      </div>

      {/* Search + Category tabs */}
      <div style={{ padding: '8px 12px 0' }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('promptPlaza.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          allowClear
          size="small"
          style={{ marginBottom: 8 }}
        />
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {CATEGORIES.map((cat) => (
            <Tag
              key={cat.key}
              color={activeCategory === cat.key ? 'blue' : 'default'}
              style={{ cursor: 'pointer', fontSize: 10 }}
              onClick={() => setActiveCategory(cat.key)}
            >
              {cat.label}
            </Tag>
          ))}
        </div>
      </div>

      {/* Prompt list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
        {filtered.length === 0 ? (
          <Empty description={t('promptPlaza.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <List
            size="small"
            dataSource={filtered}
            renderItem={(prompt) => (
              <List.Item
                style={{
                  padding: '6px 8px', cursor: 'pointer',
                  background: selectedPrompt?.id === prompt.id ? 'rgba(59,130,246,0.06)' : 'transparent',
                  borderRadius: 4,
                }}
                onClick={() => setSelectedPrompt(prompt)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                  <Tag color={categoryColor[prompt.category] ?? 'default'} style={{ fontSize: 9, minWidth: 40 }}>
                    {prompt.category}
                  </Tag>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{prompt.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                      {prompt.description.slice(0, 50)}{prompt.description.length > 50 ? '...' : ''}
                    </div>
                  </div>
                  <Space size={2}>
                    {prompt.isBuiltIn && <Tag style={{ fontSize: 8 }}>built-in</Tag>}
                    <Tag style={{ fontSize: 8 }}>v{prompt.version}</Tag>
                    <Tooltip title={t('common.copy')}>
                      <Button type="text" size="small" icon={<CopyOutlined />}
                        onClick={(e) => { e.stopPropagation(); handleCopy(prompt.template); }} />
                    </Tooltip>
                    {!prompt.isBuiltIn && (
                      <>
                        <Tooltip title={t('common.edit')}>
                          <Button type="text" size="small" icon={<EditOutlined />}
                            onClick={(e) => { e.stopPropagation(); openEditModal(prompt); }} />
                        </Tooltip>
                        <Tooltip title={t('common.delete')}>
                          <Button type="text" size="small" danger icon={<DeleteOutlined />}
                            onClick={(e) => { e.stopPropagation(); handleDelete(prompt.id); }} />
                        </Tooltip>
                      </>
                    )}
                  </Space>
                </div>
              </List.Item>
            )}
          />
        )}
      </div>

      {/* Detail drawer */}
      <Drawer
        title={selectedPrompt?.name ?? ''}
        open={!!selectedPrompt}
        onClose={() => setSelectedPrompt(null)}
        width={400}
      >
        {selectedPrompt && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <Tag color={categoryColor[selectedPrompt.category]}>{selectedPrompt.category}</Tag>
              <Tag>v{selectedPrompt.version}</Tag>
              {selectedPrompt.isBuiltIn && <Tag color="gold">Built-in</Tag>}
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 11 }}>{selectedPrompt.description}</Text>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {selectedPrompt.tags.map((tag) => (
                <Tag key={tag} style={{ fontSize: 9 }}>{tag}</Tag>
              ))}
            </div>
            <Card size="small" title={t('promptPlaza.template')} style={{ background: 'var(--bg-secondary)' }}>
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0, lineHeight: 1.6 }}>
                {selectedPrompt.template}
              </pre>
            </Card>
            <Button icon={<CopyOutlined />} onClick={() => handleCopy(selectedPrompt.template)} block>
              {t('promptPlaza.copyTemplate')}
            </Button>
          </div>
        )}
      </Drawer>

      {/* Edit modal */}
      <Modal
        title={editingPrompt ? t('promptPlaza.edit') : t('promptPlaza.add')}
        open={editModalOpen}
        onOk={handleSave}
        onCancel={() => setEditModalOpen(false)}
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item name="name" label={t('promptPlaza.name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="category" label={t('promptPlaza.category')} style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={CATEGORIES.filter((c) => c.key !== 'all').map((c) => ({ value: c.key, label: c.label }))} />
            </Form.Item>
            <Form.Item name="tags" label={t('promptPlaza.tags')} style={{ flex: 1 }}>
              <Input placeholder={t('promptPlaza.tagsPlaceholder')} />
            </Form.Item>
          </div>
          <Form.Item name="description" label={t('common.description')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="template" label={t('promptPlaza.template')} rules={[{ required: true }]}>
            <TextArea rows={8} style={{ fontFamily: 'monospace', fontSize: 11 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default PromptPlaza;
