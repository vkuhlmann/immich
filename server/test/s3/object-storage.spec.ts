import express from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import S3rver from 's3rver';
import sharp from 'sharp';
import request from 'supertest';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetMediaCreateDto } from 'src/dtos/asset-media.dto.js';
import { AssetFileType, AssetType, CacheControl, JobName, JobStatus } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { MediaService } from 'src/services/media.service.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { ImmichFileResponse, sendFile } from 'src/utils/file.js';
import { ObjectStorage, ObjectStorageConfig } from 'src/utils/object-storage.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getForGenerateThumbnail, getForMetadataExtraction } from 'test/mappers.js';
import { factory } from 'test/small.factory.js';
import { newTestService } from 'test/utils.js';

describe('S3 originals against a local S3 server', () => {
  let root: string;
  let mock: S3rver;
  let config: ObjectStorageConfig;
  let storage: StorageRepository;
  let objects: ObjectStorage;
  const logger = LoggingRepository.create();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'immich-s3-test-'));
    mock = new S3rver({
      address: '127.0.0.1',
      port: 0,
      directory: join(root, 'bucket'),
      silent: process.env.S3_TEST_DEBUG !== '1',
      configureBuckets: [{ name: 'immich-test', configs: [] }],
    });
    const address = await mock.run();
    config = {
      bucket: 'immich-test',
      endpoint: `http://127.0.0.1:${address.port}`,
      region: 'us-east-1',
      accessKeyId: 'S3RVER',
      secretAccessKey: 'S3RVER',
      forcePathStyle: true,
      prefix: 'prototype',
      temporaryDirectory: join(root, 'processing'),
      temporaryMaxBytes: 32 * 1024 ** 2,
    };
    await mkdir(join(root, 'media'), { recursive: true });
    storage = new StorageRepository(logger);
    await storage.configureS3(config, join(root, 'media'));
    objects = new ObjectStorage(config);
    await objects.initialize();
  });

  afterAll(async () => {
    await mock?.close();
    await rm(root, { recursive: true, force: true });
  });

  const upload = async (bytes: Buffer, extension = '.jpg') => {
    const path = join(root, `${randomUUID()}${extension}`);
    await writeFile(path, bytes);
    const remotePath = await storage.storeOriginal(path, 'test-user');
    await rm(path);
    return remotePath;
  };

  it('stores bytes remotely and can read them after the staging file is removed', async () => {
    const bytes = randomBytes(1024);
    const remotePath = await upload(bytes);
    expect(remotePath).toMatch(/^s3:\/\/immich-test\/prototype\/originals\/test-user\//);
    const result = await storage.createReadStream(remotePath);
    const received = await Array.fromAsync(result.stream);
    expect(Buffer.concat(received)).toEqual(bytes);
    const info = await storage.stat(remotePath);
    expect(info.size).toBe(bytes.length);
    expect(info.isFile()).toBe(true);
    expect(await readdir(config.temporaryDirectory)).toEqual([]);
  });

  it('uploads and reads an object large enough to use multipart upload', async () => {
    const bytes = randomBytes(6 * 1024 ** 2);
    const remotePath = await upload(bytes);
    await storage.withLocalFile(remotePath, async (path) => {
      expect(
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ).toBe(createHash('sha256').update(bytes).digest('hex'));
    });
    expect(await readdir(config.temporaryDirectory)).toEqual([]);
  });

  it('streams multiple remote originals into a ZIP without processing downloads', async () => {
    const first = Buffer.from('first original bytes');
    const second = Buffer.from('second original bytes');
    const firstPath = await upload(first);
    const secondPath = await upload(second);
    const zip = storage.createZipStream();
    const chunks = Array.fromAsync(zip.stream);
    zip.addFile(firstPath, 'first.jpg');
    zip.addFile(secondPath, 'second.jpg');
    await zip.finalize();
    const bytes = Buffer.concat(await chunks);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(bytes.includes(first)).toBe(true);
    expect(bytes.includes(second)).toBe(true);
    expect(bytes.includes(Buffer.from('first.jpg'))).toBe(true);
    expect(bytes.includes(Buffer.from('second.jpg'))).toBe(true);
    expect(await readdir(config.temporaryDirectory)).toEqual([]);
  });

  it('streams original bytes and ranges through the existing HTTP file response', async () => {
    const bytes = Buffer.from('0123456789');
    const remotePath = await upload(bytes, '.mp4');
    const app = express();
    app.get('/api/assets/test/original', (req, res, next) => {
      void sendFile(
        res,
        next,
        () =>
          new ImmichFileResponse({
            path: remotePath,
            contentType: 'video/mp4',
            cacheControl: CacheControl.PrivateWithCache,
            ...storage.getRemoteFileOptions(remotePath),
          }),
        logger,
      );
    });
    const full = await request(app).get('/api/assets/test/original').expect(200);
    expect(full.body).toEqual(bytes);
    const partial = await request(app).get('/api/assets/test/original').set('Range', 'bytes=2-5').expect(206);
    expect(partial.headers['content-range']).toBe('bytes 2-5/10');
    expect(partial.body).toEqual(Buffer.from('2345'));
    const unchanged = await request(app)
      .get('/api/assets/test/original')
      .set('If-None-Match', full.headers.etag)
      .expect(304);
    expect(unchanged.headers['content-length']).toBeUndefined();
    const staleRange = await request(app)
      .get('/api/assets/test/original')
      .set('Range', 'bytes=2-5')
      .set('If-Range', '"old-etag"')
      .expect(200);
    expect(staleRange.body).toEqual(bytes);
    await request(app)
      .get('/api/assets/test/original')
      .set('Range', 'bytes=2-5')
      .set('If-Range', full.headers.etag)
      .expect(206);
    const suffix = await request(app).get('/api/assets/test/original').set('Range', 'bytes=-3').expect(206);
    expect(suffix.body).toEqual(Buffer.from('789'));
    await request(app).get('/api/assets/test/original').set('Range', 'bytes=50-60').expect(416);
    await request(app).get('/api/assets/test/original').set('Range', 'bytes=0-1,3-4').expect(416);
    await request(app).head('/api/assets/test/original').expect(200).expect('Content-Length', '10');
    expect(await readdir(config.temporaryDirectory)).toEqual([]);
  });

  it('cleans up temporary files when processing fails', async () => {
    const remotePath = await upload(Buffer.from('a photo'));
    let localPath = '';
    await expect(
      storage.withLocalFile(remotePath, async (path) => {
        localPath = path;
        await access(path);
        throw new Error('Processing failed');
      }),
    ).rejects.toThrow('Processing failed');
    await expect(access(localPath)).rejects.toThrow();
    expect(await readdir(config.temporaryDirectory)).toEqual([]);
  });

  it('bounds simultaneous processing files without deleting a file still in use', async () => {
    const limited = new ObjectStorage({ ...config, temporaryMaxBytes: 10 });
    await limited.initialize();
    const firstPath = await upload(Buffer.from('12345678'));
    const secondPath = await upload(Buffer.from('abcdefgh'));
    const first = await limited.acquire(firstPath);
    await expect(limited.acquire(secondPath)).rejects.toThrow('temporary storage is full');
    expect(await readFile(first.path)).toEqual(Buffer.from('12345678'));
    await first.release();
    await first.release();
    const second = await limited.acquire(secondPath);
    await second.release();
    expect(await readdir(config.temporaryDirectory)).toEqual([]);
  });

  it('rejects originals larger than the processing limit before downloading them', async () => {
    const limited = new ObjectStorage({ ...config, temporaryMaxBytes: 4 });
    const remotePath = await upload(Buffer.from('too large'));
    await expect(limited.acquire(remotePath)).rejects.toThrow('TEMP_MAX_BYTES');
    expect(await readdir(config.temporaryDirectory)).toEqual([]);
  });

  it('keeps sidecars in durable local storage and deletes remote originals idempotently', async () => {
    const remotePath = await upload(Buffer.from('delete me'));
    const sidecar = storage.getSidecarPath(remotePath);
    expect(sidecar.startsWith(join(root, 'media', 'sidecars'))).toBe(true);
    await writeFile(sidecar, 'sidecar metadata');
    await storage.unlink(remotePath);
    await storage.unlink(remotePath);
    expect(await storage.checkFileExists(remotePath)).toBe(false);
    expect(await readFile(sidecar, 'utf8')).toBe('sidecar metadata');
  });

  it('can access originals with a newly initialized backend after a restart', async () => {
    const remotePath = await upload(Buffer.from('survives restart'));
    const restarted = new StorageRepository(logger);
    await restarted.configureS3(config, join(root, 'media'));
    await restarted.withLocalFile(remotePath, async (path) => {
      expect(await readFile(path, 'utf8')).toBe('survives restart');
    });
  });

  it('rejects paths outside the configured bucket and prefix', async () => {
    await expect(objects.head('s3://other-bucket/prototype/file.jpg')).rejects.toThrow('configured S3 bucket');
    await expect(objects.head('s3://immich-test/other-prefix/file.jpg')).rejects.toThrow('configured S3 prefix');
  });

  it('extracts real EXIF and regenerates local thumbnails after removing the original', async () => {
    const jpeg = await sharp({ create: { width: 160, height: 120, channels: 3, background: '#336699' } })
      .withExif({ IFD0: { Artist: 'S3 prototype', Make: 'TestCamera' } })
      .jpeg()
      .toBuffer();
    const remotePath = await upload(jpeg);
    const asset = AssetFactory.from({
      originalPath: remotePath,
      originalFileName: 'photo.jpg',
      type: AssetType.Image,
    })
      .exif({ exifImageWidth: 160, exifImageHeight: 120 })
      .build();
    const metadataRepository = new MetadataRepository(logger);
    try {
      const metadata = newTestService(MetadataService, { storage, metadata: metadataRepository });
      StorageCore.setMediaLocation(join(root, 'media'));
      metadata.mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      await metadata.sut.handleMetadataExtraction({ id: asset.id });
      expect(metadata.mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({
            make: 'TestCamera',
            exifImageWidth: 160,
            exifImageHeight: 120,
            fileSizeInByte: jpeg.length,
          }),
        }),
      );
      expect(await readdir(config.temporaryDirectory)).toEqual([]);

      const media = newTestService(MediaService, { storage, media: new MediaRepository(logger) });
      StorageCore.setMediaLocation(join(root, 'media'));
      media.mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
      expect(await media.sut.handleGenerateThumbnails({ id: asset.id })).toBe(JobStatus.Success);
      const generated = media.mocks.asset.upsertFiles.mock.calls[0][0];
      expect(generated.map((file) => file.type)).toEqual(
        expect.arrayContaining([AssetFileType.Preview, AssetFileType.Thumbnail]),
      );
      for (const file of generated) {
        expect(file.path.startsWith(join(root, 'media', 'thumbs'))).toBe(true);
        const thumbnailInfo = await sharp(file.path).metadata();
        expect(thumbnailInfo.width).toBeGreaterThan(0);
        await rm(file.path);
      }
      // A second pass must download from S3 again and regenerate removed derivatives.
      expect(await media.sut.handleGenerateThumbnails({ id: asset.id })).toBe(JobStatus.Success);
      expect(await readdir(config.temporaryDirectory)).toEqual([]);
      expect(asset.originalPath).toBe(remotePath);
    } finally {
      await metadataRepository.teardown();
    }
  });

  it('runs the upload service with real S3 storage and removes its staging original', async () => {
    const { sut, mocks } = newTestService(AssetMediaService, { storage });
    const auth = factory.auth();
    const originalPath = join(root, `${randomUUID()}.jpg`);
    const bytes = Buffer.from('upload service original');
    await writeFile(originalPath, bytes);
    const file = {
      originalPath,
      originalName: 'image.jpg',
      uuid: randomUUID(),
      size: bytes.length,
      checksum: createHash('sha1').update(bytes).digest(),
    };
    const asset = AssetFactory.create({ ownerId: auth.user.id });
    mocks.asset.create.mockImplementation((input) => Promise.resolve({ ...asset, ...input } as typeof asset));
    const dto: AssetMediaCreateDto = { fileCreatedAt: new Date(), fileModifiedAt: new Date('2024-01-02T03:04:05Z') };
    const response = await sut.uploadAsset(auth, dto, file);
    expect(response.status).toBe(AssetMediaStatus.CREATED);
    const stored = mocks.asset.create.mock.calls[0][0].originalPath;
    expect(stored).toMatch(/^s3:\/\//);
    await expect(access(originalPath)).rejects.toThrow();
    expect(await storage.checkFileExists(stored!)).toBe(true);
    const storedInfo = await storage.stat(stored!);
    expect(storedInfo.mtime.toISOString()).toBe('2024-01-02T03:04:05.000Z');
    expect(mocks.job.queue).toHaveBeenCalledWith({
      name: JobName.AssetExtractMetadata,
      data: { id: asset.id, source: 'upload' },
    });
  });
});
