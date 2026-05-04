#!/usr/bin/env bash
#
# Tier-1 release verification: cheap static checks against a
# published desktop release. Catches the most common autoupdate
# regressions without needing a real install or a second build.
#
# Checks:
#   1. Each platform updater payload embeds the channel-correct
#      updater endpoint (build-time jq mutation actually baked the
#      URL into the binary).
#   2. The latest.json on S3/CloudFront has the expected shape:
#      version matches the tag, every advertised platform has a
#      url + signature, signatures are non-empty.
#   3. CloudFront serves the manifest publicly (no auth wall).
#
# Usage:
#   bash scripts/verify-release.sh <tag>
#     e.g. bash scripts/verify-release.sh v0.0.2
#
# Requires `gh`, `jq`, `curl`, `tar`, `7z`. Failure to find `7z`
# fails the script (Windows verification can't be silently skipped
# in a release gate). On macOS, uses `hdiutil` (built-in) only as a
# fallback if the `.app.tar.gz` updater payload is absent.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tag>" >&2
  exit 2
fi

tag="$1"
script_dir="$(cd "$(dirname "$0")" && pwd)"
channel=$(bash "$script_dir/release-channel.sh" "$tag")
expected_endpoint="https://downloads.stll.app/desktop/$channel/latest.json"
expected_version="${tag#v}"

# Set up a single private working dir and the cleanup hook BEFORE
# we do anything that might exit. Defining `cleanup` after the trap
# would mean an early-exit between the trap line and the function
# definition silently leaks the dir + any mounted DMG.
work=$(mktemp -d)
mounted_dmg=""
cleanup() {
  if [[ -n "$mounted_dmg" ]]; then
    hdiutil detach "$mounted_dmg" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

manifest_path="$work/latest.json"

PASS=0
FAIL=0
NOTES=()

note_pass() { PASS=$((PASS + 1)); printf '  \xe2\x9c\x93  %s\n' "$1"; }
note_fail() { FAIL=$((FAIL + 1)); NOTES+=("$1"); printf '  \xe2\x9c\x97  %s\n' "$1"; }

# ── Check 3: CloudFront reachability ───────────────────────────
echo "Check 3: CloudFront serves $expected_endpoint"
http_code=$(curl -sSo "$manifest_path" -w '%{http_code}' "$expected_endpoint" || true)
if [[ "$http_code" != "200" ]]; then
  note_fail "manifest GET returned HTTP $http_code (expected 200)"
else
  note_pass "manifest GET returned 200"
  if ! jq -e . "$manifest_path" >/dev/null 2>&1; then
    note_fail "manifest body is not valid JSON"
  else
    note_pass "manifest body parses as JSON"
  fi
fi

# ── Check 2: manifest shape ────────────────────────────────────
if [[ -s "$manifest_path" ]] && jq -e . "$manifest_path" >/dev/null 2>&1; then
  echo "Check 2: manifest shape"
  manifest_version=$(jq -r '.version // empty' "$manifest_path")
  if [[ "$manifest_version" == "$expected_version" ]]; then
    note_pass "manifest .version = $manifest_version"
  else
    note_fail "manifest .version is '$manifest_version', expected '$expected_version'"
  fi

  for required in pub_date platforms; do
    if jq -e ".$required" "$manifest_path" >/dev/null 2>&1; then
      note_pass "manifest .$required present"
    else
      note_fail "manifest missing .$required"
    fi
  done

  while IFS=$'\t' read -r platform url sig; do
    if [[ -z "$url" || "$url" == "null" ]]; then
      note_fail "platform $platform has no url"
    elif [[ -z "$sig" || "$sig" == "null" ]]; then
      note_fail "platform $platform has empty signature"
    else
      note_pass "platform $platform: url + signature present"
    fi
  done < <(jq -r '.platforms | to_entries[] | "\(.key)\t\(.value.url // "")\t\(.value.signature // "")"' "$manifest_path")
fi

# ── Check 1: binary embeds the channel-correct endpoint ────────
echo "Check 1: binary embeds $expected_endpoint"

# Helper: strings|grep on one file, with a label for the report.
# The subshell turns pipefail off — grep -q closes the pipe on the
# first match and `strings` exits with SIGPIPE (141), which under
# pipefail would make the entire pipeline look failed even when the
# URL was matched.
check_inner_binary() {
  local label="$1" path="$2"
  if [[ ! -f "$path" ]]; then
    note_fail "$label: inner binary not found at $path"
    return
  fi
  if (set +o pipefail; strings -- "$path" | grep -Fq "$expected_endpoint"); then
    note_pass "$label embeds $expected_endpoint"
  else
    note_fail "$label does NOT embed $expected_endpoint"
  fi
}

# --- macOS: prefer the .app.tar.gz updater payload (just gzip+tar
#     so we can extract anywhere). Fall back to mounting the .dmg
#     with hdiutil if the tar.gz is absent (older releases).
mac_payload="Stella-macos-universal.app.tar.gz"
if gh release download "$tag" --pattern "$mac_payload" --dir "$work" 2>/dev/null; then
  tar -xzf "$work/$mac_payload" -C "$work" 2>/dev/null
  # Tauri tars `<productName>.app` at the top level. The Mach-O
  # binary lives in Contents/MacOS — name varies (productName) so
  # grab the first executable in there.
  app_dir=$(find "$work" -maxdepth 2 -name '*.app' -type d | head -n 1)
  if [[ -n "$app_dir" ]]; then
    inner=$(find "$app_dir/Contents/MacOS" -maxdepth 1 -type f | head -n 1)
    check_inner_binary "macOS app ($mac_payload)" "$inner"
  else
    note_fail "macOS: no .app directory found inside $mac_payload"
  fi
elif gh release download "$tag" --pattern "Stella-macos-universal.dmg" --dir "$work" 2>/dev/null; then
  printf '  \xe2\x84\xb9\xef\xb8\x8f  macOS: .app.tar.gz absent; mounting .dmg as fallback\n'
  # `hdiutil attach` final tab-separated column is the mount path.
  # Use grep -oE to capture it intact even when the path contains
  # spaces (productName commonly does, e.g. "/Volumes/stella desktop").
  # awk '{print $NF}' would split on the space and silently truncate.
  mounted_dmg=$(hdiutil attach "$work/Stella-macos-universal.dmg" -nobrowse -noverify -noautoopen -mountrandom /tmp 2>/dev/null \
    | grep -oE '(/Volumes/|/tmp/)[^ ].*$' | tail -n 1 || true)
  if [[ -n "$mounted_dmg" && -d "$mounted_dmg" ]]; then
    inner=$(find "$mounted_dmg" -maxdepth 4 -path '*/Contents/MacOS/*' -type f | head -n 1)
    check_inner_binary "macOS .dmg" "$inner"
  else
    note_fail "macOS: failed to determine mount point for $work/Stella-macos-universal.dmg"
  fi
else
  note_fail "macOS: neither $mac_payload nor .dmg downloadable from $tag"
fi

# --- Windows: extract the NSIS installer with 7z to reach the
#     inner binary. NSIS LZMA-compresses payloads, so a flat
#     `strings` on the outer .exe can't see the URL.
#
# Refuse to skip when 7z is missing — a "skipped" Windows check
# would silently let a broken Windows build pass the release gate.
if ! command -v 7z >/dev/null 2>&1; then
  note_fail "Windows: 7z not installed (install with 'brew install p7zip' or 'apt install p7zip-full')"
else
  win_exe="Stella-windows-x64-setup.exe"
  if gh release download "$tag" --pattern "$win_exe" --dir "$work" 2>/dev/null; then
    win_extract="$work/win-extract"
    mkdir -p "$win_extract"
    if 7z x -y -o"$win_extract" "$work/$win_exe" >/dev/null 2>&1; then
      inner=$(find "$win_extract" -maxdepth 3 -iname '*.exe' -not -iname '*-setup.exe' -not -iname 'uninstall*.exe' -type f | head -n 1)
      check_inner_binary "Windows app ($win_exe)" "$inner"
    else
      note_fail "Windows: 7z failed to extract $win_exe"
    fi
  else
    note_fail "Windows: could not download $win_exe from $tag"
  fi
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if (( FAIL > 0 )); then
  printf 'Failures:\n'
  printf '  - %s\n' "${NOTES[@]}"
  exit 1
fi
