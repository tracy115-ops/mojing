# 02 — 系统架构

## 分层

```
┌─────────────────────────────────────────────────────────────┐
│  UI 层                                                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ VideoGeneratorModal (3 阶段：config/running/done)   │   │
│  │ NovelView 底部工具栏按钮   /   VideoView 顶部按钮    │   │
│  └─────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │ 调用
┌──────────────────────────▼──────────────────────────────────┐
│  Pipeline 编排层                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ VideoPipeline                                       │   │
│  │   runScriptSlicing()    ← chapter-slicer.ts         │   │
│  │   runStoryboardPrompt() ← storyboard-prompt.ts       │   │
│  │   runVideoGeneration()  ← 并发=2 worker pool         │   │
│  │   runComposing()        ← ffmpeg-bridge.ts           │   │
│  └─────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │ 读写
┌──────────────────────────▼──────────────────────────────────┐
│  状态层                                                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ videoStore (Zustand)                                │   │
│  │   projects: Record<novelProjectId, VideoProjectState>│   │
│  │   stages: Record<VideoStage, VideoStageState>        │   │
│  │   shots / clips / audios / anchorImages              │   │
│  └─────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │ 调用
┌──────────────────────────▼──────────────────────────────────┐
│  模块服务层                                                  │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────┐│
│  │ chapter-slicer   │ │ storyboard-prompt│ │ ffmpeg-bridge││
│  │ (本地启发式)     │ │ (LLM 批处理)     │ │ (IPC 封装)   ││
│  └──────────────────┘ └──────────────────┘ └──────────────┘│
└──────────────────────────┬──────────────────────────────────┘
                           │ 调用
┌──────────────────────────▼──────────────────────────────────┐
│  Provider 抽象层（现有，复用）                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ providerRouter                                      │   │
│  │   generate(req)         → LLM                       │   │
│  │   generateImage(req)    → Image                     │   │
│  │   generateVideo(req)    → Video (Kling/Runway/Vidu) │   │
│  └─────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │ invoke (Tauri IPC)
┌──────────────────────────▼──────────────────────────────────┐
│  Tauri Rust 后端                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ffmpeg.rs                                           │   │
│  │   ffmpeg_probe()           可用性检测               │   │
│  │   ffmpeg_download_clip()    下载远程 URL            │   │
│  │   ffmpeg_compose_clips()    拼接+字幕硬编码         │   │
│  │                                                     │   │
│  │   使用 ffmpeg-sidecar crate 自动管理 FFmpeg 二进制  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 数据流（端到端）

```
[小说章节正文]
     ↓ chapter-slicer.sliceChapters()
[RawShot[]] — 段落级切片，含角色/场景/情绪识别
     ↓ storyboard-prompt.buildStoryboard()  (LLM)
[StoryboardShot[]] — 含 videoPrompt/imagePrompt/narration/cameraMovement
     ↓ providerRouter.generateVideo()  (Kling API, 并发=2)
[GeneratedClip[]] — 每个镜头一个 videoUrl
     ↓ ffmpeg-bridge.composeClips()
[final.mp4] — 拼接 + 字幕硬编码
     ↓
[VideoProjectState.finalVideoUrl]
     ↓
[VideoGeneratorModal DonePane 视频预览]
```

## 关键约束

- **Pipeline 是有状态的**：每个 novelProjectId 对应一个 VideoProjectState，可重入（重试时跳过已完成 shot）
- **stage 之间独立**：每个 stage 自己负责写入 store，UI 通过订阅 store 自动响应
- **失败不中断流水线**：单个 shot 失败只标记该 shot，其他继续
- **FFmpeg 降级路径**：非 Tauri 环境或 FFmpeg 不可用时，直接用第一个 clip URL 作占位

## 文件清单

| 路径 | 行数 | 作用 |
|------|-----|------|
| `src/types/video.ts` | 154 | 类型定义 |
| `src/stores/videoStore.ts` | 230 | Zustand store |
| `src/services/video/chapter-slicer.ts` | 175 | 启发式切片 |
| `src/services/video/storyboard-prompt.ts` | 200 | LLM 批处理 |
| `src/services/video/pipeline.ts` | 280 | 流水线编排 |
| `src/services/video/ffmpeg-bridge.ts` | 60 | IPC 封装 |
| `src-tauri/src/ffmpeg.rs` | 200 | Rust 命令 |
| `src/components/Video/VideoGeneratorModal.tsx` | 470 | 主 UI |

## 复用的现有抽象

- `src/services/providers/base.ts` — `BaseLLMProvider` / `BaseImageProvider` / `BaseVideoProvider`
- `src/services/providers/router.ts` — `providerRouter.generateVideo()`
- `src/services/providers/video-adapters.ts` — Kling / Runway / Vidu adapter
- `src/services/novel/llm-json.ts` — `parseLLMJson()`
- `src/stores/projectStore.ts` — `useProjectStore`（读小说项目）
- `src/stores/providerStore.ts` — `useProviderStore`（检测 video endpoint）
