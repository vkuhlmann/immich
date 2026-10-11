# S3-compatible original storage

This branch stores new uploaded originals in S3-compatible object storage.
Previews, thumbnails, edited images, encoded videos, profiles, mutable XMP
sidecars and database backups stay on the local media volume. Existing local
originals and external libraries continue to work. This is a custom extension
based on `3.3.0-rc.0`; the limitations below still apply. It adds no encryption
layer.

The API and mobile code are unchanged. Immich authorizes original downloads and
streams private objects through its existing routes, including byte ranges for
video playback. Clients need neither bucket credentials nor direct S3 access.
Use an official client compatible with the server version. Phone login through
Tailscale has been verified on the deployed instance.

## Configure a private bucket

Create the bucket, then give every Immich API and microservices process the
same environment settings:

```dotenv
IMMICH_STORAGE_BACKEND=s3
IMMICH_S3_BUCKET=your-bucket
IMMICH_S3_REGION=your-region
IMMICH_S3_ENDPOINT=https://your-provider-s3-endpoint
IMMICH_S3_ACCESS_KEY_ID=your-access-key
IMMICH_S3_SECRET_ACCESS_KEY=your-secret-key
IMMICH_S3_FORCE_PATH_STYLE=true
IMMICH_S3_PREFIX=immich
IMMICH_S3_TEMP_LOCATION=/data/s3-tmp
IMMICH_S3_TEMP_MAX_BYTES=5368709120
```

Use the endpoint and region from the provider's bucket configuration. Omit the
endpoint for AWS. Explicit credentials must be supplied together; omitting both
uses the AWS SDK credential chain. The server checks bucket access at startup
and does not create buckets. Credentials need bucket inspection and object
read, write, delete and multipart upload permissions for the configured prefix.
Keep the bucket private and credentials outside Git.

Defaults are local storage, region `us-east-1`, prefix `immich`, path-style
addressing disabled, temporary location `<media-location>/s3-tmp` and a 5 GiB
temporary-file budget per process. Empty prefixes are allowed. The database
stores originals as `s3://bucket/prefix/originals/owner/upload-uuid.ext`.
Changing the bucket or prefix requires moving objects and updating their
database references together. Enabling S3 only changes subsequent uploads;
there is no bulk migration command for existing originals.

The deployed OVH instance is managed by the parent containers repository's
`IMMICH-SETUP.md`. Its active credentials are in `../secrets/immich-storage.env`.
The separate checkout and deployed data directories are excluded from that
repository. This repository's ignored `.tools/` and `server/.s3-prototype/`
directories can contain an installed toolchain and live media; their names do
not mean they are disposable.

## Processing and failure behavior

Uploads first land in Immich's local staging area. The server preserves their
modification times, completes the S3 upload, checks the object's size and saves
its URI in the asset row. It removes staging bytes after saving the asset and
scheduling processing. Failed uploads use the existing file cleanup job,
including remote-object cleanup when applicable. Uploads still require local
space and an available bucket.

ExifTool, Sharp and FFmpeg require local files. Each processing operation
downloads its original into a private temporary directory, retains the filename
extension and modification time, then removes it on success or failure.
Database metadata and derivative paths never point at temporary files. HLS
playback retains its temporary original until the encoder exits. Downloads and
ZIP archives stream directly from S3.

The temporary budget covers active processing downloads within one process.
It excludes upload staging, derivatives and other workers. Originals larger
than the budget or concurrent downloads that exceed it fail processing.
Immich's existing jobs do not automatically retry these failures. Increase the
limit or reduce concurrency, then requeue affected jobs. The AWS SDK retries
network requests. A bucket outage returns a download error and must not create
missing-file or checksum-failure reports.

Sidecar writes use durable `<media-location>/sidecars` paths addressed by a hash
of the original URI. Uploaded sidecars retain their existing local upload
paths. Back up the complete local media volume, database and S3 originals.
Storage templates skip remote originals so object keys stay stable.

## Tests

Use Node 24 and the pnpm version declared in the root `package.json`. Install
dependencies and build the SDK and plugin SDK before running:

```sh
pnpm --filter immich test:s3
```

The integration tests start an HTTP S3 mock on a random loopback port and remove
its temporary bucket afterward. They exercise the AWS SDK, filesystem,
ExifTool, Sharp, upload service and HTTP file response. Database and queue
repositories are mocked; the tests do not start the complete application.
They cover multipart upload, exact bytes, ranges and cache headers, ZIP streaming,
temporary-file limits and cleanup, sidecars, deletion, restart access, real EXIF
extraction and thumbnail regeneration after removing staging originals.

Previous deployment checks against OVH's `gra` endpoint covered multipart
uploads, private access, migration hashes, photo/video uploads, metadata,
thumbnails, transcoding, byte ranges, ZIP downloads and permanent deletion.
The persistent demo stack and scripts that created shared test accounts have
been removed. The isolated integration tests retain their own local S3 mock.

## Operational limitations

- Extracted embedded motion-photo videos remain local under encoded video.
  Separately uploaded Live Photo videos use S3.
- Hard termination can leave processing directories or upload staging files.
  Remove stale processing files only with all workers stopped. Automatic crash
  cleanup is not implemented.
- A crash between object upload and database commit can leave an unreferenced
  object. There is no bucket reconciliation job; the untracked-file scan checks
  local folders only.
- Configure a bucket lifecycle rule to abort stale multipart uploads. Retention,
  versioning and bucket deletion policies remain operator responsibilities.
- Separate processing jobs download an original again. There is no persistent
  download cache, so requests and transfers incur provider costs.
- The temporary budget applies per process rather than across the filesystem.
  Multi-worker disk exhaustion and interruption tests remain outstanding.
- HLS playback, phone background uploads, full image builds and backup restores
  still need end-to-end deployment verification. The local mock does not model
  every provider's S3 behavior.
