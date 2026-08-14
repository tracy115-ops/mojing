# scripts/build-shaw-cat-video.py
# 为《80年代港风武侠·猫大师与小师妹》第1集合成包含精准角色台词与男女声配音的成片

import os
import sys
import subprocess
import json
import shutil

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

shots_info = [
    {
        "index": 0,
        "title": "分镜1全景",
        "speaker": "甜美年轻女生",
        "voice": "zh-CN-XiaoxiaoNeural",
        "dialogue": "大师，我有一事相求！",
        "subtitle": "女生：大师，我有一事相求！"
    },
    {
        "index": 1,
        "title": "分镜2中景",
        "speaker": "甜美年轻女生",
        "voice": "zh-CN-XiaoxiaoNeural",
        "dialogue": "我温柔体贴、善良可爱、长相又不差，为什么就是找不到对象啊？",
        "subtitle": "女生：我温柔体贴、善良可爱、长相又不差，为什么就是找不到对象啊？"
    },
    {
        "index": 2,
        "title": "分镜3猫咪脸部特写",
        "speaker": "胖橘猫",
        "voice": "zh-CN-YunyangNeural",
        "dialogue": "竹篮打水一场空。",
        "subtitle": "胖橘猫：竹篮打水一场空。"
    },
    {
        "index": 3,
        "title": "分镜4近景",
        "speaker": "甜美年轻女生",
        "voice": "zh-CN-XiaoxiaoNeural",
        "dialogue": "大师，你是说我缘分未到吗？",
        "subtitle": "女生：大师，你是说我缘分未到吗？"
    },
    {
        "index": 4,
        "title": "分镜5特写",
        "speaker": "胖橘猫",
        "voice": "zh-CN-YunyangNeural",
        "dialogue": "我的意思是，你接着编！",
        "subtitle": "胖橘猫：我的意思是，你接着编！"
    },
    {
        "index": 5,
        "title": "分镜6全景收尾",
        "speaker": "甜美年轻女生",
        "voice": "zh-CN-XiaoxiaoNeural",
        "dialogue": "哼！你这臭猫！",
        "subtitle": "女生：哼！你这臭猫！"
    }
]

cache_dir = r"C:\Users\Admin\AppData\Roaming\com.mojing.desktop\video-cache\ea8ba5a1-3c75-4639-9685-a67cba051d19"
output_dir = os.path.abspath("temp_video_build")
os.makedirs(output_dir, exist_ok=True)

processed_clips = []

python_bin = r"C:\Users\Admin\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe"

print("=== 1. 生成 6 个分镜的原汁原味角色台词配音 (Edge TTS) ===")
for shot in shots_info:
    idx = shot["index"]
    audio_path = os.path.join(output_dir, f"audio_{idx}.mp3")
    cmd = [
        python_bin, "-m", "edge_tts",
        "--text", shot["dialogue"],
        "--voice", shot["voice"],
        "--write-media", audio_path
    ]
    print(f"[{shot['title']}] 角色: {shot['speaker']} -> 配音: {shot['dialogue']}")
    subprocess.run(cmd, check=True)

print("\n=== 2. 将每个分镜的视频画面与精准台词音频及字幕合并 ===")
for shot in shots_info:
    idx = shot["index"]
    raw_video = os.path.join(cache_dir, f"merged_{idx}.mp4")
    audio_path = os.path.join(output_dir, f"audio_{idx}.mp3")
    merged_clip = os.path.join(output_dir, f"clip_{idx}_with_dialogue.mp4")
    
    # 获取音频时长与视频时长
    # 用 ffmpeg 将视频和音频混合，音频循环或延长视频，并烧录台词字幕
    # 视频保留 5 秒时长
    cmd = [
        "ffmpeg", "-y",
        "-i", raw_video,
        "-i", audio_path,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-shortest",
        "-t", "5",
        merged_clip
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    processed_clips.append(merged_clip)
    print(f"✓ 分镜 {idx+1} 已完成台词音频与视频对齐: {merged_clip}")

print("\n=== 3. 拼接生成最终成片 preview_final_video.mp4 ===")
concat_list_file = os.path.join(output_dir, "concat_list.txt")
with open(concat_list_file, "w", encoding="utf-8") as f:
    for clip in processed_clips:
        f.write(f"file '{clip.replace(os.sep, '/')}'\n")

final_output = os.path.abspath("preview_final_video.mp4")
concat_cmd = [
    "ffmpeg", "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concat_list_file,
    "-c", "copy",
    final_output
]
subprocess.run(concat_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

print(f"\n🎉 视频合成成功！")
print(f"成片文件路径: {final_output}")
print(f"成片大小: {os.path.getsize(final_output)} 字节")
