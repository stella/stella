#!/usr/bin/env bash

has_postgres_sqlstate() {
  local log_file="$1"
  local sqlstate="$2"
  [[ "$sqlstate" =~ ^[0-9A-Z]{5}$ ]] || return 1
  grep -Eq "errno: ['\"]${sqlstate}['\"]" "$log_file"
}
