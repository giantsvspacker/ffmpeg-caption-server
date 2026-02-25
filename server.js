const ffmpegPath = require('ffmpeg-static');
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { promisify } = require('util');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const execAsync = promisify(exec);

const app = express();
app.use(express.json({ limit: '10mb' }));
const PORT = process.env.PORT || 3000;

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

async function downloadFile(url, dest, hops = 0) {
  if (hops > 5) throw new Error('Too many redirects');
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
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

async function uploadToR2(filePath, key) {
  const buf = fs.readFileSync(filePath);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buf,
    ContentType: 'video/mp4',
  }));
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${process.env.R2_PUBLIC_URL}/${encodedKey}`;
}

app.post('/burn-captions', async (req, res) => {
  const { videoUrl, srt, videoName } = req.body;
  if (!videoUrl || !srt || !videoName)
    return res.status(400).json({ error: 'videoUrl, srt, videoName required' });

  const inputExtMatch = videoName.match(/\.(mov|mp4|avi|mkv|webm|m4v)$/i);
  const inputExt = inputExtMatch ? inputExtMatch[0].toLowerCase() : '.mp4';
  const baseName = videoName.replace(/\.(mov|mp4|avi|mkv|webm|m4v)$/i, '');

  const ts  = Date.now();
  const inp = `/tmp/in_${ts}${inputExt}`;
  const sub = `/tmp/sub_${ts}.srt`;
  const out = `/tmp/out_${ts}.mp4`;
  const cleanup = () => [inp,sub,out].forEach(f => { try { fs.unlinkSync(f); } catch(e){} });
  try {
    console.log(`▶ [${videoName}] Downloading... (format: ${inputExt})`);
    await downloadFile(videoUrl, inp);
    fs.writeFileSync(sub, srt, 'utf8');
    const style = [
      'FontSize=8',
      'PrimaryColour=&H00FFFFFF','OutlineColour=&H00000000',
      'BackColour=&H80000000','Bold=1','Outline=2',
      'Shadow=1','Alignment=2','MarginV=50'
    ].join(',');
    const safeSub = sub.replace(/'/g, "\\'");
    const cmd = `${ffmpegPath} -y -threads 1 -i "${inp}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,unsharp=5:5:0.8:5:5:0.0,eq=brightness=0.04:contrast=1.08:saturation=1.15,subtitles='${safeSub}':force_style='${style}'" -c:v libx264 -preset veryfast -crf 18 -x264-params threads=1 -profile:v high -level 4.1 -c:a aac -b:a 128k -max_muxing_queue_size 256 -movflags +faststart "${out}"`;
    console.log(`▶ [${videoName}] Burning captions...`);
    await execAsync(cmd, { timeout: 900000 });
    console.log(`▶ [${videoName}] Uploading to R2...`);
    const safeBaseName = baseName.replace(/[#%?&=+]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
    const key = `captioned/${safeBaseName}_captioned.mp4`;
    const downloadUrl = await uploadToR2(out, key);
    cleanup();
    console.log(`✅ [${videoName}] Done! → ${downloadUrl}`);
    res.json({ success: true, videoUrl: downloadUrl, videoName });
  } catch (err) {
    cleanup();
    console.error(`❌ [${videoName}]`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/list-videos', async (req, res) => {
  try {
    const prefix = req.query.prefix || '';
    const files = [];
    let continuationToken = undefined;

    do {
      const data = await s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      if (data.Contents) {
        for (const obj of data.Contents) {
          const key = obj.Key;
          if (!key.endsWith('/') && !key.startsWith('captioned/') && /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(key)) {
            files.push({
              filename: key,
              size: obj.Size,
              lastModified: obj.LastModified,
            });
          }
        }
      }

      continuationToken = data.IsTruncated ? data.NextContinuationToken : undefined;
    } while (continuationToken);

    files.sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified));

    console.log(`📦 list-videos: found ${files.length} video(s) [prefix: '${prefix}']`);
    res.json({ success: true, files, count: files.length });
  } catch (err) {
    console.error('❌ list-videos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/delete-video', async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'key query parameter required (e.g. ?key=myvideo.mp4)' });

  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    }));
    console.log(`🗑️ Deleted from R2: ${key}`);
    res.json({ success: true, deleted: key });
  } catch (err) {
    console.error('❌ delete-video error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/video-to-mp3', async (req, res) => {
  const { videoUrl, folder } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });

  const ts = Date.now();
  const tmpVideo = `/tmp/vid_${ts}`;
  const tmpMp3   = `/tmp/audio_${ts}.mp3`;
  const cleanup  = () => [tmpVideo, tmpMp3].forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });

  try {
    console.log(`▶ [MP3] Getting title: ${videoUrl}`);
    let rawTitle = '';
    try {
      const { stdout: titleOut } = await execAsync(
        `yt-dlp --ffmpeg-location "${ffmpegPath}" --print "%(title)s" --no-playlist "${videoUrl}"`,
        { timeout: 30000 }
      );
      rawTitle = (titleOut || '').trim();
    } catch(e) { /* title fetch failed silently */ }

    // Strip ALL leading Facebook/Instagram stat groups e.g. "29.3K views · 409 reactions · 934 shares "
    // Repeats the pattern (NNN word separator) until no more stat groups remain at the front
    let cleanTitle = rawTitle
      .replace(/^([\d.,]+[KMBkm]?\s+\w+[\s\u00B7·•,]+)+/i, '')
      .replace(/\s*\|.*$/, '')
      .trim();

    // If what remains looks like only numbers/stats (no real words), discard it
    if (/^[\d\s.,KMBkm\u00B7·•–-]+$/.test(cleanTitle)) cleanTitle = '';

    // Fallback: try first line of video description when title was empty or stats-only
    if (!cleanTitle) {
      try {
        const { stdout: descOut } = await execAsync(
          `yt-dlp --ffmpeg-location "${ffmpegPath}" --print "%(description)s" --no-playlist "${videoUrl}"`,
          { timeout: 30000 }
        );
        const firstLine = (descOut || '').split('\n').map(l => l.trim()).find(l => l.length > 5) || '';
        cleanTitle = firstLine.replace(/\s*\|.*$/, '').trim();
      } catch(e) { /* description fetch failed silently */ }
    }

    const safeTitle = (cleanTitle || `audio_${ts}`)
      .replace(/lofilulla/gi, 'NovaZiri')
      .replace(/[#%?&=+<>|\\/:*"\u00B7·]/g, '')
      .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
      .replace(/NovaZiri-NovaZiri/gi, 'NovaZiri')
      || `audio_${ts}`;

    console.log(`▶ [MP3] Downloading audio: ${rawTitle}`);
    await execAsync(
      `yt-dlp --ffmpeg-location "${ffmpegPath}" -f "bestaudio[ext=m4a]/bestaudio/best" ` +
      `--no-playlist -o "${tmpVideo}" "${videoUrl}"`,
      { timeout: 300000 }
    );

    console.log(`▶ [MP3] Converting to MP3...`);
    await execAsync(
      `${ffmpegPath} -y -i "${tmpVideo}" -vn -ar 44100 -ac 2 -b:a 192k "${tmpMp3}"`,
      { timeout: 120000 }
    );

    let durationSeconds = 0, endTime = '0:00';
    try { await execAsync(`${ffmpegPath} -i "${tmpMp3}"`, { timeout: 10000 }); } catch(e) {
      const m = (e.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+)/);
      if (m) {
        durationSeconds = +m[1]*3600 + +m[2]*60 + +m[3];
        const tm = Math.floor(durationSeconds / 60), ts2 = durationSeconds % 60;
        endTime = `${tm}:${ts2.toString().padStart(2, '0')}`;
      }
    }

    const mp3Name = `${safeTitle}.mp3`;
    const key     = folder ? `${folder}/${mp3Name}` : `mp3/${mp3Name}`;
    console.log(`▶ [MP3] Uploading to R2: ${key} | duration: ${endTime}`);

    const buf = fs.readFileSync(tmpMp3);
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET, Key: key, Body: buf, ContentType: 'audio/mpeg',
    }));
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const mp3Url = `${process.env.R2_PUBLIC_URL}/${encodedKey}`;

    cleanup();
    console.log(`✅ [MP3] Done → ${mp3Url} (${endTime})`);
    res.json({ success: true, mp3Url, mp3Name, durationSeconds, endTime });
  } catch (err) {
    cleanup();
    console.error('❌ video-to-mp3 error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/save-url-to-r2', async (req, res) => {
  const { url, folder, filename } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const ts  = Date.now();
  const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [,'mp4'])[1].toLowerCase();
  const tmp = `/tmp/save_${ts}.${ext}`;
  const cleanup = () => { try { fs.unlinkSync(tmp); } catch(e) {} };

  try {
    console.log(`▶ [Save] Downloading: ${url}`);
    await downloadFile(url, tmp);

    const safeName = (filename || `output_${ts}.${ext}`)
      .replace(/[#%?&=+<>|\\/:*"]/g, '').replace(/\s+/g, '-');
    const key = folder ? `${folder}/${safeName}` : safeName;

    const mime = { mp4: 'video/mp4', mp3: 'audio/mpeg', png: 'image/png',
                   jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

    const buf = fs.readFileSync(tmp);
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET, Key: key, Body: buf,
      ContentType: mime[ext] || 'application/octet-stream',
    }));
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const r2Url = `${process.env.R2_PUBLIC_URL}/${encodedKey}`;

    cleanup();
    console.log(`✅ [Save] Done → ${r2Url}`);
    res.json({ success: true, r2Url, key });
  } catch (err) {
    cleanup();
    console.error('❌ save-url-to-r2 error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/trim-and-save-to-r2', async (req, res) => {
  const { url, folder, filename, audioDuration } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const ts        = Date.now();
  const tmpInput  = `/tmp/trim_in_${ts}.mp4`;
  const tmpOutput = `/tmp/trim_out_${ts}.mp4`;
  const cleanup   = () => [tmpInput, tmpOutput].forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });

  try {
    console.log(`▶ [Trim] Downloading: ${url}`);
    await downloadFile(url, tmpInput);

    let durationSeconds = 0;
    try { await execAsync(`${ffmpegPath} -i "${tmpInput}"`, { timeout: 15000 }); } catch(e) {
      const m = (e.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (m) durationSeconds = +m[1]*3600 + +m[2]*60 + parseFloat(m[3]);
    }

    if (durationSeconds < 2) throw new Error(`Video too short to trim: ${durationSeconds}s`);

    const trimDuration = (audioDuration && audioDuration > 0)
      ? Math.min(audioDuration, durationSeconds - 0.1)
      : durationSeconds - 1;
    console.log(`▶ [Trim] Cutting: ${durationSeconds}s → ${trimDuration}s (audioDuration: ${audioDuration || 'not provided'})`);

    await execAsync(
      `${ffmpegPath} -y -i "${tmpInput}" -t ${trimDuration} -c copy "${tmpOutput}"`,
      { timeout: 120000 }
    );

    const safeName = (filename || `singing-avatar-${ts}.mp4`)
      .replace(/[#%?&=+<>|\\/:*"]/g, '').replace(/\s+/g, '-');
    const key = folder ? `${folder}/${safeName}` : safeName;

    const buf = fs.readFileSync(tmpOutput);
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET, Key: key, Body: buf, ContentType: 'video/mp4',
    }));
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const r2Url = `${process.env.R2_PUBLIC_URL}/${encodedKey}`;

    cleanup();
    console.log(`✅ [Trim] Done → ${r2Url} | original: ${durationSeconds}s → trimmed: ${trimDuration}s`);
    res.json({ success: true, r2Url, key, durationOriginal: durationSeconds, durationTrimmed: trimDuration });
  } catch (err) {
    cleanup();
    console.error('❌ trim-and-save-to-r2 error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/pick-novaziri-image', async (req, res) => {
  try {
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET,
      Prefix: 'NovaZiri Photo/',
    }));

    const objects = (listResult.Contents || []).filter(obj => !obj.Key.endsWith('/'));

    if (objects.length === 0) {
      return res.status(404).json({ error: 'No NovaZiri images available. Please upload more photos to the NovaZiri Photo folder.' });
    }

    const picked = objects[Math.floor(Math.random() * objects.length)];

    const getResult = await s3.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: picked.Key,
    }));

    const chunks = [];
    for await (const chunk of getResult.Body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const imageBuffer = Buffer.concat(chunks);

    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: picked.Key,
    }));

    console.log(`🖼️ [NovaZiri] Picked & deleted: ${picked.Key} | ${objects.length - 1} remaining`);

    const ext = picked.Key.split('.').pop().toLowerCase();
    const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
    res.setHeader('Content-Type', mimeTypes[ext] || 'image/png');
    res.send(imageBuffer);

  } catch (err) {
    console.error('❌ pick-novaziri-image error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
