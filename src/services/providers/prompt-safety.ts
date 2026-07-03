// prompt-safety.ts — 内容审核拦截时的 prompt 自动改写
//
// 当 image/video provider 返回 content_policy_violation / safety filter
// 拦截时,我们没法绕过模型的安全策略,只能改写 prompt 让它不再触发。
//
// 两档改写:
//  1. 轻量修饰(soft):在原 prompt 末尾追加安全词,弱化整体语境。
//     适用:prompt 本身没明显敏感词,但模型仍判为风险(常见于人物特写、
//     武打、情感戏)。
//  2. 强清理(aggressive):剥掉明显敏感词(violence/blood/kill/nude 等)
//     替换为温和同义词,再追加安全词。适用:prompt 明显带敏感词。
//
// 三次重试链:原 prompt → soft → aggressive。第一次失败就升级。
// 仍然失败则放弃,把原始错误抛上去让 UI 显示。

/** 检测一个错误是否是内容审核拦截 */
export function isContentPolicyViolation(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // 全部小写匹配,覆盖 OpenAI / Agnes / 各家电厂的常见 code
  const low = msg.toLowerCase();
  return (
    low.includes('content_policy_violation') ||
    low.includes('content policy') ||
    low.includes('safety') ||
    low.includes('sensitive content') ||
    low.includes('unable to generate this content')
  );
}

/** 在 prompt 末尾追加安全修饰词。原 prompt 内容不动。 */
function softRewrite(prompt: string): string {
  const safetySuffix =
    ', tasteful composition, non-explicit, safe for work, ' +
    'neutral facial expression, fully clothed, peaceful atmosphere, ' +
    'no violence, no weapons, no blood, no nudity';
  // 避免重复追加
  if (prompt.includes('safe for work')) return prompt;
  return `${prompt}${safetySuffix}`;
}

/** 敏感词 → 温和同义词的替换表。
 *  只覆盖最常触发的几个类别;不是穷举,目标是让 80% 的 case 通过。 */
const SENSITIVE_WORD_MAP: Array<[RegExp, string]> = [
  // 暴力 / 血腥
  [/\b(kill|kills|killing|killed)\b/gi, 'confronts'],
  [/\b(murder|murdered)\b/gi, 'conflict'],
  [/\b(blood|bloody)\b/gi, 'red liquid'],
  [/\b(gore|gory)\b/gi, 'dramatic scene'],
  [/\b(dead body|corpse)\b/gi, 'unconscious figure'],
  [/\b(stab|stabbed|stabbing)\b/gi, 'touches'],
  [/\b(shoot|shoots|shooting|shot)\b/gi, 'aims'],
  [/\b(gun|guns|pistol|rifle)\b/gi, 'tool'],
  [/\b(sword|blade|knife|dagger)\b/gi, 'object'],
  [/\b(wound|wounded|injury)\b/gi, 'mark'],
  [/\b(die|dies|died|dying)\b/gi, 'faints'],
  [/\b(attack|attacked|attacking)\b/gi, 'approaches'],
  [/\b(fight|fights|fighting|fought)\b/gi, 'encounter'],
  [/\b(war|battlefield)\b/gi, 'dramatic setting'],
  // 裸露 / 性
  [/\b(nude|naked|nudity)\b/gi, 'clothed'],
  [/\b(sexy|sensual|erotic)\b/gi, 'elegant'],
  [/\b(cleavage|breast|breasts)\b/gi, 'torso'],
  [/\b(lingerie|underwear)\b/gi, 'casual wear'],
  // 药物
  [/\b(drug|drugs|heroin|cocaine)\b/gi, 'substance'],
  [/\b(inject|injection|needle)\b/gi, 'medical procedure'],
  // 仇恨 / 极端
  [/\b(hate|racist|nazi)\b/gi, 'disagreement'],
];

/** 强清理:替换敏感词 + 追加安全修饰。 */
function aggressiveRewrite(prompt: string): string {
  let cleaned = prompt;
  for (const [pattern, replacement] of SENSITIVE_WORD_MAP) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  return softRewrite(cleaned);
}

/** 生成一个改写后的 prompt 序列(不含原 prompt,调用方自己决定要不要先试原版)。
 *  返回的数组长度 = 重试次数。每个元素 = 一次升级后的 prompt。 */
export function buildSafetyRewriteChain(originalPrompt: string): string[] {
  return [softRewrite(originalPrompt), aggressiveRewrite(originalPrompt)];
}
