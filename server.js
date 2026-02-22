const ffmpegPath = require('ffmpeg-static');
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { promisify } = require('util');
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
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
  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

app.post('/burn-captions', async (req, res) => {
  const { videoUrl, srt, videoName } = req.body;
  if (!videoUrl || !srt || !videoName)
    return res.status(400).json({ error: 'videoUrl, srt, videoName required' });

  // Support .mp4 and .mov (and other formats) — always output as .mp4
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
      'FontSize=24',
      'PrimaryColour=&H00FFFFFF','OutlineColour=&H00000000',
      'BackColour=&H80000000','Bold=1','Outline=2',
      'Shadow=1','Alignment=2','MarginV=30'
    ].join(',');
    const safeSub = sub.replace(/'/g, "\\'");
    const cmd = `${ffmpegPath} -y -threads 1 -i "${inp}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,subtitles='${safeSub}':force_style='${style}'" -c:v libx264 -preset ultrafast -crf 23 -x264-params threads=1 -profile:v high -level 4.1 -c:a aac -b:a 128k -max_muxing_queue_size 256 -movflags +faststart "${out}"`;
    console.log(`▶ [${videoName}] Burning captions...`);
    await execAsync(cmd, { timeout: 900000 });
    console.log(`▶ [${videoName}] Uploading to R2...`);
    const key = `captioned/${baseName}_captioned.mp4`;
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

// List all videos from R2 bucket (excludes captioned/ folder)
// Used by n8n Queue Builder to auto-discover uploaded videos
app.get('/list-videos', async (req, res) => {
  try {
    const files = [];
    let continuationToken = undefined;

    do {
      const data = await s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET,
        ContinuationToken: continuationToken,
      }));

      if (data.Contents) {
        for (const obj of data.Contents) {
          const key = obj.Key;
          // Skip the captioned/ output folder and non-video files
          if (!key.startsWith('captioned/') && /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(key)) {
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

    // Sort oldest-first so videos post in upload order
    files.sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified));

    console.log(`📦 list-videos: found ${files.length} video(s) in R2`);
    res.json({ success: true, files, count: files.length });
  } catch (err) {
    console.error('❌ list-videos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
