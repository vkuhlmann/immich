# S3 original storage prototype

This branch adds native S3-compatible storage for new uploaded originals. Previews, thumbnails, edited images, encoded videos, profiles, mutable XMP sidecars and database backups remain on the local media volume. Existing local originals and external libraries continue to work. There is no encryption layer.

The API and mobile code are unchanged. Originals pass through Immich's existing authorization and download routes. The server streams private objects, including byte ranges for video playback. Clients do not need bucket credentials or direct access to S3. Use an official client compatible with this checkout's server version, currently `3.3.0-rc.0`. An Android device has not been tested.

## Run the automated prototype

Use Node 24 and the pnpm version in the root `package.json`. From the repository root:

```sh
pnpm --filter immich --filter @immich/sdk --filter @immich/plugin-sdk install --frozen-lockfile
pnpm --filter @immich/sdk build
pnpm --filter @immich/plugin-sdk build
pnpm --filter immich test:s3
```

The tests start a real HTTP S3 mock on a random loopback port and remove its temporary bucket afterward. They exercise the AWS SDK, filesystem, ExifTool, Sharp, upload service and HTTP file response. Database and queue repositories are mocked. They verify that metadata and thumbnails can be regenerated after deleting the staging original. These tests do not start the complete application.

This workspace also has an isolated Node 24/pnpm installation. To repeat the S3 tests with the dependencies already installed here:

```sh
PATH="$PWD/.tools/node_modules/.bin:$PATH" server/node_modules/.bin/vitest run --config server/test/vitest.config.s3.mjs
```

## Run the mock or full installation

The working demo in this workspace runs through Podman at `http://127.0.0.1:2285`. Its review account is `admin@s3-prototype.local` with password `s3-prototype-review-only`. It contains a generated photo and a two-second test video. If this workspace is on a remote host, forward port 2285 over SSH to open it locally.

The modified server build and installed dependencies are mounted into an upstream runtime image, pinned by digest, which supplies the web interface, geodata, plugins and FFmpeg. PostgreSQL, Valkey and S3 run separately. Existing services on this host are unaffected. To start, stop or inspect this demo from the repository root:

```sh
bash server/test/s3/demo.sh up
bash server/test/s3/demo.sh down
bash server/test/s3/demo.sh status
```

The script preserves its database volume and local test media. The demo forces video transcoding to exercise S3 processing. Rebuilding `server/dist` and restarting `immich-s3-prototype-server` picks up source changes. Recreate that container to change its environment. The launcher requires the dependencies and compiled server from the build instructions above; it does not build the full upstream Docker image.

Repeat the real API checks against this isolated installation:

```sh
PATH="$PWD/.tools/node_modules/.bin:$PATH" node server/test/s3/smoke.mjs
```

These checks cover login, upload, duplicate detection, original download hashes, byte ranges, real background metadata extraction, generated thumbnails, ZIP archives and denial of unauthenticated original downloads. Set `IMMICH_S3_SMOKE_VIDEO` to a video file path to include a video upload.

Start the persistent mock by itself:

```sh
node server/test/s3/mock-server.mjs
```

It listens on `http://127.0.0.1:4569`, creates `immich-test`, and uses `S3RVER` for both credentials. Objects persist in `server/.s3-prototype/buckets`. It is a development service with fixed credentials.

The isolated Compose recipe builds this modified checkout and includes PostgreSQL, Valkey and the mock. It uses separate named volumes and port 2285. Machine learning is disabled to keep the demo smaller.

```sh
docker compose -f docker/s3-prototype.compose.yml up --build -d
```

Open `http://localhost:2285` and create a test account. Upload a photo, check its metadata, and download the original. The originals volume should hold the object; the media volume should hold its preview and thumbnail. Stop the installation with the same Compose command followed by `down`; named volumes persist. To test a phone on the LAN, set `IMMICH_S3_DEMO_BIND` to the host's LAN address before starting Compose.

The TypeScript build, type checking, ESLint, 696 affected upstream unit tests and 12 S3 integration tests pass. The Podman installation also passed real photo/video uploads, download hashes, range streaming, ExifTool/FFmpeg metadata, thumbnail generation and video transcoding. Both photo and video thumbnails were removed and regenerated from S3. The web entry point responds successfully, but browser automation was unavailable. The complete Compose image build remains untested; its configuration was validated. Allow ample disk space for the upstream build stages and media processing.

## Connect a real bucket

Create a private bucket first, then give every Immich API and microservices process the same settings:

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

Copy the endpoint and region from your OVH bucket's configuration. The optional endpoint can be omitted for AWS. Explicit credentials must be supplied together; omitting both uses the AWS SDK credential chain. The server checks bucket access at startup and never creates a real bucket. Credentials need bucket inspection and object read, write, delete and multipart-upload permissions for the configured prefix. Keep the bucket private.

Defaults are local storage, region `us-east-1`, prefix `immich`, path style disabled, temporary location `<media-location>/s3-tmp`, and a 5 GiB temporary-file budget per process. Empty prefixes are allowed. The database stores original references as `s3://bucket/prefix/originals/owner/upload-uuid.ext`. Changing the bucket or prefix later requires migrating those references and objects together.

## Processing and failure behavior

Uploads first land in the existing local staging area. The server preserves their modification times, completes the S3 upload, checks the object's size and stores its URI in the asset row. It removes staging bytes after saving the asset and scheduling processing. Failed uploads use the existing file cleanup job, including remote-object cleanup when applicable. Uploads therefore still need local space and an available bucket.

ExifTool, Sharp and FFmpeg need local files. Each processing operation downloads the original into a private directory, retains the filename extension and modification time, and removes it on success or failure. Metadata and derivative paths in the database never point at temporary files. HLS playback keeps its temporary original until the encoder exits. Downloads and ZIP archives stream directly from S3.

The temporary budget covers active processing downloads within one process. It excludes upload staging, derived files and other workers. A file larger than the budget, or concurrent downloads that exceed it, fail processing. Immich's existing jobs do not automatically retry these failures. Increase the limit or reduce concurrency, then requeue the affected processing jobs. Network access uses the AWS SDK's request retries. A bucket outage produces a download error and must not create missing-file or checksum-failure reports.

Sidecar writes go to durable `<media-location>/sidecars`, addressed by a hash of the original's URI. Uploaded sidecars retain their existing local upload paths. Back up the complete local media volume, the database and the S3 originals. Storage templates skip remote originals because object keys remain stable.

## Remaining work before production

- Existing originals have no bulk migration command. Enabling S3 affects subsequent uploads.
- Extracted embedded motion-photo videos remain local, as upstream stores them under encoded video. Separately uploaded Live Photo videos use S3.
- Hard termination can leave processing directories or upload staging files. Clear stale processing files only with all workers stopped; automatic crash cleanup remains to be added.
- A crash between object upload and database commit can leave an unreferenced object. There is no bucket reconciliation job yet. The existing untracked-file scan only examines local folders.
- Configure a bucket lifecycle rule to abort stale multipart uploads. Bucket deletion, retention and versioning policies remain the operator's responsibility.
- There is no persistent download cache. Separate processing jobs download the same original again, with corresponding request and transfer costs.
- The 5 GiB budget is per process. It is not a shared filesystem quota, and each original must fit in it. Disk-full and interruption testing across multiple workers remains necessary.
- OVH itself, Android, HLS playback and a full image build still need deployment tests. The mock does not model every provider's S3 behavior.

Keep this branch separate from a real photo library until those deployment checks and backup restores have been completed.
