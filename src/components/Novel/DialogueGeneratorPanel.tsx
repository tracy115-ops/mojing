// ============================================================================
// Dialogue Generator Panel — AI-powered character dialogue generation
// Uses character psyche anchors (verbal tic, mental state, speech style)
// ============================================================================

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Select, Input, Button, Space, Card, Tag, Empty, message, Alert } from 'antd';
import { MessageOutlined, CopyOutlined, ReloadOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { providerRouter } from '@/services/providers';
import type { LLMGenerateRequest } from '@/types/providers';
import type { BibleCharacter } from '@/types/narrative';

const { TextArea } = Input;

interface DialogueGeneratorPanelProps {
  novelId: string;
}

const DialogueGeneratorPanel: React.FC<DialogueGeneratorPanelProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [repo] = useState(() => new NarrativeRepository(novelId));

  const [characters, setCharacters] = useState<BibleCharacter[]>([]);
  const [selectedCharId, setSelectedCharId] = useState<string | undefined>();
  const [sceneDesc, setSceneDesc] = useState('');
  const [generated, setGenerated] = useState('');
  const [generating, setGenerating] = useState(false);

  const refresh = useCallback(() => {
    setCharacters(repo.getCharacters());
  }, [repo]);

  useEffect(() => { refresh(); }, [refresh]);

  const selectedChar = useMemo(
    () => characters.find((c) => c.id === selectedCharId),
    [characters, selectedCharId],
  );

  const handleGenerate = async () => {
    if (!selectedChar || !sceneDesc.trim()) {
      message.warning(t('dialogue.needCharAndScene'));
      return;
    }
    setGenerating(true);
    setGenerated('');
    try {
      const psyche = selectedChar.psyche;
      const voice = selectedChar.voiceAnchor;
      const prompt = `你是角色"${selectedChar.name}"。
${psyche?.coreBelief ? `核心信念: ${psyche.coreBelief}` : ''}
${psyche?.taboo ? `禁忌: ${psyche.taboo}` : ''}
${voice?.verbalTic ? `口头禅: ${voice.verbalTic}` : ''}
${voice?.speechStyle ? `说话风格: ${voice.speechStyle}` : ''}
${voice?.mentalState ? `心理状态: ${voice.mentalState}` : ''}
${selectedChar.personality ? `性格: ${selectedChar.personality}` : ''}

场景描述: ${sceneDesc}

请以${selectedChar.name}的口吻说出一段对话（2-5句话），要符合其性格和说话方式。只输出对话内容，不要加引号或旁白。`;

      const request: LLMGenerateRequest = {
        taskType: 'generation',
        systemPrompt: `你是角色对话生成器。根据角色的心理档案和场景描述，生成符合角色性格的对话。只输出角色说的话。`,
        userPrompt: prompt,
        maxTokens: 500,
      };
      const response = await providerRouter.generate(request);
      setGenerated(response.content.trim());
    } catch {
      // Fallback: generate a template dialogue
      const tic = selectedChar.voiceAnchor?.verbalTic ?? '';
      const style = selectedChar.voiceAnchor?.speechStyle ?? '';
      setGenerated(
        `${tic ? tic + '……' : ''}（基于${selectedChar.name}的${style || '性格'}，在此场景下的对话）\n\n` +
        `[${t('dialogue.fallbackHint')}]`,
      );
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = () => {
    if (generated) {
      navigator.clipboard.writeText(generated);
      message.success(t('common.copiedToClipboard'));
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 12px' }}>
      <div style={{ fontWeight: 600, fontSize: 13, borderBottom: '1px solid var(--border-secondary)', paddingBottom: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span><MessageOutlined style={{ marginRight: 6 }} />{t('dialogue.title')}</span>
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
      </div>

      <Alert
        type="info"
        showIcon
        icon={<InfoCircleOutlined />}
        message={t('dialogue.usageHint')}
        style={{ fontSize: 11 }}
        banner
      />

      <div>
        <div style={{ fontSize: 12, marginBottom: 4, color: 'var(--text-secondary)' }}>
          {t('dialogue.selectCharacter')}
        </div>
        <Select
          style={{ width: '100%' }}
          placeholder={t('dialogue.selectCharacterPlaceholder')}
          value={selectedCharId}
          onChange={setSelectedCharId}
          showSearch
          optionFilterProp="label"
          options={characters.map((c) => ({ value: c.id, label: c.name }))}
        />
      </div>

      {selectedChar && (
        <Card
          size="small"
          style={{ background: 'var(--bg-secondary, rgba(0,0,0,0.02))' }}
          title={<span style={{ fontSize: 12 }}>{selectedChar.name} — {t('dialogue.anchor')}</span>}
        >
          <Space wrap size={[4, 4]}>
            {selectedChar.psyche?.coreBelief && (
              <Tag color="red" style={{ fontSize: 10 }}>{t('psyche.coreBelief')}: {selectedChar.psyche.coreBelief}</Tag>
            )}
            {selectedChar.psyche?.taboo && (
              <Tag color="volcano" style={{ fontSize: 10 }}>{t('psyche.taboo')}: {selectedChar.psyche.taboo}</Tag>
            )}
            {selectedChar.voiceAnchor?.verbalTic && (
              <Tag color="blue" style={{ fontSize: 10 }}>{t('psyche.verbalTic')}: {selectedChar.voiceAnchor.verbalTic}</Tag>
            )}
            {selectedChar.voiceAnchor?.speechStyle && (
              <Tag color="geekblue" style={{ fontSize: 10 }}>{t('psyche.speechStyle')}: {selectedChar.voiceAnchor.speechStyle}</Tag>
            )}
            {selectedChar.voiceAnchor?.mentalState && (
              <Tag color="purple" style={{ fontSize: 10 }}>{t('psyche.mentalState')}: {selectedChar.voiceAnchor.mentalState}</Tag>
            )}
          </Space>
        </Card>
      )}

      <div>
        <div style={{ fontSize: 12, marginBottom: 4, color: 'var(--text-secondary)' }}>
          {t('dialogue.sceneDesc')}
        </div>
        <TextArea
          rows={3}
          value={sceneDesc}
          onChange={(e) => setSceneDesc(e.target.value)}
          placeholder={t('dialogue.sceneDescPlaceholder')}
        />
      </div>

      <Button
        type="primary"
        icon={<MessageOutlined />}
        onClick={handleGenerate}
        loading={generating}
        disabled={!selectedChar || !sceneDesc.trim()}
        block
      >
        {generating ? t('dialogue.generating') : t('dialogue.generate')}
      </Button>

      {generated ? (
        <Card
          size="small"
          style={{ background: 'var(--bg-secondary, rgba(0,0,0,0.02))', flex: 1, overflow: 'auto' }}
          title={
            <span style={{ fontSize: 12 }}>
              {selectedChar?.name} {t('dialogue.result')}
            </span>
          }
          extra={
            <Space>
              <Button type="text" size="small" icon={<CopyOutlined />} onClick={handleCopy} />
              <Button type="text" size="small" icon={<ReloadOutlined />} onClick={handleGenerate} loading={generating} />
            </Space>
          }
        >
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.8 }}>{generated}</div>
        </Card>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty description={t('dialogue.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </div>
      )}
    </div>
  );
};

export default DialogueGeneratorPanel;
