# 15. Seedance 视频 Provider

更新日期：2026-11-16。关联代码：`src/services/providers/video-adapters.ts::DoubaoVideoProvider`。

## 接入状态

已实现火山方舟异步视频生成协议，支持文生视频、首帧、首尾帧和图片／音频／视频多模态参考。
本次验证为模拟 HTTP 的请求／响应契约测试，尚未用真实账号调用 Seedance。

小云雀是产品或渠道名称，不能直接认定其与火山方舟公开 API 相同。
若使用小云雀或第三方中转服务，需要核对该渠道的鉴权、模型名称、任务接口及素材格式，
再增加独立适配器或明确兼容配置。

## 模型与当前实现的约束

| Model ID | 时长 | 当前支持的分辨率 |
| --- | --- | --- |
| `doubao-seedance-2-5-260628` | 整数 4–30 秒 | 720P／1080P |
| `doubao-seedance-2-5-flash-261115` | 整数 4–30 秒 | 720P |
| `doubao-seedance-2-0-260128` | 整数 4–15 秒 | 720P／1080P |
| `doubao-seedance-2-0-fast-260128` | 整数 4–15 秒 | 720P |

这些 ID 已按官方模型列表核对，账号能否调用取决于开通状态与权限。
官方后续提供的更高规格不等于本项目已支持；当前界面没有启用 4K 视频。
默认模型保留现有配置，新增建议模型不会自动切换账号或产生付费生成。

## 设置步骤

1. 在「设置 → 模型 Provider」新增或编辑 `Doubao Video` 视频接口。
2. Base URL 填 `https://ark.cn-beijing.volces.com`，也支持完整的 `/api/v3` 前缀。
3. 配置有视频模型调用权限的 Ark API Key，并填写账号实际可用的模型列表。
4. 选择视频主接口和默认模型，创建项目时绑定；单镜工作台可切换该接口已配置的模型。

LLM 和视频可以使用同一个有相应权限的 Ark Key，但应用内是独立 Provider 配置，
不要假定配置了文本接口就会自动配置视频接口。密钥只填设置，不写入文档或测试。

## 请求协议

```text
POST /api/v3/contents/generations/tasks
GET  /api/v3/contents/generations/tasks/{id}
Authorization: Bearer <ARK_API_KEY>
```

创建返回 `{ id }`；查询成功时从 `content.video_url` 读取视频。
终态为 `succeeded`／`success` 时必须存在视频 URL；`failed`／`error`／`cancelled` 返回失败原因。
流水线下载持久化结果，避免依赖临时 CDN URL。

```json
{
  "model": "doubao-seedance-2-5-260628",
  "content": [
    { "type": "text", "text": "店员拿起书册，缓慢递给来客；镜头平稳跟随。" },
    { "type": "image_url", "image_url": { "url": "https://example.com/first.png" }, "role": "first_frame" },
    { "type": "image_url", "image_url": { "url": "https://example.com/last.png" }, "role": "last_frame" }
  ],
  "duration": 8,
  "ratio": "16:9",
  "resolution": "1080p",
  "generate_audio": false,
  "watermark": false,
  "seed": 1234
}
```

项目使用现有 TTS 和合成流程，默认关闭模型原生音频。自由创作工作台可显式启用原生声音。

| 控制方式 | `content` 中的图片角色 |
| --- | --- |
| 纯文本 | 无图片 |
| 首帧驱动 | `first_frame` |
| 首尾帧驱动 | `first_frame` + `last_frame` |
| 图片参考 | 2.0 最多 9 张、2.5 最多 30 张、2.5 Flash 最多 10 张 `reference_image`，提示词用 `@图像1` 等明确对应主体 |
| 音频参考 | `audio_url` + `reference_audio`；2.0 最多 3 段、2.5 最多 10 段、2.5 Flash 最多 5 段 |
| 视频参考 | `video_url` + `reference_video`；数量与音频相同，使用公网链接或 Ark 素材 ID |

首尾帧与主体参考遵循独立控制方式，不把人物参考图当作时间首帧。
参考图超限会在提交前报错，不静默截断。图片可使用公网 URL 或 data URI；本地文件由上层读取为 data URI。
音频支持 MP3／WAV 的 URL／Data URI；本地 MP4／MOV 可经 [S3 兼容上传](./22-media-upload.md) 获得临时读取链接，视频请求发送该链接。WebM 需先用桌面 MP4 转换，不直接作为受支持格式提交。该上传流程尚未注册 Ark 私有 `asset://` 素材。
2.0 音频不能单独使用，2.5 支持音频单独使用。具体限制与验证见 [18-media-editing-and-shot-transfer.md](./18-media-editing-and-shot-transfer.md)。

## 参数与结果记录

时长根据当前模型归一到合法整数范围。标准模型按请求宽高选择原生尺寸，
Fast／Flash 强制使用 720P。真实响应包含宽高或时长时优先记录响应；
没有时使用本次提交的原生参数，不把请求的 1080P 错记为极速模型的实际产出。
请求预览和实际提交使用同一套分辨率与时长选择逻辑。

模型能力声明位于 `provider-capabilities.ts`，负责约束 UI、参数过滤和参考模式；
适配器负责转换原生协议。新增模型需同时核对两者，不能只追加一个模型名。

## 验证

`npm.cmd run test:capabilities` 与 `npm.cmd run test:video-reference-payloads` 覆盖：

- 标准、Fast、2.5 Flash 的时长与分辨率约束。
- 首尾帧都进入真实提交的 `content`，主体参考的编号对应及超限处理。
- 2.5 的 30 秒请求和随机种子透传。
- 结果尺寸采用实际响应或提交档位。

真实账号的成功生成、下载、画质和费用仍需实际联调验证。

官方依据：[视频生成 API](https://www.volcengine.com/docs/82379/1520757)、
[模型列表](https://www.volcengine.com/docs/82379/1330310)。
