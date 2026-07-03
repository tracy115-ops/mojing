# 15. Doubao (Seedance 2.0) Video Provider

> 状态:已实现
> 关联代码:`src/services/providers/video-adapters.ts::DoubaoVideoProvider`
> 官方文档:
> - API 参考: https://www.volcengine.com/docs/82379/1520757
> - 模型列表: https://www.volcengine.com/docs/82379/1330310

## 背景

接入火山方舟(Volcano Ark / 火山引擎方舟)**Seedance 2.0** 视频生成模型,用于替代/补充 Kling/Runway/Vidu。

民间常叫"小云雀流水线",实际后端是火山方舟的 Doubao Seedance 系列模型,与豆包 LLM **共用 API Key**(Bearer token)。

## 模型 ID

| Model ID | 用途 | 备注 |
|---|---|---|
| `doubao-seedance-2-0-260128` | 标准版,1080p,默认 | 公开 API 2026-04-02 开放,`260128` = 版本日期戳(2026-01-28) |
| `doubao-seedance-2-0-fast-260128` | 极速版,720p | 更低延迟、更低成本 |

**注意:**
- 2.0 系列**没有** `pro` / `lite` 后缀(`pro` / `lite` 只在 1.0 系列)
- Seedance 2.5 在 2026-06-23 FORCE 大会发布,7 月正式上线,届时追加 `doubao-seedance-2-5-*` 即可

## API 端点

```
POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks
```

异步任务模式:**提交 → 轮询 → 拉取结果**。

- 提交:返回 `{ id: "..." }`
- 查询:`GET /api/v3/contents/generations/tasks/{id}` → `data.status` ∈ `running` / `succeeded` / `failed`
- 结果:`data.content.video_url`(临时 CDN URL,需立即下载)

## 鉴权

Bearer token,与 Doubao LLM provider 共用:

```
Authorization: Bearer ${ARK_API_KEY}
```

## 请求体

```jsonc
{
  "model": "doubao-seedance-2-0-260128",
  "content": [
    { "type": "text", "text": "prompt..." },
    { "type": "image_url", "image_url": { "url": "https://..." }, "role": "first_frame" }
  ],
  "duration": 5,            // [4, 15] 秒
  "ratio": "16:9",          // 16:9 / 4:3 / 1:1 / 3:4 / 9:16 / 21:9 / adaptive
  "resolution": "1080p",    // 480p / 720p / 1080p(fast 不支持 1080p)
  "generate_audio": false,  // 我们的 TTS 流水线处理音频,关掉避免冲突
  "watermark": false
}
```

### `content` 数组 — mode 选择关键

| 模式 | content 组成 |
|---|---|
| **T2V**(文生视频) | `[{ type: 'text', text }]` |
| **I2V first_frame**(首帧驱动,默认) | `text` + `{ type: 'image_url', image_url: { url }, role: 'first_frame' }` |
| **I2V last_frame**(尾帧驱动) | role 改成 `'last_frame'` |
| 视频编辑(参考素材) | role 改成 `'reference_image'` |

### 关键约束

- **duration**:整数,范围 `[4, 15]` 秒。Adapter `clampDuration` 做了 clamp。
- **ratio**:必须从枚举里选,不能传任意比例。Adapter `pickRatio` 用 `TOLERANCE=0.05` 匹配最接近的标准比例,匹配不到 fallback 到 `'adaptive'`。
- **resolution**:fast 版最大 720p,pro 版最大 1080p。
- **first_frame 图片必须是 URL**:`data:` URI 接受,但本地文件 URL(`file:///`)后端拉不到。Adapter `normalizeImageRef` 做了 base64 → data URI 转换,纯本地路径会抛清晰错误。

## Adapter 实现

`DoubaoVideoProvider extends BaseVideoProvider`(~230 行,在 `video-adapters.ts`)。

### 关键内部方法

```typescript
private normalizeImageRef(raw: string): string
// 三种输入:
//   - http(s):// / data: / asset: → 原样
//   - base64 字符串(长度>100) → 补全为 data:image/png;base64,...
//   - 本地文件路径 → 抛错(后端拉不到)

private pickRatio(width?: number, height?: number): string
// 用 TOLERANCE=0.05 在标准比例表里查,匹配不到返回 'adaptive'

private clampDuration(seconds?: number): number
// [4, 15] clamp,非整数 round

private async pollUntilComplete(taskId: string, startTime: number): Promise<VideoGenerateResponse>
// 120 polls × 5s = 10 min max,3 次连续 error → 失败
```

### `generate(request)` 主流程

```typescript
1. 拼 submitUrl:如果 endpoint.baseUrl 已含 /api/vN 直接追加 /contents/generations/tasks,
   否则追加 /api/v3/contents/generations/tasks
2. content 数组:prompt 进 text;I2V 时把 referenceImages[0] 用 normalizeImageRef 转,
   放 image_url 带 role='first_frame'
3. body:duration/ratio/generate_audio=false/watermark=false
4. 根据 width×height 选 resolution(fast 强制 720p;≥1920×1080 → 1080p;≥1280×720 → 720p;否则 480p)
5. POST submit → 拿 task id → pollUntilComplete
```

### `checkStatus(taskId)` 单次查询

```typescript
GET /api/v3/contents/generations/tasks/{taskId}
→ data.status:
   'succeeded'/'success' → completed, video_url = data.content.video_url
   'failed'/'error'/'cancelled' → failed
   其他 → running
```

## 注册位置

| 文件 | 改动 |
|---|---|
| `src/types/providers.ts` | `VideoProviderId` 加 `'doubao-video'` |
| `src/stores/providerStore.ts` | `PROVIDER_CATEGORY['doubao-video']: 'video'` |
| `src/components/Settings/ProviderSettings.tsx` | `VIDEO_PROVIDER_OPTIONS` 加 entry |
| `src/components/Settings/ProviderSettings.tsx` | `PROVIDER_MODEL_SUGGESTIONS['doubao-video']` 加两个 Seedance ID |
| `src/components/Settings/ProviderSettings.tsx` | `PROVIDER_DEFAULT_URLS['doubao-video']: 'https://ark.cn-beijing.volces.com'` |
| `src/services/providers/video-adapters.ts` | `DoubaoVideoProvider` 类 + factory `case 'doubao-video'` |
| `src/i18n/locales/zh-CN.ts` / `en-US.ts` | `provider.provider.doubao-video` |

## 与 LLM 共用 Key

Doubao LLM provider 和 Doubao Video provider **共用一个 Ark API Key**,在「设置 → 模型 Provider」里配一次即可。两者端点都是 `https://ark.cn-beijing.volces.com`,只是 path 不同(LLM 走 `/api/v3/chat/completions`,Video 走 `/api/v3/contents/generations/tasks`)。

## 与流水线的整合

### 视频生成阶段(`step-video-gen.ts`)

`providerRouter.generateVideo` 根据 endpoint 配置路由到 `DoubaoVideoProvider.generate()`。

- I2V:shot.keyframeImage 经 `readAsDataUri` 转 data URI 喂入(Seedance 后端能读 base64)
- T2V:只有 prompt,无 image_url

**返回的 clip.hasAudio = false**(因为 `generate_audio: false`),这影响下游 audio_merge 的策略选择,详见 [14-audio-merge-fix.md](./14-audio-merge-fix.md)。

### 音视合并阶段(`step-audio-merge.ts` + Rust `ffmpeg_merge_audio`)

视频本身无音轨 → Rust 走 mux-only 分支(`-map 0:v -map 1:a -shortest`),把 TTS 直接接进视频。**必须加 `-shortest`**,否则 TTS 比视频长时输出文件损坏。

## 后续可扩展

- **Seedance 2.5 接入**:7 月正式上线后,在 `PROVIDER_MODEL_SUGGESTIONS` 追加 `doubao-seedance-2-5-*`,Adapter 内部逻辑无需改(只是 model ID)。
- **首尾帧 I2V**:`content` 数组支持同时放 first_frame + last_frame,可用于"关键帧 → 末帧"的双向驱动。需要在 `VideoGenerateRequest` 加 `referenceLastFrame` 字段,Adapter 里 push 一个 `role: 'last_frame'` 项。当前只用了首帧。
- **视频编辑模式**:`role: 'reference_image'` 可用于"参考视频生成新视频",目前 pipeline 没用到。
- **fractional seconds**:`frames` 参数(格式 `25+4n`)可生成 4-15 秒之间的非整数时长,目前用 `duration` 整数已够。
