import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import S3rver from 's3rver';

// Development credentials only. This mock listens on loopback by default.
const directory =
  process.env.MOCK_S3_DIRECTORY ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../.s3-prototype/buckets');
await mkdir(directory, { recursive: true });
const server = new S3rver({
  address: process.env.MOCK_S3_HOST ?? '127.0.0.1',
  port: Number(process.env.MOCK_S3_PORT ?? 4569),
  directory,
  silent: true,
  configureBuckets: [{ name: 'immich-test', configs: [] }],
});
const address = await server.run();
console.log(`S3 mock listening on http://${address.address}:${address.port}`);
console.log(`Bucket: immich-test; access key: S3RVER; secret key: S3RVER; data: ${directory}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void server.close().then(() => process.exit(0)));
}
