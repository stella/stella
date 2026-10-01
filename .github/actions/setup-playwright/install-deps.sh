#!/usr/bin/env bash
set -euo pipefail

# Playwright invokes apt itself; configure its child processes, too.
sudo tee /etc/apt/apt.conf.d/80-playwright-retries >/dev/null <<'APT'
Acquire::Retries "3";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
APT

# Bound the whole attempt: a mirror can keep transferring too slowly for an
# inactivity timeout to fire. A failed attempt may have installed some packages.
if timeout --kill-after=10s 180s bunx playwright install-deps "$@"; then
  exit 0
fi

echo "::warning::Playwright dependency install failed; retrying with the Ubuntu archive mirror"
shopt -s nullglob
for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  [[ -f "$source" ]] || continue
  sudo sed -i 's|://azure\.archive\.ubuntu\.com/ubuntu|://archive.ubuntu.com/ubuntu|g' "$source"
done

# A killed unpack/configure phase may leave dpkg interrupted. Reconcile before
# apt retries; missing dependencies can still be repaired by that final install.
if ! sudo timeout --kill-after=10s 60s dpkg --configure -a; then
  echo "::warning::dpkg recovery did not complete; the final dependency install must repair or fail"
fi

timeout --kill-after=10s 180s bunx playwright install-deps "$@"
