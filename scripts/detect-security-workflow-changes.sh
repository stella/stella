#!/usr/bin/env bash
# Skip only after a successful complete PR diff proves the workflow irrelevant.
set -euo pipefail

scope=${1:-}
shift || true
case "$scope" in
  codeql) shopt -s nocasematch ;;
  migrations) ;;
  *) echo 'Unknown security workflow scope' >&2; exit 1 ;;
esac

relevant() {
  local file=$1
  case "$scope" in
    codeql)
      # Include embedded scripts and data formats in CodeQL's supported-language
      # table; its pinned upstream document drives the coverage test.
      case "$file" in
        *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts|*.es|*.es6|*.xsjs|*.xsjslib|\
        *.html|*.htm|*.xhtml|*.xhtm|*.vue|*.ejs|*.hbs|*.njk|*.html.erb|*.jsp|*.html.dot|\
        *.json|*.yaml|*.yml|*.raml|*.xml|*.py|*.pyi|*.rs|\
        .github/workflows/*|.github/codeql/*|\
        package.json|*/package.json|bun.lock|*/bun.lock|bun.lockb|*/bun.lockb|\
        package-lock.json|*/package-lock.json|yarn.lock|*/yarn.lock|pnpm-lock.yaml|*/pnpm-lock.yaml|\
        Cargo.toml|*/Cargo.toml|Cargo.lock|*/Cargo.lock|\
        pyproject.toml|*/pyproject.toml|uv.lock|*/uv.lock|poetry.lock|*/poetry.lock|\
        Pipfile|*/Pipfile|Pipfile.lock|*/Pipfile.lock|requirements*.txt|*/requirements*.txt|\
        scripts/detect-security-workflow-changes.sh|scripts/detect-security-workflow-changes.test.ts)
          return 0 ;;
      esac
      ;;
    migrations)
      case "$file" in
        docker/postgres/*|scripts/configure-test-postgres*.sh|\
        apps/api/drizzle/*|apps/api/src/db/*|apps/api/src/lib/db/*|apps/api/drizzle.config.ts|\
        scripts/*migrat*|scripts/fixtures/migration*/*|scripts/rehearse-better-auth-constraint-retry.sh|\
        .github/workflows/db-migrations.yml|scripts/detect-security-workflow-changes.sh|\
        scripts/detect-security-workflow-changes.test.ts)
          return 0 ;;
      esac
      ;;
  esac
  return 1
}

# The same predicate is exercised without Git by the path-coverage tests.
if [[ ${1:-} == --files ]]; then
  shift
  for file in "$@"; do
    if relevant "$file"; then echo true; exit 0; fi
  done
  echo false
  exit 0
fi

if [[ ${EVENT_NAME:-} != pull_request ]]; then
  echo true
  exit 0
fi
if [[ ! ${BASE_SHA:-} =~ ^[[:xdigit:]]{40}$ || ! ${HEAD_SHA:-} =~ ^[[:xdigit:]]{40}$ ]]; then
  echo 'Unknown PR base/head; running security checks' >&2
  echo true
  exit 0
fi

changes=$(mktemp)
trap 'rm -f "$changes"' EXIT
# No rename collapsing: moving code to a docs path must still match its old path.
if ! git diff --name-only --no-renames -z "$BASE_SHA...$HEAD_SHA" -- > "$changes"; then
  echo 'PR diff failed; running security checks' >&2
  echo true
  exit 0
fi
while IFS= read -r -d '' file; do
  if relevant "$file"; then echo true; exit 0; fi
done < "$changes"
echo false
