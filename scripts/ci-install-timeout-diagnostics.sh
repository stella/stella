#!/usr/bin/env bash
set -u
shopt -s nullglob

install_pid=$1
store=$2
tmp=$3

echo 'Install timeout diagnostics: process tree'
snapshot=$(ps -eo pid=,ppid=,stat=,wchan:32=,comm=)
tree=$(printf '%s\n' "$snapshot" | awk -v root="$install_pid" '
  { parent[$1]=$2; line[$1]=$0 }
  END { for (pid in line) { current=pid; for (n=0;n<100 && current>1;n++) {
    if (current==root) { print line[pid]; break } current=parent[current]
  } } }')
printf '%s\n' "$tree"
pids=$(printf '%s\n' "$tree" | awk 'NF { print $1 }')
for pid in $pids; do
  echo "Process $pid status and wchan"
  cat "/proc/$pid/status" "/proc/$pid/wchan" 2>&1 || true
  descriptors=(/proc/"$pid"/fd/*)
  echo "Process $pid open fd count: ${#descriptors[@]}"
done
if [[ -z "$pids" ]]; then
  echo "Install process $install_pid exited before the snapshot"
fi
echo 'Install store and temporary filesystem capacity'
df -h "$store" "$tmp" 2>&1 || true
df -i "$store" "$tmp" 2>&1 || true
echo 'Newest install-store temporary entries'
if [[ -d "$store" ]]; then
  find "$store" -maxdepth 2 -name '*.tmp*' -printf '%T@ %p\n' 2>&1 | sort -nr | head -n 20
fi
