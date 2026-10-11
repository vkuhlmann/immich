import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import sharp from 'sharp';

// Run only against the isolated demo. This creates its first administrator and uploads test media.
const base = process.env.IMMICH_S3_SMOKE_URL ?? 'http://127.0.0.1:2285';
const email = 'admin@s3-prototype.local';
const password = 's3-prototype-review-only';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (response) => {
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
};
const credentials = { email, password };
const login = () =>
  fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
let response = await login();
if (response.status === 401) {
  await json(
    await fetch(`${base}/api/auth/admin-sign-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...credentials, name: 'S3 prototype reviewer' }),
    }),
  );
  response = await login();
}
const { accessToken } = await json(response);
const headers = { Authorization: `Bearer ${accessToken}` };
const upload = async (bytes, name, type) => {
  const body = new FormData();
  body.set('assetData', new Blob([bytes], { type }), name);
  body.set('fileCreatedAt', '2024-01-02T03:04:05.000Z');
  body.set('fileModifiedAt', '2024-01-02T03:04:05.000Z');
  const asset = await json(await fetch(`${base}/api/assets`, { method: 'POST', headers, body }));
  const original = await fetch(`${base}/api/assets/${asset.id}/original`, { headers });
  assert.equal(original.status, 200);
  assert.equal(digest(Buffer.from(await original.arrayBuffer())), digest(bytes));
  const range = await fetch(`${base}/api/assets/${asset.id}/original`, {
    headers: { ...headers, Range: 'bytes=2-15' },
  });
  assert.equal(range.status, 206);
  assert.equal(digest(Buffer.from(await range.arrayBuffer())), digest(bytes.subarray(2, 16)));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const thumbnail = await fetch(`${base}/api/assets/${asset.id}/thumbnail`, { headers });
    if (thumbnail.ok) {
      const info = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
      assert.ok(info.width > 0);
      console.log(
        `PASS ${name}: upload ${asset.status}, original SHA256, byte range, generated thumbnail. Asset ${asset.id}`,
      );
      return asset.id;
    }
    await thumbnail.arrayBuffer();
    await setTimeout(500);
  }
  throw new Error(`Thumbnail did not become available for ${asset.id}`);
};

const image = await sharp({ create: { width: 160, height: 120, channels: 3, background: '#336699' } })
  .withExif({ IFD0: { Artist: 'S3 prototype', Make: 'TestCamera' } })
  .jpeg()
  .toBuffer();
const id = await upload(image, 's3-prototype.jpg', 'image/jpeg');
const originals = [{ id, bytes: image }];
const asset = await json(await fetch(`${base}/api/assets/${id}`, { headers }));
assert.equal(asset.exifInfo.make, 'TestCamera');
assert.equal(asset.exifInfo.exifImageWidth, 160);
assert.equal(asset.exifInfo.exifImageHeight, 120);
console.log('PASS real background EXIF extraction');
if (process.env.IMMICH_S3_SMOKE_VIDEO) {
  const bytes = await readFile(process.env.IMMICH_S3_SMOKE_VIDEO);
  originals.push({ id: await upload(bytes, 's3-prototype.mp4', 'video/mp4'), bytes });
}
const assetIds = originals.map((original) => original.id);
await json(
  await fetch(`${base}/api/download/info`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetIds }),
  }),
);
const archive = await fetch(`${base}/api/download/archive`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ assetIds }),
});
assert.equal(archive.status, 200);
const archiveBytes = Buffer.from(await archive.arrayBuffer());
assert.equal(archiveBytes.subarray(0, 4).toString('hex'), '504b0304');
for (const original of originals) assert.ok(archiveBytes.includes(original.bytes));
if (process.env.IMMICH_S3_SMOKE_ARCHIVE) await writeFile(process.env.IMMICH_S3_SMOKE_ARCHIVE, archiveBytes);
console.log(`PASS ZIP archive contains ${originals.length} exact originals`);
assert.equal((await fetch(`${base}/api/assets/${id}/original`)).status, 401);
console.log('PASS unauthenticated original download is denied');
console.log(`Review account: ${email} / ${password}`);
