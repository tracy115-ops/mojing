import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { Button, List, Typography, Tag, message, Tooltip, Dropdown, Input } from 'antd';
import {
  PlusOutlined,
  CheckCircleOutlined,
  EditOutlined,
  FileTextOutlined,
  ApartmentOutlined,
  BookOutlined,
  DownloadOutlined,
  FolderOutlined,
  FolderOpenOutlined,
  MoreOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { useAutopilotStore } from '@/stores/autopilotStore';
import { useProviderStore } from '@/stores/providerStore';
import { AutopilotEngine } from '@/services/novel/autopilot-engine';
import type { AutopilotEvent } from '@/services/novel/autopilot-engine';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import type { NovelChapter, NovelMetadata, ChapterStatus } from '@/types';
import type { AutopilotState } from '@/types/pipeline';
import type { RelationshipTriple, TimelineAnchor, CompletedBeat, Foreshadowing } from '@/types/narrative';
import { useResizable } from '@/hooks/useResizable';
import ProjectList from '@/components/Common/ProjectList';
import ResizeHandle from '@/components/Common/ResizeHandle';
import NovelSetupWizard from './NovelSetupWizard';
import ChapterEditor from './ChapterEditor';
import AutopilotPanel from './AutopilotPanel';
import NarrativeWorkbench from './NarrativeWorkbench';
import ExportPanel from './ExportPanel';

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
  const addVolume = useProjectStore((s) => s.addVolume);
  const updateVolume = useProjectStore((s) => s.updateVolume);
  const deleteVolume = useProjectStore((s) => s.deleteVolume);
  const moveChapterToVolume = useProjectStore((s) => s.moveChapterToVolume);
  const endpoints = useProviderStore((s) => s.endpoints);

  const setAutopilotState = useAutopilotStore((s) => s.setAutopilotState);
  const setBreaker = useAutopilotStore((s) => s.setBreaker);
  const setActiveEngine = useAutopilotStore((s) => s.setActiveEngine);
  const setBeatProgress = useAutopilotStore((s) => s.setBeatProgress);

  const [createOpen, setCreateOpen] = useState(false);
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [showWorkbench, setShowWorkbench] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [collapsedVolumes, setCollapsedVolumes] = useState<Set<string>>(new Set());
  const [editingVolumeId, setEditingVolumeId] = useState<string | null>(null);
  const [editingVolumeTitle, setEditingVolumeTitle] = useState('');
  const [narrativeData, setNarrativeData] = useState<{
    triples: RelationshipTriple[];
    anchors: TimelineAnchor[];
    beats: CompletedBeat[];
    foreshadowing: Foreshadowing[];
  }>({ triples: [], anchors: [], beats: [], foreshadowing: [] });

  const engineRef = useRef<AutopilotEngine | null>(null);

  const { width: workbenchWidth, handleProps: resizeHandleProps, isDragging: isResizing } = useResizable({
    minWidth: 320,
    maxViewportFraction: 0.7,
    defaultWidth: 460,
    storageKey: 'mojing-workbench-width',
  });

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

  const handleWizardComplete = (result: {
    values: { title: string; description: string; genre: string; targetWordCount: number; style: string; language: string };
    worldbuilding: Record<string, { key: string; value: string }[]>;
    styleConvention: string;
    characters: any[];
    locations: any[];
    plotOutline: any;
  }) => {
    const { values, worldbuilding: wb, styleConvention: style, characters: chars, locations: locs, plotOutline: plot } = result;
    const project = useProjectStore.getState().createProject('novel', values.title, values.description, {
      genre: values.genre,
      targetWordCount: values.targetWordCount,
      style: values.style,
      language: values.language,
    } as Partial<NovelMetadata>);
    setActiveProject(project.id);
    setCreateOpen(false);

    // Persist Bible data from wizard
    const repo = new NarrativeRepository(project.id);
    const bible = repo.loadBible();

    // Save style convention
    if (style) {
      bible.styleNotes = [{ id: 'style-convention', key: '文风公约', value: style }];
    }

    // Save world settings
    bible.worldSettings = Object.entries(wb).flatMap(([dim, items]) =>
      items.filter((i) => i.key).map((item) => ({
        id: `ws_${dim}_${item.key}`,
        category: dim,
        name: item.key,
        description: item.value,
        constraints: [],
      }))
    );

    // Save characters
    bible.characters = chars.map((c) => ({
      id: `char_${c.name}`,
      name: c.name,
      aliases: [],
      description: c.description || '',
      appearance: c.appearance || '',
      personality: c.personality || '',
      backstory: c.backstory || '',
      relationships: (c.relationships || []).map((r: any) => ({
        targetCharacterId: `char_${r.target}`,
        type: r.type || '',
        description: r.description || '',
        sinceChapter: 0,
      })),
      currentState: 'active',
      firstAppearChapter: 0,
      lastUpdateChapter: 0,
      importance: c.importance || 'supporting',
      status: 'active' as const,
    }));

    // Save locations
    bible.locations = locs.map((l) => ({
      id: `loc_${l.name}`,
      name: l.name,
      description: l.description || '',
      parentLocation: l.parentLocation || undefined,
      significance: l.significance || '',
    }));

    repo.saveBible(bible);

    // Save plot outline as a timeline note if available
    if (plot) {
      const notes = bible.timelineNotes || [];
      notes.push({
        id: 'plot-outline',
        chapter: 0,
        event: `剧情总纲: ${plot.mainPlot || ''}`,
        significance: plot.coreConflict || '',
      });
      bible.timelineNotes = notes;
      repo.saveBible(bible);
    }

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
          setShowWorkbench(true);
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

  // Volume-grouped chapter list
  const volumes = novelMeta?.volumes ?? [];
  const unassignedChapters = chapters.filter((c) => !c.volumeId);
  const volumeGroups = useMemo(() => {
    return volumes.map((v) => ({
      volume: v,
      chapters: chapters.filter((c) => c.volumeId === v.id),
    }));
  }, [volumes, chapters]);

  const toggleVolumeCollapse = (volumeId: string) => {
    setCollapsedVolumes((prev) => {
      const next = new Set(prev);
      if (next.has(volumeId)) next.delete(volumeId);
      else next.add(volumeId);
      return next;
    });
  };

  const handleAddVolume = () => {
    if (!activeProjectId) return;
    addVolume(activeProjectId);
  };

  const handleDeleteVolume = (volumeId: string) => {
    if (!activeProjectId) return;
    deleteVolume(activeProjectId, volumeId);
  };

  const handleRenameVolume = (volumeId: string) => {
    if (!activeProjectId || !editingVolumeTitle.trim()) return;
    updateVolume(activeProjectId, volumeId, { title: editingVolumeTitle.trim() });
    setEditingVolumeId(null);
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
        // Update live word count, progress, and streaming content in store
        store.setAutopilotState(event.novelId, {
          currentWordCount: (event.data.wordCount as number) ?? 0,
          ...(event.data.progress != null ? { progress: event.data.progress as number } : {}),
          ...(event.data.content != null ? { currentChapterContent: event.data.content as string } : {}),
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
        // Auto-show workbench when data arrives
        if (narrative && (narrative.triples.length > 0 || narrative.anchors.length > 0 || narrative.foreshadowing.length > 0)) {
          setShowWorkbench(true);
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
          const err = (event.data.error as string) || t('autopilot.circuitBreakerMsg');
          store.setAutopilotState(event.novelId, { lastError: err });
        }
        if (event.data.status === 'idle' || event.data.status === 'completed' || event.data.status === 'error') {
          // Clear streaming content on completion
          store.setAutopilotState(event.novelId, { currentChapterContent: undefined });
          // Final narrative data refresh and persist
          refreshAndPersist();
          // Auto-show workbench on completion
          const data = engineRef.current?.getNarrativeData();
          if (data && (data.triples.length > 0 || data.anchors.length > 0 || data.foreshadowing.length > 0)) {
            setShowWorkbench(true);
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

      // --- Beat events ---
      case 'beat_plan':
        setBeatProgress(event.novelId, {
          totalBeats: (event.data.beats as { index: number }[])?.length ?? 0,
          currentBeatIndex: 0,
          currentFocus: null,
          currentPhase: null,
          beatWordCount: 0,
          chapterWordCount: 0,
        });
        break;

      case 'beat_start':
        setBeatProgress(event.novelId, {
          currentBeatIndex: (event.data.beatIndex as number) ?? 0,
          currentFocus: (event.data.focus as string) as 'action' | 'dialogue' | 'sensory' | 'emotion' | 'suspense' | 'hook' | 'character_intro' | 'narration' | null,
          currentTargetWords: (event.data.targetWords as number) ?? 0,
          currentPhase: (event.data.phase as string) as 'unfurl' | 'converge' | 'land' | null,
          beatWordCount: 0,
        });
        break;

      case 'beat_complete':
        setBeatProgress(event.novelId, {
          currentBeatIndex: (event.data.beatIndex as number) ?? 0,
          beatWordCount: (event.data.wordCount as number) ?? 0,
          chapterWordCount: (event.data.totalWords as number) ?? 0,
        });
        break;
    }
  }, [persistNarrative, setBeatProgress]);

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
            {/* Chapter list with volume grouping */}
            <div style={{ width: 200, borderRight: '1px solid var(--border-secondary)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)', fontWeight: 600, fontSize: 13 }}>
                {t('novel.chapters')} ({chapters.length})
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                {/* Volume groups */}
                {volumeGroups.map(({ volume, chapters: volChapters }) => {
                  const isCollapsed = collapsedVolumes.has(volume.id);
                  const isEditing = editingVolumeId === volume.id;
                  return (
                    <div key={volume.id}>
                      <div
                        style={{
                          padding: '6px 10px',
                          background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
                          borderBottom: '1px solid var(--border-secondary)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          cursor: 'pointer',
                          userSelect: 'none',
                        }}
                        onClick={() => toggleVolumeCollapse(volume.id)}
                      >
                        {isCollapsed ? <FolderOutlined style={{ fontSize: 11 }} /> : <FolderOpenOutlined style={{ fontSize: 11 }} />}
                        {isEditing ? (
                          <Input
                            size="small"
                            value={editingVolumeTitle}
                            onChange={(e) => setEditingVolumeTitle(e.target.value)}
                            onPressEnter={() => handleRenameVolume(volume.id)}
                            onBlur={() => handleRenameVolume(volume.id)}
                            onClick={(e) => e.stopPropagation()}
                            style={{ flex: 1, fontSize: 12, height: 20 }}
                            autoFocus
                          />
                        ) : (
                          <Text strong style={{ flex: 1, fontSize: 12 }} ellipsis>{volume.title}</Text>
                        )}
                        <Text type="secondary" style={{ fontSize: 10 }}>{volChapters.length}</Text>
                        <Dropdown
                          menu={{
                            items: [
                              { key: 'rename', label: t('novel.renameVolume'), onClick: () => { setEditingVolumeId(volume.id); setEditingVolumeTitle(volume.title); } },
                              { key: 'delete', label: t('common.delete'), danger: true, onClick: () => handleDeleteVolume(volume.id) },
                            ],
                          }}
                          trigger={['click']}
                        >
                          <Button type="text" size="small" icon={<MoreOutlined />} style={{ fontSize: 10 }} onClick={(e) => e.stopPropagation()} />
                        </Dropdown>
                      </div>
                      {!isCollapsed && volChapters.map((chapter) => (
                        <div
                          key={chapter.id}
                          onClick={() => setActiveChapterId(chapter.id)}
                          style={{
                            padding: '5px 12px 5px 28px',
                            cursor: 'pointer',
                            background: activeChapterId === chapter.id ? 'var(--bg-active, rgba(59,130,246,0.08))' : 'transparent',
                            borderLeft: activeChapterId === chapter.id ? '3px solid var(--accent-primary, #3b82f6)' : '3px solid transparent',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          {STATUS_ICONS[chapter.status]}
                          <Text ellipsis style={{ flex: 1, fontSize: 12 }}>{chapter.title || t('novel.chapterN', { order: chapter.order + 1 })}</Text>
                          <Text type="secondary" style={{ fontSize: 10 }}>{chapter.wordCount}</Text>
                        </div>
                      ))}
                    </div>
                  );
                })}

                {/* Unassigned chapters */}
                {unassignedChapters.length > 0 && (volumes.length > 0 ? (
                  <>
                    <div style={{ padding: '6px 10px', background: 'var(--bg-secondary, rgba(0,0,0,0.02))', borderBottom: '1px solid var(--border-secondary)' }}>
                      <Text type="secondary" style={{ fontSize: 11 }}>{t('novel.unassignedChapters')}</Text>
                    </div>
                    {unassignedChapters.map((chapter) => (
                      <div
                        key={chapter.id}
                        onClick={() => setActiveChapterId(chapter.id)}
                        style={{
                          padding: '5px 12px 5px 28px',
                          cursor: 'pointer',
                          background: activeChapterId === chapter.id ? 'var(--bg-active, rgba(59,130,246,0.08))' : 'transparent',
                          borderLeft: activeChapterId === chapter.id ? '3px solid var(--accent-primary, #3b82f6)' : '3px solid transparent',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        {STATUS_ICONS[chapter.status]}
                        <Text ellipsis style={{ flex: 1, fontSize: 12 }}>{chapter.title || t('novel.chapterN', { order: chapter.order + 1 })}</Text>
                        <Text type="secondary" style={{ fontSize: 10 }}>{chapter.wordCount}</Text>
                      </div>
                    ))}
                  </>
                ) : (
                  unassignedChapters.map((chapter) => (
                    <div
                      key={chapter.id}
                      onClick={() => setActiveChapterId(chapter.id)}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        background: activeChapterId === chapter.id ? 'var(--bg-active, rgba(59,130,246,0.08))' : 'transparent',
                        borderLeft: activeChapterId === chapter.id ? '3px solid var(--accent-primary, #3b82f6)' : '3px solid transparent',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      {STATUS_ICONS[chapter.status]}
                      <Text ellipsis style={{ flex: 1, fontSize: 12 }}>{chapter.title || t('novel.chapterN', { order: chapter.order + 1 })}</Text>
                      <Text type="secondary" style={{ fontSize: 10 }}>{chapter.wordCount}</Text>
                    </div>
                  ))
                ))}
              </div>
              <div style={{ padding: 8, borderTop: '1px solid var(--border-secondary)', display: 'flex', gap: 4 }}>
                <Button size="small" icon={<PlusOutlined />} onClick={handleAddChapter} style={{ flex: 1 }}>
                  {t('novel.addChapter')}
                </Button>
                <Tooltip title={t('novel.addVolume')}>
                  <Button size="small" icon={<BookOutlined />} onClick={handleAddVolume} />
                </Tooltip>
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

              {/* Editor area + optional Narrative Workbench right panel */}
              <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
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

                {/* Narrative Workbench right panel — replaces separate Bible + Narrative panels */}
                {showWorkbench && activeProjectId && (
                  <div style={{
                    width: workbenchWidth,
                    borderLeft: '1px solid var(--border-secondary)',
                    overflow: 'auto',
                    background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
                    position: 'relative',
                    flexShrink: 0,
                  }}>
                    <ResizeHandle
                      onPointerDown={resizeHandleProps.onPointerDown}
                      isDragging={isResizing}
                      position="left"
                    />
                    <NarrativeWorkbench
                      novelId={activeProjectId}
                      totalChapters={chapters.length}
                      currentChapter={chapters.filter((c) => c.content).length}
                    />
                  </div>
                )}
              </div>

              {/* Bottom toolbar with panel toggles */}
              {activeProjectId && (
                <div style={{
                  borderTop: '1px solid var(--border-secondary)',
                  padding: '4px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}>
                  <Tooltip title={t('workbench.toggleHint')}>
                    <Button
                      size="small"
                      type={showWorkbench ? 'primary' : 'default'}
                      ghost={showWorkbench}
                      icon={<ApartmentOutlined />}
                      onClick={() => setShowWorkbench(!showWorkbench)}
                    >
                      {t('workbench.toggle')}
                    </Button>
                  </Tooltip>
                  <Tooltip title={t('export.title')}>
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      disabled={chapters.filter((c) => c.content).length === 0}
                      onClick={() => setExportOpen(true)}
                    >
                      {t('common.export')}
                    </Button>
                  </Tooltip>
                  {narrativeData.foreshadowing.length > 0 && (
                    <Tag color="purple" style={{ fontSize: 10 }}>
                      {narrativeData.foreshadowing.filter((f) => f.status === 'planted').length} {t('novel.engine.foreshadowing')}
                    </Tag>
                  )}
                </div>
              )}

            </div>
          </div>
        )}
      </div>

      <NovelSetupWizard open={createOpen} onComplete={handleWizardComplete} onCancel={() => setCreateOpen(false)} />
      {activeProject && exportOpen && (
        <ExportPanel
          onClose={() => setExportOpen(false)}
          title={activeProject.title}
          chapters={chapters}
        />
      )}
    </div>
  );
};

export default NovelView;
