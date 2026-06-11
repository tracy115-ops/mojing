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
  ReadOutlined,
  FolderOutlined,
  FolderOpenOutlined,
  MoreOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { useAutopilotStore } from '@/stores/autopilotStore';
import { useProviderStore } from '@/stores/providerStore';
import { AutopilotEngine } from '@/services/novel/autopilot-engine';
import type { AutopilotEvent } from '@/services/novel/autopilot-engine';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { StoryTreeService, type StoryTreeNode, type CreateNodeParams } from '@/services/novel/story-tree';
import type { NovelChapter, NovelMetadata, ChapterStatus } from '@/types';
import type { StoryNode, StoryNodeType } from '@/types/narrative';
import type { AutopilotState } from '@/types/pipeline';
import type { RelationshipTriple, TimelineAnchor, CompletedBeat, Foreshadowing } from '@/types/narrative';
import { useResizable } from '@/hooks/useResizable';
import { LAYOUT } from '@/design/layoutDensity';
import ProjectList from '@/components/Common/ProjectList';
import ResizeHandle from '@/components/Common/ResizeHandle';
import NovelSetupWizard from './NovelSetupWizard';
import ChapterEditor from './ChapterEditor';
import AutopilotPanel from './AutopilotPanel';
import NarrativeWorkbench from './NarrativeWorkbench';
import ExportPanel from './ExportPanel';
import ReaderPanel from './ReaderPanel';
import NovelInfoModal from './NovelInfoModal';

const { Text } = Typography;

// Target words per chapter for progress bar
const CHAPTER_TARGET_WORDS = 3000;

// Chinese number conversion for chapter labels
const CN_NUMS = ['零','一','二','三','四','五','六','七','八','九','十',
  '十一','十二','十三','十四','十五','十六','十七','十八','十九','二十'];
function toCnNum(n: number): string {
  if (n <= 20) return CN_NUMS[n] ?? String(n);
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return (tens === 2 ? '二十' : CN_NUMS[tens] + '十') + (ones ? CN_NUMS[ones] : '');
  }
  return String(n);
}

// Chapter row with status tag, progress bar and hover state
const STATUS_TAG: Record<string, { color: string; bg: string }> = {
  planned: { color: 'var(--text-tertiary)', bg: 'var(--bg-tertiary, rgba(0,0,0,0.04))' },
  drafting: { color: '#3b82f6', bg: 'rgba(59,130,246,0.08)' },
  revising: { color: '#f59e0b', bg: 'rgba(245,158,11,0.08)' },
  complete: { color: '#22c55e', bg: 'rgba(34,197,94,0.08)' },
};

const ChapterRow: React.FC<{
  node: StoryTreeNode;
  isActive: boolean;
  onClick: () => void;
}> = ({ node, isActive, onClick }) => {
  const { t } = useTranslation();
  const wordCount = node.wordCount ?? 0;
  const wordRatio = Math.min(1, wordCount / CHAPTER_TARGET_WORDS);
  const isDrafting = node.status === 'drafting';
  const globalIdx = node.globalChapterNumber ?? 0;
  const status = node.status ?? 'planned';

  const statusColor = STATUS_TAG[status]?.color ?? 'var(--text-tertiary)';

  const chapterLabel = node.title && node.title !== String(node.order + 1) && !/^第?\d+[章幕部]?$/.test(node.title)
    ? `第${toCnNum(globalIdx + 1)}章 ${node.title}`
    : `第${toCnNum(globalIdx + 1)}章`;

  const indent = 12 + node.indent * 14;
  const tag = STATUS_TAG[status] ?? STATUS_TAG.planned;

  return (
    <div
      onClick={onClick}
      style={{
        padding: `5px 12px 5px ${indent}px`,
        cursor: 'pointer',
        background: isActive ? 'var(--bg-active, rgba(59,130,246,0.08))' : 'transparent',
        borderLeft: isActive ? '3px solid var(--accent-primary, #3b82f6)' : '3px solid transparent',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover, rgba(0,0,0,0.03))'; }}
      onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{
          width: 6, height: 6, borderRadius: 3, flexShrink: 0,
          background: statusColor,
          animation: isDrafting ? 'pulse-dot 1.5s ease-in-out infinite' : 'none',
        }} />
        <Text ellipsis style={{ flex: 1, fontSize: 12 }}>
          {chapterLabel}
        </Text>
        <span style={{
          fontSize: 9, padding: '0 4px', borderRadius: 3, flexShrink: 0,
          color: tag.color, background: tag.bg, lineHeight: '16px',
        }}>
          {t(`novel.chapterStatus.${status}`)}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-tertiary)', flexShrink: 0 }}>
          {wordCount > 0 ? `${(wordCount / 1000).toFixed(1)}k` : '-'}
        </span>
      </div>
      {wordCount > 0 && (
        <div style={{
          height: 2, borderRadius: 1,
          background: 'var(--bg-tertiary, rgba(0,0,0,0.04))',
          marginLeft: 12, marginRight: 0,
        }}>
          <div style={{
            width: `${wordRatio * 100}%`, height: '100%',
            background: statusColor, borderRadius: 1,
            transition: 'width 0.3s',
          }} />
        </div>
      )}
    </div>
  );
};

// Recursive tree node for containers (part/volume/act)
const StoryTreeNodeRow: React.FC<{
  node: StoryTreeNode;
  activeChapterId: string | null;
  onSelectChapter: (id: string) => void;
  collapsed: Set<string>;
  onToggleCollapse: (id: string) => void;
  editingId: string | null;
  editingTitle: string;
  onEditStart: (id: string, title: string) => void;
  onEditConfirm: (id: string, newTitle: string) => void;
  onEditTitleChange: (val: string) => void;
  onDelete: (id: string) => void;
  onAddChild: (parentId: string, type: StoryNodeType) => void;
}> = ({ node, activeChapterId, onSelectChapter, collapsed, onToggleCollapse,
  editingId, editingTitle, onEditStart, onEditConfirm, onEditTitleChange,
  onDelete, onAddChild }) => {
  const { t } = useTranslation();
  const isEditing = editingId === node.id;
  const isCollapsed = collapsed.has(node.id);
  const indent = 10 + node.indent * 14;

  const childCount = node.children.reduce((sum, c) =>
    c.nodeType === 'chapter' ? sum + 1 : sum + StoryTreeService.getDescendantChapters([c], c.id).length + 1, 0);

  // Determine background shade by depth
  const bgAlpha = node.indent === 0 ? 0.02 : node.indent === 1 ? 0.04 : 0.06;

  const allowedChildren = StoryTreeService.allowedChildTypes(node.nodeType);

  return (
    <div>
      {/* Container header */}
      <div
        style={{
          padding: `${Math.max(4, 6 - node.indent)}px 10px ${Math.max(4, 6 - node.indent)}px ${indent}px`,
          background: `var(--bg-secondary, rgba(0,0,0,${bgAlpha}))`,
          borderBottom: '1px solid var(--border-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          cursor: 'pointer',
          userSelect: 'none',
          fontWeight: node.indent === 0 ? 700 : 600,
        }}
        onClick={() => onToggleCollapse(node.id)}
      >
        {isCollapsed ? <FolderOutlined style={{ fontSize: 10 }} /> : <FolderOpenOutlined style={{ fontSize: 10 }} />}
        {isEditing ? (
          <Input
            size="small"
            value={editingTitle}
            onChange={(e) => onEditTitleChange(e.target.value)}
            onPressEnter={() => onEditConfirm(node.id, editingTitle)}
            onBlur={() => onEditConfirm(node.id, editingTitle)}
            onClick={(e) => e.stopPropagation()}
            style={{ flex: 1, fontSize: 11, height: 18 }}
            autoFocus
          />
        ) : (
          <Text strong={node.indent === 0} style={{ flex: 1, fontSize: 12 - node.indent }} ellipsis>
            {node.title}
          </Text>
        )}
        <Text type="secondary" style={{ fontSize: 9 }}>{childCount}</Text>
        <Dropdown
          menu={{
            items: [
              ...allowedChildren
                .filter((t) => t !== 'chapter')
                .map((type) => ({
                  key: `add_${type}`,
                  label: t(`novel.add${type.charAt(0).toUpperCase() + type.slice(1)}`),
                  onClick: () => onAddChild(node.id, type),
                })),
              { type: 'divider' as const },
              { key: 'addChapter', label: t('novel.addChapter'), onClick: () => onAddChild(node.id, 'chapter') },
              { type: 'divider' as const },
              { key: 'rename', label: t('novel.renameVolume'), onClick: () => onEditStart(node.id, node.title) },
              { key: 'delete', label: t('novel.deleteWithChildren', { default: t('common.delete') }), danger: true, onClick: () => onDelete(node.id) },
            ],
          }}
          trigger={['click']}
        >
          <Button type="text" size="small" icon={<MoreOutlined />} style={{ fontSize: 9 }} onClick={(e) => e.stopPropagation()} />
        </Dropdown>
      </div>

      {/* Children */}
      {!isCollapsed && node.children.map((child) =>
        child.nodeType === 'chapter' ? (
          <ChapterRow
            key={child.id}
            node={child}
            isActive={activeChapterId === child.id}
            onClick={() => onSelectChapter(child.id)}
          />
        ) : (
          <StoryTreeNodeRow
            key={child.id}
            node={child}
            activeChapterId={activeChapterId}
            onSelectChapter={onSelectChapter}
            collapsed={collapsed}
            onToggleCollapse={onToggleCollapse}
            editingId={editingId}
            editingTitle={editingTitle}
            onEditStart={onEditStart}
            onEditConfirm={onEditConfirm}
            onEditTitleChange={onEditTitleChange}
            onDelete={onDelete}
            onAddChild={onAddChild}
          />
        ),
      )}
    </div>
  );
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

  // StoryNode methods
  const getStoryNodes = useProjectStore((s) => s.getStoryNodes);
  const createStoryNode = useProjectStore((s) => s.createStoryNode);
  const updateStoryNode = useProjectStore((s) => s.updateStoryNode);
  const deleteStoryNode = useProjectStore((s) => s.deleteStoryNode);

  const setAutopilotState = useAutopilotStore((s) => s.setAutopilotState);
  const setBreaker = useAutopilotStore((s) => s.setBreaker);
  const setActiveEngine = useAutopilotStore((s) => s.setActiveEngine);
  const setBeatProgress = useAutopilotStore((s) => s.setBeatProgress);

  const [createOpen, setCreateOpen] = useState(false);
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [showWorkbench, setShowWorkbench] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
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
    minWidth: LAYOUT.workbenchMinWidth,
    maxViewportFraction: LAYOUT.workbenchMaxViewportFraction,
    defaultWidth: LAYOUT.workbenchDefaultWidth,
    storageKey: 'mojing-workbench-width',
  });

  const novelProjects = useMemo(
    () => projects.filter((p) => p.type === 'novel'),
    [projects],
  );

  const activeProject = projects.find((p) => p.id === activeProjectId && p.type === 'novel');
  const novelMeta = activeProject?.metadata as NovelMetadata | undefined;

  // Derive chapters from storyNodes (unified model), fall back to legacy chapters
  const chapterNodes = useMemo(() => {
    if (!activeProjectId) return [];
    const nodes = getStoryNodes(activeProjectId);
    return nodes.filter((n) => n.nodeType === 'chapter').sort((a, b) => a.order - b.order);
  }, [activeProjectId, getStoryNodes, projects]);

  const chapters: NovelChapter[] = useMemo(() => {
    if (chapterNodes.length > 0) {
      return chapterNodes.map((n, i) => ({
        id: n.id,
        title: n.title,
        outline: n.outline ?? '',
        content: n.content ?? '',
        status: n.status ?? 'planned',
        wordCount: n.wordCount ?? 0,
        order: i,
        volumeId: n.parentId ?? undefined,
      }));
    }
    // Fallback to legacy
    return novelMeta?.chapters ?? [];
  }, [chapterNodes, novelMeta]);

  const currentWordCount = useMemo(() => chapters.reduce((s, c) => s + c.wordCount, 0), [chapters]);
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

  // Listen for global "new project" event from titlebar
  useEffect(() => {
    const handler = (e: Event) => {
      const { type } = (e as CustomEvent).detail;
      if (type === 'novel') setCreateOpen(true);
    };
    window.addEventListener('mojing:create-project', handler);
    return () => window.removeEventListener('mojing:create-project', handler);
  }, []);

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
      // Try StoryNode path first
      const nodes = useProjectStore.getState().getStoryNodes(id);
      const firstChapter = nodes.filter((n) => n.nodeType === 'chapter').sort((a, b) => a.order - b.order)[0];
      if (firstChapter) {
        setActiveChapterId(firstChapter.id);
      } else {
        setActiveChapterId(meta.chapters[0]?.id ?? null);
      }
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
    // Update legacy chapter (for backward compat with Export/Reader)
    updateChapter(activeProjectId, activeChapterId, updates);
    // Also update StoryNode
    updateStoryNode(activeProjectId, activeChapterId, {
      ...(updates.title !== undefined ? { title: updates.title } : {}),
      ...(updates.outline !== undefined ? { outline: updates.outline } : {}),
      ...(updates.content !== undefined ? { content: updates.content, wordCount: updates.content.length } : {}),
      ...(updates.status !== undefined ? { status: updates.status } : {}),
    });
  };

  const handleAddChapter = () => {
    if (!activeProjectId) return;
    createStoryNode(activeProjectId, { nodeType: 'chapter' });
    const nodes = useProjectStore.getState().getStoryNodes(activeProjectId);
    const chapters = nodes.filter((n) => n.nodeType === 'chapter').sort((a, b) => a.order - b.order);
    if (chapters.length > 0) setActiveChapterId(chapters[chapters.length - 1].id);
  };

  // --- StoryNode tree helpers ---

  const storyNodes = useMemo(() => {
    if (!activeProjectId) return [];
    return getStoryNodes(activeProjectId);
  }, [activeProjectId, getStoryNodes, projects]); // re-compute when projects change

  const tree = useMemo(() => StoryTreeService.buildTree(storyNodes), [storyNodes]);

  const toggleCollapse = (id: string) => {
    setCollapsedVolumes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleEditStart = (id: string, title: string) => {
    setEditingVolumeId(id);
    setEditingVolumeTitle(title);
  };

  const handleEditConfirm = (id: string, newTitle: string) => {
    if (!activeProjectId || !newTitle.trim() || editingVolumeId !== id) return;
    updateStoryNode(activeProjectId, id, { title: newTitle.trim() });
    setEditingVolumeId(null);
  };

  const handleDeleteNode = (nodeId: string) => {
    if (!activeProjectId) return;
    deleteStoryNode(activeProjectId, nodeId);
    if (activeChapterId === nodeId) setActiveChapterId(null);
  };

  const handleAddChild = (parentId: string, type: StoryNodeType) => {
    if (!activeProjectId) return;
    createStoryNode(activeProjectId, { nodeType: type, parentId });
  };

  const handleAddTopLevel = (type: StoryNodeType) => {
    if (!activeProjectId) return;
    createStoryNode(activeProjectId, { nodeType: type });
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
        // Keep StoryNode in sync
        useProjectStore.getState().updateStoryNode(activeProjectId, chapterId, {
          ...(updates.title !== undefined ? { title: updates.title } : {}),
          ...(updates.outline !== undefined ? { outline: updates.outline } : {}),
          ...(updates.content !== undefined ? { content: updates.content, wordCount: updates.content.length } : {}),
          ...(updates.status !== undefined ? { status: updates.status } : {}),
        });
      },
      onAddChapter: (volumeId?: string) => {
        useProjectStore.getState().addChapter(activeProjectId, volumeId);
        const proj = useProjectStore.getState().projects.find((p) => p.id === activeProjectId);
        if (proj?.type === 'novel') {
          const m = proj.metadata as NovelMetadata;
          return m.chapters[m.chapters.length - 1].id;
        }
        return '';
      },
      onAddVolume: (title: string) => {
        useProjectStore.getState().addVolume(activeProjectId, title);
        const proj = useProjectStore.getState().projects.find((p) => p.id === activeProjectId);
        if (proj?.type === 'novel') {
          const m = proj.metadata as NovelMetadata;
          return m.volumes[m.volumes.length - 1].id;
        }
        return '';
      },
      onUpdateMetadata: () => {},
      getChapters: () => {
        const proj = useProjectStore.getState().projects.find((p) => p.id === activeProjectId);
        if (proj?.type === 'novel') {
          return (proj.metadata as NovelMetadata).chapters;
        }
        return [];
      },
      // New StoryNode callbacks
      getStoryNodes: () => useProjectStore.getState().getStoryNodes(activeProjectId),
      onSetStoryNodes: (nodes) => useProjectStore.getState().setStoryNodes(activeProjectId, nodes),
      onUpdateStoryNode: (nodeId, updates) => useProjectStore.getState().updateStoryNode(activeProjectId, nodeId, updates),
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
      <div style={{ width: LAYOUT.projectListWidth, borderRight: '1px solid var(--border-secondary)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ProjectList
          projects={novelProjects}
          type="novel"
          activeId={activeProjectId}
          onSelect={handleSelectProject}
          onDelete={deleteProject}
          onToggleFavorite={toggleFavorite}
          onCreate={() => setCreateOpen(true)}
          onEditInfo={() => setInfoOpen(true)}
          onDuplicate={(id) => {
            const proj = novelProjects.find((p) => p.id === id);
            if (!proj) return;
            const newProj = useProjectStore.getState().createProject('novel', `${proj.title} (副本)`, proj.description ?? '', { ...(proj.metadata as NovelMetadata) });
            setActiveProject(newProj.id);
          }}
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
            {/* Chapter list — recursive tree */}
            <div style={{ width: LAYOUT.chapterListWidth, borderRight: '1px solid var(--border-secondary)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{t('novel.chapters')} ({storyNodes.filter((n) => n.nodeType === 'chapter').length})</span>
                <Tooltip title={t('project.info')}>
                  <InfoCircleOutlined
                    style={{ cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: 13 }}
                    onClick={() => setInfoOpen(true)}
                  />
                </Tooltip>
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                {tree.map((node) =>
                  node.nodeType === 'chapter' ? (
                    <ChapterRow
                      key={node.id}
                      node={node}
                      isActive={activeChapterId === node.id}
                      onClick={() => setActiveChapterId(node.id)}
                    />
                  ) : (
                    <StoryTreeNodeRow
                      key={node.id}
                      node={node}
                      activeChapterId={activeChapterId}
                      onSelectChapter={(id) => setActiveChapterId(id)}
                      collapsed={collapsedVolumes}
                      onToggleCollapse={toggleCollapse}
                      editingId={editingVolumeId}
                      editingTitle={editingVolumeTitle}
                      onEditStart={handleEditStart}
                      onEditConfirm={handleEditConfirm}
                      onEditTitleChange={setEditingVolumeTitle}
                      onDelete={handleDeleteNode}
                      onAddChild={handleAddChild}
                    />
                  ),
                )}

                {/* Flat unassigned chapters (only when no tree structure exists) */}
                {tree.length === 0 && chapters.length > 0 && chapters.map((chapter) => {
                  const gi = chapters.indexOf(chapter);
                  return (
                    <ChapterRow
                      key={chapter.id}
                      node={{
                        ...chapter,
                        novelId: activeProjectId!,
                        nodeType: 'chapter' as const,
                        parentId: null,
                        createdAt: '',
                        updatedAt: '',
                        indent: 0,
                        children: [],
                        globalChapterNumber: gi >= 0 ? gi : chapter.order,
                      }}
                      isActive={activeChapterId === chapter.id}
                      onClick={() => setActiveChapterId(chapter.id)}
                    />
                  );
                })}
              </div>
              <div style={{ padding: 8, borderTop: '1px solid var(--border-secondary)', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <Button size="small" icon={<PlusOutlined />} onClick={handleAddChapter} style={{ flex: 1 }}>
                  {t('novel.addChapter')}
                </Button>
                <Dropdown
                  menu={{
                    items: [
                      { key: 'part', label: t('novel.addPart'), onClick: () => handleAddTopLevel('part') },
                      { key: 'volume', label: t('novel.addVolume'), onClick: () => handleAddTopLevel('volume') },
                      { key: 'act', label: t('novel.addAct'), onClick: () => handleAddTopLevel('act') },
                    ],
                  }}
                  trigger={['click']}
                >
                  <Button size="small" icon={<BookOutlined />} />
                </Dropdown>
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
                  currentWordCount={currentWordCount}
                  chapterCount={chapters.length}
                  onStart={handleStartAutopilot}
                  onPause={handlePauseAutopilot}
                  onResume={handleResumeAutopilot}
                  onStop={handleStopAutopilot}
                />
              )}

              {/* Editor area + optional Narrative Workbench right panel */}
              <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                <div style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
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

                {/* Narrative Workbench right panel — animated collapse */}
                {activeProjectId && (
                  <div style={{
                    width: showWorkbench ? workbenchWidth : 0,
                    maxWidth: showWorkbench ? workbenchWidth : 0,
                    minWidth: 0,
                    borderLeft: '1px solid var(--border-secondary)',
                    overflowY: 'hidden',
                    overflowX: 'auto',
                    background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
                    position: 'relative',
                    flexShrink: 1,
                    transition: showWorkbench ? 'none' : 'width 0.25s ease-out',
                    opacity: 1,
                  }}>
                    <div style={{ width: workbenchWidth, minWidth: LAYOUT.workbenchMinWidth, height: '100%', position: 'relative' }}>
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
                  <Tooltip title={t('reader.title')}>
                    <Button
                      size="small"
                      icon={<ReadOutlined />}
                      disabled={chapters.filter((c) => c.content).length === 0}
                      onClick={() => setReaderOpen(true)}
                    >
                      {t('reader.title')}
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
      {activeProject && readerOpen && (
        <ReaderPanel
          title={activeProject.title}
          chapters={chapters}
          initialChapterId={activeChapterId}
          onClose={() => setReaderOpen(false)}
        />
      )}
      {activeProjectId && (
        <NovelInfoModal
          open={infoOpen}
          onClose={() => setInfoOpen(false)}
          projectId={activeProjectId}
        />
      )}
    </div>
  );
};

export default NovelView;
