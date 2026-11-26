#!/usr/bin/env bash
set -eo pipefail
curl --fail --silent --show-error --aws-sigv4 "aws:amz:us-east-1:s3" \
  --user "$RUSTFS_ACCESS_KEY:$RUSTFS_SECRET_KEY" \
  --request PUT http://127.0.0.1:9000/stella
(cd apps/api && bun run src/db/migrate.ts)
