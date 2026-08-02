#!/usr/bin/env bash
#
# Create a portable release manifest for downstream deploy systems.
# Keep this infra neutral; do not tie it to Stella-specific deploy details.
#
set -euo pipefail

if [[ $# -ne 6 ]]; then
  echo "Usage: $0 <version> <api-image-name> <api-image-digest> <web-image-name> <web-image-digest> <web-target-environment>" >&2
  exit 1
fi

VERSION="$1"
IMAGE_NAME="$2"
IMAGE_DIGEST="$3"
WEB_IMAGE_NAME="$4"
WEB_IMAGE_DIGEST="$5"
WEB_TARGET_ENVIRONMENT="$6"
MIGRATIONS_DIR="apps/api/drizzle"

validate_digest() {
  local label="$1"
  local digest="$2"

  if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "ERROR: ${label} must look like sha256:<64 lowercase hex chars>." >&2
    exit 1
  fi
}

validate_digest "API image digest" "$IMAGE_DIGEST"
validate_digest "web image digest" "$WEB_IMAGE_DIGEST"

if [[ "$WEB_TARGET_ENVIRONMENT" != "production" && "$WEB_TARGET_ENVIRONMENT" != "staging" ]]; then
  echo "ERROR: web target environment must be production or staging." >&2
  exit 1
fi

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
  --arg webImageName "$WEB_IMAGE_NAME" \
  --arg webImageDigest "$WEB_IMAGE_DIGEST" \
  --arg webTargetEnvironment "$WEB_TARGET_ENVIRONMENT" \
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
    webImage: {
      name: $webImageName,
      digest: $webImageDigest,
      reference: ($webImageName + "@" + $webImageDigest),
      targetEnvironment: $webTargetEnvironment
    },
    migrations: {
      path: $migrationsPath,
      count: $migrationCount,
      sha256: $migrationsSha256,
      files: $migrationFiles
    }
  }'
