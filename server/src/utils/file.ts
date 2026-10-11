import { NotFoundException, ServiceUnavailableException, StreamableFile } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { access, constants } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { CacheControl } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ImmichReadStream } from 'src/repositories/storage.repository.js';
import { onRouteError } from 'src/utils/logger.js';
import { ObjectRead } from 'src/utils/object-storage.js';

export function getFileNameWithoutExtension(path: string): string {
  return basename(path, getFilenameExtension(path));
}

export function getFilenameExtension(path: string) {
  const extension = extname(path);
  if (!extension && path.startsWith('.') && !path.includes('.', 1)) {
    return path;
  }
  return extension;
}

export function getLivePhotoMotionFilename(stillName: string, motionName: string) {
  return getFileNameWithoutExtension(stillName) + getFilenameExtension(motionName);
}

export class ImmichFileResponse {
  public readonly path!: string;
  public readonly contentType!: string;
  public readonly cacheControl!: CacheControl;
  public readonly fileName?: string;
  public readonly getStream?: (range?: string) => Promise<ObjectRead>;
  public readonly getSize?: () => Promise<number>;

  constructor(response: ImmichFileResponse) {
    Object.assign(this, response);
  }
}
type SendFile = Parameters<Response['sendFile']>;
type SendFileOptions = SendFile[1];

const cacheControlHeaders: Record<CacheControl, string | null> = {
  [CacheControl.PrivateWithCache]:
    'private, max-age=86400, no-transform, stale-while-revalidate=2592000, stale-if-error=2592000',
  [CacheControl.PrivateWithoutCache]: 'private, no-cache, no-transform',
  [CacheControl.None]: null, // falsy value to prevent adding Cache-Control header
};

export const sendFile = async (
  res: Response,
  next: NextFunction,
  handler: () => Promise<ImmichFileResponse> | ImmichFileResponse,
  logger: LoggingRepository,
): Promise<void> => {
  // promisified version of 'res.sendFile' for cleaner async handling
  const _sendFile = (path: string, options: SendFileOptions) =>
    promisify<string, SendFileOptions>(res.sendFile).bind(res)(path, options);

  let remote = false;
  try {
    const file = await handler();
    remote = !!file.getStream;
    if (!remote) {
      await access(file.path, constants.R_OK);
    }

    const cacheControlHeader = cacheControlHeaders[file.cacheControl];
    if (cacheControlHeader) {
      // set the header to Cache-Control
      res.header('Cache-Control', cacheControlHeader);
    }

    res.header('Content-Type', file.contentType);
    if (file.fileName) {
      res.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    }

    if (file.getStream) {
      res.header('Accept-Ranges', 'bytes');
      let object: ObjectRead;
      try {
        const range = res.req.method === 'HEAD' ? undefined : res.req.headers.range;
        if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
          res
            .status(416)
            .header('Content-Range', `bytes */${await file.getSize!()}`)
            .end();
          return;
        }
        object = await file.getStream(range);
        const ifRange = res.req.headers['if-range'];
        if (range && typeof ifRange === 'string') {
          const matches = ifRange.startsWith('"')
            ? ifRange === object.etag
            : !!object.lastModified && object.lastModified.getTime() <= Date.parse(ifRange);
          if (!matches) {
            object.stream.destroy();
            object = await file.getStream();
          }
        }
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 416) {
          res
            .status(416)
            .header('Content-Range', `bytes */${await file.getSize!()}`)
            .end();
          return;
        }
        throw error;
      }
      try {
        res.status(object.contentRange ? 206 : 200);
        res.header('Content-Length', String(object.length));
        if (object.contentRange) {
          res.header('Content-Range', object.contentRange);
        }
        if (object.etag) {
          res.header('ETag', object.etag);
        }
        if (object.lastModified) {
          res.header('Last-Modified', object.lastModified.toUTCString());
        }
        if (res.req.fresh) {
          res.status(304).removeHeader('Content-Length');
          res.removeHeader('Content-Range');
          res.end();
          return;
        }
        if (res.req.method === 'HEAD') {
          res.end();
          return;
        }
        await pipeline(object.stream, res);
        return;
      } finally {
        object.stream.destroy();
      }
    }

    return await _sendFile(file.path, { dotfiles: 'allow' });
  } catch (error: Error | any) {
    const { canWrite } = onRouteError(undefined, res, error, logger);
    if (canWrite) {
      const status = error?.$metadata?.httpStatusCode;
      next(
        remote && status !== 404
          ? new ServiceUnavailableException('Original storage is unavailable')
          : new NotFoundException(),
      );
    }
  }
};

export const asStreamableFile = ({ stream, type, disposition, length }: ImmichReadStream) => {
  return new StreamableFile(stream, { type, disposition, length });
};
