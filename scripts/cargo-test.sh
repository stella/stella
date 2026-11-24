#!/usr/bin/env bash
# Runs `cargo test` (with the given arguments) in the current Rust package,
# under the toolchain its rust-toolchain.toml pins. Package tests run in
# parallel, and two rustup installs of the same toolchain at once leave it
# half installed, so the pinned toolchain (with its targets and components)
# is installed first under one lock per toolchain.
#
# The lock is an exclusive lock on a file, held on a descriptor the
# installer inherits: the system releases it once the installer and its
# holder have both ended, however they end. No lock outlives its installer,
# and no caller ever removes one. Perl holds it (it ships with macOS and
# every Debian and Ubuntu image the tests run on; `flock(1)` is not on
# macOS).
set -euo pipefail

if [[ ! -f rust-toolchain.toml ]]; then
  printf '%s: run it from a Rust package with a rust-toolchain.toml\n' "$0" >&2
  exit 2
fi
channel="$(sed -n 's/^channel = "\([^"]*\)"/\1/p' rust-toolchain.toml)"
readonly channel
readonly lock="${TMPDIR:-/tmp}/stella-rust-toolchain-${channel}.lock"

# Holds the lock while the installer runs and exits with its status.
# shellcheck disable=SC2016 # Perl's own variables, not the shell's.
perl -MFcntl=:flock,F_SETFD -e '
  open(my $lock, ">>", shift @ARGV) or die "cargo-test: lock: $!\n";
  flock($lock, LOCK_EX) or die "cargo-test: lock: $!\n";
  fcntl($lock, F_SETFD, 0) or die "cargo-test: lock: $!\n";
  system { $ARGV[0] } @ARGV;
  exit($? == -1 ? 127 : ($? & 127) ? 128 + ($? & 127) : $? >> 8);
' "${lock}" rustup toolchain install --no-self-update >/dev/null

exec cargo test "$@"
