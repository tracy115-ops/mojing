import fs from 'fs';
import path from 'path';

function generateEdgeTTS(text, voice, outputPath) {
  return new Promise((resolve, reject) => {
    const connectionId = 'd3b1464b-7412-4217-9154-1b15764b81ab';
    const ws = new WebSocket(
      `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EA654941A3E436AA702568F&ConnectionId=${connectionId}`,
      {
        headers: {
          'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
        },
      }
    );

    const audioChunks = [];
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('TTS timeout'));
    }, 15000);

    ws.onopen = () => {
      ws.send(`Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="${voice}">${text}</voice></speak>`;
      ws.send(`X-RequestId:${connectionId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`);
    };

    ws.onmessage = async (ev) => {
      if (typeof ev.data !== 'string') {
        const arrayBuf = await (ev.data instanceof Blob ? ev.data.arrayBuffer() : ev.data);
        const buf = Buffer.from(arrayBuf);
        const headerLen = (buf[0] << 8) | buf[1];
        const body = buf.subarray(2 + headerLen);
        if (body.length > 0) audioChunks.push(body);
      }
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      if (audioChunks.length === 0) {
        return reject(new Error('No audio returned'));
      }
      const fullBuffer = Buffer.concat(audioChunks);
      fs.writeFileSync(outputPath, fullBuffer);
      resolve(outputPath);
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

const testOutput = path.resolve('test_voice.mp3');
console.log('Testing Edge TTS...');
generateEdgeTTS('大师，我有一事相求！', 'zh-CN-XiaoxiaoNeural', testOutput)
  .then((p) => {
    console.log('TTS success! File saved to:', p, 'Size:', fs.statSync(p).size, 'bytes');
    process.exit(0);
  })
  .catch((err) => {
    console.error('TTS failed:', err);
    process.exit(1);
  });
