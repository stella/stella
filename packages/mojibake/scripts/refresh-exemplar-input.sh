#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
work_directory="${1:?Pass an empty working directory}"
java_binary="${CLDR_JAVA:?Set CLDR_JAVA to a Java 21 executable}"
manifest="$repo_root/packages/mojibake/scripts/cldr49-input.json"
mkdir -p "$work_directory"
if [[ -n "$(ls -A "$work_directory")" ]]; then
  echo 'CLDR refresh requires an empty working directory' >&2
  exit 1
fi

for input_name in source converter npm; do
  input_url="$(jq -r --arg name "$input_name" '.sources[$name].url' "$manifest")"
  expected_digest="$(jq -r --arg name "$input_name" '.sources[$name].sha256' "$manifest")"
  bash "$repo_root/scripts/retry.sh" curl --fail --location --max-time 120 \
    "$input_url" --output "$work_directory/$input_name.download"
  printf '%s  %s\n' "$expected_digest" "$work_directory/$input_name.download" | sha256sum --check --strict
done

# Only digest-verified release archives reach either unpacker.
mkdir "$work_directory/source" "$work_directory/npm" "$work_directory/converted"
unzip -q "$work_directory/source.download" -d "$work_directory/source"
tar -xzf "$work_directory/npm.download" --strip-components=1 -C "$work_directory/npm"
source_commit="$(jq -r '.sourceCommit' "$manifest")"
source_root="$work_directory/source/cldr-$source_commit"
bun "$repo_root/packages/mojibake/scripts/refresh-exemplar-input.ts" prepare "$work_directory"

# Select the official characters mapping, not calendars, units and currencies.
# The pinned source still owns both the package and path mapping definitions.
awk -v section="$(jq -r '.converterOptions.section' "$manifest")" '
  /^package=misc ;/ || index($0, "section=" section " ;") == 1 { print; count++ }
  END { if (count != 2) exit 1 }
' "$source_root/tools/cldr-code/src/main/resources/org/unicode/cldr/json/JSON_config.txt" \
  > "$work_directory/characters-config.txt"

# Production-data generation removes below-Basic locales. Resolve the immutable
# full release source directly with Unicode's own converter instead.
"$java_binary" -Xmx3g -XX:ActiveProcessorCount=2 \
  -Djava.util.concurrent.ForkJoinPool.common.parallelism=2 \
  "-DCLDR_DIR=$source_root" \
  -cp "$work_directory/converter.download" org.unicode.cldr.json.Ldml2JsonConverter \
  -c "$source_root/common/" -d "$work_directory/converted" \
  -k "$work_directory/characters-config.txt" \
  -m "$(cat "$work_directory/locales.regex")" \
  -r "$(jq -r '.converterOptions.resolved' "$manifest")" \
  -s "$(jq -r '.converterOptions.draftstatus' "$manifest")" \
  -l "$(jq -r '.converterOptions.coverage' "$manifest")" \
  -p "$(jq -r '.converterOptions.packages' "$manifest")" \
  -t "$(jq -r '.converterOptions.type' "$manifest")" \
  -o false -V "$(jq -r '.version' "$manifest")"
bun "$repo_root/packages/mojibake/scripts/refresh-exemplar-input.ts" collect "$work_directory"
