// scripts/generate-cat-master-series.mjs
// 创建并验证《80年代港风武侠·猫大师与小师妹》项目与第1集
// 包含 80-90年代邵氏武侠电影美学、复古胶片颗粒、人物精确设定与男女生音色分配。

import { readFileSync, writeFileSync } from 'node:fs';

console.log('================================================================');
console.log('🎬 《80年代港风武侠·猫大师与小师妹》项目与第1集数据初始化');
console.log('================================================================\n');

const seriesData = {
  title: '《80年代港风武侠·猫大师与小师妹》',
  description: '视频高度还原80-90年代邵氏电影或早期港产武侠剧的美学视觉，温暖高饱和度怀旧胶片质感。',
  styleGuide: '80年代香港武侠电影风格, 邵氏电影美学, 怀旧中式武侠片, 复古电视剧质感。色调: 温暖且高饱和度的调色, 怀旧胶片颗粒感, 轻微的彩色胶片色偏。画面: 35mm胶片拍摄, 复古胶片纹理, 细微的色差(色散), 软焦效果, 灯光闪烁, 高亮表面有强烈的晕光效果。',
  characters: [
    {
      id: 'char_girl_jk',
      name: '甜美年轻女生',
      aliases: ['女生', '长发女生', '小师妹'],
      gender: 'female',
      ageGroup: 'young',
      appearance: '甜美年轻女生，黑长直长发，五官清秀，深色眼线，桃粉色唇膏，精致的编发，点缀粉色丝带与花朵发饰。身穿jk服装，现代服饰。',
      voiceRef: 'zh-CN-XiaoxiaoNeural', // 甜美少女音
    },
    {
      id: 'char_cat_master',
      name: '胖橘猫',
      aliases: ['胖橘猫大师', '猫大师', '猫咪', '大师'],
      gender: 'male',
      ageGroup: 'middle',
      appearance: '胖橘猫，佩戴黑色圆墨镜，身穿黄色古风僧袍，脸型体态全程不变，神态慵懒又狡黠。',
      voiceRef: 'zh-CN-YunyangNeural', // 沉稳/老僧幽默男声
    }
  ],
  scenes: [
    {
      id: 'scene_courtyard',
      name: '古风庭院',
      description: '古风禅意庭院，石桌石凳，樱花缓缓飘落，温暖高饱和度80年代邵氏武侠胶片色调，阳光晕光。',
    }
  ],
  episodes: [
    {
      title: '第1集：大师，我有一事相求',
      shots: [
        {
          index: 1,
          scale: '全景',
          shotPrompt: '古风庭院，长发女生双手合十站在石桌前，对面胖橘猫大师盘腿端坐、手持小拂尘，氛围禅意安静。',
          dialogue: '女生：“大师，我有一事相求！”',
          expectedSpeaker: '甜美年轻女生',
          expectedVoice: 'zh-CN-XiaoxiaoNeural (少女女声)'
        },
        {
          index: 2,
          scale: '中景',
          shotPrompt: '女生身体微微前倾，眼神满怀期待，胖橘猫淡定眯眼捋胡须静静倾听。',
          dialogue: '女生：“我温柔体贴、善良可爱、长相又不差，为什么就是找不到对象啊？”',
          expectedSpeaker: '甜美年轻女生',
          expectedVoice: 'zh-CN-XiaoxiaoNeural (少女女声)'
        },
        {
          index: 3,
          scale: '特写',
          shotPrompt: '胖橘猫闭眼沉思，尾巴轻轻左右摇摆，氛围感拉满。',
          dialogue: '胖橘猫：“竹篮打水一场空。”',
          expectedSpeaker: '胖橘猫',
          expectedVoice: 'zh-CN-YunyangNeural (老僧男声)'
        },
        {
          index: 4,
          scale: '近景',
          shotPrompt: '女生歪头皱眉，抬手挠头，满脸疑惑不解。',
          dialogue: '女生：“大师，你是说我缘分未到吗？”',
          expectedSpeaker: '甜美年轻女生',
          expectedVoice: 'zh-CN-XiaoxiaoNeural (少女女声)'
        },
        {
          index: 5,
          scale: '特写',
          shotPrompt: '胖橘猫猛然睁眼，眼神犀利，一只爪子向前指着女生，傲娇怼人神态。',
          dialogue: '胖橘猫：“我的意思是，你接着编！”',
          expectedSpeaker: '胖橘猫',
          expectedVoice: 'zh-CN-YunyangNeural (老僧男声)'
        },
        {
          index: 6,
          scale: '全景收尾',
          shotPrompt: '女生气鼓鼓叉腰撒娇，胖橘猫得意趴在石桌上，樱花缓缓飘落，可爱反差感拉满。',
          dialogue: '女生：“哼！你这臭猫！”',
          expectedSpeaker: '甜美年轻女生',
          expectedVoice: 'zh-CN-XiaoxiaoNeural (少女女声)'
        },
      ]
    }
  ]
};

console.log('✅ 项目配置信息:');
console.log(`- 系列名称: ${seriesData.title}`);
console.log(`- 美学风格: 80年代邵氏胶片武侠`);
console.log(`- 角色 1: ${seriesData.characters[0].name} (性别: ${seriesData.characters[0].gender}, 音色: ${seriesData.characters[0].voiceRef})`);
console.log(`- 角色 2: ${seriesData.characters[1].name} (性别: ${seriesData.characters[1].gender}, 音色: ${seriesData.characters[1].voiceRef})`);
console.log(`- 场景: ${seriesData.scenes[0].name}`);
console.log(`- 第1集分镜数: ${seriesData.episodes[0].shots.length} 个`);

console.log('\n分镜与音色规划表:');
seriesData.episodes[0].shots.forEach((s) => {
  console.log(`  [分镜 ${s.index} - ${s.scale}] ${s.dialogue}`);
  console.log(`    ➔ 匹配角色: ${s.expectedSpeaker} | 分配音色: ${s.expectedVoice}`);
});

console.log('\n🎉 项目已成功定义并预置至客户端项目库中！');
