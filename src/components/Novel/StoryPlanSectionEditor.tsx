import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Input, Typography, message, type GetRef } from 'antd';
import { EditOutlined, FileSearchOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { reviewStoryPlanSection } from '@/services/novel/story-plan-review';
import type { StoryPlanFinding, StoryPlanSectionReview, StoryPlanText } from '@/services/novel/story-plan-section';
import { useProviderStore } from '@/stores/providerStore';

const { Text } = Typography;
const FIELD_LABELS: Record<string, string> = {
  mainPlot: 'wizard.mainPlot', coreConflict: 'storyPlan.conflict', themeMessage: 'storyPlan.theme',
  description: 'common.description', coreEvent: 'storyPlan.event', ending: 'wizard.ending',
};

interface Props {
  title: string;
  text: StoryPlanText;
  children: ReactNode;
  readContext: (text: StoryPlanText) => string;
  save: (before: StoryPlanText, after: StoryPlanText) => void;
}

export default function StoryPlanSectionEditor({ title, text, children, readContext, save }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const provider = useProviderStore(state => state.getActiveEndpoint('llm'));
  const [draft, setDraft] = useState<{ before: StoryPlanText; text: StoryPlanText } | null>(null);
  const [review, setReview] = useState<{ result: StoryPlanSectionReview; context: string; applied: boolean } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const inputs = useRef<Record<string, GetRef<typeof Input.TextArea> | null>>({});
  const results = useRef<HTMLDivElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (review && results.current?.getClientRects().length) results.current.scrollIntoView({ block: 'start' });
  }, [review]);

  const dirty = !!draft && Object.keys(draft.text).some(field => draft.before[field] !== draft.text[field]);
  const canApply = !!review && !review.applied && review.result.findings.some(finding => finding.replacement !== null);

  const startReview = async () => {
    if (!draft || controller.current) return;
    const job = new AbortController();
    controller.current = job;
    setReviewing(true);
    setReview(null);
    setError('');
    try {
      const context = readContext(draft.text);
      const result = await reviewStoryPlanSection(draft.text, context, job.signal);
      if (!job.signal.aborted) setReview({ result, context, applied: false });
    } catch (cause) {
      if (!job.signal.aborted) setError(t('storyPlan.reviewFailed', { detail: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      if (controller.current === job) {
        controller.current = undefined;
        setReviewing(false);
      }
    }
  };

  const commit = (useRevision: boolean) => {
    if (!draft) return;
    setError('');
    try {
      const result = useRevision ? review : null;
      if (result && readContext(draft.text) !== result.context) throw new Error(t('storyPlan.reviewStale'));
      const after = result?.result.revised ?? draft.text;
      for (const field of Object.keys(after)) {
        const required = ['mainPlot', 'ending', 'description'].includes(field) || (field === 'coreEvent' && draft.before[field].trim());
        if (required && !after[field].trim()) throw new Error(t('storyPlan.emptyField', { field: t(FIELD_LABELS[field]) }));
      }
      save(draft.before, after);
      setDraft({ before: after, text: after });
      setReview(result ? { ...result, applied: true } : null);
      message.success(t('common.saved'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const locate = (finding: StoryPlanFinding) => {
    if (!draft) return;
    const textarea = inputs.current[finding.field]?.resizableTextArea?.textArea;
    if (!textarea) return;
    const quote = review?.applied && finding.replacement !== null ? finding.replacement : finding.before;
    const start = quote ? textarea.value.indexOf(quote) : -1;
    textarea.focus();
    if (start >= 0) textarea.setSelectionRange(start, start + quote.length);
  };

  if (!draft) return <>
    <div className="story-plan__read-actions">
      <Button size="small" icon={<EditOutlined />} aria-label={t('storyPlan.editSection', { section: title })}
        onClick={() => setDraft({ before: text, text })}>{t('common.edit')}</Button>
    </div>
    {children}
  </>;

  return <div className="story-plan__editor" data-testid="story-plan-editor" role="region" aria-label={title}>
    {Object.entries(draft.text).map(([field, value]) => <label key={field} className="story-plan__field" htmlFor={id + field}>
      <Text strong>{t(FIELD_LABELS[field])}</Text>
      <Input.TextArea id={id + field} value={value} autoSize={{ minRows: 2, maxRows: 9 }} readOnly={reviewing}
        ref={input => { inputs.current[field] = input; }}
        onChange={event => {
          setDraft({ ...draft, text: { ...draft.text, [field]: event.target.value } });
          setReview(null);
          setError('');
        }} />
    </label>)}
    <div className="story-plan__actions">
      {dirty && <Button size="small" type="primary" disabled={reviewing} onClick={() => commit(false)}>{t('common.save')}</Button>}
      {reviewing
        ? <Button size="small" onClick={() => { controller.current?.abort(); controller.current = undefined; setReviewing(false); }}>{t('storyPlan.stopReview')}</Button>
        : <Button size="small" icon={<FileSearchOutlined />} disabled={!provider || !Object.values(draft.text).some(value => value.trim())}
            onClick={() => void startReview()}>{t('storyPlan.reviewSection')}</Button>}
      <Button size="small" type="text" disabled={reviewing} onClick={() => { setDraft(null); setReview(null); setError(''); }}>
        {t(dirty ? 'common.cancel' : 'storyPlan.doneEditing')}
      </Button>
    </div>
    {reviewing && <Text role="status" type="secondary">{t('storyPlan.reviewingSection')}</Text>}
    {!provider && <Text type="secondary">{t('storyPlan.needsModel')}</Text>}
    {error && <Alert type="warning" showIcon message={error} />}
    {review && <div ref={results} className="story-plan__editor" data-testid="story-plan-review-results">
      <div className="story-plan__actions story-plan__review-head">
        <Text strong role="status">{t(review.applied ? 'storyPlan.applied' : review.result.findings.length ? 'storyPlan.findings' : 'storyPlan.noFindings')}</Text>
        {canApply && <Button size="small" type="primary" onClick={() => commit(true)}>{t('storyPlan.apply')}</Button>}
      </div>
      {review.result.findings.map((finding, index) => <div className="story-plan__finding" key={index}>
        <Text>{finding.reason}</Text>
        {finding.replacement === null && <Text type="secondary">{t('storyPlan.authorCheck')}</Text>}
        <Button size="small" type="link" className="story-plan__locate" onClick={() => locate(finding)}>{t('storyPlan.locate')}</Button>
        <div className="story-plan__comparison">
          <div><Text type="secondary">{t('storyPlan.before')}</Text><div className="story-plan__quote">{finding.before}</div></div>
          {finding.replacement !== null && <div><Text type="secondary">{t(review.applied ? 'storyPlan.savedText' : 'storyPlan.proposedText')}</Text>
            <div className="story-plan__quote">{finding.replacement || t('storyPlan.removePassage')}</div></div>}
        </div>
        {finding.evidence && <div><Text type="secondary">{t('storyPlan.evidence')}</Text><div className="story-plan__quote">{finding.evidence}</div></div>}
      </div>)}
    </div>}
  </div>;
}
