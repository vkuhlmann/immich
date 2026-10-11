import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ObjectStorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
  prefix: string;
  temporaryDirectory: string;
  temporaryMaxBytes: number;
}

export interface ObjectRead {
  stream: Readable;
  length: number;
  contentRange?: string;
  lastModified?: Date;
  etag?: string;
}

export interface LocalFile {
  path: string;
  release: () => Promise<void>;
}

export const isObjectPath = (path: string) => path.startsWith('s3://');

/** Originals are immutable. Temporary files are private to one operation and never stored in the database. */
export class ObjectStorage {
  private readonly client: S3Client;
  private temporaryBytes = 0;

  constructor(private readonly config: ObjectStorageConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
          : undefined,
      // Compatible with providers which do not implement the newer AWS checksum trailers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async initialize() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
    await mkdir(this.config.temporaryDirectory, { recursive: true, mode: 0o700 });
  }

  private key(path: string) {
    const prefix = `s3://${this.config.bucket}/`;
    if (!path.startsWith(prefix)) {
      throw new Error('Object path does not belong to the configured S3 bucket');
    }
    const key = path.slice(prefix.length);
    const allowedPrefix = this.config.prefix ? `${this.config.prefix}/` : '';
    if (!key || !key.startsWith(allowedPrefix)) {
      throw new Error('Object path does not belong to the configured S3 prefix');
    }
    return key;
  }

  async upload(path: string, ownerId: string): Promise<string> {
    const info = await stat(path);
    const key = [this.config.prefix, 'originals', ownerId, basename(path)].filter(Boolean).join('/');
    const objectPath = `s3://${this.config.bucket}/${key}`;
    const body = createReadStream(path);
    try {
      await new Upload({
        client: this.client,
        params: {
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentLength: info.size,
          ContentType: 'application/octet-stream',
          Metadata: { mtime: info.mtime.toISOString() },
        },
        queueSize: 2,
        leavePartsOnError: false,
      }).done();
      const stored = await this.head(objectPath);
      if (stored.ContentLength !== info.size) {
        throw new Error('S3 upload size verification failed');
      }
      return objectPath;
    } catch (error) {
      // Delete an object if completion/verification failed. Keep the local upload until the caller cleans it up.
      await this.delete(objectPath).catch(() => {});
      throw error;
    } finally {
      body.destroy();
    }
  }

  async head(path: string) {
    return this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.key(path) }));
  }

  async exists(path: string) {
    try {
      await this.head(path);
      return true;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
        return false;
      }
      // A bucket outage or denied access must not be treated as a missing original.
      throw error;
    }
  }

  async stat(path: string) {
    const info = await this.head(path);
    // Reuse Node's Stats methods without downloading the object just to check its existence or size.
    const result = await stat(this.config.temporaryDirectory);
    const modified = info.Metadata?.mtime ? new Date(info.Metadata.mtime) : (info.LastModified ?? new Date(0));
    result.mode = 0o10_0600;
    result.size = info.ContentLength ?? 0;
    result.mtime = result.atime = result.ctime = result.birthtime = modified;
    result.mtimeMs = result.atimeMs = result.ctimeMs = result.birthtimeMs = modified.getTime();
    return result;
  }

  async read(path: string, range?: string): Promise<ObjectRead> {
    // Normalize suffix ranges because some S3-compatible implementations interpret them incorrectly.
    if (range?.startsWith('bytes=-')) {
      const info = await this.head(path);
      const length = info.ContentLength ?? 0;
      const suffix = Number(range.slice(7));
      if (!Number.isSafeInteger(suffix) || suffix <= 0 || length === 0) {
        throw Object.assign(new Error('Invalid byte range'), { $metadata: { httpStatusCode: 416 } });
      }
      range = `bytes=${Math.max(0, length - suffix)}-${length - 1}`;
    }
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(path),
        Range: range,
      }),
    );
    if (!(result.Body instanceof Readable) || result.ContentLength === undefined) {
      throw new Error('S3 returned an invalid object body');
    }
    return {
      stream: result.Body,
      length: result.ContentLength,
      contentRange: result.ContentRange,
      lastModified: result.LastModified,
      etag: result.ETag,
    };
  }

  private async *iterate(path: string) {
    const object = await this.read(path);
    try {
      yield* object.stream;
    } finally {
      object.stream.destroy();
    }
  }

  createReadStream(path: string): Readable {
    // ZIP entries wait in a queue. Open their S3 requests only when the archive consumes each entry.
    return Readable.from(this.iterate(path), { objectMode: false });
  }

  async delete(path: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.key(path) }));
  }

  async acquire(path: string): Promise<LocalFile> {
    const info = await this.head(path);
    const size = info.ContentLength;
    if (size === undefined || size > this.config.temporaryMaxBytes) {
      throw new Error('Original exceeds IMMICH_S3_TEMP_MAX_BYTES');
    }
    if (this.temporaryBytes + size > this.config.temporaryMaxBytes) {
      // Fail instead of waiting while a nested operation may own a lease. Failed processing must be requeued.
      throw new Error('S3 processing temporary storage is full; retry after active jobs finish');
    }
    this.temporaryBytes += size;
    let directory: string | undefined;
    let released = false;
    const release = async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        if (directory) {
          await rm(directory, { recursive: true, force: true });
        }
      } finally {
        this.temporaryBytes -= size;
      }
    };
    try {
      directory = await mkdtemp(join(this.config.temporaryDirectory, 'original-'));
      const localPath = join(directory, basename(this.key(path)));
      const object = await this.read(path);
      await pipeline(object.stream, createWriteStream(localPath, { flags: 'wx', mode: 0o600 }));
      const downloaded = await stat(localPath);
      if (downloaded.size !== size) {
        throw new Error('S3 processing download size verification failed');
      }
      const mtime = info.Metadata?.mtime ? new Date(info.Metadata.mtime) : info.LastModified;
      if (mtime && !Number.isNaN(mtime.getTime())) {
        await utimes(localPath, mtime, mtime);
      }
      return { path: localPath, release };
    } catch (error) {
      await release();
      throw error;
    }
  }
}
