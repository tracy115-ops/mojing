// ============================================================================
// Smart Dynamic Shot Duration Estimator (智能分镜时长估算器)
// ----------------------------------------------------------------------------
// 彻底解决分镜固定 5 秒导致的“音画不同步、冷场拖沓、缺乏视听呼吸节奏”问题。
// 核心原则：
// 1. 台词音频驱动 (Audio-Driven)：根据台词真实字数估算 TTS 朗读耗时 + 0.6s 呼吸留白；
// 2. 动作景别驱动 (Action/Scale Pacing)：动作打斗特写短平快(2~3.5s)，宏大全景空镜沉浸(5~7s)；
// 3. 用户显式干预优先 (Manual Override)：用户手动设置的时长优先保留。
// ============================================================================

export interface DurationEstimateParams {
  /** 镜头文本/画面描述 */
  text?: string;
  /** 原剧本台词或旁白 */
  narration?: string;
  /** 结构化对白列表 */
  dialogue?: { speaker?: string; text: string }[];
  /** 运镜方式 */
  cameraMovement?: string;
  /** 是否包含动作 */
  hasAction?: boolean;
  /** 是否包含对白 */
  hasDialogue?: boolean;
  /** 用户或上游显式指定的时长 (秒) */
  explicitDuration?: number;
  /** 默认基线时长 (0 表示纯智能动态，其他为基准) */
  defaultShotDuration?: number;
}

/**
 * 智能估算单镜头的最佳时长 (秒)
 */
export function estimateSmartShotDuration(params: DurationEstimateParams): number {
  const {
    text = '',
    narration = '',
    dialogue,
    cameraMovement = '',
    hasAction,
    hasDialogue,
    explicitDuration,
    defaultShotDuration = 0,
  } = params;

  // 1. 若用户在分镜编辑弹窗中手动修改了具体时长 (且 >0 且明确非 0/auto), 尊重用户手动输入
  if (typeof explicitDuration === 'number' && explicitDuration > 0 && explicitDuration !== 5) {
    return Math.max(2, Math.min(18, Math.round(explicitDuration * 2) / 2));
  }

  // 2. 提取所有对白文本
  let allDialogueText = '';
  if (dialogue && dialogue.length > 0) {
    allDialogueText = dialogue.map((d) => d.text).join('');
  } else if (narration && narration.trim()) {
    allDialogueText = narration.trim();
  } else {
    // 从 text 中尝试提取引号对白
    const quotes = text.match(/["“「『]([^"”」』]+)["”」』]/g);
    if (quotes) {
      allDialogueText = quotes.map((q) => q.replace(/["“”「」『』]/g, '')).join('');
    }
  }

  // 去除标点与空格，计算纯字符数
  const pureCharCount = allDialogueText.replace(/[\s\p{P}\p{S}]/gu, '').length;

  // 3. 对白优先：如果存在实际台词
  if (pureCharCount > 0) {
    // 中文正常语速：约 3.6 ~ 4.2 字/秒，加上前置停顿和后置呼吸余量 0.6 秒
    const speechSeconds = pureCharCount / 3.8;
    const totalWithBuffer = speechSeconds + 0.6;
    // 台词镜头时长：最短 3.0 秒，最长 12.0 秒
    return Math.max(3.0, Math.min(12.0, Math.ceil(totalWithBuffer * 2) / 2));
  }

  const combinedText = `${text} ${narration}`.toLowerCase();

  // 4. 动作戏/打斗/快速特写 (Action & Impact Shot: 2.0s ~ 3.5s)
  const isFastAction =
    hasAction ||
    ['tracking', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down', 'handheld'].includes(cameraMovement) ||
    /(拔剑|出鞘|斩|踢|出拳|飞身|瞬移|闪避|爆炸|击中|撞击|挥刀|刺出|暴退|怒吼|眼神特写|侧脸特写|动作|slash|attack|punch|kick|fight|dodge)/i.test(combinedText);

  if (isFastAction) {
    return 3.0;
  }

  // 5. 宏大场景/远景空镜/转场氛围 (Establishing & Landscape Shot: 5.0s ~ 7.0s)
  const isWideAtmosphere =
    ['aerial', 'dolly_out'].includes(cameraMovement) ||
    /(全景|大远景|远景|宗门|皇城|大殿|夜景|群山|黄昏|落日|清晨|苍穹|俯瞰|星空|浩瀚|空镜|aerial|landscape|panorama|wide shot)/i.test(combinedText);

  if (isWideAtmosphere) {
    return 6.0;
  }

  // 6. 普通中景叙事/人物神态交互 (Medium Narrative Shot: 3.5s ~ 4.5s)
  if (defaultShotDuration && defaultShotDuration > 0 && defaultShotDuration !== 5) {
    return defaultShotDuration;
  }

  return 4.0;
}
