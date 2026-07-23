#!/usr/bin/env bash
set -euo pipefail

base_ref=""
version=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      base_ref="${2:-}"
      shift 2
      ;;
    --version)
      version="${2:-}"
      shift 2
      ;;
    *)
      echo "::error::Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Enforce that changelog media embeds actually render on the landing changelog
# and stay accessible. The client renderer only recognizes `<video ... src>`
# and markdown-image syntax, so a raw user-attachments URL falls through to
# inert paragraph text; and a `<video>` without `controls` gives readers no way
# to play, pause, or scrub the demo. This runs on every changelog file (not
# just the release being cut) so a regression fails the PR check and the release
# tag gate rather than shipping a broken or inaccessible embed.
validate_changelog_media() {
  local had_error=0
  local file line_no line
  for file in docs/changelog/v*.md; do
    [[ -e "$file" ]] || continue
    line_no=0
    while IFS= read -r line || [[ -n "$line" ]]; do
      line_no=$((line_no + 1))
      if [[ "$line" == *"<video"* && "$line" != *"controls"* ]]; then
        echo "::error file=$file,line=$line_no::<video> embed is missing the 'controls' attribute; use <video controls src=\"...\"></video> so readers can play the demo." >&2
        had_error=1
      fi
      if [[ "$line" == *"github.com/user-attachments/"* && "$line" != *"<video"* && "$line" != *"!["* ]]; then
        echo "::error file=$file,line=$line_no::raw user-attachments URL renders as plain text; wrap it as <video controls src=\"...\"></video> (video) or ![alt](url) (image)." >&2
        had_error=1
      fi
    done < "$file"
  done
  if [[ "$had_error" -ne 0 ]]; then
    echo "::error::Changelog media validation failed; see annotations above." >&2
    exit 1
  fi
}

validate_changelog_media

if [[ -z "$version" ]]; then
  if [[ ! -f VERSION ]]; then
    echo "::error::VERSION file is missing" >&2
    exit 1
  fi
  version="$(tr -d '[:space:]' < VERSION)"
fi

if [[ -n "$base_ref" ]]; then
  previous_version="$(git show "$base_ref:VERSION" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$previous_version" == "$version" ]]; then
    echo "VERSION unchanged ($version); changelog release file not required."
    exit 0
  fi
fi

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(rc|beta|alpha)\.[0-9]+)?$ ]]; then
  echo "::error::VERSION must look like 1.2.3, 1.2.3-rc.1, 1.2.3-beta.1, or 1.2.3-alpha.1; got '$version'" >&2
  exit 1
fi

if [[ "$version" == *-* ]]; then
  echo "VERSION $version is a prerelease; public changelog preview file not required."
  exit 0
fi

changelog_file="docs/changelog/v${version}.md"
if [[ ! -f "$changelog_file" ]]; then
  cat >&2 <<EOF
::error file=VERSION::VERSION was bumped to $version, but $changelog_file is missing.
Create the file even for minor releases with no handwritten notes; it may be blank. The landing site uses it to generate release-specific link preview pages and version-only fallback images.
EOF
  exit 1
fi

echo "Found $changelog_file for VERSION $version."
