#!/bin/sh
set -eu

image=${1:-}
case "$image" in
  ""|*[!a-z0-9./:@_-]*)
    echo "previous web image must be a repository pinned by a lowercase sha256 digest" >&2
    exit 1
    ;;
esac
if ! LC_ALL=C grep -Eq '^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$' <<EOF
$image
EOF
then
  echo "previous web image must be a repository pinned by a lowercase sha256 digest" >&2
  exit 1
fi
