import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const s3 = new S3Client({});
const SERVICE_URL = process.env.SERVICE_URL!;

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export async function handler(event: S3Event): Promise<void> {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // Only process files under raw/
    if (!key.startsWith('raw/')) {
      console.log(`Skipping non-raw key: ${key}`);
      continue;
    }

    console.log(`Processing: s3://${bucket}/${key}`);

    // Download file from S3
    const getResp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const fileBuffer = await streamToBuffer(getResp.Body as Readable);
    const fileName = key.split('/').pop() || 'document';

    // Build multipart form data manually (no external deps needed in Node 18+)
    const boundary = `----FormBoundary${Date.now()}`;
    const formParts: Buffer[] = [];

    // File part
    formParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    ));
    formParts.push(fileBuffer);
    formParts.push(Buffer.from('\r\n'));

    // Close boundary
    formParts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(formParts);

    // Parse as text
    const textResp = await fetch(`${SERVICE_URL}/parse?text=true`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });

    if (!textResp.ok) {
      throw new Error(`Parse (text) failed: ${textResp.status} ${await textResp.text()}`);
    }
    const textContent = await textResp.text();

    // Parse as JSON
    const jsonResp = await fetch(`${SERVICE_URL}/parse`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });

    if (!jsonResp.ok) {
      throw new Error(`Parse (json) failed: ${jsonResp.status} ${await jsonResp.text()}`);
    }
    const jsonContent = await jsonResp.text();

    // Write outputs to processed/ prefix
    // raw/YYYYMMDD/report.docx → processed/YYYYMMDD/report.docx.txt + .json
    const processedKey = key.replace(/^raw\//, 'processed/');

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${processedKey}.txt`,
      Body: textContent,
      ContentType: 'text/plain',
    }));

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${processedKey}.json`,
      Body: jsonContent,
      ContentType: 'application/json',
    }));

    console.log(`Done: ${processedKey}.txt and ${processedKey}.json written`);
  }
}
