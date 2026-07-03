# 14. 音视合成 + 成片 0 秒修复

> 状态:已修复(2026-06-29)
> 关联代码:`src-tauri/src/ffmpeg.rs`、`src/services/video/core/stage-handlers.ts`

## 症状

完整 Doubao 流水线跑完后:
1. **音视合成结果 = 原视频**:TTS 旁白没混进去,听不到声音
2. **成片 0 秒不可播**:最终 `final.mp4` 时长 0,播放器黑屏

## 根因

### Bug 1:audio_merge 把失败的 shot 的 TTS URL 错当成"合并文件路径"

`stage-handlers.ts` 旧版 `executeAudioMerge`:

```typescript
if (mergeResult.mergedShotIds.length) {
  const shotToMerged = new Map(mergeResult.shots.map((s) => [s.id, s.audioTrack]));
  for (const clip of newClips) {
    const mergedPath = shotToMerged.get(clip.shotId);
    if (mergedPath && !mergedPath.startsWith('data:')) {
      clip.videoUrl = toWebviewUrl(mergedPath);  // ❌ 写错值
      clip.hasAudio = true;
    }
  }
}
```

`mergeResult.shots` 包含**所有 shot**(成功 + 失败),失败的 shot 的 `audioTrack` 还是原 TTS URL(`http://asset.localhost/...`,不以 `data:` 开头),被错误地当成"合并文件路径"写进 `clip.videoUrl`。

**结果:**
- 失败的 shot:`clip.videoUrl` 被替换成 TTS 音频的 URL → `<video>` 标签播音频文件
- 成功的 shot:逻辑"看起来对",但还有 Bug 2 隐藏

### Bug 2:audio_merge 改过的 clips 没写回 store

`executeAudioMerge` 只改了局部 `newClips` 副本,**没调 `store.addClip` / `store.setClips`**。

后果链:
- `runPipeline` 累积进局部 `clips` 变量 → composing 阶段读到的还是带音轨的(这条链 OK)
- 但**单步重跑**(`runSingleStage` / `runFromStage`)从 store 重建 ctx 时,读 `store.clips` → **旧的没音轨的 clips** → composing 拿到无音轨 clip

### Bug 3:成片 0 秒 — TTS 比视频长导致 mux 输出损坏

Doubao provider(`video-adapters.ts` `DoubaoVideoProvider`)设了 `generate_audio: false`,视频本身**无音轨**。

`ffmpeg.rs::ffmpeg_merge_audio` 的 `has_audio=false` 分支(旧版):

```rust
cmd.arg("-c:v").arg("copy")
    .arg("-c:a").arg("aac")
    .arg("-b:a").arg("192k")
    // ❌ 没加 -shortest
    .arg("-map").arg("0:v")
    .arg("-map").arg("1:a");
```

TTS 按文字长度算,常 8-12s,但 Doubao 视频固定 5s。**没加 `-shortest` 时:**
- 输出 container 时长 = max(视频, 音频) = 音频时长(如 10s)
- 视频流在第 5 秒就结束
- 后半段(5-10s)只有音频,没有视频帧
- mp4 container 的 moov atom 记录的时长 = 10s,但 video track 实际只有 5s 数据
- webview 播放器解析时 report 0 时长 / 黑屏

这个损坏的 `merged_X.mp4` 再喂给 compose concat → 整个成片也坏了。

## 修复

### Fix 1:`stage-handlers.ts` executeAudioMerge

只对真正成功的 shot(`mergedShotIds`)更新 videoUrl,且通过 `addClip` 写回 store:

```typescript
let updatedClips = clips;
if (mergeResult.mergedShotIds.length) {
  const mergedSet = new Set(mergeResult.mergedShotIds);
  const shotToMerged = new Map(
    mergeResult.shots
      .filter((s) => mergedSet.has(s.id))   // ✅ 只用成功的 shot
      .map((s) => [s.id, s.audioTrack]),
  );
  updatedClips = clips.map((clip) => {
    const mergedPath = shotToMerged.get(clip.shotId);
    if (mergedPath && !mergedPath.startsWith('data:')) {
      const updated: GeneratedClip = {
        ...clip,
        videoUrl: toWebviewUrl(mergedPath),
        hasAudio: true,
      };
      store.addClip(pid, updated);   // ✅ 写回 store
      return updated;
    }
    return clip;
  });
}
return { spec, clips: updatedClips };   // ✅ 也返回让 runPipeline 累积
```

### Fix 2:`ffmpeg.rs` merge_audio mux 分支加 `-shortest`

```rust
} else {
    // 视频没有音轨:只把 TTS 接进去。
    // 关键:必须加 -shortest,以视频流时长为准截断。
    cmd.arg("-c:v").arg("copy")
        .arg("-c:a").arg("aac")
        .arg("-b:a").arg("192k")
        .arg("-shortest")          // ✅ 修复
        .arg("-map").arg("0:v")
        .arg("-map").arg("1:a");
}
```

`-shortest` 让 ffmpeg 在**最短的输入流结束时就停止**输出 — 视频流 5s 结束,输出文件就是干净的 5s,音视频同步结束。

## 验证步骤

完整跑一次 Novel pipeline 或 Direct multishot(用 Doubao provider),检查:

1. **audio_merge 阶段**:点开产物区的 clip,应能听到 TTS 旁白
2. **composing 成片**:时长应是各镜累加(单镜 5s、双镜 10s...),能正常播放
3. **单步重跑 composing**:从 store 读到的 clips 已经带音轨,最终成片也有声音

## 后续可改进

- `amix` 分支(`has_audio=true`)原本用 `duration=first`,TTS 比视频长时会被截断 — 没问题。但如果将来 provider 默认 `generate_audio=true`(如关闭我们设的 false),需要重新审视混音策略。
- compose 的 concat demuxer 在源 clip 编码不一致时降级到 re-encode(`compose_reencode_only`)已能兜底,但耗时。未来可以考虑在 audio_merge 阶段统一编码输出,让后续 concat 走 stream-copy。
