#!/usr/bin/env bash
set -eo pipefail
required=false
for answer in "$MIGRATION_PATHS" "$SCHEMA_IMPORTS" "$SCHEMA_IMPORTS_FALLBACK"; do
  if [[ "$answer" == true ]]; then
    required=true
  fi
done
echo "database_migrations_required=$required" >> "$GITHUB_OUTPUT"
