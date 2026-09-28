#!/usr/bin/env node
// Legt den S3-Bucket aus OPENVIDEO_S3_BUCKET an, falls er fehlt (Init-Container in Kubernetes).
//
// Läuft nur, wenn OPENVIDEO_S3_CREATE_BUCKET=true ist (z. B. für das mitgelieferte SeaweedFS).
// Bei einem fremden S3 (AWS, MinIO) lege den Bucket selbst an und lasse die Variable weg.
// Wartet bis zu OPENVIDEO_S3_WAIT_SECONDS (Standard 300) auf den Speicher.
import { signV4 } from '@agentic-video/cache';

const env = process.env;
if (env.OPENVIDEO_S3_CREATE_BUCKET !== 'true' || env.OPENVIDEO_S3_ENDPOINT === undefined) {
  process.stdout.write('s3-bucket: nothing to do (OPENVIDEO_S3_CREATE_BUCKET is not "true").\n');
  process.exit(0);
}
const need = (name) => {
  const value = env[name];
  if (value === undefined || value === '') {
    process.stderr.write(`s3-bucket: ${name} is required.\n`);
    process.exit(2);
  }
  return value;
};
const bucket = need('OPENVIDEO_S3_BUCKET');
const url = new URL(`${need('OPENVIDEO_S3_ENDPOINT').replace(/\/$/u, '')}/${bucket}`);
const region = env.OPENVIDEO_S3_REGION ?? 'us-east-1';
const accessKeyId = need('OPENVIDEO_S3_ACCESS_KEY_ID');
const secretAccessKey = need('OPENVIDEO_S3_SECRET_ACCESS_KEY');
const deadline = performance.now() + Number(env.OPENVIDEO_S3_WAIT_SECONDS ?? '300') * 1000;

for (let attempt = 1; ; attempt++) {
  let reason;
  try {
    const headers = signV4({ method: 'PUT', url, region, accessKeyId, secretAccessKey, body: new Uint8Array(), now: new Date() });
    const res = await fetch(url, { method: 'PUT', headers, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    // 409 BucketAlreadyOwnedByYou / BucketAlreadyExists: der Bucket ist schon da.
    if (res.ok || res.status === 409) {
      process.stdout.write(`s3-bucket: bucket "${bucket}" is ready (HTTP ${String(res.status)}).\n`);
      process.exit(0);
    }
    reason = `HTTP ${String(res.status)} ${text.slice(0, 200)}`;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  if (performance.now() > deadline) {
    process.stderr.write(`s3-bucket: giving up after ${String(attempt)} attempts: ${reason}\n`);
    process.exit(1);
  }
  process.stdout.write(`s3-bucket: waiting for ${url.origin} (${reason})\n`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
