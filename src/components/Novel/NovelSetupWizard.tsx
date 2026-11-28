// ============================================================================
// Novel Setup Wizard — 5-step guided creation inspired by PlotPilot
// Step 1: Basic info | Step 2: World | Step 3: Characters | Step 4: Locations | Step 5: Plot Outline
// ============================================================================

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Modal, Steps, Button, Space, Form, Input, Select, InputNumber,
  Alert, Card, Tag, Typography, message, Spin, Empty, Collapse, Row, Col,
} from 'antd';
import {
  RocketOutlined, GlobalOutlined, UserOutlined, EnvironmentOutlined,
  ReadOutlined, DeleteOutlined, EditOutlined, CheckCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { providerRouter } from '@/services/providers';
import { getTemplate } from '@/services/novel/prompt-templates';
import { collectNovelStreamText } from '@/services/novel/planning-generation';
import { reviewStoryPlan } from '@/services/novel/story-plan-review';
import { validateWizardPlot } from '@/services/novel/story-plan-contract';
import { decodeNovelReference, formatNovelReference, prepareNovelReference, REFERENCE_GUIDE_LIMIT,
  type NovelReference, type NovelReferenceMode } from '@/services/novel/novel-reference';

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

interface WizardValues {
  title: string;
  description: string;
  genre: string;
  targetWordCount: number;
  style: string;
  language: string;
}

export interface WizardResult {
  values: WizardValues;
  worldbuilding: Record<string, { key: string; value: string }[]>;
  styleConvention: string;
  characters: any[];
  locations: any[];
  plotOutline: any;
  reference?: NovelReference;
}

interface NovelSetupWizardProps {
  open: boolean;
  onComplete: (result: WizardResult) => void;
  onCancel: () => void;
}

type GenerationStatus = 'idle' | 'generating' | 'done' | 'error';

const NovelSetupWizard: React.FC<NovelSetupWizardProps> = ({ open, onComplete, onCancel }) => {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(0);
  const [form] = Form.useForm<WizardValues>();

  // Step data
  const [basicValues, setBasicValues] = useState<WizardValues | null>(null);
  const [styleConvention, setStyleConvention] = useState('');
  const [worldbuilding, setWorldbuilding] = useState<Record<string, { key: string; value: string }[]>>({});
  const [characters, setCharacters] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [plotOutline, setPlotOutline] = useState<any>(null);
  const [referenceText, setReferenceText] = useState('');
  const [referenceMode, setReferenceMode] = useState<NovelReferenceMode>('style');
  const [referenceName, setReferenceName] = useState<string>();
  const [reference, setReference] = useState<NovelReference>();
  const [referenceProgress, setReferenceProgress] = useState('');
  const referenceNotes = useRef<string[]>([]);
  const referenceFile = useRef<HTMLInputElement>(null);

  // Generation state
  const [genStatus, setGenStatus] = useState<GenerationStatus>('idle');
  const [genError, setGenError] = useState('');
  const [streamText, setStreamText] = useState('');
  const [budgetRetry, setBudgetRetry] = useState(false);
  const [reviewingPlot, setReviewingPlot] = useState(false);
  const [plotChanges, setPlotChanges] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Cleanup on close
  useEffect(() => {
    if (!open) {
      setCurrent(0);
      setBasicValues(null);
      setStyleConvention('');
      setWorldbuilding({});
      setCharacters([]);
      setLocations([]);
      setPlotOutline(null);
      setPlotChanges([]);
      setReviewingPlot(false);
      setGenStatus('idle');
      setGenError('');
      setStreamText('');
      setReferenceText('');
      setReferenceMode('style');
      setReferenceName(undefined);
      setReference(undefined);
      setReferenceProgress('');
      referenceNotes.current = [];
      form.resetFields();
    }
  }, [open, form]);

  // --- AI Generation Helpers ---

  const generateWithStream = useCallback(async (templateId: string, vars: Record<string, string>): Promise<string> => {
    const template = getTemplate(templateId);
    if (!template) throw new Error(`Template ${templateId} not found`);

    const arrayKey = templateId === 'character-generation' ? 'characters' : templateId === 'location-generation' ? 'locations' : undefined;
    const systemPrompt = [template.buildSystem(vars) + (arrayKey
      ? `\n请把上述数组放入 JSON 对象的 "${arrayKey}" 字段；返回对象，不要直接返回顶层数组。`
      : ''), formatNovelReference(reference)].filter(Boolean).join('\n\n');
    const userPrompt = template.buildUser(vars);

    const controller = new AbortController();
    abortRef.current = controller;
    setBudgetRetry(false);
    return collectNovelStreamText(maxTokens => providerRouter.stream({
        taskType: 'generation',
        systemPrompt,
        userPrompt,
        temperature: 0.85,
        maxTokens,
        responseFormat: 'json',
        thinking: false,
      }), { signal: controller.signal, onText: setStreamText, onRetry: () => setBudgetRetry(true) });
  }, [reference]);

  const parseJSON = useCallback((text: string): any => {
    const trimmed = text.trim();

    // 1. Try direct parse first (best case: clean JSON from json_object mode)
    try {
      return JSON.parse(trimmed);
    } catch { /* continue */ }

    // 2. Extract from markdown code block
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1].trim());
      } catch { /* continue */ }
    }

    // 3. Find first { ... } or [ ... ] in the text
    const objectMatch = trimmed.match(/(\{[\s\S]*\})/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[1]);
      } catch { /* continue */ }
    }

    const arrayMatch = trimmed.match(/(\[[\s\S]*\])/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[1]);
      } catch { /* continue */ }
    }

    throw new Error(`Failed to parse JSON response: ${trimmed.slice(0, 100)}...`);
  }, []);

  // --- Step Generators ---

  const generateWorld = useCallback(async () => {
    if (!basicValues) return;
    setGenStatus('generating');
    setGenError('');
    setStreamText('');
    try {
      const result = await generateWithStream('worldbuilding', {
        title: basicValues.title,
        genre: basicValues.genre,
        description: basicValues.description,
        style: basicValues.style,
        language: basicValues.language,
      });
      const parsed = parseJSON(result);
      setStyleConvention(parsed['style公约'] || parsed.styleConvention || '');
      const wb: Record<string, { key: string; value: string }[]> = {};
      const dimensionNames = ['核心法则', '地理生态', '社会结构', '历史文化', '日常细节'];
      for (const dim of dimensionNames) {
        if (Array.isArray(parsed[dim])) {
          wb[dim] = parsed[dim].map((item: any) => ({
            key: item.key || item.name || '',
            value: item.value || item.description || '',
          }));
        }
      }
      setWorldbuilding(wb);
      setGenStatus('done');
    } catch (err) {
      setGenStatus('error');
      setGenError(err instanceof Error ? err.message : String(err));
    }
  }, [basicValues, generateWithStream, parseJSON]);

  const generateCharacters = useCallback(async () => {
    if (!basicValues) return;
    setGenStatus('generating');
    setGenError('');
    setStreamText('');
    try {
      const wbStr = styleConvention + '\n' + Object.entries(worldbuilding)
        .map(([dim, items]) => `${dim}:\n${items.map((i) => `- ${i.key}: ${i.value}`).join('\n')}`)
        .join('\n');
      const result = await generateWithStream('character-generation', {
        title: basicValues.title,
        genre: basicValues.genre,
        description: basicValues.description,
        worldbuilding: wbStr,
      });
      const parsed = parseJSON(result);
      const items = Array.isArray(parsed) ? parsed : parsed.characters;
      if (!Array.isArray(items) || !items.length) throw new Error(t('wizard.emptyCharacters'));
      setCharacters(items);
      setGenStatus('done');
    } catch (err) {
      setGenStatus('error');
      setGenError(err instanceof Error ? err.message : String(err));
    }
  }, [basicValues, styleConvention, worldbuilding, generateWithStream, parseJSON]);

  const generateLocations = useCallback(async () => {
    if (!basicValues) return;
    setGenStatus('generating');
    setGenError('');
    setStreamText('');
    try {
      const wbStr = Object.entries(worldbuilding)
        .map(([dim, items]) => `${dim}:\n${items.map((i) => `- ${i.key}: ${i.value}`).join('\n')}`)
        .join('\n');
      const charStr = characters.map((c) => `- ${c.name}(${c.importance}): ${c.description}`).join('\n');
      const result = await generateWithStream('location-generation', {
        title: basicValues.title,
        genre: basicValues.genre,
        description: basicValues.description,
        worldbuilding: wbStr,
        characters: charStr,
      });
      const parsed = parseJSON(result);
      const items = Array.isArray(parsed) ? parsed : parsed.locations;
      if (!Array.isArray(items) || !items.length) throw new Error(t('wizard.emptyLocations'));
      setLocations(items);
      setGenStatus('done');
    } catch (err) {
      setGenStatus('error');
      setGenError(err instanceof Error ? err.message : String(err));
    }
  }, [basicValues, worldbuilding, characters, generateWithStream, parseJSON]);

  const generatePlot = useCallback(async () => {
    if (!basicValues) return;
    setGenStatus('generating');
    setGenError('');
    setStreamText('');
    setPlotChanges([]);
    try {
      const wbStr = Object.entries(worldbuilding)
        .map(([dim, items]) => `${dim}:\n${items.map((i) => `- ${i.key}: ${i.value}`).join('\n')}`)
        .join('\n');
      const charStr = characters.map((c) => `- ${c.name}: ${c.description}`).join('\n');
      const locStr = locations.map((l) => `- ${l.name}: ${l.description}`).join('\n');
      const result = await generateWithStream('plot-outline', {
        title: basicValues.title,
        genre: basicValues.genre,
        description: basicValues.description,
        targetWordCount: String(basicValues.targetWordCount),
        worldbuilding: wbStr,
        characters: charStr,
        locations: locStr,
      });
      const parsed = parseJSON(result);
      validateWizardPlot(parsed);
      setReviewingPlot(true);
      const reviewed = await reviewStoryPlan(`原始简介：${basicValues.description}\n题材：${basicValues.genre}；目标字数：${basicValues.targetWordCount}\n待推演的世界设定：${wbStr}\n人物：${charStr}\n地点：${locStr}\n\n${formatNovelReference(reference)}`, JSON.stringify(parsed), abortRef.current?.signal);
      validateWizardPlot(reviewed.plan);
      setPlotOutline(reviewed.plan);
      setPlotChanges(reviewed.changes);
      setGenStatus('done');
    } catch (err) {
      setGenStatus('error');
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewingPlot(false);
    }
  }, [basicValues, worldbuilding, characters, locations, generateWithStream, parseJSON, reference]);

  // --- Navigation ---

  const resetReference = () => {
    setReference(undefined);
    referenceNotes.current = [];
    setGenStatus('idle');
    setGenError('');
  };

  const readReferenceFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setGenStatus('generating');
    setReferenceProgress(t('novelReference.readingFile'));
    try {
      const text = decodeNovelReference(await file.arrayBuffer());
      if (controller.signal.aborted) return;
      if (!text.trim()) throw new Error(t('novelReference.readFailed'));
      resetReference();
      setReferenceText(text);
      setReferenceName(file.name);
    } catch (error) {
      if (controller.signal.aborted) return;
      setGenStatus('error');
      setGenError(t('novelReference.readFailed'));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const handleNext = async () => {
    if (current === 0) {
      const values = await form.validateFields().catch(() => undefined);
      if (!values) return;
      if (referenceText.trim() && !reference) {
        const controller = new AbortController();
        abortRef.current = controller;
        setGenStatus('generating');
        setGenError('');
        try {
          const guide = await prepareNovelReference(referenceText, (request, signal) => providerRouter.generate(request, signal), {
            mode: referenceMode, sourceName: referenceName, signal: controller.signal, notes: referenceNotes.current,
            onProgress: (done, total, merging) => setReferenceProgress(merging
              ? t('novelReference.merging') : t('novelReference.analyzing', { current: done + 1, total })),
          });
          if (controller.signal.aborted) return;
          setReference(guide);
        } catch (error) {
          if (controller.signal.aborted) return;
          setGenError(error instanceof Error ? error.message : String(error));
          setGenStatus('error');
          return;
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
        }
      }
      setBasicValues(values);
    }
    setGenStatus('idle');
    setStreamText('');
    setCurrent(current + 1);
  };

  const handleFinish = useCallback(() => {
    if (!basicValues) return;
    onComplete({
      values: basicValues,
      worldbuilding,
      styleConvention,
      characters,
      locations,
      plotOutline,
      reference: reference?.guide.trim() ? reference : undefined,
    });
  }, [basicValues, worldbuilding, styleConvention, characters, locations, plotOutline, reference, onComplete]);

  // --- Step Renderers ---

  const renderStep0 = () => (
    <Form form={form} layout="vertical" size="small" disabled={genStatus === 'generating'}
      initialValues={{ genre: 'fantasy', targetWordCount: 100000, style: 'literary', language: 'zh-CN' }}>
      <Form.Item name="title" label={t('wizard.title')} rules={[{ required: true, message: t('common.required') }]}>
        <Input placeholder={t('wizard.titlePlaceholder')} />
      </Form.Item>
      <Form.Item name="description" label={t('common.description')}>
        <TextArea rows={3} placeholder={t('wizard.descPlaceholder')} />
      </Form.Item>
      <Row gutter={16}>
        <Col span={12}>
          <Form.Item name="genre" label={t('novel.genre')}>
            <Select options={[
              { value: 'fantasy', label: t('novel.genre.fantasy') },
              { value: 'scifi', label: t('novel.genre.scifi') },
              { value: 'romance', label: t('novel.genre.romance') },
              { value: 'mystery', label: t('novel.genre.mystery') },
              { value: 'literary', label: t('novel.genre.literary') },
              { value: 'wuxia', label: t('novel.genre.wuxia') },
            ]} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name="targetWordCount" label={t('novel.targetWordCount')}>
            <InputNumber min={10000} max={5000000} step={50000} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={16}>
        <Col span={12}>
          <Form.Item name="style" label={t('novel.style')}>
            <Select options={[
              { value: 'literary', label: t('novel.style.literary') },
              { value: 'light', label: t('novel.style.light') },
              { value: 'suspense', label: t('novel.style.suspense') },
              { value: 'epic', label: t('novel.style.epic') },
              { value: 'humorous', label: t('novel.style.humorous') },
            ]} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name="language" label={t('settings.general.language')}>
            <Select options={[
              { value: 'zh-CN', label: t('settings.general.language.zh-CN') },
              { value: 'en-US', label: t('settings.general.language.en-US') },
            ]} />
          </Form.Item>
        </Col>
      </Row>
      <Collapse size="small" items={[{
        key: 'reference',
        label: t('novelReference.entry'),
        children: <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <Select aria-label={t('novelReference.mode')} value={referenceMode} disabled={genStatus === 'generating'}
              options={[
                { value: 'style', label: t('novelReference.style') },
                { value: 'rewrite', label: t('novelReference.rewrite') },
              ]}
              onChange={mode => { setReferenceMode(mode); resetReference(); }} />
            <Button size="small" disabled={genStatus === 'generating'} onClick={() => referenceFile.current?.click()}>
              {t('novelReference.import')}
            </Button>
            <input ref={referenceFile} data-testid="novel-reference-file" type="file" accept=".txt,.md" hidden onChange={readReferenceFile} />
          </Space>
          <TextArea data-testid="novel-reference-text" aria-label={t('novelReference.source')} value={referenceText}
            placeholder={t('novelReference.source')} autoSize={{ minRows: 3, maxRows: 7 }} disabled={genStatus === 'generating'}
            onChange={event => { setReferenceText(event.target.value); resetReference(); }} />
          <Text type="secondary">{referenceName && `${referenceName} · `}{t('novel.wordCount', { count: referenceText.length.toLocaleString() })}</Text>
          <Text type="secondary">{t(referenceMode === 'style' ? 'novelReference.styleHint' : 'novelReference.rewriteHint')}</Text>
        </Space>,
      }]} />
      {genStatus === 'generating' && <Space wrap style={{ marginTop: 8 }}>
        <Text role="status"><Spin size="small" /> {referenceProgress}</Text>
        <Button size="small" disabled={false} onClick={() => { abortRef.current?.abort(); setGenStatus('idle'); }}>
          {t('novel.stopGeneration')}
        </Button>
      </Space>}
      {genStatus === 'error' && <Alert type="error" showIcon message={genError} />}
    </Form>
  );

  const renderGenerationCard = (title: string, onGenerate: () => Promise<void>, hasData: boolean, children: React.ReactNode) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {genStatus === 'generating' && (
        <Card size="small" style={{ background: 'var(--bg-secondary, rgba(0,0,0,0.02))' }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              <Spin size="small" />
              <Text style={{ fontSize: 12 }}>{t(reviewingPlot ? 'wizard.reviewingPlot' : budgetRetry ? 'wizard.retryOutputBudget' : 'wizard.generating')}</Text>
            </Space>
            {streamText && (
              <div style={{
                maxHeight: 120, overflow: 'auto', fontSize: 11,
                color: 'var(--text-tertiary)', whiteSpace: 'pre-wrap',
                background: 'var(--bg-tertiary, rgba(0,0,0,0.04))',
                padding: '4px 8px', borderRadius: 4,
              }}>
                {streamText.slice(-500)}
              </div>
            )}
          </Space>
        </Card>
      )}
      {genStatus === 'error' && (
        <Card size="small" style={{ borderLeft: '3px solid #ef4444' }}>
          <Text type="danger" style={{ fontSize: 12 }}>{genError}</Text>
          <Button size="small" style={{ marginLeft: 8 }} onClick={onGenerate}>{t('common.retry')}</Button>
        </Card>
      )}
      {!hasData && (genStatus === 'idle' || genStatus === 'error') && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={onGenerate}>
            {title}
          </Button>
        </div>
      )}
      {hasData && children}
      {hasData && genStatus === 'done' && (
        <Button size="small" icon={<ThunderboltOutlined />} onClick={onGenerate}>
          {t('wizard.regenerate')}
        </Button>
      )}
    </div>
  );

  const renderStep1 = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {reference && <Collapse size="small" items={[{
        key: 'guide',
        label: t('novelReference.editGuide'),
        children: <TextArea data-testid="novel-reference-guide" aria-label={t('novelReference.guide')}
          value={reference.guide} autoSize={{ minRows: 4, maxRows: 8 }} maxLength={REFERENCE_GUIDE_LIMIT}
          disabled={genStatus === 'generating'}
          onChange={event => setReference({ ...reference, guide: event.target.value })} />,
      }]} />}
      {renderGenerationCard(t('wizard.genWorld'), generateWorld, Object.keys(worldbuilding).length > 0, (
        <>
          {styleConvention && (
            <Card size="small" title={<Space><ReadOutlined /> {t('wizard.styleConvention')}</Space>}>
              <TextArea
                value={styleConvention}
                onChange={(e) => setStyleConvention(e.target.value)}
                rows={3}
                style={{ fontSize: 12 }}
              />
            </Card>
          )}
          {Object.entries(worldbuilding).map(([dim, items]) => (
            <Card key={dim} size="small" title={<Space><GlobalOutlined /> {dim}</Space>}>
              {items.map((item, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                  <Input size="small" value={item.key} style={{ width: 120, fontSize: 12 }}
                    onChange={(e) => {
                      const newWb = { ...worldbuilding };
                      newWb[dim] = newWb[dim].map((it, i) => i === idx ? { ...it, key: e.target.value } : it);
                      setWorldbuilding(newWb);
                    }}
                  />
                  <Input size="small" value={item.value} style={{ flex: 1, fontSize: 12 }}
                    onChange={(e) => {
                      const newWb = { ...worldbuilding };
                      newWb[dim] = newWb[dim].map((it, i) => i === idx ? { ...it, value: e.target.value } : it);
                      setWorldbuilding(newWb);
                    }}
                  />
                  <Button size="small" danger icon={<DeleteOutlined />}
                    onClick={() => {
                      const newWb = { ...worldbuilding };
                      newWb[dim] = newWb[dim].filter((_, i) => i !== idx);
                      setWorldbuilding(newWb);
                    }}
                  />
                </div>
              ))}
              <Button size="small" type="dashed" style={{ marginTop: 4 }}
                onClick={() => {
                  const newWb = { ...worldbuilding };
                  newWb[dim] = [...newWb[dim], { key: '', value: '' }];
                  setWorldbuilding(newWb);
                }}
              >+ {t('common.add')}</Button>
            </Card>
          ))}
        </>
      ))}
    </div>
  );

  const renderStep2 = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {renderGenerationCard(t('wizard.genCharacters'), generateCharacters, characters.length > 0, (
        <>
          {characters.map((char, idx) => (
            <Card key={idx} size="small" title={
              <Space>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%', background: 'var(--accent-primary, #3b82f6)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontSize: 12, fontWeight: 600,
                }}>
                  {char.name?.[0] || '?'}
                </div>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{char.name}</span>
                <Tag style={{ fontSize: 9 }}>{char.importance}</Tag>
              </Space>
            } extra={
              <Button size="small" danger icon={<DeleteOutlined />}
                onClick={() => setCharacters(characters.filter((_, i) => i !== idx))}
              />
            }>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div>
                  <Text type="secondary" style={{ fontSize: 11 }}>{t('common.description')}:</Text>
                  <TextArea rows={2} value={char.description} style={{ fontSize: 12 }}
                    onChange={(e) => setCharacters(characters.map((c, i) => i === idx ? { ...c, description: e.target.value } : c))}
                  />
                </div>
                {char.personality && <div><Text type="secondary" style={{ fontSize: 11 }}>{t('wizard.personality')}:</Text> <Text style={{ fontSize: 12 }}>{char.personality}</Text></div>}
                {char.coreBelief && <div><Text type="secondary" style={{ fontSize: 11 }}>{t('wizard.coreBelief')}:</Text> <Text style={{ fontSize: 12 }}>{char.coreBelief}</Text></div>}
                {char.verbalTic && <div><Text type="secondary" style={{ fontSize: 11 }}>{t('wizard.verbalTic')}:</Text> <Text style={{ fontSize: 12 }}>{char.verbalTic}</Text></div>}
                {char.relationships?.length > 0 && (
                  <div>
                    <Text type="secondary" style={{ fontSize: 11 }}>{t('bible.characterRelationships')}:</Text>
                    <div style={{ marginTop: 2 }}>{char.relationships.map((r: any, ri: number) => (
                      <Tag key={ri} style={{ fontSize: 9, marginBottom: 2 }}>{r.target} - {r.type}</Tag>
                    ))}</div>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </>
      ))}
    </div>
  );

  const renderStep3 = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {renderGenerationCard(t('wizard.genLocations'), generateLocations, locations.length > 0, (
        <>
          {locations.map((loc, idx) => (
            <Card key={idx} size="small" title={
              <Space>
                <span style={{ fontSize: 16 }}>📍</span>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{loc.name}</span>
              </Space>
            } extra={
              <Button size="small" danger icon={<DeleteOutlined />}
                onClick={() => setLocations(locations.filter((_, i) => i !== idx))}
              />
            }>
              <TextArea rows={2} value={loc.description} style={{ fontSize: 12 }}
                onChange={(e) => setLocations(locations.map((l, i) => i === idx ? { ...l, description: e.target.value } : l))}
              />
            </Card>
          ))}
        </>
      ))}
    </div>
  );

  const renderStep4 = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {renderGenerationCard(t('wizard.genPlot'), generatePlot, !!plotOutline, (
        <>
          {plotOutline && (
            <>
              {plotChanges.length > 0 && <Card size="small" title={t('wizard.plotChanges')}>{plotChanges.map((change, index) => <Paragraph key={index}>{change}</Paragraph>)}</Card>}
              {plotOutline.mainPlot && (
                <Card size="small" title={<Space><ReadOutlined /> {t('wizard.mainPlot')}</Space>}>
                  <TextArea rows={3} value={plotOutline.mainPlot} style={{ fontSize: 12 }}
                    onChange={(e) => setPlotOutline({ ...plotOutline, mainPlot: e.target.value })}
                  />
                </Card>
              )}
              {plotOutline.stages?.length > 0 && (
                <Card size="small" title={<Space><ThunderboltOutlined /> {t('wizard.stagePlan')}</Space>}>
                  {plotOutline.stages.map((stage: any, idx: number) => (
                    <div key={idx} style={{
                      padding: '6px 8px', marginBottom: 4, borderRadius: 4,
                      background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
                      borderLeft: `3px solid ${stage.tension >= 8 ? '#ef4444' : stage.tension >= 5 ? '#f59e0b' : '#3b82f6'}`,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                        <Text strong style={{ fontSize: 12 }}>{stage.name}</Text>
                        <Space size={4}>
                          <Tag style={{ fontSize: 9 }}>{stage.chapterRange}</Tag>
                          <Tag color={stage.tension >= 8 ? 'red' : 'blue'} style={{ fontSize: 9 }}>
                            {t('wizard.tension')}: {stage.tension}/10
                          </Tag>
                        </Space>
                      </div>
                      <Text style={{ fontSize: 11 }}>{stage.description}</Text>
                      {stage.coreEvent && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>🎯 {stage.coreEvent}</div>}
                    </div>
                  ))}
                </Card>
              )}
              {plotOutline.ending && (
                <Card size="small" title={t('wizard.ending')}>
                  <TextArea rows={2} value={plotOutline.ending} style={{ fontSize: 12 }}
                    onChange={(e) => setPlotOutline({ ...plotOutline, ending: e.target.value })}
                  />
                </Card>
              )}
            </>
          )}
        </>
      ))}
    </div>
  );

  const stepRenderers = [renderStep0, renderStep1, renderStep2, renderStep3, renderStep4];

  const stepTitles = [
    { title: t('wizard.step1'), icon: <RocketOutlined /> },
    { title: t('wizard.step2'), icon: <GlobalOutlined /> },
    { title: t('wizard.step3'), icon: <UserOutlined /> },
    { title: t('wizard.step4'), icon: <EnvironmentOutlined /> },
    { title: t('wizard.step5'), icon: <ReadOutlined /> },
  ];

  return (
    <Modal
      title={t('wizard.title')}
      open={open}
      onCancel={() => {
        abortRef.current?.abort();
        setGenStatus('idle');
        onCancel();
      }}
      width={720}
      footer={null}
      destroyOnClose
      getContainer={() => document.getElementById('root')!}
    >
      <Steps current={current} size="small" style={{ marginBottom: 20 }}
        items={stepTitles.map((s) => ({ title: s.title, icon: s.icon }))}
      />

      <div style={{ maxHeight: 'calc(80vh - 180px)', overflow: 'auto', paddingRight: 4 }}>
        {stepRenderers[current]()}
      </div>

      {/* Footer buttons */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-secondary)' }}>
        <Button onClick={() => {
          abortRef.current?.abort();
          setGenStatus('idle');
          onCancel();
        }}>
          {t('common.cancel')}
        </Button>
        <Space>
          {current > 0 && (
            <Button disabled={genStatus === 'generating'} onClick={() => { setCurrent(current - 1); setGenStatus('idle'); setStreamText(''); }}>
              {t('common.back')}
            </Button>
          )}
          {current < 4 && (
            <Button type="primary" onClick={handleNext} disabled={genStatus === 'generating'}>
              {t('common.next')}
            </Button>
          )}
          {current === 4 && (
            <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleFinish}
              disabled={genStatus === 'generating'}>
              {t('wizard.finish')}
            </Button>
          )}
        </Space>
      </div>
    </Modal>
  );
};

export default NovelSetupWizard;
