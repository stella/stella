#!/bin/sh
set -eu

fail() { printf '%s\n' "stella: $*" >&2; exit 1; }
case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) fail 'Unsupported operating system. Use install.ps1 on Windows.' ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail 'Unsupported architecture.' ;;
esac
asset="stella-$platform-$arch"
base=https://github.com/stella/stella/releases
if [ -n "${STELLA_VERSION:-}" ]; then
  version=${STELLA_VERSION#v}
  case "$version" in *[!0-9A-Za-z.-]*|'') fail 'Invalid STELLA_VERSION.' ;; esac
  release="$base/download/v$version"
else
  release="$base/latest/download"
fi
install_dir=${STELLA_INSTALL_DIR:-"$HOME/.local/bin"}
case "$install_dir" in /*) ;; *) fail 'STELLA_INSTALL_DIR must be absolute.' ;; esac
mkdir -p "$install_dir"
staging=$(mktemp -d "$install_dir/.stella-install.XXXXXXXX")
trap 'rm -rf "$staging"' EXIT HUP INT TERM
fetch() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 "$1" -o "$2"; }
fetch "$release/$asset" "$staging/$asset"
fetch "$release/checksums.txt" "$staging/checksums.txt"
expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$staging/checksums.txt")
[ "${#expected}" = 64 ] || fail 'Missing or invalid release checksum.'
case "$expected" in *[!0-9a-fA-F]*) fail 'Invalid release checksum.' ;; esac
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$staging/$asset" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$staging/$asset" | awk '{print $1}')
fi
[ "$actual" = "$expected" ] || fail 'Checksum mismatch; installation refused.'
chmod 755 "$staging/$asset"
mv -f "$staging/$asset" "$install_dir/stella"
config_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/stella
mkdir -p "$config_dir"
printf 'native\n' > "$config_dir/install-channel"
printf '%s/stella\n' "$install_dir" > "$config_dir/install-path"
# Quote literal paths so profile contents cannot execute directory names.
quoted_dir=$(printf '%s' "$install_dir" | sed "s/'/'\\\\''/g")
case "${SHELL:-}" in
  */fish)
    profile="${XDG_CONFIG_HOME:-"$HOME/.config"}/fish/conf.d/stella.fish"
    path_line="fish_add_path '$quoted_dir' # stella PATH"
    ;;
  */zsh) profile="$HOME/.zshrc"; path_line="export PATH='$quoted_dir':\"\$PATH\" # stella PATH" ;;
  *)
    if [ "$platform" = darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi
    path_line="export PATH='$quoted_dir':\"\$PATH\" # stella PATH"
    ;;
esac
case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *)
    if [ "${STELLA_NO_MODIFY_PATH:-}" = 1 ]; then
      printf 'Add this line to %s:\n%s\n' "$profile" "$path_line"
    elif ! [ -f "$profile" ] || ! grep -Fqx "$path_line" "$profile"; then
      mkdir -p "$(dirname "$profile")"
      # Replace only our own prior line when an override changes the directory.
      if [ -f "$profile" ]; then
        awk '$0 !~ / # stella PATH$/ { print }' "$profile" > "$staging/profile"
      else
        : > "$staging/profile"
      fi
      printf '%s\n' "$path_line" >> "$staging/profile"
      cat "$staging/profile" > "$profile"
    fi
    ;;
esac
printf 'Installed stella to %s/stella\nNext: stella auth login\n' "$install_dir"
