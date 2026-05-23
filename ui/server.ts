import express from 'express';
import multer from 'multer';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const s3 = new S3Client({});

const BUCKET = process.env.LITEPARSE_BUCKET || 'liteparse-docs-726793866085';
const PORT = parseInt(process.env.PORT || '3000');

app.use(express.static(path.join(__dirname, 'public')));

// Upload file to S3 raw/ prefix
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fileName = req.file.originalname.replace(/\s+/g, '_');
  const key = `raw/${today}/${fileName}`;

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: req.file.buffer,
    ContentType: req.file.mimetype,
  }));

  const processedPrefix = `processed/${today}/${fileName}`;
  res.json({ key, processedPrefix, bucket: BUCKET });
});

// Poll for processed results
app.get('/api/status', async (req, res) => {
  const prefix = req.query.prefix as string;
  if (!prefix) return res.status(400).json({ error: 'Missing prefix param' });

  const txtKey = `${prefix}.txt`;
  const jsonKey = `${prefix}.json`;

  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: txtKey }));
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: jsonKey }));
    res.json({ ready: true, txtKey, jsonKey });
  } catch {
    res.json({ ready: false });
  }
});

// Download processed result
app.get('/api/download', async (req, res) => {
  const key = req.query.key as string;
  if (!key) return res.status(400).json({ error: 'Missing key param' });

  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const contentType = key.endsWith('.json') ? 'application/json' : 'text/plain';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(key)}"`);

    const stream = resp.Body as Readable;
    stream.pipe(res);
  } catch (err: any) {
    res.status(404).json({ error: 'File not found', detail: err.message });
  }
});

// Preview parsed text
app.get('/api/preview', async (req, res) => {
  const key = req.query.key as string;
  if (!key) return res.status(400).json({ error: 'Missing key param' });

  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of resp.Body as Readable) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(Buffer.concat(chunks).toString('utf-8'));
  } catch (err: any) {
    res.status(404).json({ error: 'File not found' });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ╶─── LiteParse UI ───╴\n`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Bucket:  ${BUCKET}\n`);
});
