const ffmpegPath = require('ffmpeg-static');
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const B2_KEY_ID   = process.env.B2_KEY_ID;
const B2_APP_KEY  = process.env.B2_APP_KEY;
const BUCKET_ID   = process.env.BUCKET_ID;
const BUCKET_NAME = process.env.BUCKET_NAME || 'creatomate-n8n';

async function downloadFile(url, dest, hops = 0) {
  if (hops > 5) throw new Error('Too many redirects');
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        file.close(); try { fs.unlinkSync(dest); } catch(e) {}
        return downloadFile(res.headers.location, dest, hops+1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { file.close(); try { fs.unlinkSync(dest); } catch(e) {} reject(err); });
  });
}

async function b2Auth() {
  const cred = Buffer.from(`${B2_KEY_ID}:${B2_APP_KEY}`).toString('base64');
  const r = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account',
    { headers: { Authorization: `Basic ${cred}` } });
  if (!r.ok) throw new Error(`B2 auth failed: ${await r.text()}`);
  return r.json();
}

async function b2GetUploadUrl(auth) {
  const r = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: BUCKET_ID })
  });
  if (!r.ok) throw new Error(`B2 upload url failed: ${await r.text()}`);
  return r.json();
}

async function b2Upload(uploadData, filePath, b2FileName) {
  const buf  = fs.readFileSync(filePath);
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  const r = await fetch(uploadData.uploadUrl, {
    method: 'POST',
    headers: {
      Authorization:       uploadData.authorizationToken,
      'Content-Type':      'video/mp4',
      'Content-Length':    String(buf.length),
      'X-Bz-File-Name':    encodeURIComponent(b2FileName),
      'X-Bz-Content-Sha1': sha1
    },
    body: buf,
    duplex: 'half'
  });
  if (!r.ok) throw new Error(`B2 upload failed: ${await r.text()}`);
  return r.json();
}

app.post('/burn-captions', async (req, res) => {
  const { videoUrl, srt, videoName } = req.body;
  if (!videoUrl || !srt || !videoName)
    return res.status(400).json({ error: 'videoUrl, srt, videoName required' });

  const ts  = Date.now();
  const inp = `/tmp/in_${ts}.mp4`;
  const sub = `/tmp/sub_${ts}.srt`;
  const out = `/tmp/out_${ts}.mp4`;
  const cleanup = () => [inp,sub,out].forEach(f => { try { fs.unlinkSync(f); } catch(e){} });

  try {
    console.log(`▶ [${videoName}] Downloading...`);
    await downloadFile(videoUrl, inp);
    fs.writeFileSync(sub, srt, 'utf8');

    const style = [
      'FontSize=24',
      'PrimaryColour=&H00FFFFFF','OutlineColour=&H00000000',
      'BackColour=&H80000000','Bold=1','Outline=2',
      'Shadow=1','Alignment=2','MarginV=30'
    ].join(',');

    const safeSub = sub.replace(/:/g, '\\:');
    const cmd = `${ffmpegPath} -y -i "${inp}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,subtitles='${safeSub}':force_style='${style}'" -c:v libx264 -preset ultrafast -crf 23 -profile:v high -level 4.1 -c:a aac -b:a 128k -movflags +faststart "${out}"`;

    console.log(`▶ [${videoName}] Burning captions...`);
    await execAsync(cmd, { timeout: 900000 });

    console.log(`▶ [${videoName}] Uploading to Backblaze...`);
    const auth       = await b2Auth();
    const uploadData = await b2GetUploadUrl(auth);
    const b2Name     = `captioned/${videoName}_captioned.mp4`;
    await b2Upload(uploadData, out, b2Name);

    const downloadUrl = `${auth.downloadUrl}/file/${BUCKET_NAME}/${encodeURIComponent(b2Name)}`;
    cleanup();
    console.log(`✅ [${videoName}] Done!`);
    res.json({ success: true, videoUrl: downloadUrl, videoName });

  } catch (err) {
    cleanup();
    console.error(`❌ [${videoName}]`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'FFmpeg Caption Server' }));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
