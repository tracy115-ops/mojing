import { useState } from 'react';
import { Button, Empty, Form, Input, Modal, Popconfirm, Select, Space, Tag, Typography, Upload, message } from 'antd';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { studioId } from '@/services/video-studio/document';
import { downloadStudioFile } from '@/services/video-studio/generation';
import { fetch as httpFetch } from '@/services/providers/fetch-proxy';
import type { StudioRecipe } from '@/types/video-studio';

export default function StudioRecipes() {
  const { t } = useTranslation();
  const store = useVideoStudioStore();
  const [editing, setEditing] = useState<Partial<StudioRecipe>>(), [search, setSearch] = useState(''), [urlOpen, setUrlOpen] = useState(false), [url, setUrl] = useState(''), [loading, setLoading] = useState(false);
  const [form] = Form.useForm();
  const builtins: StudioRecipe[] = ['product', 'character', 'motion', 'script'].map((key) => ({ id: `builtin:${key}`, name: t(`studio.recipe.${key}`), description: t(`studio.recipe.${key}Description`), prompt: t(`studio.recipe.${key}Prompt`), kind: key === 'motion' ? 'video' : key === 'script' ? 'text' : 'image', tags: [] }));
  const recipes = [...store.recipes, ...builtins].filter((recipe) => `${recipe.name} ${recipe.description} ${recipe.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const openEditor = (recipe: Partial<StudioRecipe> = {}) => { setEditing(recipe); form.resetFields(); form.setFieldsValue({ kind: 'video', ...recipe, tags: recipe.tags?.join(', ') ?? '' }); };
  const save = async () => {
    const values = await form.validateFields();
    store.saveRecipe({ ...values, id: editing?.id && !editing.id.startsWith('builtin:') ? editing.id : studioId(), tags: String(values.tags || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) });
    setEditing(undefined); message.success(t('studio.saved'));
  };
  const importText = (text: string, source?: string) => {
    let value: Partial<StudioRecipe>;
    if (text.trim().startsWith('{')) value = JSON.parse(text);
    else value = { name: text.match(/^#\s+(.+)$/m)?.[1] ?? source?.split('/').pop() ?? t('studio.recipe.new'), prompt: text, kind: 'video', source };
    if (typeof value.name !== 'string' || typeof value.prompt !== 'string' || !value.prompt.trim() || !['image', 'video', 'text'].includes(value.kind ?? '')) throw new Error(t('studio.recipe.invalid'));
    openEditor({ ...value, id: undefined, tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === 'string') : [], source: source || value.source });
  };
  const fromUrl = async () => {
    setLoading(true);
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(t('studio.recipe.invalid'));
      const source = parsed.hostname === 'github.com' ? url.replace('github.com/', 'raw.githubusercontent.com/').replace('/blob/', '/') : url;
      const response = await httpFetch(source);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      importText(await response.text(), url); setUrlOpen(false);
    } catch (error) { message.error(String(error)); } finally { setLoading(false); }
  };
  return <div className="video-studio-content" data-testid="studio-skills">
    <div className="video-studio-toolbar"><Input.Search allowClear placeholder={t('studio.search')} value={search} onChange={(event) => setSearch(event.target.value)} /><Button type="primary" onClick={() => openEditor()}>{t('studio.recipe.new')}</Button><Upload accept=".json,.md,.txt" showUploadList={false} beforeUpload={(file) => { void file.text().then((text) => importText(text)).catch((error) => message.error(String(error))); return false; }}><Button>{t('studio.import')}</Button></Upload><Button onClick={() => setUrlOpen(true)}>{t('studio.recipe.install')}</Button></div>
    {!recipes.length ? <Empty description={t('studio.empty')} /> : <div className="video-studio-grid">{recipes.map((recipe) => <article className="video-studio-card" key={recipe.id}><Tag>{t(`studio.kind.${recipe.kind}`)}</Tag><h4>{recipe.name}</h4><Typography.Paragraph type="secondary">{recipe.description}</Typography.Paragraph><Space wrap>{recipe.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space><div className="video-studio-card-actions"><Button type="primary" size="small" onClick={() => { if (recipe.id.startsWith('builtin:')) store.setDraft({ kind: recipe.kind, prompt: recipe.prompt }); else store.setDraft({ kind: recipe.kind, recipeId: recipe.id }); store.setPage(recipe.kind === 'image' ? 'image' : recipe.kind === 'video' ? 'video' : 'home'); }}>{t('studio.creator.use')}</Button><Button size="small" onClick={() => openEditor(recipe)}>{t('studio.open')}</Button><Button size="small" onClick={() => downloadStudioFile(JSON.stringify(recipe, null, 2), `${recipe.name}.json`)}>{t('studio.export')}</Button>{!recipe.id.startsWith('builtin:') && <Popconfirm title={t('studio.deleteConfirm')} onConfirm={() => store.removeRecipe(recipe.id)}><Button size="small" danger>{t('studio.delete')}</Button></Popconfirm>}</div></article>)}</div>}
    <Modal className="studio-recipe-editor" open={!!editing} title={t('studio.recipe.new')} onCancel={() => setEditing(undefined)} onOk={() => void save()} okText={t('studio.save')} cancelText={t('studio.cancel')} width={760} destroyOnClose><Form form={form} layout="vertical"><Form.Item name="name" label={t('studio.rename')} rules={[{ required: true, whitespace: true }]}><Input /></Form.Item><Form.Item name="kind" label={t('studio.creator.mode')}><Select options={['image', 'video', 'text'].map((value) => ({ value, label: t(`studio.kind.${value}`) }))} /></Form.Item><Form.Item name="description" label={t('studio.description')}><Input /></Form.Item><Form.Item name="prompt" label={t('studio.recipe.prompt')} rules={[{ required: true, whitespace: true }]}><Input.TextArea rows={9} /></Form.Item><Form.Item name="tags" label={t('studio.recipe.tags')}><Input /></Form.Item><Form.Item name="source" label={t('studio.recipe.source')}><Input /></Form.Item></Form></Modal>
    <Modal className="studio-recipe-import" open={urlOpen} title={t('studio.recipe.install')} onCancel={() => setUrlOpen(false)} onOk={() => void fromUrl()} confirmLoading={loading}><Input aria-label={t('studio.recipe.url')} placeholder={t('studio.recipe.url')} value={url} onChange={(event) => setUrl(event.target.value)} /></Modal>
  </div>;
}
