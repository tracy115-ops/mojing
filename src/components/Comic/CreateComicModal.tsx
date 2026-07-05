import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Form, Input, Select, InputNumber, Alert, Typography } from 'antd';
import { useTranslation } from '@/i18n';
import { useComicStore } from '@/stores/comicStore';
import { useProjectStore } from '@/stores/projectStore';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import type { AspectRatio } from '@/types/video';
import type { BibleCharacter } from '@/types/narrative';

const { Text } = Typography;

interface CreateComicModalProps {
  open: boolean;
  onOk: (projectId: string) => void;
  onCancel: () => void;
}

interface NovelImportValue {
  novelProjectId: string;
  chapterId: string;
}

const CreateComicModal: React.FC<CreateComicModalProps> = ({ open, onOk, onCancel }) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const createProject = useComicStore((s) => s.createProject);
  const sourceMode = Form.useWatch('sourceMode', form);
  // 暂存 novel 导入的角色(novel 模式才有),不通过 Form 传,避免 JSON 字符串污染表单
  const importedCharsRef = React.useRef<
    { id: string; name: string; appearance: string; personality?: string }[]
  >([]);

  const handleOk = async () => {
    const values = await form.validateFields();
    const isNovel = values.sourceMode === 'novel';
    const project = createProject({
      title: values.title,
      sourceMode: isNovel ? 'novel' : 'pure',
      novelProjectId: isNovel ? values.novelProjectId : undefined,
      sourceText: values.theme ?? '',
      style: values.style,
      aspectRatio: values.aspectRatio as AspectRatio,
      panelLayout: values.panelLayout,
      panelCount: values.panelCount ?? 6,
      characters: isNovel ? importedCharsRef.current : undefined,
      options: {
        enableCharacterAnchor: true,
        characterAnchorLimit: 5,
      },
    });
    importedCharsRef.current = [];
    form.resetFields();
    onOk(project.id);
  };

  return (
    <Modal
      title={t('comic.newProject')}
      open={open}
      onOk={handleOk}
      onCancel={() => {
        form.resetFields();
        onCancel();
      }}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      width={560}
      destroyOnClose
      getContainer={() => document.getElementById('root')!}
    >
      <Form
        form={form}
        layout="vertical"
        size="small"
        initialValues={{
          style: 'manga',
          panelLayout: 'grid-2',
          aspectRatio: '16:9',
          panelCount: 6,
          sourceMode: 'theme',
        }}
      >
        <Form.Item name="title" label={t('project.create')} rules={[{ required: true }]}>
          <Input />
        </Form.Item>

        <Form.Item name="sourceMode" label={t('comic.sourceMode')}>
          <Select
            options={[
              { value: 'theme', label: t('comic.sourceMode.theme') },
              { value: 'novel', label: t('comic.sourceMode.novel') },
            ]}
          />
        </Form.Item>

        {sourceMode === 'novel' ? (
          <NovelImporter
            onChange={(val: NovelImportValue) => {
              form.setFieldValue('novelProjectId', val.novelProjectId);
              form.setFieldValue('chapterId', val.chapterId);
            }}
            onThemeLoaded={(text, title) => {
              form.setFieldValue('theme', text);
              if (!form.getFieldValue('title')) {
                form.setFieldValue('title', title);
              }
            }}
            onCharactersLoaded={(chars) => {
              importedCharsRef.current = chars;
            }}
          />
        ) : null}

        <Form.Item
          name="theme"
          label={t('comic.theme')}
          rules={[{ required: true }]}
          tooltip={t('comic.themePlaceholder')}
        >
          <Input.TextArea rows={4} placeholder={t('comic.themePlaceholder')} />
        </Form.Item>

        <Form.Item name="novelProjectId" hidden>
          <Input />
        </Form.Item>
        <Form.Item name="chapterId" hidden>
          <Input />
        </Form.Item>

        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="style" label={t('comic.style')} style={{ flex: 1 }}>
            <Select
              options={[
                { value: 'manga', label: t('comic.style.manga') },
                { value: 'western', label: t('comic.style.western') },
                { value: 'watercolor', label: t('comic.style.watercolor') },
                { value: 'pixel', label: t('comic.style.pixel') },
              ]}
            />
          </Form.Item>
          <Form.Item name="aspectRatio" label={t('comic.aspectRatio')} style={{ flex: 1 }}>
            <Select
              options={[
                { value: '16:9', label: '16:9' },
                { value: '9:16', label: '9:16' },
                { value: '1:1', label: '1:1' },
              ]}
            />
          </Form.Item>
        </div>

        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="panelLayout" label={t('comic.panelLayout')} style={{ flex: 1 }}>
            <Select
              options={[
                { value: 'single', label: t('comic.panelLayout.grid') },
                { value: 'grid-2', label: t('comic.panelLayout.grid') },
                { value: 'grid-4', label: t('comic.panelLayout.grid') },
                { value: 'manga-row', label: t('comic.panelLayout.manga-row') },
              ]}
            />
          </Form.Item>
          <Form.Item name="panelCount" label={t('comic.panelCount')} style={{ flex: 1 }}>
            <InputNumber min={1} max={20} style={{ width: '100%' }} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
};

// --- 小说导入子组件 ---

interface NovelImporterProps {
  onChange: (val: NovelImportValue) => void;
  onThemeLoaded: (text: string, suggestedTitle: string) => void;
  onCharactersLoaded: (chars: { id: string; name: string; appearance: string; personality?: string }[]) => void;
}

const NovelImporter: React.FC<NovelImporterProps> = ({ onChange, onThemeLoaded, onCharactersLoaded }) => {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const getStoryNodes = useProjectStore((s) => s.getStoryNodes);

  const [novelProjectId, setNovelProjectId] = useState<string | undefined>();
  const [chapterId, setChapterId] = useState<string | undefined>();
  const [characters, setCharacters] = useState<BibleCharacter[]>([]);

  const novelProjects = useMemo(
    () => projects.filter((p) => p.type === 'novel'),
    [projects],
  );

  // 拿选中小说项目的章节列表(按 order 排序)
  const chapters = useMemo(() => {
    if (!novelProjectId) return [];
    return getStoryNodes(novelProjectId)
      .filter((n) => n.nodeType === 'chapter')
      .sort((a, b) => a.order - b.order);
  }, [novelProjectId, getStoryNodes]);

  // 选了小说项目 → 抓角色列表
  useEffect(() => {
    if (!novelProjectId) {
      setCharacters([]);
      onCharactersLoaded([]);
      return;
    }
    try {
      const repo = new NarrativeRepository(novelProjectId);
      const bible = repo.loadBible();
      const list = bible.characters ?? [];
      setCharacters(list);
      onCharactersLoaded(
        list
          .filter((c) => c.appearance && c.appearance.trim().length > 0)
          .slice(0, 8)
          .map((c) => ({
            id: c.id,
            name: c.name,
            appearance: c.appearance,
            personality: c.personality || undefined,
          })),
      );
    } catch {
      setCharacters([]);
      onCharactersLoaded([]);
    }
  }, [novelProjectId, onCharactersLoaded]);

  // 选了章节 → 把章节内容填到 theme
  useEffect(() => {
    if (!novelProjectId || !chapterId) return;
    const node = chapters.find((c) => c.id === chapterId);
    if (!node) return;
    const text = (node.content ?? '').trim();
    const suggestedTitle = node.title || '';
    onThemeLoaded(text, suggestedTitle);
  }, [novelProjectId, chapterId, chapters, onThemeLoaded]);

  return (
    <div
      style={{
        marginBottom: 12,
        padding: 10,
        border: '1px solid var(--border-secondary)',
        borderRadius: 4,
        background: 'var(--bg-secondary, transparent)',
      }}
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        <Form.Item
          noStyle
          shouldUpdate={(prev, cur) => prev.novelProjectId !== cur.novelProjectId}
        >
          {() => (
            <Select
              placeholder={t('comic.importNovel')}
              style={{ flex: 1 }}
              value={novelProjectId}
              onChange={(v) => {
                setNovelProjectId(v);
                setChapterId(undefined);
                onChange({ novelProjectId: v, chapterId: '' });
              }}
              options={novelProjects.map((p) => ({
                value: p.id,
                label: p.title,
              }))}
              notFoundContent={
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {t('comic.importNovelEmpty')}
                </Text>
              }
            />
          )}
        </Form.Item>
        <Select
          placeholder={t('comic.importChapter')}
          style={{ flex: 1 }}
          value={chapterId}
          disabled={!novelProjectId}
          onChange={(v) => {
            setChapterId(v);
            if (novelProjectId) onChange({ novelProjectId, chapterId: v });
          }}
          options={chapters.map((c) => ({
            value: c.id,
            label: c.title || `#${c.order + 1}`,
          }))}
        />
      </div>
      {characters.length > 0 && (
        <Alert
          type="info"
          showIcon={false}
          style={{ fontSize: 11, padding: '4px 8px' }}
          message={`${t('comic.importedCharacters')}: ${characters.length} · ${characters
            .slice(0, 5)
            .map((c) => c.name)
            .join(', ')}${characters.length > 5 ? '...' : ''}`}
        />
      )}
    </div>
  );
};

export default CreateComicModal;
