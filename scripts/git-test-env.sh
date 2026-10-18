#!/usr/bin/env bash

# Keep fixture repositories stable while another Git process reads their objects.
git_test_config_count=${GIT_CONFIG_COUNT:-0}
for git_test_config in \
  'maintenance.auto=false' \
  'gc.auto=0' \
  'gc.autoDetach=false'; do
  export "GIT_CONFIG_KEY_${git_test_config_count}=${git_test_config%%=*}"
  export "GIT_CONFIG_VALUE_${git_test_config_count}=${git_test_config#*=}"
  ((git_test_config_count += 1))
done
export GIT_CONFIG_COUNT="$git_test_config_count"
unset git_test_config git_test_config_count
