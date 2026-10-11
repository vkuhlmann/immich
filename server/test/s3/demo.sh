#!/usr/bin/env bash
set -euo pipefail

# Uses already installed dependencies and a compiled server. All resources have a dedicated prototype name.
prototype_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
prototype_runtime='ghcr.io/immich-app/immich-server@sha256:4b6b0a6a336b7ef8f9495814b1220c1965ee581034b7523293662d46db9dc620'
prototype_database='ghcr.io/immich-app/postgres@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23'
prototype_names=(immich-s3-prototype-redis immich-s3-prototype-database immich-s3-prototype-s3 immich-s3-prototype-server)

case "${1:-up}" in
  down)
    for prototype_name in "${prototype_names[@]}"; do
      if podman container exists "$prototype_name"; then podman stop "$prototype_name"; fi
    done
    exit 0
    ;;
  status)
    podman ps -a --filter name=immich-s3-prototype --format '{{.Names}} {{.Status}}'
    exit 0
    ;;
  up) ;;
  *) echo 'Usage: bash server/test/s3/demo.sh [up|down|status]' >&2; exit 1 ;;
esac

test -f "$prototype_root/server/dist/main.js" || { echo 'Build the server first; see S3-PROTOTYPE.md' >&2; exit 1; }
mkdir -p "$prototype_root/server/.s3-prototype/media"
if podman container exists immich-s3-prototype-redis; then
  podman start immich-s3-prototype-redis
else
  podman run -d --name immich-s3-prototype-redis -p 127.0.0.1:56379:6379 docker.io/valkey/valkey:9-alpine
fi
if podman container exists immich-s3-prototype-database; then
  podman start immich-s3-prototype-database
else
  podman run -d --name immich-s3-prototype-database -p 127.0.0.1:55435:5432 \
    -e POSTGRES_PASSWORD=prototype-only -e POSTGRES_USER=postgres -e POSTGRES_DB=immich \
    -v immich-s3-prototype-database:/var/lib/postgresql/data "$prototype_database"
fi
if podman container exists immich-s3-prototype-s3; then
  podman start immich-s3-prototype-s3
else
  podman run -d --name immich-s3-prototype-s3 --network host --security-opt label=disable \
    -v "$prototype_root:/workspace" -w /workspace/server --entrypoint node \
    "$prototype_runtime" test/s3/mock-server.mjs
fi

for prototype_attempt in {1..30}; do
  if podman exec immich-s3-prototype-database pg_isready -U postgres -d immich >/dev/null \
    && podman exec immich-s3-prototype-s3 node -e "fetch('http://127.0.0.1:4569').then(()=>process.exit(0),()=>process.exit(1))"; then
    break
  fi
  if [ "$prototype_attempt" -eq 30 ]; then echo 'Dependencies failed to start' >&2; exit 1; fi
  sleep 1
done
if podman container exists immich-s3-prototype-server; then
  podman start immich-s3-prototype-server
else
  podman run -d --name immich-s3-prototype-server --network host --security-opt label=disable \
    -v "$prototype_root:/workspace" \
    -v "$prototype_root/docker/s3-prototype.config.json:/etc/immich/prototype.json:ro" \
    -w /workspace/server --entrypoint node \
    -e IMMICH_HOST=127.0.0.1 -e IMMICH_PORT=2285 \
    -e IMMICH_MEDIA_LOCATION=/workspace/server/.s3-prototype/media \
    -e IMMICH_CONFIG_FILE=/etc/immich/prototype.json \
    -e DB_HOSTNAME=127.0.0.1 -e DB_PORT=55435 -e DB_USERNAME=postgres -e DB_PASSWORD=prototype-only \
    -e DB_DATABASE_NAME=immich -e REDIS_HOSTNAME=127.0.0.1 -e REDIS_PORT=56379 \
    -e IMMICH_STORAGE_BACKEND=s3 -e IMMICH_S3_BUCKET=immich-test -e IMMICH_S3_REGION=us-east-1 \
    -e IMMICH_S3_ENDPOINT=http://127.0.0.1:4569 -e IMMICH_S3_ACCESS_KEY_ID=S3RVER \
    -e IMMICH_S3_SECRET_ACCESS_KEY=S3RVER -e IMMICH_S3_FORCE_PATH_STYLE=true \
    -e IMMICH_SOURCE_REF=s3-prototype "$prototype_runtime" dist/main.js
fi
echo 'Demo starting at http://127.0.0.1:2285. Run server/test/s3/smoke.mjs to create the review account and verify media.'
