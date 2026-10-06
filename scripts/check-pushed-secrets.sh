#!/usr/bin/env bash
# Scan the commits a push would publish for secrets. Runs from the pre-push
# hook, which hands every ref update on stdin as
# `<local-ref> <local-oid> <remote-ref> <remote-oid>`; each pushed ref is
# scanned from what the remote already has to what it would receive, so an
# explicit refspec (`git push origin other:other`) is covered, not only HEAD.
# Commits on a remote-tracking ref are already published, so a branch that
# merged main scans its own commits, not main's. Merges are read with
# `--remerge-diff`: a plain `git log -p` prints no patch for a merge, which
# would leave anything added while resolving it unscanned.
# Everything else is validated in CI.
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "error: gitleaks is required for pre-push secret scanning." >&2
  echo "Install it from https://github.com/gitleaks/gitleaks/releases" >&2
  echo "  macOS (Homebrew): brew install gitleaks" >&2
  echo "  Other platforms: use the releases page above" >&2
  exit 1
fi

zero_oid="0000000000000000000000000000000000000000"
ranges=()
records=0

if [[ ! -t 0 ]]; then
  while read -r local_ref local_oid remote_ref remote_oid; do
    [[ -z "${local_ref:-}" ]] && continue
    records=$((records + 1))
    # Deleting a remote ref publishes no commits.
    [[ "${local_oid}" == "${zero_oid}" ]] && continue
    if [[ "${remote_oid}" == "${zero_oid}" ]] ||
      ! git cat-file -e "${remote_oid}^{commit}" 2>/dev/null; then
      # New remote ref, or a remote tip this clone has not fetched (gitleaks
      # reads an unknown range as zero commits and exits 0): everything not
      # already on any remote-tracking ref.
      ranges+=("${local_oid} --not --remotes")
    else
      ranges+=("${remote_oid}..${local_oid} --not --remotes")
    fi
  done
fi

if [[ ${records} -gt 0 && ${#ranges[@]} -eq 0 ]]; then
  echo "secrets: the push publishes no commits; nothing to scan." >&2
  exit 0
fi

# Run by hand (no hook records): scan the current branch against origin/main.
if [[ ${#ranges[@]} -eq 0 ]]; then
  if base="$(git merge-base origin/main HEAD 2>/dev/null)"; then
    ranges+=("${base}..HEAD")
  else
    ranges+=("HEAD")
  fi
fi

# A scanner can exit 0 when Git cannot resolve the commits it was asked to
# read, so every range must resolve before any scan result is trusted.
for range in "${ranges[@]}"; do
  read -r -a revisions <<<"${range}"
  if ! git rev-list "${revisions[@]}" >/dev/null 2>&1; then
    echo "error: cannot resolve pushed commit range ${range}; secret scanning refused." >&2
    exit 1
  fi
done

# Git before 2.36 rejects --remerge-diff; gitleaks may then read no commits
# and pass, so refuse instead.
if ! git log --remerge-diff -n 0 HEAD >/dev/null 2>&1; then
  echo "error: git log --remerge-diff is unsupported (Git 2.36+ required); secret scanning refused." >&2
  exit 1
fi

# A resolvable range can still fail to print its patches (a blob a partial
# clone must fetch lazily, and the fetch fails); the scanner then reads no
# commits and exits 0, so every patch must be readable before the scan.
for range in "${ranges[@]}"; do
  read -r -a revisions <<<"${range}"
  if ! git log -p --remerge-diff "${revisions[@]}" >/dev/null 2>&1; then
    echo "error: cannot read the patches of pushed commit range ${range}; secret scanning refused." >&2
    exit 1
  fi
done

# Every changed commit must be read by the scanner. It counts a commit whose
# patch changes text lines in a file the commit keeps (not deleted); the scan
# passes only when its reported count covers the same count of the range.
scanner_log="$(mktemp)"
trap 'rm -f "${scanner_log}"' EXIT

for range in "${ranges[@]}"; do
  read -r -a revisions <<<"${range}"
  expected="$(
    git log -p --remerge-diff --no-ext-diff --no-color --format=%x01 "${revisions[@]}" |
      awk '
        /^\001/ { counted = 0; next }
        /^diff --git / { deleted = 0; next }
        /^deleted file mode / { deleted = 1; next }
        /^@@ / && !deleted && !counted { commits++; counted = 1 }
        END { print commits + 0 }
      '
  )"
  status=0
  gitleaks git --redact --no-banner --no-color --log-opts="--remerge-diff ${range}" . 2>"${scanner_log}" || status=$?
  cat "${scanner_log}" >&2
  if [[ ${status} -ne 0 ]]; then
    exit "${status}"
  fi
  scanned="$(sed -n 's/.* \([0-9][0-9]*\) commits scanned.*/\1/p' "${scanner_log}" | tail -n 1)"
  if [[ -z "${scanned}" ]]; then
    echo "error: the scanner did not report how many commits of ${range} it read; secret scanning refused." >&2
    exit 1
  fi
  if ((scanned < expected)); then
    echo "error: the scanner read ${scanned} of ${expected} changed commits in ${range}; secret scanning refused." >&2
    exit 1
  fi
done
