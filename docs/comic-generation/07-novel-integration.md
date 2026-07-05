# 07. 与小说引擎的集成(Novel pipeline 模式)

## 入口设计

对齐视频工坊已有的 "NovelView → 生成视频" 入口:

```
NovelView 工具栏  →  "生成漫画" 按钮  →  ComicFromNovelModal
                                              │
                                              ▼
                                     选小说项目 + 章节范围
                                              │
                                              ▼
                                     自动提取角色 + 生成 panels
                                              │
                                              ▼
                                     ComicPipeline 跑 6 步
```

## 创建漫画的三种入口(对齐视频)

| 入口 | 来源 | sourceMode |
|---|---|---|
| `CreateComicModal`(现有) | ComicView 顶部"新建漫画" | `pure`(Direct) |
| `DirectComicModal`(新) | 选 `extract` 模式,粘贴文本 | `extract` |
| `ComicFromNovelModal`(新) | NovelView / ComicView 选 `novel` | `novel` |

Phase 1 只做 `pure`,Phase 2 加 `extract` + `novel`。

## 数据映射:小说项目 → 漫画项目

### 现有小说数据结构

```typescript
// NovelProject(简化)
{
  id, title,
  characters: [{ id, name, appearance, personality, ... }],
  volumes: [{
    id, title,
    chapters: [{ id, title, content, status, wordCount }]
  }]
}
```

### 漫画侧需要的数据

```typescript
// ComicSceneSpec(目标)
{
  meta: { style, aspectRatio, panelLayout },
  characters: [{ id, name, appearance, ... }],   // ← 从小说复用
  panels: [{ description, dialogue, characterIds, ... }]  // ← LLM 从章节内容生成
}
```

### 映射规则

| NovelProject 字段 | ComicSceneSpec 字段 | 转换 |
|---|---|---|
| `characters[]` | `characters[]` | 直接复用(只取必要字段) |
| `volumes[].chapters[].content` | LLM 输入 | 拼接所选章节文本 |
| `volumes[].chapters[].title` | 漫画章节标题 | `${novelTitle} - ${chapterTitle}` |
| (新) | `meta.style` | 用户在 modal 选 |
| (新) | `meta.aspectRatio` | 用户在 modal 选 |
| (新) | `meta.panelLayout` | 用户在 modal 选 |

## Modal 设计:`ComicFromNovelModal`

```
┌─ 从小说生成漫画 ──────────────────────┐
│                                       │
│  小说项目:[下拉选]                    │
│            ▾                          │
│                                       │
│  卷:[全选▾]  章:[全选 / 手动勾选]    │
│  ┌────────────────────────────────┐  │
│  │ ☑ 第1章 开端                    │  │
│  │ ☑ 第2章 相遇                    │  │
│  │ ☐ 第3章 冲突                    │  │
│  │ ☐ 第4章 转折                    │  │
│  └────────────────────────────────┘  │
│                                       │
│  每章镜数:[6  ▾]                     │
│                                       │
│  画风:[manga ▾]  比例:[3:4 ▾]       │
│                                       │
│  ── 角色处理 ──                       │
│  ◉ 复用小说角色(推荐)               │
│  ○ 重新生成角色                       │
│                                       │
│              [取消]  [生成]           │
└───────────────────────────────────────┘
```

每选一章 → 创建一个独立 ComicProject。批量选 5 章 → 创建 5 个项目,UI 提示"将创建 5 个漫画项目"。

## 处理流程

```typescript
async function handleCreateComicFromNovel(values: FromNovelValues) {
  const novel = useNovelStore.getState().getProject(values.novelId);
  const selectedChapters = flattenChaptersBySelection(
    novel.volumes,
    values.chapterIds,
  );

  const created: string[] = [];
  for (const chapter of selectedChapters) {
    const comicProject = useComicStore.getState().createProject({
      type: 'comic',
      title: `${novel.title} - ${chapter.title}`,
      sourceMode: 'novel',
      novelProjectId: novel.id,
      novelChapterId: chapter.id,
      meta: {
        style: values.style,
        aspectRatio: values.aspectRatio,
        panelLayout: values.panelLayout,
      },
      characters: values.reuseCharacters
        ? mapNovelCharactersToComic(novel.characters)
        : [],
      panelCount: values.panelCount,
      sourceText: chapter.content,  // panel_script 用
    });

    created.push(comicProject.id);
  }

  message.success(`已创建 ${created.length} 个漫画项目`);
  // 跳到第一个项目的 pipeline panel
  setActiveComicProject(created[0]);
}
```

## panel_script stage 的 LLM 输入

Novel 模式下,LLM 拿到的输入是:

```
章节标题:第3章 相遇
章节内容:
{chapter.content}

本章出场角色(用户提供 / LLM 自动识别):
{characters.filter(c => appearsIn(chapter, c)).map(...)}
  - alice: 金发蓝眼,身高中等,穿白衬衫...
  - bob: 黑发眼镜,瘦高,穿黑色风衣...

期望分镜数:6

输出 JSON...
```

LLM 决策的细节:
- 哪些角色出现在第几镜(characterIds)
- 每镜从章节哪个片段取材(description)
- 对白优先用章节原文对白,无对白的镜可让 LLM 适度补充

## 角色复用策略

| 选项 | 行为 | 适用 |
|---|---|---|
| **复用小说角色**(默认) | 直接搬 `novel.characters` → `comic.characters` | 小说已有完善角色库 |
| **重新生成角色** | `character_anchor` stage 跑 LLM 重新提取 | 小说角色描述模糊 |

`mapNovelCharactersToComic`:

```typescript
function mapNovelCharactersToComic(
  novelChars: NovelCharacter[],
): ComicCharacter[] {
  return novelChars.map(nc => ({
    id: nc.id,                          // 保留原 ID,方便跨工坊引用
    name: nc.name,
    description: nc.personality || '',
    appearance: nc.appearance || '',
    referenceImages: [],                // character_anchor stage 会填
  }));
}
```

## 跨项目角色一致性(进阶)

如果同一小说的多个章节都生成漫画,理论上每个 ComicProject 独立跑 `character_anchor` 会让角色长相不一致。

**Phase 2 解法:**

第一次从小说创建漫画时,把 `novel.characters[].comicReferenceImage` 缓存到 NovelProject:

```typescript
// NovelCharacter(扩展)
{
  id, name, appearance, personality,
  comicReferenceImage?: string;   // ← 缓存
}
```

后续从同小说创建漫画时,`mapNovelCharactersToComic` 直接读 `comicReferenceImage`,**跳过 character_anchor stage**。

```typescript
function mapNovelCharactersToComic(novelChars: NovelCharacter[]) {
  return novelChars.map(nc => ({
    id: nc.id,
    name: nc.name,
    description: nc.personality || '',
    appearance: nc.appearance || '',
    referenceImages: nc.comicReferenceImage ? [nc.comicReferenceImage] : [],
  }));
}

// pipeline 里
if (allCharactersHaveReference(spec.characters)) {
  // 跳过 character_anchor
  setStageStatus(pid, 'character_anchor', 'skipped');
}
```

## 与视频工坊"从小说生成视频"的对照

| 维度 | 视频 | 漫画 |
|---|---|---|
| 入口按钮位置 | NovelView 工具栏 | NovelView 工具栏(并列) |
| 选择粒度 | 整本 / 单章 | 整本 / 单章 / 多章(批量) |
| 角色处理 | 复用 / 重生成 | 复用 / 重生成 |
| Pipeline 复用度 | 中(character_anchor + scene_image 共享) | 高(character_anchor 共享) |
| 跨项目一致性 | 暂未做 | Phase 2 做(comicReferenceImage 缓存) |

## NovelView 改动

NovelView 工具栏加并列按钮:

```tsx
<Button icon={<VideoCameraOutlined />} onClick={openVideoFromNovel}>
  生成视频
</Button>
<Button icon={<PictureOutlined />} onClick={openComicFromNovel}>
  生成漫画
</Button>
```

两个 modal 互斥(同时只能开一个)。

## 章节状态联动(可选,Phase 3)

可以在 NovelChapter 加字段:

```typescript
{
  id, title, content, status,
  comicProjectId?: string;   // 已生成的漫画项目 ID
}
```

章节列表右键菜单:
- "查看漫画" → 跳转到对应 ComicProject
- "重新生成漫画" → 删除旧的 + 创建新的

## 与现有 CreateComicModal 的整合

Phase 2 时,把现有 `CreateComicModal` 升级为三 mode 切换(对齐 `DirectVideoModal`):

```
┌─ 新建漫画 ─────────────────────────┐
│                                     │
│  来源:[● 直接输入 ○ 粘贴文本 ○ 从小说]│
│                                     │
│  ─── 直接输入表单(现有) ───        │
│  ...                                │
└─────────────────────────────────────┘
```

切换到"从小说"时,表单内容换成小说/章节选择。

## 总结

| Phase | 功能 |
|---|---|
| Phase 1 | 不做 novel 模式 |
| Phase 2 | `ComicFromNovelModal` + 单章创建 + 角色复用 |
| Phase 2.5 | 多章批量创建 + novelView 入口按钮 |
| Phase 3 | 跨项目角色一致性(comicReferenceImage 缓存) + 章节状态联动 |
