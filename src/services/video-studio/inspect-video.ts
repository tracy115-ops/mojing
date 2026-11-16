/** Decode real output frames before allowing a supplied video into shot review. */
export async function inspectStudioVideo(dataUri: string): Promise<{ width: number; height: number; durationSeconds: number; sha256: string; frames: string[] }> {
  const blob = await (await fetch(dataUri)).blob();
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const url = URL.createObjectURL(blob), video = document.createElement('video');
  video.preload = 'auto'; video.muted = true;
  const wait = (event: 'loadeddata' | 'seeked', action: () => void) => new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => { clearTimeout(timer); video.removeEventListener(event, success); video.removeEventListener('error', failure); error ? reject(error) : resolve(); };
    const success = () => done(), failure = () => done(new Error('Video decoding failed'));
    const timer = setTimeout(() => done(new Error('Video inspection timed out')), 15000);
    video.addEventListener(event, success, { once: true }); video.addEventListener('error', failure, { once: true }); action();
  });
  try {
    await wait('loadeddata', () => { video.src = url; video.load(); });
    // MediaRecorder WebM often omits the duration header. A seek scans its cues.
    if (!Number.isFinite(video.duration)) await wait('seeked', () => { video.currentTime = 1e10; });
    const width = video.videoWidth, height = video.videoHeight, durationSeconds = video.duration;
    if (!width || !height || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Video has no finite duration or decodable picture');
    const canvas = document.createElement('canvas'), scale = Math.min(1, 960 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Video frame inspection is unavailable');
    const frames: string[] = [];
    for (const time of [0, durationSeconds / 2, Math.max(0, durationSeconds - 0.1)]) {
      if (Math.abs(video.currentTime - time) > 0.001) await wait('seeked', () => { video.currentTime = time; });
      context.drawImage(video, 0, 0, canvas.width, canvas.height); frames.push(canvas.toDataURL('image/jpeg', 0.85));
    }
    return { width, height, durationSeconds, sha256, frames };
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}
