#!/usr/bin/env bash
#
# Create a portable release manifest for downstream deploy systems.
# Keep this infra neutral; do not tie it to Stella-specific deploy details.
#
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <version> <image-name> <image-digest>" >&2
  exit 1
fi

VERSION="$1"
IMAGE_NAME="$2"
IMAGE_DIGEST="$3"
MIGRATIONS_DIR="apps/api/drizzle"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required to create the release manifest." >&2
  exit 1
fi

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{ print $1 }'
    return
  fi

  shasum -a 256 | awk '{ print $1 }'
}

COMMIT_SHA="$(git rev-parse HEAD)"
GENERATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

MIGRATION_FILES_JSON="[]"
MIGRATION_COUNT="0"
MIGRATION_SHA256="$(printf '' | sha256_stdin)"

if [[ -d "$MIGRATIONS_DIR" ]]; then
  MIGRATION_LIST="$(mktemp)"
  cleanup_migration_list() {
    rm -f "$MIGRATION_LIST"
  }
  trap cleanup_migration_list EXIT

  (cd "$MIGRATIONS_DIR" && find . -type f | sed 's#^\./##' | sort) > "$MIGRATION_LIST"
  MIGRATION_COUNT="$(wc -l < "$MIGRATION_LIST" | tr -d ' ')"
  MIGRATION_FILES_JSON="$(jq -R -s -c 'split("\n") | map(select(length > 0))' < "$MIGRATION_LIST")"

  if [[ "$MIGRATION_COUNT" != "0" ]]; then
    MIGRATION_SHA256="$(
      while IFS= read -r file; do
        printf '%s\n' "$file"
        cat "$MIGRATIONS_DIR/$file"
        printf '\n'
      done < "$MIGRATION_LIST" | sha256_stdin
    )"
  fi
fi

jq -n \
  --arg schemaVersion "1" \
  --arg project "stella" \
  --arg component "api" \
  --arg version "$VERSION" \
  --arg commit "$COMMIT_SHA" \
  --arg generatedAt "$GENERATED_AT" \
  --arg imageName "$IMAGE_NAME" \
  --arg imageDigest "$IMAGE_DIGEST" \
  --arg migrationsPath "$MIGRATIONS_DIR" \
  --arg migrationsSha256 "$MIGRATION_SHA256" \
  --argjson migrationCount "$MIGRATION_COUNT" \
  --argjson migrationFiles "$MIGRATION_FILES_JSON" \
  '{
    schemaVersion: $schemaVersion,
    project: $project,
    component: $component,
    version: $version,
    commit: $commit,
    generatedAt: $generatedAt,
    image: {
      name: $imageName,
      digest: $imageDigest,
      reference: ($imageName + "@" + $imageDigest)
    },
    migrations: {
      path: $migrationsPath,
      count: $migrationCount,
      sha256: $migrationsSha256,
      files: $migrationFiles
    }
  }'
