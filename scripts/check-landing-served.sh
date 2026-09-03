#!/usr/bin/env bash
#
# Prove the landing site serves whole: a few routes answer 200, and every
# hashed asset the served homepage references answers 200. A page whose
# stylesheet or script is missing renders as bare text, which is the failure
# a deploy that removed assets before the edge stopped serving old pages
# produced. Run after a deploy (the deploy workflow) and on a schedule (the
# landing canary), so the same check catches it both ways.
#
#   LANDING_SITE=https://stll.app bash scripts/check-landing-served.sh
#
# One retry after a pause: a single edge blip is not an outage.
set -euo pipefail

site="${LANDING_SITE:-https://stll.app}"
routes=(/ /changelog/ /docs/)
retry_pause_seconds=30

check_once() {
  local route code html asset
  for route in "${routes[@]}"; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "${site}${route}" || echo "000")"
    if [[ "$code" != "200" ]]; then
      echo "${site}${route} answered ${code}." >&2
      return 1
    fi
  done

  html="$(curl -fsS --max-time 20 "${site}/")"
  local assets=()
  while IFS= read -r asset; do
    assets+=("$asset")
  done < <(
    grep -oE '(src|href)="/_astro/[^"]+"' <<<"$html" \
      | sed -E 's/^[a-z]+="//; s/"$//' \
      | sort -u
  )
  if [[ "${#assets[@]}" -eq 0 ]]; then
    echo "The served homepage references no hashed assets; the build or the upload is wrong." >&2
    return 1
  fi
  for asset in "${assets[@]}"; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "${site}${asset}" || echo "000")"
    if [[ "$code" != "200" ]]; then
      echo "${site}${asset}, referenced by the served homepage, answered ${code}." >&2
      return 1
    fi
  done
  echo "${site}: ${#routes[@]} route(s) and ${#assets[@]} referenced asset(s) answer 200."
}

if check_once; then
  exit 0
fi
echo "Retrying in ${retry_pause_seconds}s." >&2
sleep "$retry_pause_seconds"
if check_once; then
  exit 0
fi
echo "::error::${site} is not serving whole; see the lines above." >&2
exit 1
