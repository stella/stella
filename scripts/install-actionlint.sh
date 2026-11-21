#!/usr/bin/env bash
set -euo pipefail

version=${1:?actionlint version}
checksum=${2:?archive SHA-256}
directory=${3:?installation directory}
archive="$directory/actionlint.tar.gz"
retry="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/retry.sh"
# --output truncates, so a retried attempt never appends to a partial archive.
bash "$retry" curl --fail --location --silent --show-error --connect-timeout 20 \
  "https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz" \
  --output "$archive"
echo "$checksum  $archive" | sha256sum --check
tar --extract --gzip --file "$archive" --directory "$directory" actionlint
