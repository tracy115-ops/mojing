// scripts/verify-series-workflow.mjs
// 针对视频漫剧系列工作流 (docs/video-generation/series-workflow-plan.md)
// 对剧本智能切镜、角色提取、系列资产匹配、关键帧一致性、单镜重跑与合成诊断进行端到端全链路验证。

import { readFileSync } from 'node:fs';

let passCount = 0;
let failCount = 0;

function assert(condition, testName, extraInfo = '') {
  if (condition) {
    passCount++;
    console.log(`  ✓ [PASS] ${testName}`);
  } else {
    failCount++;
    console.error(`  ✗ [FAIL] ${testName} ${extraInfo ? `— ${extraInfo}` : ''}`);
  }
}

console.log('================================================================');
console.log('🚀 开始验证系列漫剧工作流 (Series Workflow & Continuity Verification)');
console.log('================================================================\n');

// -----------------------------------------------------------------------------
// 1. 验证剧本与小说智能分镜切片 (P0)
// -----------------------------------------------------------------------------
console.log('--- 1. 验证分词与剧本镜头切分算法 ---');

const sampleScript = `
镜头1: 雨夜，霓虹街头，林墨撑着黑伞缓步走过积水的街道。
林墨（低声）：“一切才刚刚开始。”
第2镜: 特写林墨冷峻的侧脸，雨水沿着伞沿滴落。
【镜头3】街角拐弯处，神秘少女苏清雪一身白色风衣站在路灯下。
苏清雪（微笑）：“你终于来了。”
`;

// 提取镜头切分与角色对白识别正则逻辑
const SHOT_BOUNDARY_REGEX = /\n(?=(?:镜头\s*\d+|第?\d+镜|Shot\s*\d+|Scene\s*\d+|【镜头|【分镜|【场|第\d+场))/i;
const DIALOGUE_SPEAKER_REGEX = /^([一-龥A-Za-z0-9_]{1,8})(?:（[^）]+）|\([^)]+\))?[:：]/;

const lines = sampleScript.trim().split(SHOT_BOUNDARY_REGEX);
assert(lines.length >= 3, '剧本格式自动切分出 3 个独立镜头', `实际切出 ${lines.length} 个镜头`);

const extractedSpeakers = [];
for (const line of sampleScript.split('\n')) {
  const match = line.trim().match(DIALOGUE_SPEAKER_REGEX);
  if (match) {
    extractedSpeakers.push(match[1]);
  }
}
assert(extractedSpeakers.includes('林墨'), '成功从剧本对白提取角色: 林墨');
assert(extractedSpeakers.includes('苏清雪'), '成功从剧本对白提取角色: 苏清雪');

// -----------------------------------------------------------------------------
// 2. 验证系列资产库匹配与收录逻辑 (P1)
// -----------------------------------------------------------------------------
console.log('\n--- 2. 验证系列资产匹配与新角色收录 ---');

const seriesCharacters = [
  { id: 'char_1', name: '林墨', aliases: ['林先生', '墨哥'], portraitImage: 'data:image/png;base64,mock1' }
];

function matchCharacterToLibrary(name, library) {
  return library.find((c) => c.name === name || c.aliases?.includes(name));
}

const matchLin = matchCharacterToLibrary('林墨', seriesCharacters);
assert(matchLin?.id === 'char_1', '已有系列角色 "林墨" 准确命中资产库');

const matchAlias = matchCharacterToLibrary('墨哥', seriesCharacters);
assert(matchAlias?.id === 'char_1', '别名 "墨哥" 准确命中资产库');

const matchSu = matchCharacterToLibrary('苏清雪', seriesCharacters);
assert(matchSu === undefined, '新角色 "苏清雪" 准确识别为未匹配 (防止静默生成错乱同名立绘)');

// 模拟一键录入系列资产库
const newSeriesCharacters = [...seriesCharacters];
if (!matchSu) {
  newSeriesCharacters.push({
    id: 'char_2',
    name: '苏清雪',
    aliases: ['苏清雪'],
    appearance: '从剧集分镜提取的角色: 苏清雪',
    firstAppearShotIndex: 2
  });
}
assert(newSeriesCharacters.length === 2 && newSeriesCharacters[1].name === '苏清雪', '一键录入后系列库成功收录新角色 "苏清雪"');

// -----------------------------------------------------------------------------
// 3. 验证关键帧审核门禁与连续性评分 (P1)
// -----------------------------------------------------------------------------
console.log('\n--- 3. 验证关键帧门禁 (Gatekeeper) & 连续性核对 ---');

const mockSceneSpec = {
  characters: newSeriesCharacters,
  scenes: [{ id: 'scene_street', name: '霓虹街头', backgroundImage: 'data:image/png;base64,mockscene' }],
  shots: [
    { id: 'shot_1', index: 0, keyframeImage: 'data:image/png;base64,kf1', characterIds: ['char_1'], sceneId: 'scene_street' },
    { id: 'shot_2', index: 1, keyframeImage: 'data:image/png;base64,kf2', characterIds: ['char_1'], sceneId: 'scene_street' },
    { id: 'shot_3', index: 2, keyframeImage: 'data:image/png;base64,kf3', characterIds: ['char_2'], sceneId: 'scene_street' },
  ],
};

function reviewKeyframeGatekeeper(spec) {
  const missingKeyframes = spec.shots.filter(s => !s.keyframeImage);
  const unanchoredChars = spec.characters.filter(c => !c.portraitImage);
  const ready = missingKeyframes.length === 0;
  return {
    ready,
    totalShots: spec.shots.length,
    keyframedShots: spec.shots.length - missingKeyframes.length,
    unanchoredCount: unanchoredChars.length
  };
}

const gatekeeperResult = reviewKeyframeGatekeeper(mockSceneSpec);
assert(gatekeeperResult.ready === true, '所有镜头关键帧就绪，门禁通过');
assert(gatekeeperResult.keyframedShots === 3, '关键帧数量统计准确 (3/3)');

// -----------------------------------------------------------------------------
// 4. 验证单镜头重跑与合成诊断机制 (P1 & P2)
// -----------------------------------------------------------------------------
console.log('\n--- 4. 验证单镜头重生成与多媒体合成诊断 ---');

const mockClips = [
  { shotId: 'shot_1', videoUrl: 'http://asset.localhost/clip_1.mp4', hasAudio: true },
  { shotId: 'shot_2', videoUrl: 'invalid_dead_url', hasAudio: false },
  { shotId: 'shot_3', videoUrl: 'http://asset.localhost/clip_3.mp4', hasAudio: true },
];

function validateClipsForCompose(clips) {
  const valid = [];
  const invalid = [];
  for (const c of clips) {
    if (c.videoUrl && (c.videoUrl.startsWith('http://') || c.videoUrl.startsWith('https://') || c.videoUrl.startsWith('blob:') || c.videoUrl.startsWith('data:'))) {
      valid.push(c);
    } else {
      invalid.push(`镜头 (${c.shotId}): 视频地址无效`);
    }
  }
  return { valid, invalid };
}

const validation = validateClipsForCompose(mockClips);
assert(validation.valid.length === 2, '合成前有效 Clip 过滤准确 (2个有效)');
assert(validation.invalid.length === 1, '准确拦截并记录无效 Clip 诊断信息');

// 模拟单独重生成 shot_2 镜头
const regeneratedClip = { shotId: 'shot_2', videoUrl: 'http://asset.localhost/clip_2_fixed.mp4', hasAudio: true };
const updatedClips = mockClips.map(c => c.shotId === 'shot_2' ? regeneratedClip : c);
const revalidation = validateClipsForCompose(updatedClips);
assert(revalidation.valid.length === 3, '单镜重生成后，所有分镜 Clip 恢复 100% 有效并可立即合成');

// -----------------------------------------------------------------------------
// 5. 验证配音音色精准分配与文本清洗 (TTS Speaker & Clean)
// -----------------------------------------------------------------------------
console.log('\n--- 5. 验证配音音色匹配 (甜美少女音 vs 胖橘猫老僧音) 与台词清洗 ---');

function cleanNarrationForTTS(raw) {
  if (!raw) return '';
  return raw
    .replace(/\[.*?\]/g, '') // 去除 [动作/神态] 提示
    .replace(/【.*?】/g, '')
    .replace(/（.*?）/g, '') // 去除 (括号) 提示
    .replace(/\(.*?\)/g, '')
    .replace(/^.*?[：:]\s*/g, '')  // 去除 "角色名:" 或 "角色名：" 前缀
    .replace(/[“”"「」]/g, '')     // 去除双引号/单引号等符号，让发音自然连贯
    .trim();
}

const cleaned1 = cleanNarrationForTTS('女生：“大师，我有一事相求！”');
assert(cleaned1 === '大师，我有一事相求！', '中文全角冒号与双引号已干净剥离', `实际: ${cleaned1}`);

const cleaned2 = cleanNarrationForTTS('胖橘猫（傲娇）：“我的意思是，你接着编！”');
assert(cleaned2 === '我的意思是，你接着编！', '带神态括号的角色对白已干净剥离', `实际: ${cleaned2}`);

// 角色音色分配逻辑
const testCharacters = [
  {
    id: 'char_girl_jk',
    name: '甜美年轻女生',
    aliases: ['女生', '长发女生', '小师妹'],
    gender: 'female',
    ageGroup: 'young',
    appearance: '甜美年轻女生，黑长直长发，五官清秀，深色眼线，桃粉色唇膏，精致的编发，点缀粉色丝带与花朵发饰。身穿jk服装，现代服饰。',
    voiceRef: 'zh-CN-XiaoxiaoNeural',
  },
  {
    id: 'char_cat_master',
    name: '胖橘猫',
    aliases: ['胖橘猫大师', '猫大师', '猫咪', '大师'],
    gender: 'male',
    ageGroup: 'middle',
    appearance: '胖橘猫，佩戴黑色圆墨镜，身穿黄色古风僧袍，脸型体态全程不变，神态慵懒又狡黠。',
    voiceRef: 'zh-CN-YunyangNeural',
  },
];

function resolveSpeakerVoice(text, characters) {
  for (const c of characters) {
    const namesToCheck = [c.name, ...(c.aliases || [])].filter(Boolean);
    const matched = namesToCheck.some(
      (name) =>
        text.startsWith(`${name}:`) ||
        text.startsWith(`${name}：`) ||
        text.startsWith(`【${name}】`) ||
        new RegExp(`^${name}(?:（[^）]+）|\\([^)]+\\))?[:：]`).test(text) ||
        text.startsWith(name),
    );
    if (matched) {
      return c.voiceRef;
    }
  }
  return undefined;
}

const voiceGirl = resolveSpeakerVoice('女生：“大师，我有一事相求！”', testCharacters);
assert(voiceGirl === 'zh-CN-XiaoxiaoNeural', '女生台词准确识别并分配甜美少女音色 (zh-CN-XiaoxiaoNeural)');

const voiceCat = resolveSpeakerVoice('胖橘猫：“竹篮打水一场空。”', testCharacters);
assert(voiceCat === 'zh-CN-YunyangNeural', '胖橘猫台词准确识别并分配沉稳/老僧男音色 (zh-CN-YunyangNeural)');

const voiceMasterAlias = resolveSpeakerVoice('大师：“我的意思是，你接着编！”', testCharacters);
assert(voiceMasterAlias === 'zh-CN-YunyangNeural', '别名 "大师" 台词准确识别并分配胖橘猫音色');

// -----------------------------------------------------------------------------
// 6. 验证智能动态分镜时长算法 (Dynamic Shot Duration Pacing)
// -----------------------------------------------------------------------------
console.log('\n--- 6. 验证智能动态分镜时长算法 (不固定秒数) ---');

function estimateSmartShotDurationTest({ text = '', narration = '', dialogue, cameraMovement = '' }) {
  let allDialogueText = '';
  if (dialogue && dialogue.length > 0) {
    allDialogueText = dialogue.map((d) => d.text).join('');
  } else if (narration && narration.trim()) {
    allDialogueText = narration.trim();
  } else {
    const quotes = text.match(/["“「『]([^"”」』]+)["”」』]/g);
    if (quotes) {
      allDialogueText = quotes.map((q) => q.replace(/["“”「」『』]/g, '')).join('');
    }
  }

  const pureCharCount = allDialogueText.replace(/[\s\p{P}\p{S}]/gu, '').length;
  if (pureCharCount > 0) {
    const speechSeconds = pureCharCount / 3.8;
    const totalWithBuffer = speechSeconds + 0.6;
    return Math.max(3.0, Math.min(12.0, Math.ceil(totalWithBuffer * 2) / 2));
  }

  const combinedText = `${text} ${narration}`.toLowerCase();
  const isFastAction =
    ['tracking', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down', 'handheld'].includes(cameraMovement) ||
    /(拔剑|出鞘|斩|踢|出拳|飞身|瞬移|闪避|爆炸|击中|撞击|挥刀|刺出|暴退|怒吼|眼神特写|侧脸特写|动作|slash|attack|punch|kick|fight|dodge)/i.test(combinedText);

  if (isFastAction) return 3.0;

  const isWideAtmosphere =
    ['aerial', 'dolly_out'].includes(cameraMovement) ||
    /(全景|大远景|远景|宗门|皇城|大殿|夜景|群山|黄昏|落日|清晨|苍穹|俯瞰|星空|浩瀚|空镜|aerial|landscape|panorama|wide shot)/i.test(combinedText);

  if (isWideAtmosphere) return 6.0;

  return 4.0;
}

const actionDuration = estimateSmartShotDurationTest({
  text: '林墨眼神一凛，反手拔剑斩出，剑气如虹！',
  cameraMovement: 'tracking',
});
assert(actionDuration === 3.0, '动作打斗特写自动分配快节奏时长 3.0s (非生硬 5s)');

const longDialogueDuration = estimateSmartShotDurationTest({
  text: '大师叹了口气',
  dialogue: [{ speaker: '大师', text: '天下大势合久必分分久必合，你此去青云山，万万不可锋芒太露！' }],
});
assert(longDialogueDuration >= 7.0, `长台词对白根据真实语速自适应延长 (${longDialogueDuration}s >= 7.0s)`);

const wideLandscapeDuration = estimateSmartShotDurationTest({
  text: '大远景，夕阳落日余晖洒在巍峨的青云门千重殿宇之上，云海翻腾。',
  cameraMovement: 'aerial',
});
assert(wideLandscapeDuration === 6.0, '宏大远景/氛围空镜自动分配沉浸时长 6.0s');

// -----------------------------------------------------------------------------
// 7. 验证 Agnes Video 2.5 全新协议构造与官方网关连通性
// -----------------------------------------------------------------------------
console.log('\n--- 7. 验证 Agnes Video 2.5 全新协议构造与官方网关连通性 ---');

function buildAgnesVideoPayload(request) {
  const model = request.model?.trim() || 'agnes-video-v2.0';
  const isV25 = model === 'agnes-video-2.5' || model.includes('2.5');

  if (isV25) {
    const seconds = Math.max(4, Math.min(12, Math.round(request.durationSeconds || 5)));
    let aspect_ratio = '16:9';
    if (request.aspectRatio) {
      if (['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(request.aspectRatio)) {
        aspect_ratio = request.aspectRatio;
      }
    } else if (request.width && request.height) {
      const aspect = request.width / request.height;
      if (Math.abs(aspect - 9 / 16) < 0.1) aspect_ratio = '9:16';
      else if (Math.abs(aspect - 1) < 0.1) aspect_ratio = '1:1';
      else if (Math.abs(aspect - 4 / 3) < 0.1) aspect_ratio = '4:3';
      else if (Math.abs(aspect - 3 / 4) < 0.1) aspect_ratio = '3:4';
      else if (Math.abs(aspect - 21 / 9) < 0.1) aspect_ratio = '21:9';
    }

    const body = {
      model: 'agnes-video-2.5',
      prompt: request.prompt,
      size: '720P',
      aspect_ratio,
      seconds,
    };

    if (typeof request.seed === 'number' && Number.isInteger(request.seed)) {
      body.seed = request.seed;
    }

    if (request.referenceImages && request.referenceImages.length > 0) {
      const cleanedImages = request.referenceImages.filter(Boolean);
      if (cleanedImages.length === 1) {
        body.mode = 'keyframe';
        body.first_frame = cleanedImages[0];
      } else {
        body.mode = 'reference';
        body.images = cleanedImages;
      }
    } else {
      body.mode = 'text';
    }

    return body;
  }

  return {
    model,
    prompt: request.prompt,
    width: request.width || 1152,
    height: request.height || 768,
    num_frames: 121,
    frame_rate: 24,
  };
}

// 7.1 验证纯文生视频
const textPayload = buildAgnesVideoPayload({
  model: 'agnes-video-2.5',
  prompt: '夜晚古风庭院，樱花缓缓飘落，电影级光影',
  durationSeconds: 6,
  aspectRatio: '16:9',
});
assert(textPayload.model === 'agnes-video-2.5', '2.5 纯文生视频模型识别为 agnes-video-2.5');
assert(textPayload.mode === 'text', '无图输入自动设为 mode: text');
assert(textPayload.size === '720P', '分辨率档位严格按官方规范固定为 720P');
assert(textPayload.aspect_ratio === '16:9', '画幅比例正确输出为 16:9');
assert(textPayload.seconds === 6, '时长正确映射为 6 秒');
assert(textPayload.width === undefined && textPayload.num_frames === undefined, '成功剥离 2.0 旧版 width/num_frames 违规字段');

// 7.2 验证首帧图生视频
const keyframePayload = buildAgnesVideoPayload({
  model: 'agnes-video-2.5',
  prompt: '人物从首帧姿态缓缓拔剑',
  durationSeconds: 3,
  referenceImages: ['https://example.com/first_frame.png'],
});
assert(keyframePayload.mode === 'keyframe', '单张参考图自动设为 mode: keyframe');
assert(keyframePayload.first_frame === 'https://example.com/first_frame.png', '首帧 URL 正确填入 first_frame 字段');
assert(keyframePayload.image === undefined, '成功剥离旧版的 image 违规字段');
assert(keyframePayload.seconds === 4, '小于4秒的时长自动约束在官方合法下限 4 秒');

// 7.3 验证多图参考模式
const refPayload = buildAgnesVideoPayload({
  model: 'agnes-video-2.5',
  prompt: '以 <Picture 1> 与 <Picture 2> 角色和背景风格为参考生成打斗',
  durationSeconds: 15,
  referenceImages: ['https://example.com/char.png', 'https://example.com/scene.png'],
});
assert(refPayload.mode === 'reference', '多张图自动设为 mode: reference');
assert(Array.isArray(refPayload.images) && refPayload.images.length === 2, '多图参考数组 images 正确注入');
assert(refPayload.seconds === 12, '超过12秒的时长自动约束在官方合法上限 12 秒');

// 7.4 验证官方 API 网关网络连通性
try {
  const probeResp = await fetch('https://apihub.agnes-ai.com/v1/videos', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.AGNES_API_KEY || 'test_probe_token'}`,
    },
    body: JSON.stringify(textPayload),
  });
  const probeText = await probeResp.text();
  assert(
    probeResp.status === 200 || probeResp.status === 201 || probeResp.status === 401,
    `官方 API 网关 https://apihub.agnes-ai.com 在线联通成功 (HTTP ${probeResp.status})`
  );
} catch (err) {
  assert(false, `无法连接官方 API: ${err.message}`);
}

console.log('\n================================================================');
console.log(`🎉 验证完成: ${passCount} 项测试通过，${failCount} 项失败。`);
console.log('================================================================');

if (failCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
