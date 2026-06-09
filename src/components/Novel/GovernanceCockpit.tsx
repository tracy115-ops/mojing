// ============================================================================
// Narrative Governance Cockpit — Contract, budget, promises, suggestions
// Inspired by PlotPilot's NarrativeGovernanceCockpit.vue
// ============================================================================

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Card, Row, Col, Statistic, Tag, Space, Button, Form, Input, Select, Typography, Divider, List, Progress, Tooltip, Empty, message,
} from 'antd';
import {
  SafetyCertificateOutlined, CheckCircleOutlined, WarningOutlined,
  EditOutlined, ThunderboltOutlined, FileProtectOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { GovernanceEngine, type NarrativeContract, type GovernanceReport } from '@/services/novel/governance-engine';
import { NarrativeRepository } from '@/services/novel/narrative-repository';

const { TextArea } = Input;
const { Text } = Typography;

interface GovernanceCockpitProps {
  novelId: string;
}

const GovernanceCockpit: React.FC<GovernanceCockpitProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [engine] = useState(() => new GovernanceEngine(novelId));
  const [repo] = useState(() => new NarrativeRepository(novelId));

  // Auto-refresh tick — increments every 10s to re-read from localStorage
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(v => v + 1), []);
  useEffect(() => { const i = setInterval(refresh, 10000); return () => clearInterval(i); }, [refresh]);

  const [contract, setContract] = useState<NarrativeContract | null>(() => {
    const existing = engine.loadContract();
    if (existing) return existing;
    // Auto-create a default contract from novel metadata so users have something to start with
    const bible = new NarrativeRepository(novelId).loadBible();
    const title = bible.timelineNotes?.[0]?.event ?? '';
    const defaultContract = engine.createDefaultContract(novelId, title);
    engine.saveContract(defaultContract);
    return defaultContract;
  });
  const [editingContract, setEditingContract] = useState(false);
  const [forbiddenReveals, setForbiddenReveals] = useState(contract?.forbiddenReveals ?? []);
  const [form] = Form.useForm();

  // Load latest governance report — tick dependency forces re-read from localStorage
  const latestReport = useMemo((): GovernanceReport | null => {
    if (!contract) return null;
    const foreshadowing = repo.loadForeshadowing();
    const debts = repo.loadNarrativeDebts();
    const totalChapters = foreshadowing.length > 0
      ? Math.max(...foreshadowing.map((f) => f.plantedInChapter), 1)
      : 1;
    const currentChapter = totalChapters;

    return engine.generateReport({
      chapterNumber: currentChapter,
      totalChapters,
      storyPhase: 'development',
      chapterContent: '',
      foreshadowing,
      debts,
    });
  }, [contract, engine, repo, tick]);

  // Stats
  const promiseHitRate = latestReport?.promiseHitRate ?? 0;
  const governanceScore = latestReport?.governanceScore ?? 100;
  const openDebts = repo.loadNarrativeDebts().filter((d) => d.status === 'open').length;
  const foreshadowing = repo.loadForeshadowing();
  const plantedCount = foreshadowing.filter((f) => f.status === 'planted').length;
  const resolvedCount = foreshadowing.filter((f) => f.status === 'resolved').length;

  // Contract editing
  const saveContract = async () => {
    const values = await form.validateFields();
    const c: NarrativeContract = {
      novelId,
      titlePromise: values.titlePromise,
      coreQuestion: values.coreQuestion,
      themeAnchors: (values.themeAnchors ?? '').split(/[,，]/).map((s: string) => s.trim()).filter(Boolean),
      forbiddenReveals,
      chapterBudget: {
        maxNewSubplots: values.maxNewSubplots ?? 1,
        maxNewCharacters: values.maxNewCharacters ?? 2,
        maxNewForeshadowing: values.maxNewForeshadowing ?? 2,
        minForeshadowingClosure: values.minForeshadowingClosure ?? 0,
        maxNarrativeDebt: values.maxNarrativeDebt ?? 3,
      },
      version: (contract?.version ?? 0) + 1,
      createdAt: contract?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    engine.saveContract(c);
    setContract(c);
    setEditingContract(false);
    message.success(t('governance.contract.saved'));
  };

  const startEdit = () => {
    if (contract) {
      form.setFieldsValue({
        titlePromise: contract.titlePromise,
        coreQuestion: contract.coreQuestion,
        themeAnchors: contract.themeAnchors.join(', '),
        maxNewSubplots: contract.chapterBudget.maxNewSubplots,
        maxNewCharacters: contract.chapterBudget.maxNewCharacters,
        maxNewForeshadowing: contract.chapterBudget.maxNewForeshadowing,
        minForeshadowingClosure: contract.chapterBudget.minForeshadowingClosure,
        maxNarrativeDebt: contract.chapterBudget.maxNarrativeDebt,
      });
    } else {
      const defaultContract = engine.createDefaultContract(novelId, '');
      form.setFieldsValue({
        titlePromise: defaultContract.titlePromise,
        coreQuestion: defaultContract.coreQuestion,
        themeAnchors: defaultContract.themeAnchors.join(', '),
        maxNewSubplots: defaultContract.chapterBudget.maxNewSubplots,
        maxNewCharacters: defaultContract.chapterBudget.maxNewCharacters,
        maxNewForeshadowing: defaultContract.chapterBudget.maxNewForeshadowing,
        minForeshadowingClosure: defaultContract.chapterBudget.minForeshadowingClosure,
        maxNarrativeDebt: defaultContract.chapterBudget.maxNarrativeDebt,
      });
    }
    setEditingContract(true);
  };

  // Score color
  function scoreColor(score: number): string {
    if (score >= 80) return '#22c55e';
    if (score >= 60) return '#f59e0b';
    return '#ef4444';
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header bar */}
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><SafetyCertificateOutlined style={{ marginRight: 6 }} />{t('governance.title')}</span>
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {/* Top: Key Metrics */}
        <Row gutter={8}>
          <Col span={6}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <Statistic
                title={t('governance.score')}
                value={governanceScore}
                suffix="/100"
                valueStyle={{ color: scoreColor(governanceScore), fontSize: 20 }}
                prefix={<SafetyCertificateOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <Statistic
                title={t('governance.hitRate')}
                value={Math.round(promiseHitRate * 100)}
                suffix="%"
                valueStyle={{ fontSize: 20 }}
                prefix={<CheckCircleOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <Statistic
                title={t('governance.openDebts')}
                value={openDebts}
                valueStyle={{ fontSize: 20, color: openDebts > 3 ? '#ef4444' : '#22c55e' }}
                prefix={<WarningOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small" style={{ textAlign: 'center' }}>
              <Statistic
                title={t('governance.closureRate')}
                value={foreshadowing.length > 0 ? Math.round((resolvedCount / foreshadowing.length) * 100) : 0}
                suffix="%"
                valueStyle={{ fontSize: 20 }}
              />
              <Text type="secondary" style={{ fontSize: 10 }}>{t('governance.closurePending', { count: plantedCount })}</Text>
            </Card>
          </Col>
        </Row>

        {/* Narrative Contract */}
        <Card
          size="small"
          title={<Space><FileProtectOutlined /> {t('governance.contract')}</Space>}
          extra={
            <Button size="small" icon={<EditOutlined />} onClick={startEdit}>
              {contract ? t('governance.contract.edit') : t('governance.contract.create')}
            </Button>
          }
          style={{ marginTop: 10 }}
        >
          {editingContract ? (
            <Form form={form} layout="vertical" size="small">
              <div style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 6, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)' }}>
                <Text style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('governance.contract.hint')}</Text>
              </div>
              <Form.Item name="titlePromise" label={t('governance.titlePromise')} rules={[{ required: true }]}>
                <Input placeholder={t('governance.titlePromisePlaceholder')} />
              </Form.Item>
              <Form.Item name="coreQuestion" label={t('governance.coreQuestion')} rules={[{ required: true }]}>
                <Input placeholder={t('governance.coreQuestionPlaceholder')} />
              </Form.Item>
              <Form.Item name="themeAnchors" label={t('governance.themeAnchors')}>
                <Input placeholder={t('governance.themeAnchorsPlaceholder')} />
              </Form.Item>
              <Divider style={{ margin: '8px 0' }} />
              <Text strong style={{ fontSize: 12 }}>{t('governance.chapterBudgetTitle')}</Text>
              <div style={{ marginBottom: 4 }}>
                <Text type="secondary" style={{ fontSize: 10 }}>{t('governance.budgetHint')}</Text>
              </div>
              <Row gutter={8}>
                <Col span={12}><Form.Item name="maxNewSubplots" label={t('governance.maxNewSubplots')}><Input type="number" min={0} /></Form.Item></Col>
                <Col span={12}><Form.Item name="maxNewCharacters" label={t('governance.maxNewCharacters')}><Input type="number" min={0} /></Form.Item></Col>
                <Col span={12}><Form.Item name="maxNewForeshadowing" label={t('governance.maxNewForeshadowing')}><Input type="number" min={0} /></Form.Item></Col>
                <Col span={12}><Form.Item name="minForeshadowingClosure" label={t('governance.minForeshadowingClosure')}><Input type="number" min={0} /></Form.Item></Col>
                <Col span={12}><Form.Item name="maxNarrativeDebt" label={t('governance.maxNarrativeDebt')}><Input type="number" min={0} /></Form.Item></Col>
              </Row>
              <Space>
                <Button type="primary" size="small" onClick={saveContract}>{t('common.save')}</Button>
                <Button size="small" onClick={() => setEditingContract(false)}>{t('common.cancel')}</Button>
              </Space>
            </Form>
          ) : contract ? (
            <div>
              <div style={{ marginBottom: 6 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('governance.titlePromise')}:</Text>
                <div style={{ fontSize: 12 }}>{contract.titlePromise}</div>
              </div>
              <div style={{ marginBottom: 6 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('governance.coreQuestion')}:</Text>
                <div style={{ fontSize: 12 }}>{contract.coreQuestion}</div>
              </div>
              <div style={{ marginBottom: 6 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('governance.themeAnchors')}:</Text>
                <div>{contract.themeAnchors.map((a) => <Tag key={a} style={{ fontSize: 10 }}>{a}</Tag>)}</div>
              </div>
              <Divider style={{ margin: '6px 0' }} />
              <Row gutter={8}>
                <Col span={8}><Text type="secondary" style={{ fontSize: 10 }}>{t('governance.maxNewSubplots')} ≤{contract.chapterBudget.maxNewSubplots}</Text></Col>
                <Col span={8}><Text type="secondary" style={{ fontSize: 10 }}>{t('governance.maxNewCharacters')} ≤{contract.chapterBudget.maxNewCharacters}</Text></Col>
                <Col span={8}><Text type="secondary" style={{ fontSize: 10 }}>{t('governance.maxNewForeshadowing')} ≤{contract.chapterBudget.maxNewForeshadowing}</Text></Col>
              </Row>
            </div>
          ) : (
            <Empty description={t('governance.noContract')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Card>

        {/* Governance Suggestions */}
        {latestReport && latestReport.suggestions.length > 0 && (
          <Card size="small" title={<Space><ThunderboltOutlined /> {t('governance.suggestions')}</Space>} style={{ marginTop: 10 }}>
            <List
              size="small"
              dataSource={latestReport.suggestions}
              renderItem={(suggestion, idx) => (
                <List.Item style={{ padding: '4px 0', fontSize: 12 }}>
                  <Space>
                    {suggestion.startsWith('⚠') || suggestion.startsWith('预算')
                      ? <WarningOutlined style={{ color: '#f59e0b' }} />
                      : <CheckCircleOutlined style={{ color: '#22c55e' }} />
                    }
                    <span>{suggestion}</span>
                  </Space>
                </List.Item>
              )}
            />
          </Card>
        )}

        {/* Forbidden Reveals */}
        {contract && contract.forbiddenReveals.length > 0 && (
          <Card size="small" title={t('governance.forbiddenReveals')} style={{ marginTop: 10 }}>
            {contract.forbiddenReveals.map((r, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <Tag color={r.status === 'forbidden' ? 'red' : r.status === 'revealed' ? 'green' : 'blue'} style={{ fontSize: 9 }}>
                  {r.status}
                </Tag>
                <Text style={{ fontSize: 11 }}>{r.description}</Text>
                <Text type="secondary" style={{ fontSize: 10 }}>Ch.{r.earliestChapter}</Text>
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
};

export default GovernanceCockpit;
