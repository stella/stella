#!/usr/bin/env bash

# The infra promote job owns a 60-minute timeout. The caller must keep watching
# beyond that boundary so it can report the child's terminal conclusion instead
# of manufacturing an earlier timeout of its own.
readonly INFRA_PROMOTE_TIMEOUT_SECONDS=3600
readonly INFRA_WATCH_MARGIN_SECONDS=600

# Infra concurrency permits one running promote and one pending successor. A
# caller may therefore wait for the running 60-minute job before its own child
# starts. Bound that distinct queue state with the same ten-minute headroom.
readonly INFRA_PROMOTE_QUEUE_TIMEOUT_SECONDS=4200

# GitHub App installation tokens expire after one hour. Rotate before then;
# every phase carries forward the deadline derived from the child job start.
readonly INFRA_WATCH_TOKEN_PHASE_SECONDS=3000
readonly INFRA_WATCH_POLL_SECONDS=10
readonly INFRA_WATCH_MAX_CONSECUTIVE_ERRORS=12
export INFRA_WATCH_POLL_SECONDS INFRA_WATCH_MAX_CONSECUTIVE_ERRORS

readonly STAGING_IMAGE_BUILD_BUDGET_SECONDS=1500
readonly STAGING_DEPLOY_JOB_TIMEOUT_MINUTES=180

readonly INFRA_WATCH_BUDGET_SECONDS=$((
  INFRA_PROMOTE_TIMEOUT_SECONDS + INFRA_WATCH_MARGIN_SECONDS
))
readonly INFRA_MAX_CALLER_WAIT_SECONDS=$((
  INFRA_PROMOTE_QUEUE_TIMEOUT_SECONDS + INFRA_WATCH_BUDGET_SECONDS
))
export INFRA_WATCH_BUDGET_SECONDS
