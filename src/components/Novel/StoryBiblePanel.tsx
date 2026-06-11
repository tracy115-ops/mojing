// ============================================================================
// Story Bible Panel — Character, Location, World Setting CRUD
// ============================================================================

import React, { useState, useCallback, useEffect } from 'react';
import {
  Tabs, Table, Button, Modal, Form, Input, Select, Tag, Space,
  message, Popconfirm, Empty, Card, Descriptions, Tooltip, Badge, Typography,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, EditOutlined,
  UserOutlined, EnvironmentOutlined, GlobalOutlined,
  BulbOutlined, BookOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { panelHeader } from './PanelStyles';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import type {
  BibleCharacter,
  BibleLocation,
  BibleWorldSetting,
  BibleStyleNote,
  CharacterRelationship,
} from '@/types/narrative';

const { TextArea } = Input;

// --- Props ---

interface StoryBiblePanelProps {
  novelId: string;
}

// --- Character Form ---

interface CharacterFormValues {
  name: string;
  aliases: string;
  description: string;
  appearance: string;
  personality: string;
  backstory: string;
  importance: BibleCharacter['importance'];
  status: BibleCharacter['status'];
  coreBelief: string;
  taboo: string;
  voiceTag: string;
  wound: string;
  verbalTic: string;
  mentalState: string;
  idleBehavior: string;
  speechStyle: string;
}

// --- Location Form ---

interface LocationFormValues {
  name: string;
  description: string;
  parentLocation: string;
  significance: string;
}

// --- World Setting Form ---

interface WorldSettingFormValues {
  category: string;
  name: string;
  description: string;
  constraints: string;
}

// --- Component ---

const StoryBiblePanel: React.FC<StoryBiblePanelProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [repo] = useState(() => new NarrativeRepository(novelId));

  // Data
  const [characters, setCharacters] = useState<BibleCharacter[]>([]);
  const [locations, setLocations] = useState<BibleLocation[]>([]);
  const [worldSettings, setWorldSettings] = useState<BibleWorldSetting[]>([]);

  // Modal states
  const [charModalOpen, setCharModalOpen] = useState(false);
  const [editingChar, setEditingChar] = useState<BibleCharacter | null>(null);
  const [locModalOpen, setLocModalOpen] = useState(false);
  const [editingLoc, setEditingLoc] = useState<BibleLocation | null>(null);
  const [wsModalOpen, setWsModalOpen] = useState(false);
  const [editingWs, setEditingWs] = useState<BibleWorldSetting | null>(null);

  // Form instances
  const [charForm] = Form.useForm<CharacterFormValues>();
  const [locForm] = Form.useForm<LocationFormValues>();
  const [wsForm] = Form.useForm<WorldSettingFormValues>();

  // Load data
  const refresh = useCallback(() => {
    const bible = repo.loadBible();
    setCharacters(bible.characters);
    setLocations(bible.locations);
    setWorldSettings(bible.worldSettings);
  }, [repo]);

  useEffect(() => { refresh(); }, [refresh]);

  // --- Character CRUD ---

  const openCharModal = (char?: BibleCharacter) => {
    if (char) {
      setEditingChar(char);
      charForm.setFieldsValue({
        name: char.name,
        aliases: char.aliases.join(', '),
        description: char.description,
        appearance: char.appearance,
        personality: char.personality,
        backstory: char.backstory,
        importance: char.importance,
        status: char.status,
        coreBelief: char.psyche?.coreBelief ?? '',
        taboo: char.psyche?.taboo ?? '',
        voiceTag: char.psyche?.voiceTag ?? '',
        wound: char.psyche?.wound ?? '',
        verbalTic: char.voiceAnchor?.verbalTic ?? '',
        mentalState: char.voiceAnchor?.mentalState ?? '',
        idleBehavior: char.voiceAnchor?.idleBehavior ?? '',
        speechStyle: char.voiceAnchor?.speechStyle ?? '',
      });
    } else {
      setEditingChar(null);
      charForm.resetFields();
    }
    setCharModalOpen(true);
  };

  const saveCharacter = async () => {
    const values = await charForm.validateFields();
    const id = editingChar?.id ?? `char_${Date.now()}`;

    const char: BibleCharacter = {
      id,
      name: values.name,
      aliases: values.aliases.split(/[,，、]/).map((s: string) => s.trim()).filter(Boolean),
      description: values.description,
      appearance: values.appearance,
      personality: values.personality,
      backstory: values.backstory,
      relationships: editingChar?.relationships ?? [],
      currentState: editingChar?.currentState ?? '',
      firstAppearChapter: editingChar?.firstAppearChapter ?? 0,
      lastUpdateChapter: editingChar?.lastUpdateChapter ?? 0,
      importance: values.importance,
      status: values.status,
      psyche: (values.coreBelief || values.taboo || values.voiceTag || values.wound) ? {
        coreBelief: values.coreBelief,
        taboo: values.taboo,
        voiceTag: values.voiceTag,
        wound: values.wound,
      } : undefined,
      voiceAnchor: (values.verbalTic || values.mentalState || values.idleBehavior || values.speechStyle) ? {
        verbalTic: values.verbalTic,
        mentalState: values.mentalState,
        idleBehavior: values.idleBehavior,
        speechStyle: values.speechStyle,
      } : undefined,
    };

    repo.upsertCharacter(char);
    refresh();
    setCharModalOpen(false);
    message.success(t('common.saved', { defaultValue: t('common.save') }));
  };

  const deleteCharacter = (id: string) => {
    repo.deleteCharacter(id);
    refresh();
  };

  // --- Location CRUD ---

  const openLocModal = (loc?: BibleLocation) => {
    if (loc) {
      setEditingLoc(loc);
      locForm.setFieldsValue({
        name: loc.name,
        description: loc.description,
        parentLocation: loc.parentLocation ?? '',
        significance: loc.significance,
      });
    } else {
      setEditingLoc(null);
      locForm.resetFields();
    }
    setLocModalOpen(true);
  };

  const saveLocation = async () => {
    const values = await locForm.validateFields();
    const id = editingLoc?.id ?? `loc_${Date.now()}`;

    const loc: BibleLocation = {
      id,
      name: values.name,
      description: values.description,
      parentLocation: values.parentLocation || undefined,
      significance: values.significance,
    };

    repo.upsertLocation(loc);
    refresh();
    setLocModalOpen(false);
    message.success(t('common.saved', { defaultValue: t('common.save') }));
  };

  const deleteLocation = (id: string) => {
    repo.deleteLocation(id);
    refresh();
  };

  // --- World Setting CRUD ---

  const openWsModal = (ws?: BibleWorldSetting) => {
    if (ws) {
      setEditingWs(ws);
      wsForm.setFieldsValue({
        category: ws.category,
        name: ws.name,
        description: ws.description,
        constraints: ws.constraints.join('\n'),
      });
    } else {
      setEditingWs(null);
      wsForm.resetFields();
    }
    setWsModalOpen(true);
  };

  const saveWorldSetting = async () => {
    const values = await wsForm.validateFields();
    const id = editingWs?.id ?? `ws_${Date.now()}`;

    const ws: BibleWorldSetting = {
      id,
      category: values.category,
      name: values.name,
      description: values.description,
      constraints: values.constraints.split('\n').filter(Boolean),
    };

    repo.upsertWorldSetting(ws);
    refresh();
    setWsModalOpen(false);
    message.success(t('common.saved', { defaultValue: t('common.save') }));
  };

  const deleteWorldSetting = (id: string) => {
    repo.deleteWorldSetting(id);
    refresh();
  };

  // --- Importance / Status colors ---

  const importanceColor: Record<string, string> = {
    protagonist: 'red',
    major: 'orange',
    supporting: 'blue',
    minor: 'default',
  };

  const statusColor: Record<string, string> = {
    active: 'green',
    deceased: 'red',
    missing: 'orange',
    retired: 'default',
  };

  // --- Tab items ---

  const tabItems = [
    {
      key: 'characters',
      label: (
        <span>
          <UserOutlined /> {t('bible.characters')} ({characters.length})
        </span>
      ),
      children: (
        <div>
          <div style={{ marginBottom: 12 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openCharModal()} size="small">
              {t('bible.addCharacter')}
            </Button>
          </div>

          {characters.length === 0 ? (
            <Empty description={t('bible.addCharacter')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {characters.map((char) => (
                <Card
                  key={char.id}
                  size="small"
                  title={
                    <Space>
                      <span style={{ fontWeight: 600 }}>{char.name}</span>
                      {char.aliases.length > 0 && (
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          ({char.aliases.join(', ')})
                        </Text>
                      )}
                      <Tag color={importanceColor[char.importance]} style={{ fontSize: 10 }}>
                        {t(`bible.importance.${char.importance}`)}
                      </Tag>
                      <Tag color={statusColor[char.status]} style={{ fontSize: 10 }}>
                        {t(`bible.status.${char.status}`)}
                      </Tag>
                    </Space>
                  }
                  extra={
                    <Space size={4}>
                      <Tooltip title={t('common.edit')}>
                        <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openCharModal(char)} />
                      </Tooltip>
                      <Popconfirm title={t('common.confirm')} onConfirm={() => deleteCharacter(char.id)}>
                        <Tooltip title={t('common.delete')}>
                          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                        </Tooltip>
                      </Popconfirm>
                    </Space>
                  }
                  style={{ background: 'var(--bg-secondary, rgba(0,0,0,0.02))' }}
                >
                  <Descriptions size="small" column={1} colon={false}>
                    {char.description && (
                      <Descriptions.Item label={t('common.description')}>{char.description}</Descriptions.Item>
                    )}
                    {char.appearance && (
                      <Descriptions.Item label={t('bible.characterAppearance')}>{char.appearance}</Descriptions.Item>
                    )}
                    {char.personality && (
                      <Descriptions.Item label={t('bible.characterPersonality')}>{char.personality}</Descriptions.Item>
                    )}
                    {char.backstory && (
                      <Descriptions.Item label={t('bible.characterBackstory')}>{char.backstory}</Descriptions.Item>
                    )}
                    {char.psyche && (
                      <>
                        {char.psyche.coreBelief && (
                          <Descriptions.Item label={t('psyche.coreBelief')}>{char.psyche.coreBelief}</Descriptions.Item>
                        )}
                        {char.psyche.taboo && (
                          <Descriptions.Item label={t('psyche.taboo')}>{char.psyche.taboo}</Descriptions.Item>
                        )}
                        {char.psyche.voiceTag && (
                          <Descriptions.Item label={t('psyche.voiceTag')}>{char.psyche.voiceTag}</Descriptions.Item>
                        )}
                        {char.psyche.wound && (
                          <Descriptions.Item label={t('psyche.wound')}>{char.psyche.wound}</Descriptions.Item>
                        )}
                      </>
                    )}
                    {char.voiceAnchor && (char.voiceAnchor.verbalTic || char.voiceAnchor.speechStyle) && (
                      <Descriptions.Item label={t('psyche.voiceAnchor')}>
                        {char.voiceAnchor.verbalTic && <Tag>{char.voiceAnchor.verbalTic}</Tag>}
                        {char.voiceAnchor.speechStyle && <Tag color="blue">{char.voiceAnchor.speechStyle}</Tag>}
                      </Descriptions.Item>
                    )}
                    {char.relationships.length > 0 && (
                      <Descriptions.Item label={t('bible.characterRelationships')}>
                        <Space wrap size={[4, 4]}>
                          {char.relationships.map((r) => (
                            <Tag key={`${r.type}-${r.targetCharacterId}`} style={{ fontSize: 10 }}>
                              {r.type}: {r.targetCharacterId}
                            </Tag>
                          ))}
                        </Space>
                      </Descriptions.Item>
                    )}
                  </Descriptions>
                </Card>
              ))}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'locations',
      label: (
        <span>
          <EnvironmentOutlined /> {t('bible.locations')} ({locations.length})
        </span>
      ),
      children: (
        <div>
          <div style={{ marginBottom: 12 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openLocModal()} size="small">
              {t('bible.addLocation')}
            </Button>
          </div>

          {locations.length === 0 ? (
            <Empty description={t('bible.addLocation')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Table<BibleLocation>
              dataSource={locations}
              rowKey="id"
              size="small"
              pagination={false}
              columns={[
                { title: t('bible.locationName'), dataIndex: 'name', key: 'name', width: 100, ellipsis: true },
                { title: t('bible.locationDescription'), dataIndex: 'description', key: 'description', ellipsis: true, width: 'auto' },
                {
                  title: t('bible.locationSignificance'), dataIndex: 'significance', key: 'significance',
                  render: (v: string) => v ? (
                    <Tag style={{ fontSize: 10, maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{v}</Tag>
                  ) : '-',
                  width: 100, ellipsis: true,
                },
                {
                  title: '', key: 'actions', width: 60, align: 'center',
                  render: (_, record) => (
                    <Space size={2}>
                      <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openLocModal(record)} />
                      <Popconfirm title={t('common.confirm')} onConfirm={() => deleteLocation(record.id)}>
                        <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          )}
        </div>
      ),
    },
    {
      key: 'worldSettings',
      label: (
        <span>
          <GlobalOutlined /> {t('bible.worldSettings')} ({worldSettings.length})
        </span>
      ),
      children: (
        <div>
          <div style={{ marginBottom: 12 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openWsModal()} size="small">
              {t('bible.addWorldSetting')}
            </Button>
          </div>

          {worldSettings.length === 0 ? (
            <Empty description={t('bible.addWorldSetting')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {worldSettings.map((ws) => (
                <Card
                  key={ws.id}
                  size="small"
                  title={
                    <Space>
                      <Tag color="purple" style={{ fontSize: 10 }}>
                        {t(`bible.settingCategory.${ws.category}`, { defaultValue: ws.category })}
                      </Tag>
                      <span>{ws.name}</span>
                    </Space>
                  }
                  extra={
                    <Space size={4}>
                      <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openWsModal(ws)} />
                      <Popconfirm title={t('common.confirm')} onConfirm={() => deleteWorldSetting(ws.id)}>
                        <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  }
                  style={{ background: 'var(--bg-secondary, rgba(0,0,0,0.02))' }}
                >
                  <p style={{ margin: 0, fontSize: 12 }}>{ws.description}</p>
                  {ws.constraints.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      <Text type="secondary" style={{ fontSize: 11 }}>{t('bible.settingConstraints')}:</Text>
                      <ul style={{ margin: '2px 0 0 16px', fontSize: 11 }}>
                        {ws.constraints.map((c) => <li key={c}>{c}</li>)}
                      </ul>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={panelHeader()}>
        <span><BookOutlined style={{ marginRight: 6 }} />{t('bible.title')}</span>
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 8px' }}>
        <Tabs items={tabItems} size="small" style={{ marginBottom: 0 }} />
      </div>

      {/* Character Modal */}
      <Modal
        title={editingChar ? t('bible.editCharacter') : t('bible.addCharacter')}
        open={charModalOpen}
        onOk={saveCharacter}
        onCancel={() => setCharModalOpen(false)}
        width={560}
        destroyOnClose
      >
        <Form form={charForm} layout="vertical" size="small">
          <Form.Item name="name" label={t('bible.characterName')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="aliases" label={t('bible.characterAliases')}>
            <Input placeholder={t('props.aliasesPlaceholder')} />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="importance" label={t('bible.characterImportance')} style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={[
                { value: 'protagonist', label: t('bible.importance.protagonist') },
                { value: 'major', label: t('bible.importance.major') },
                { value: 'supporting', label: t('bible.importance.supporting') },
                { value: 'minor', label: t('bible.importance.minor') },
              ]} />
            </Form.Item>
            <Form.Item name="status" label={t('bible.characterStatus')} style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={[
                { value: 'active', label: t('bible.status.active') },
                { value: 'deceased', label: t('bible.status.deceased') },
                { value: 'missing', label: t('bible.status.missing') },
                { value: 'retired', label: t('bible.status.retired') },
              ]} />
            </Form.Item>
          </div>
          <Form.Item name="description" label={t('common.description')}>
            <TextArea rows={2} />
          </Form.Item>
          <Form.Item name="appearance" label={t('bible.characterAppearance')}>
            <TextArea rows={2} />
          </Form.Item>
          <Form.Item name="personality" label={t('bible.characterPersonality')}>
            <TextArea rows={2} />
          </Form.Item>
          <Form.Item name="backstory" label={t('bible.characterBackstory')}>
            <TextArea rows={3} />
          </Form.Item>
          <div style={{ borderTop: '1px dashed var(--border-secondary)', margin: '8px 0', paddingTop: 8 }}>
            <Text strong style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('psyche.sectionTitle')}</Text>
          </div>
          <Form.Item name="coreBelief" label={t('psyche.coreBelief')}>
            <Input placeholder={t('psyche.coreBeliefPlaceholder')} />
          </Form.Item>
          <Form.Item name="taboo" label={t('psyche.taboo')}>
            <Input placeholder={t('psyche.tabooPlaceholder')} />
          </Form.Item>
          <Form.Item name="voiceTag" label={t('psyche.voiceTag')}>
            <Input placeholder={t('psyche.voiceTagPlaceholder')} />
          </Form.Item>
          <Form.Item name="wound" label={t('psyche.wound')}>
            <Input placeholder={t('psyche.woundPlaceholder')} />
          </Form.Item>
          <div style={{ borderTop: '1px dashed var(--border-secondary)', margin: '8px 0', paddingTop: 8 }}>
            <Text strong style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('psyche.voiceSectionTitle')}</Text>
          </div>
          <Form.Item name="verbalTic" label={t('psyche.verbalTic')}>
            <Input placeholder={t('psyche.verbalTicPlaceholder')} />
          </Form.Item>
          <Form.Item name="mentalState" label={t('psyche.mentalState')}>
            <Input placeholder={t('psyche.mentalStatePlaceholder')} />
          </Form.Item>
          <Form.Item name="speechStyle" label={t('psyche.speechStyle')}>
            <Input placeholder={t('psyche.speechStylePlaceholder')} />
          </Form.Item>
          <Form.Item name="idleBehavior" label={t('psyche.idleBehavior')}>
            <Input placeholder={t('psyche.idleBehaviorPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Location Modal */}
      <Modal
        title={editingLoc ? t('common.edit') : t('bible.addLocation')}
        open={locModalOpen}
        onOk={saveLocation}
        onCancel={() => setLocModalOpen(false)}
        width={480}
        destroyOnClose
      >
        <Form form={locForm} layout="vertical" size="small">
          <Form.Item name="name" label={t('bible.locationName')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('bible.locationDescription')}>
            <TextArea rows={3} />
          </Form.Item>
          <Form.Item name="parentLocation" label={t('bible.locationParent')}>
            <Input />
          </Form.Item>
          <Form.Item name="significance" label={t('bible.locationSignificance')}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      {/* World Setting Modal */}
      <Modal
        title={editingWs ? t('common.edit') : t('bible.addWorldSetting')}
        open={wsModalOpen}
        onOk={saveWorldSetting}
        onCancel={() => setWsModalOpen(false)}
        width={480}
        destroyOnClose
      >
        <Form form={wsForm} layout="vertical" size="small">
          <Form.Item name="category" label={t('bible.settingCategory')} rules={[{ required: true }]}>
            <Select options={[
              { value: 'magic_system', label: t('bible.settingCategory.magicSystem') },
              { value: 'technology', label: t('bible.settingCategory.technology') },
              { value: 'social_structure', label: t('bible.settingCategory.socialStructure') },
              { value: 'history', label: t('bible.settingCategory.history') },
              { value: 'rules', label: t('bible.settingCategory.rules') },
            ]} />
          </Form.Item>
          <Form.Item name="name" label={t('bible.settingName')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('bible.settingDescription')}>
            <TextArea rows={3} />
          </Form.Item>
          <Form.Item name="constraints" label={t('bible.settingConstraints')}>
            <TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

const { Text: AntText } = Typography;
const Text: React.FC<{ children?: React.ReactNode; type?: string; style?: React.CSSProperties; strong?: boolean; ellipsis?: boolean }> = ({ children, style, strong, type }) => {
  if (strong || type) {
    return <AntText style={style} strong={strong} type={type as any}>{children}</AntText>;
  }
  return <span style={style}>{children}</span>;
};

export default StoryBiblePanel;
