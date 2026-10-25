#!/bin/sh
set -eu

source_directory=$1
manifest=$2
destination_directory=$3
output_manifest=${4:-}

mkdir -p "$destination_directory"
while IFS= read -r asset; do
  case "$asset" in
    ""|/*|../*|*/../*|*/..)
      echo "invalid web asset manifest entry: $asset" >&2
      exit 1
      ;;
  esac

  source_file="$source_directory/$asset"
  destination_file="$destination_directory/$asset"
  if [ ! -f "$source_file" ]; then
    echo "web asset manifest entry is not a file: $asset" >&2
    exit 1
  fi
  # The destination is authoritative: a previous release can only fill gaps.
  if [ -e "$destination_file" ] || [ -L "$destination_file" ]; then
    continue
  fi
  mkdir -p "$(dirname "$destination_file")"
  cp -p "$source_file" "$destination_file"
done < "$manifest"

if [ -n "$output_manifest" ]; then
  cp -p "$manifest" "$output_manifest"
fi
