import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { Button, List, Typography, Tag, message, Tooltip } from 'antd';
import {
  PlusOutlined,
  CheckCircleOutlined,
  EditOutlined,
  FileTextOutlined,
  ApartmentOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { useAutopilotStore } from '@/stores/autopilotStore';
import { useProviderStore } from '@/stores/providerStore';
import { AutopilotEngine } from '@/services/novel/autopilot-engine';
import type { AutopilotEvent } from '@/services/novel/autopilot-engine';
import type { NovelChapter, NovelMetadata, ChapterStatus } from '@/types';
import type { AutopilotState } from '@/types/pipeline';
import type { RelationshipTriple, TimelineAnchor, CompletedBeat, Foreshadowing } from '@/types/narrative';
import ProjectList from '@/components/Common/ProjectList';
import CreateNovelModal from './CreateNovelModal';
import ChapterEditor from './ChapterEditor';
import AutopilotPanel from './AutopilotPanel';
import NarrativePanel from './NarrativePanel';

const { Text } = Typography;

const STATUS_ICONS: Record<ChapterStatus, React.ReactNode> = {
  planned: <FileTextOutlined style={{ color: 'var(--text-tertiary)' }} />,
  drafting: <EditOutlined style={{ color: '#3b82f6' }} />,
  revising: <EditOutlined style={{ color: '#f59e0b' }} />,
  complete: <CheckCircleOutlined style={{ color: '#22c55e' }} />,
};

const NovelView: React.FC = () => {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const toggleFavorite = useProjectStore((s) => s.toggleFavorite);
  const addChapter = useProjectStore((s) => s.addChapter);
  const deleteChapter = useProjectStore((s) => s.deleteChapter);
  const updateChapter = useProjectStore((s) => s.updateChapter);
  const updateNarrativeData = useProjectStore((s) => s.updateNarrativeData);
  const endpoints = useProviderStore((s) => s.endpoints);

  const setAutopilotState = useAutopilotStore((s) => s.setAutopilotState);
  const setBreaker = useAutopilotStore((s) => s.setBreaker);
  const setActiveEngine = useAutopilotStore((s) => s.setActiveEngine);

  const [createOpen, setCreateOpen] = useState(false);
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [showNarrative, setShowNarrative] = useState(false);
  const [narrativeData, setNarrativeData] = useState<{
    triples: RelationshipTriple[];
    anchors: TimelineAnchor[];
    beats: CompletedBeat[];
    foreshadowing: Foreshadowing[];
  }>({ triples: [], anchors: [], beats: [], foreshadowing: [] });

  const engineRef = useRef<AutopilotEngine | null>(null);

  const novelProjects = useMemo(
    () => projects.filter((p) => p.type === 'novel'),
    [projects],
  );

  const activeProject = projects.find((p) => p.id === activeProjectId && p.type === 'novel');
  const novelMeta = activeProject?.metadata as NovelMetadata | undefined;
  const chapters = novelMeta?.chapters ?? [];
  const activeChapter = chapters.find((c) => c.id === activeChapterId);
  const hasEndpoint = endpoints.length > 0;

  // Initialize narrative data from persisted project on mount / project change
  useEffect(() => {
    if (activeProject?.type === 'novel') {
      const meta = activeProject.metadata as NovelMetadata;
      const saved = meta.narrativeData;
      if (saved) {
        setNarrativeData({
          triples: saved.triples,
          anchors: saved.anchors,
          beats: saved.beats,
          foreshadowing: saved.foreshadowing,
        });
      } else {
        setNarrativeData({ triples: [], anchors: [], beats: [], foreshadowing: [] });
      }
    }
  }, [activeProjectId]);

  const handleCreate = (values: { title: string; description: string; genre: string; targetWordCount: number; style: string; language: string }) => {
    const project = useProjectStore.getState().createProject('novel', values.title, values.description, {
      genre: values.genre,
      targetWordCount: values.targetWordCount,
      style: values.style,
      language: values.language,
    } as Partial<NovelMetadata>);
    setActiveProject(project.id);
    setCreateOpen(false);
    message.success(t('common.success'));
  };

  const handleSelectProject = (id: string) => {
    setActiveProject(id);
    const proj = useProjectStore.getState().projects.find((p) => p.id === id);
    if (proj?.type === 'novel') {
      const meta = proj.metadata as NovelMetadata;
      setActiveChapterId(meta.chapters[0]?.id ?? null);
      // Restore narrative data from persisted project
      const saved = meta.narrativeData;
      if (saved) {
        setNarrativeData({
          triples: saved.triples,
          anchors: saved.anchors,
          beats: saved.beats,
          foreshadowing: saved.foreshadowing,
        });
        if (saved.triples.length > 0 || saved.anchors.length > 0 || saved.foreshadowing.length > 0) {
          setShowNarrative(true);
        }
      } else {
        setNarrativeData({ triples: [], anchors: [], beats: [], foreshadowing: [] });
      }
    }
  };

  const handleUpdateChapter = (updates: Partial<NovelChapter>) => {
    if (!activeProjectId || !activeChapterId) return;
    updateChapter(activeProjectId, activeChapterId, updates);
  };

  const handleAddChapter = () => {
    if (!activeProjectId) return;
    addChapter(activeProjectId);
    const proj = useProjectStore.getState().projects.find((p) => p.id === activeProjectId);
    if (proj?.type === 'novel') {
      const meta = proj.metadata as NovelMetadata;
      setActiveChapterId(meta.chapters[meta.chapters.length - 1]?.id ?? null);
    }
  };

  // --- Autopilot ---

  // Helper: update narrative data in both local state and persisted store
  const persistNarrative = useCallback((data: { triples: RelationshipTriple[]; anchors: TimelineAnchor[]; beats: CompletedBeat[]; foreshadowing: Foreshadowing[] }) => {
    setNarrativeData(data);
    if (activeProjectId) {
      updateNarrativeData(activeProjectId, data);
    }
  }, [activeProjectId, updateNarrativeData]);

  const handleAutopilotEvent = useCallback((event: AutopilotEvent) => {
    const store = useAutopilotStore.getState();

    // Helper: refresh narrative from engine and persist
    const refreshAndPersist = () => {
      const data = engineRef.current?.getNarrativeData();
      if (data) {
        persistNarrative(data);
      }
    };

    switch (event.type) {
      case 'stage_change':
        store.setAutopilotState(event.novelId, {
          currentStage: event.data.stage as AutopilotState['currentStage'],
          currentChapterNumber: (event.data.chapter as number) ?? 0,
        });
        break;

      case 'chapter_progress':
        // Switch to the generating chapter (only when chapterId changes)
        if (event.data.chapterId) {
          setActiveChapterId(event.data.chapterId as string);
        }
        // Update live word count and progress in store
        store.setAutopilotState(event.novelId, {
          currentWordCount: (event.data.wordCount as number) ?? 0,
          ...(event.data.progress != null ? { progress: event.data.progress as number } : {}),
        });
        break;

      case 'chapter_complete': {
        // Engine sends narrative data directly in the event
        const narrative = event.data.narrative as { triples: RelationshipTriple[]; anchors: TimelineAnchor[]; beats: CompletedBeat[]; foreshadowing: Foreshadowing[] } | undefined;
        if (narrative) {
          persistNarrative(narrative);
        } else {
          refreshAndPersist();
        }
        // Auto-show narrative panel when data arrives
        if (narrative && (narrative.triples.length > 0 || narrative.anchors.length > 0 || narrative.foreshadowing.length > 0)) {
          setShowNarrative(true);
        }
        break;
      }

      case 'review_complete':
        break;

      case 'status_change':
        store.setAutopilotState(event.novelId, {
          status: event.data.status as AutopilotState['status'],
          ...(event.data.error ? { lastError: event.data.error as string } : {}),
        });
        if (event.data.reason === 'circuit_breaker') {
          const err = (event.data.error as string) || '连续失败次数过多，已自动暂停';
          store.setAutopilotState(event.novelId, { lastError: err });
        }
        if (event.data.status === 'idle' || event.data.status === 'completed' || event.data.status === 'error') {
          // Final narrative data refresh and persist
          refreshAndPersist();
          // Auto-show narrative panel on completion
          const data = engineRef.current?.getNarrativeData();
          if (data && (data.triples.length > 0 || data.anchors.length > 0 || data.foreshadowing.length > 0)) {
            setShowNarrative(true);
          }
          setActiveEngine(null);
          engineRef.current = null;
        }
        break;

      case 'error':
        store.setAutopilotState(event.novelId, {
          lastError: event.data.error as string,
        });
        break;
    }
  }, [persistNarrative]);

  const handleStartAutopilot = useCallback(() => {
    if (!activeProjectId || !activeProject) return;

    if (!hasEndpoint) {
      message.warning(t('provider.title') + ' — ' + t('provider.addEndpoint'));
      return;
    }

    const meta = novelMeta;
    if (!meta) return;

    const targetChapterCount = Math.max(1, Math.ceil(meta.targetWordCount / 3000));

    setAutopilotState(activeProjectId, {
      novelId: activeProjectId,
      status: 'running',
      currentStage: 'macro_planning',
      currentChapterNumber: meta.chapters.length,
      targetChapterCount,
      targetWordCount: meta.targetWordCount,
      currentWordCount: meta.currentWordCount,
      progress: 0,
      consecutiveFailures: 0,
    });

    setBreaker(activeProjectId, {
      state: 'closed',
      failureCount: 0,
      failureThreshold: 3,
      resetTimeoutMs: 60000,
    });

    const engine = new AutopilotEngine({
      novelId: activeProjectId,
      title: activeProject.title,
      genre: meta.genre,
      style: meta.style,
      targetChapterCount,
      targetWordCount: meta.targetWordCount,
      existingChapters: meta.chapters,
      onUpdateChapter: (chapterId, updates) => {
        useProjectStore.getState().updateChapter(activeProjectId, chapterId, updates);
      },
      onAddChapter: () => {
        useProjectStore.getState().addChapter(activeProjectId);
        const proj = useProjectStore.getState().projects.find((p) => p.id === activeProjectId);
        if (proj?.type === 'novel') {
          const m = proj.metadata as NovelMetadata;
          return m.chapters[m.chapters.length - 1].id;
        }
        return '';
      },
      onUpdateMetadata: () => {},
    });

    engine.onEvent(handleAutopilotEvent);
    engineRef.current = engine;
    setActiveEngine(activeProjectId);

    engine.start();
  }, [activeProjectId, activeProject, novelMeta, hasEndpoint, setAutopilotState, setBreaker, setActiveEngine, handleAutopilotEvent, t]);

  const handlePauseAutopilot = useCallback(() => {
    engineRef.current?.pause();
  }, []);

  const handleResumeAutopilot = useCallback(() => {
    engineRef.current?.resume();
  }, []);

  const handleStopAutopilot = useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
    if (activeProjectId) {
      setAutopilotState(activeProjectId, { status: 'idle', currentStage: 'idle' });
      setActiveEngine(null);
    }
  }, [activeProjectId, setAutopilotState, setActiveEngine]);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Left: Project list */}
      <div style={{ width: 220, borderRight: '1px solid var(--border-secondary)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ProjectList
          projects={novelProjects}
          type="novel"
          activeId={activeProjectId}
          onSelect={handleSelectProject}
          onDelete={deleteProject}
          onToggleFavorite={toggleFavorite}
          onCreate={() => setCreateOpen(true)}
        />
      </div>

      {/* Right: Workspace */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!activeProject ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
            <Text type="secondary">{t('novel.empty')}</Text>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            {/* Chapter list */}
            <div style={{ width: 180, borderRight: '1px solid var(--border-secondary)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)', fontWeight: 600, fontSize: 13 }}>
                {t('novel.chapters')} ({chapters.length})
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                <List
                  size="small"
                  dataSource={chapters}
                  renderItem={(chapter) => (
                    <List.Item
                      onClick={() => setActiveChapterId(chapter.id)}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        background: activeChapterId === chapter.id ? 'var(--bg-active, rgba(59,130,246,0.08))' : 'transparent',
                        borderLeft: activeChapterId === chapter.id ? '3px solid var(--accent-primary, #3b82f6)' : '3px solid transparent',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                        {STATUS_ICONS[chapter.status]}
                        <Text ellipsis style={{ flex: 1, fontSize: 12 }}>{chapter.title || `第${chapter.order + 1}章`}</Text>
                        <Text type="secondary" style={{ fontSize: 10 }}>{chapter.wordCount}</Text>
                      </div>
                    </List.Item>
                  )}
                  locale={{ emptyText: t('common.noData') }}
                />
              </div>
              <div style={{ padding: 8, borderTop: '1px solid var(--border-secondary)' }}>
                <Button size="small" icon={<PlusOutlined />} onClick={handleAddChapter} block>
                  {t('novel.addChapter')}
                </Button>
              </div>
            </div>

            {/* Main area: editor + optional narrative panel */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {/* Autopilot toolbar */}
              {activeProjectId && (
                <AutopilotPanel
                  novelId={activeProjectId}
                  novelTitle={activeProject.title}
                  genre={novelMeta?.genre ?? 'fantasy'}
                  targetWordCount={novelMeta?.targetWordCount ?? 100000}
                  currentWordCount={novelMeta?.currentWordCount ?? 0}
                  chapterCount={chapters.length}
                  onStart={handleStartAutopilot}
                  onPause={handlePauseAutopilot}
                  onResume={handleResumeAutopilot}
                  onStop={handleStopAutopilot}
                />
              )}

              {/* Editor area */}
              <div style={{ flex: 1, overflow: 'auto' }}>
                {activeChapter ? (
                  <ChapterEditor
                    chapter={activeChapter}
                    onUpdate={handleUpdateChapter}
                    allChapters={chapters}
                    novelTitle={activeProject.title}
                  />
                ) : (
                  <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Text type="secondary">{t('novel.addChapter')}</Text>
                  </div>
                )}
              </div>

              {/* Narrative panel toggle + panel */}
              {activeProjectId && (
                <>
                  <div style={{
                    borderTop: '1px solid var(--border-secondary)',
                    padding: '4px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}>
                    <Tooltip title={t('narrative.toggleHint')}>
                      <Button
                        size="small"
                        type={showNarrative ? 'primary' : 'default'}
                        ghost={showNarrative}
                        icon={<ApartmentOutlined />}
                        onClick={() => setShowNarrative(!showNarrative)}
                      >
                        {t('narrative.title')}
                      </Button>
                    </Tooltip>
                    {narrativeData.foreshadowing.length > 0 && (
                      <Tag color="purple" style={{ fontSize: 10 }}>
                        {narrativeData.foreshadowing.filter((f) => f.status === 'planted').length} {t('novel.engine.foreshadowing')}
                      </Tag>
                    )}
                  </div>

                  {showNarrative && (
                    <div style={{
                      height: 280,
                      borderTop: '1px solid var(--border-secondary)',
                      overflow: 'auto',
                      background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
                    }}>
                      <NarrativePanel
                        triples={narrativeData.triples}
                        anchors={narrativeData.anchors}
                        beats={narrativeData.beats}
                        foreshadowing={narrativeData.foreshadowing}
                        totalChapters={chapters.length}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <CreateNovelModal open={createOpen} onOk={handleCreate} onCancel={() => setCreateOpen(false)} />
    </div>
  );
};

export default NovelView;
