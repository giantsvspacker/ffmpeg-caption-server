const ffmpegPath = require('ffmpeg-static');
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { promisify } = require('util');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const execAsync = promisify(exec);
const MAX_BUFFER = 1024 * 1024 * 200; // 200 MB — prevents stderr maxBuffer exceeded on long videos

// Make node binary visible to yt-dlp subprocesses so they can solve YouTube's n-challenge
const ytDlpEnv = { ...process.env, PATH: `${require('path').dirname(process.execPath)}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}` };

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

// Universal browser cookies — stored in R2 at key: _config/cookies.txt (no size limit)
// Fallback: BROWSER_COOKIES or YOUTUBE_COOKIES env var (32KB limit, legacy)
// To update cookies: upload new cookies.txt to R2 → _config/cookies.txt → redeploy server
const COOKIES_PATH = '/tmp/browser-cookies.txt';
const COOKIES_R2_KEY = '_config/cookies.txt';
let cookiesReady = false; // loaded once at startup

async function loadCookiesFromR2() {
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const resp = await s3.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: COOKIES_R2_KEY
    }));
    const chunks = [];
    for await (const chunk of resp.Body) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw && raw.trim()) {
      fs.writeFileSync(COOKIES_PATH, raw, 'utf8');
      const count = raw.split('\n').filter(l => l && !l.startsWith('#')).length;
      console.log(`🍪 Cookies loaded from R2 (_config/cookies.txt): ${count} entries`);
      cookiesReady = true;
      return;
    }
  } catch(e) {
    if (e.name !== 'NoSuchKey') console.warn('⚠️ Could not load cookies from R2:', e.message);
  }

  // Fallback: env var (BROWSER_COOKIES or legacy YOUTUBE_COOKIES)
  const cookieData = process.env.BROWSER_COOKIES || process.env.YOUTUBE_COOKIES;
  if (cookieData && cookieData.trim()) {
    try {
      const normalised = cookieData.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const fixed = normalised.trim().split('\n').map(line => {
        const trimmed = line.trimEnd();
        if (trimmed.startsWith('#') || trimmed.trim() === '') return trimmed;
        if (!trimmed.includes('\t')) {
          return trimmed.replace(
            /^(\S+)\s+(TRUE|FALSE)\s+(\S+)\s+(TRUE|FALSE)\s+(\S+)\s+(\S+)\s+(.+)$/,
            '$1\t$2\t$3\t$4\t$5\t$6\t$7'
          );
        }
        return trimmed;
      }).join('\n');
      fs.writeFileSync(COOKIES_PATH, fixed + '\n', 'utf8');
      const count = fixed.split('\n').filter(l => l && !l.startsWith('#')).length;
      console.log(`🍪 Cookies loaded from env var: ${count} entries`);
      cookiesReady = true;
    } catch(e) {
      console.warn('⚠️ Failed to write cookies from env var:', e.message);
    }
  } else {
    console.log('ℹ️ No cookies configured — restricted videos will be skipped');
  }
}

function getCookiesFlag() {
  return cookiesReady ? `--cookies "${COOKIES_PATH}"` : '';
}

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
  const { videoUrl, srt, videoName, folder, audioDuration } = req.body;
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
      'FontSize=14',
      'Fontname=Archivo Black',
      'PrimaryColour=&H00FFFFFF','OutlineColour=&H00000000',
      'BackColour=&H80000000','Bold=1','Outline=2',
      'Shadow=1','Alignment=2','MarginV=30'
    ].join(',');
    const safeSub = sub.replace(/'/g, "\\'");
    const fontsDir = require('path').join(__dirname, 'fonts');
    const trimFlag = (audioDuration && parseFloat(audioDuration) > 0)
      ? `-t ${parseFloat(audioDuration).toFixed(3)}`
      : '';
    const cmd = `${ffmpegPath} -y -threads 1 -i "${inp}" -vf "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,unsharp=5:5:0.8:5:5:0.0,eq=brightness=0.04:contrast=1.08:saturation=1.15,subtitles='${safeSub}':fontsdir='${fontsDir}':force_style='${style}'" -c:v libx264 -preset veryfast -crf 18 -x264-params threads=1 -profile:v high -level 4.1 -c:a aac -b:a 128k -max_muxing_queue_size 256 -movflags +faststart ${trimFlag} "${out}"`;
    console.log(`▶ [${videoName}] Burning captions...`);
    await execAsync(cmd, { timeout: 900000, maxBuffer: MAX_BUFFER });
    console.log(`▶ [${videoName}] Uploading to R2...`);
    const safeBaseName = baseName.replace(/[#%?&=+]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
    const outputFolder = folder || 'captioned';
    const outputName = folder ? `${safeBaseName}.mp4` : `${safeBaseName}_captioned.mp4`;
    const key = `${outputFolder}/${outputName}`;
    await uploadToR2(out, key);
    const proxyUrl = `https://${req.get('host')}/proxy-r2?key=${encodeURIComponent(key)}`;
    cleanup();
    console.log(`✅ [${videoName}] Done! → ${proxyUrl}`);
    res.json({ success: true, videoUrl: proxyUrl, videoName });
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
  const { videoUrl, folder, artist } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
  const artistName = artist || (folder && folder.toLowerCase().includes('lufiaurora') ? 'LufiAurora' : 'NovaZiri');

  const ts = Date.now();
  const tmpVideo = `/tmp/vid_${ts}`;
  const tmpMp3   = `/tmp/audio_${ts}.mp3`;
  const cleanup  = () => [tmpVideo, tmpMp3].forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });

  try {
    console.log(`▶ [MP3:${artistName}] Getting title: ${videoUrl}`);
    let rawTitle = '';
    try {
      const { stdout: titleOut } = await execAsync(
        `yt-dlp --ffmpeg-location "${ffmpegPath}" --print "%(title)s" --no-playlist "${videoUrl}"`,
        { timeout: 30000, maxBuffer: MAX_BUFFER }
      );
      rawTitle = (titleOut || '').trim();
    } catch(e) { /* title fetch failed silently */ }

    let cleanTitle = rawTitle
      .replace(/^([\d.,]+[KMBkm]?\s+\w+[\s\u00B7·•,]+)+/i, '')
      .replace(/\s*\|.*$/, '')
      .trim();

    if (/^[\d\s.,KMBkm\u00B7·•–-]+$/.test(cleanTitle)) cleanTitle = '';

    if (!cleanTitle) {
      try {
        const { stdout: descOut } = await execAsync(
          `yt-dlp --ffmpeg-location "${ffmpegPath}" --print "%(description)s" --no-playlist "${videoUrl}"`,
          { timeout: 30000, maxBuffer: MAX_BUFFER }
        );
        const firstLine = (descOut || '').split('\n').map(l => l.trim()).find(l => l.length > 5) || '';
        cleanTitle = firstLine.replace(/\s*\|.*$/, '').trim();
      } catch(e) { /* description fetch failed silently */ }
    }

    const safeTitle = (cleanTitle || `audio_${ts}`)
      .replace(/lofilulla/gi, artistName)
      .replace(/[#%?&=+<>|\\/:*"\u00B7·]/g, '')
      .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
      .replace(new RegExp(`${artistName}-${artistName}`, 'gi'), artistName)
      || `audio_${ts}`;

    console.log(`▶ [MP3] Downloading audio: ${rawTitle}`);
    await execAsync(
      `yt-dlp --ffmpeg-location "${ffmpegPath}" -f "bestaudio[ext=m4a]/bestaudio/best" ` +
      `--no-playlist -o "${tmpVideo}" "${videoUrl}"`,
      { timeout: 300000, maxBuffer: MAX_BUFFER }
    );

    console.log(`▶ [MP3] Converting to MP3...`);
    await execAsync(
      `${ffmpegPath} -y -i "${tmpVideo}" -vn -ar 44100 -ac 2 -b:a 192k "${tmpMp3}"`,
      { timeout: 120000, maxBuffer: MAX_BUFFER }
    );

    let durationSeconds = 0, endTime = '0:00';
    try { await execAsync(`${ffmpegPath} -i "${tmpMp3}"`, { timeout: 10000, maxBuffer: MAX_BUFFER }); } catch(e) {
      const m = (e.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+)/);
      if (m) {
        durationSeconds = +m[1]*3600 + +m[2]*60 + +m[3];
      }
    }

    try {
      let silenceOut = '';
      try {
        const r = await execAsync(`${ffmpegPath} -i "${tmpMp3}" -af "silencedetect=noise=-35dB:d=0.3" -f null /dev/null`, { timeout: 30000, maxBuffer: MAX_BUFFER });
        silenceOut = r.stderr || '';
      } catch(e2) { silenceOut = e2.stderr || ''; }
      const silenceStarts = [...silenceOut.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
      if (silenceStarts.length > 0) {
        const lastSilenceStart = silenceStarts[silenceStarts.length - 1];
        const trailingSec = durationSeconds - lastSilenceStart;
        if (trailingSec > 0.3 && lastSilenceStart > 1) {
          console.log(`▶ [MP3] Trailing silence detected: cutting ${durationSeconds}s → ${lastSilenceStart.toFixed(3)}s (removed ${trailingSec.toFixed(2)}s)`);
          durationSeconds = parseFloat(lastSilenceStart.toFixed(3));
        }
      }
    } catch(e) { /* silencedetect failed silently — keep full duration */ }

    const tm = Math.floor(durationSeconds / 60), ts2 = Math.floor(durationSeconds % 60);
    endTime = `${tm}:${ts2.toString().padStart(2, '0')}`;

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
    try { await execAsync(`${ffmpegPath} -i "${tmpInput}"`, { timeout: 15000, maxBuffer: MAX_BUFFER }); } catch(e) {
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
      { timeout: 120000, maxBuffer: MAX_BUFFER }
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

app.post('/pick-lufiaurora-image', async (req, res) => {
  try {
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET,
      Prefix: 'LufiAurora-Photo/',
    }));

    const objects = (listResult.Contents || []).filter(obj => !obj.Key.endsWith('/'));

    if (objects.length === 0) {
      return res.status(404).json({ error: 'No LufiAurora images available. Please upload more photos to the LufiAurora-Photo folder.' });
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

    console.log(`🖼️ [LufiAurora] Picked & deleted: ${picked.Key} | ${objects.length - 1} remaining`);

    const ext = picked.Key.split('.').pop().toLowerCase();
    const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
    res.setHeader('Content-Type', mimeTypes[ext] || 'image/png');
    res.send(imageBuffer);

  } catch (err) {
    console.error('❌ pick-lufiaurora-image error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/proxy-r2', async (req, res) => {
  const key = decodeURIComponent(req.query.key || '');
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    const ext = (key.split('.').pop() || '').toLowerCase();
    const mime = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4',
                   mp3: 'audio/mpeg', webm: 'video/webm', mkv: 'video/x-matroska' };
    res.setHeader('Content-Type', mime[ext] || 'video/mp4');
    console.log(`📡 proxy-r2: ${key}`);
    data.Body.pipe(res);
  } catch(err) {
    console.error('❌ proxy-r2 error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/scale-video', async (req, res) => {
  const { videoUrl, width, height, folder, videoName } = req.body;
  if (!videoUrl || !width || !height || !videoName)
    return res.status(400).json({ error: 'videoUrl, width, height, videoName required' });

  const ts  = Date.now();
  const inp = `/tmp/scale_in_${ts}.mp4`;
  const out = `/tmp/scale_out_${ts}.mp4`;
  const cleanup = () => [inp, out].forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });

  try {
    const w = parseInt(width);
    const h = parseInt(height);
    console.log(`▶ [Scale] Downloading: ${videoUrl}`);
    await downloadFile(videoUrl, inp);

    console.log(`▶ [Scale] Upscaling to ${w}x${h}...`);
    const cmd = `${ffmpegPath} -y -i "${inp}" -vf "scale=${w}:${h}:flags=lanczos" -c:v libx264 -preset veryfast -crf 20 -c:a copy -movflags +faststart "${out}"`;
    await execAsync(cmd, { timeout: 600000, maxBuffer: MAX_BUFFER });

    const baseName = videoName.replace(/\.(mov|mp4|avi|mkv|webm|m4v)$/i, '');
    const safeBaseName = baseName
      .replace(/[#%?&=+<>|\\/:*"]/g, '')
      .replace(/\s+/g, '-').replace(/-+/g, '-').trim();
    const outputFolder = folder || 'scaled';
    const key = `${outputFolder}/${safeBaseName}.mp4`;

    console.log(`▶ [Scale] Uploading to R2: ${key}`);
    await uploadToR2(out, key);
    const proxyUrl = `https://${req.get('host')}/proxy-r2?key=${encodeURIComponent(key)}`;

    cleanup();
    console.log(`✅ [Scale] Done! ${w}x${h} → ${proxyUrl}`);
    res.json({ success: true, output_url: proxyUrl, key });
  } catch (err) {
    cleanup();
    console.error('❌ scale-video error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/download-youtube-to-r2', async (req, res) => {
  const { youtubeUrl, folder, videoName, width, height } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: 'youtubeUrl required' });

  const w = parseInt(width)  || 2160;
  const h = parseInt(height) || 3840;
  const ts  = Date.now();
  const inp = `/tmp/yt_in_${ts}.mp4`;
  const trimmed = `/tmp/yt_trim_${ts}.mp4`;
  const out = `/tmp/yt_out_${ts}.mp4`;
  const cleanup = () => [inp, trimmed, out].forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });

  try {
    const cookiesFlag = getCookiesFlag();
    const jsRuntime = `--js-runtimes "node:${process.execPath}"`;
    // Detect platform — YouTube needs specific player_client args; other sites use auto-detection
    const isYouTube = /youtube\.com|youtu\.be/.test(youtubeUrl);
    const extractorArgs = isYouTube
      ? (cookiesFlag
          ? '--extractor-args "youtube:player_client=web,web_creator"'
          : '--extractor-args "youtube:player_client=android,ios"')
      : ''; // Instagram, TikTok, Dailymotion etc — let yt-dlp auto-detect

    let rawTitle = '';
    try {
      const { stdout: titleOut } = await execAsync(
        `yt-dlp --ffmpeg-location "${ffmpegPath}" --print "%(title)s" --no-playlist ` +
        `${jsRuntime} ${extractorArgs} ${cookiesFlag} "${youtubeUrl}"`,
        { timeout: 30000, maxBuffer: MAX_BUFFER, env: ytDlpEnv }
      );
      rawTitle = (titleOut || '').trim();
    } catch(e) { /* title fetch failed silently */ }

    // Always include timestamp in filename → guarantees unique R2 key even when titles are identical
    const baseTitle = rawTitle.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 60);
    const safeName = videoName || `${baseTitle}_${ts}.mp4`;

    console.log(`▶ [YT] Downloading: ${rawTitle || youtubeUrl}`);
    // Retry once on 429 (rate-limit) after a short wait
    let ytErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await execAsync(
          `yt-dlp --ffmpeg-location "${ffmpegPath}" -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" ` +
          `--no-playlist --merge-output-format mp4 --sleep-interval 3 --max-sleep-interval 8 ` +
          `${jsRuntime} ${extractorArgs} ${cookiesFlag} -o "${inp}" "${youtubeUrl}"`,
          { timeout: 360000, maxBuffer: MAX_BUFFER, env: ytDlpEnv }
        );
        ytErr = null; break;
      } catch (e) {
        ytErr = e;
        if (attempt === 1 && (e.message || '').includes('429')) {
          console.warn('⚠️ [YT] 429 rate-limit hit — waiting 30s before retry...');
          await new Promise(r => setTimeout(r, 30000));
        } else { break; }
      }
    }

    // If cookie-based download failed → retry without cookies
    // For YouTube: use android,ios clients (no n-challenge, no cookies needed)
    // For Instagram/other: cookies are the only option — if they fail, video is restricted → skip
    if (ytErr && cookiesFlag) {
      const msg1 = (ytErr.message || '') + (ytErr.stderr || '');
      const isRestricted = msg1.includes('Sign in') || msg1.includes('age-restricted') || msg1.includes('confirm your age') || msg1.includes('Only images') || msg1.includes('403') || msg1.includes('Forbidden') || msg1.includes('inappropriate') || msg1.includes('unavailable for certain audiences') || msg1.includes('Login required') || msg1.includes('Private video');
      if (isRestricted && isYouTube) {
        console.warn('⚠️ [YT] Cookie path failed — retrying without cookies (android,ios)...');
        try {
          await execAsync(
            `yt-dlp --ffmpeg-location "${ffmpegPath}" -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" ` +
            `--no-playlist --merge-output-format mp4 --sleep-interval 3 --max-sleep-interval 8 ` +
            `${jsRuntime} --extractor-args "youtube:player_client=android,ios" -o "${inp}" "${youtubeUrl}"`,
            { timeout: 360000, maxBuffer: MAX_BUFFER, env: ytDlpEnv }
          );
          console.log('✅ [YT] Fallback (no-cookies) succeeded');
          ytErr = null;
        } catch (e2) { ytErr = e2; }
      }
    }

    if (ytErr) {
      const msg = (ytErr.message || '') + (ytErr.stderr || '');
      console.error('❌ [YT] yt-dlp error:', msg.slice(0, 800));
      if (msg.includes('429')) throw new Error('YouTube rate-limited this server IP (429). Wait ~10 min and retry.');
      if (msg.includes('Sign in') || msg.includes('age-restricted') || msg.includes('Only images') || msg.includes('confirm your age') || msg.includes('403') || msg.includes('Forbidden') || msg.includes('inappropriate') || msg.includes('unavailable for certain audiences') || msg.includes('Login required') || msg.includes('Private video')) {
        console.log(`⏭️ Skipping — restricted/blocked: ${youtubeUrl}`);
        cleanup();
        return res.json({ skipped: true, reason: 'blocked', youtubeUrl });
      }
      throw ytErr;
    }

    // Detect and trim freeze-frame endings (static image + audio, no motion)
    let sourceForScale = inp;
    try {
      let totalDuration = 0;
      try {
        await execAsync(`${ffmpegPath} -i "${inp}"`, { timeout: 15000, maxBuffer: MAX_BUFFER });
      } catch(e) {
        const m = (e.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
        if (m) totalDuration = +m[1]*3600 + +m[2]*60 + parseFloat(m[3]);
      }
      if (totalDuration > 8) {
        let freezeOut = '';
        try {
          const r = await execAsync(
            `${ffmpegPath} -i "${inp}" -vf "freezedetect=noise=0.003:duration=1.5" -f null /dev/null`,
            { timeout: 120000, maxBuffer: MAX_BUFFER }
          );
          freezeOut = r.stderr || '';
        } catch(e) { freezeOut = e.stderr || ''; }

        const freezeStarts = [...freezeOut.matchAll(/freeze_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
        // Only trim if the freeze starts in the last 40% of the video
        const trimAt = freezeStarts.find(t => t > totalDuration * 0.60);
        if (trimAt && trimAt > 3) {
          console.log(`✂️ [YT] Freeze-frame ending at ${trimAt.toFixed(2)}s / ${totalDuration.toFixed(2)}s — trimming`);
          await execAsync(
            `${ffmpegPath} -y -i "${inp}" -t ${trimAt.toFixed(3)} -c copy "${trimmed}"`,
            { timeout: 120000, maxBuffer: MAX_BUFFER }
          );
          sourceForScale = trimmed;
        } else {
          console.log(`✅ [YT] No freeze-frame ending detected (${totalDuration.toFixed(1)}s)`);
        }
      }
    } catch(e) {
      console.warn('⚠️ [YT] Freeze detection skipped:', e.message);
    }

    console.log(`▶ [YT] Scaling to ${w}x${h} (9:16 crop)...`);
    const cmd = `${ffmpegPath} -y -i "${sourceForScale}" -vf "scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}" -c:v libx264 -preset veryfast -crf 20 -c:a copy -movflags +faststart "${out}"`;
    await execAsync(cmd, { timeout: 540000, maxBuffer: MAX_BUFFER });

    const folderPath = (folder || 'YouTube-Downloads').replace(/\/$/, '');
    const key = `${folderPath}/${safeName}`;
    const publicUrl = await uploadToR2(out, key);

    cleanup();
    console.log(`✅ [YT] Done: ${publicUrl}`);
    res.json({ success: true, output_url: publicUrl, key, title: rawTitle, filename: safeName });
  } catch (err) {
    cleanup();
    console.error('❌ download-youtube-to-r2 error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/delete-r2', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    console.log(`🗑️ Deleted R2 key: ${key}`);
    res.json({ success: true, deleted: key });
  } catch (err) {
    console.error('❌ delete-r2 error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to upload new cookies.txt directly to R2 (no redeploy needed)
// POST /upload-cookies with body: { cookiesText: "...full cookies.txt content..." }
app.post('/upload-cookies', async (req, res) => {
  const { cookiesText } = req.body;
  if (!cookiesText || !cookiesText.trim()) return res.status(400).json({ error: 'cookiesText required' });
  try {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: COOKIES_R2_KEY,
      Body: cookiesText,
      ContentType: 'text/plain'
    }));
    // Reload into memory immediately
    await loadCookiesFromR2();
    res.json({ success: true, message: 'Cookies uploaded to R2 and reloaded' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: '3.0.0', maxBuffer: '200MB', cookiesReady }));
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT} — v3.0.0 (cookies from R2 — no size limit)`);
  // Load cookies from R2 (or env var fallback) before accepting requests
  await loadCookiesFromR2();
  // Auto-update yt-dlp at startup to get latest n-challenge solver + YouTube fixes
  exec('yt-dlp -U 2>&1', { env: ytDlpEnv }, (err, stdout) => {
    const out = (stdout || '').trim();
    if (out) console.log('🔄 yt-dlp update:', out.split('\n')[0]);
    else if (err) console.warn('⚠️ yt-dlp update failed (read-only fs?):', err.message.split('\n')[0]);
  });
});
