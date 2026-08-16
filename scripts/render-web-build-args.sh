#!/usr/bin/env bash
# Render Docker build arguments from Stella's generated web environment contract.
set -euo pipefail

if (( $# < 2 || $# > 3 )); then
  echo "Usage: $0 <contract.json> <configuration.json> [omitted-variable]" >&2
  exit 2
fi

contract_path="$1"
configuration_path="$2"
omitted_variable="${3:-}"

if [[ ! -f "$contract_path" ]]; then
  echo "ERROR: web build contract not found: ${contract_path}" >&2
  exit 1
fi
if [[ ! -f "$configuration_path" ]]; then
  echo "ERROR: web build configuration not found: ${configuration_path}" >&2
  exit 1
fi

if ! jq -e '
  .version == 1 and
  (.variables | type == "object") and
  (.variables | length > 0) and
  ([.variables | to_entries[] |
    (.key | test("^VITE_[A-Z0-9_]+$")) and
    (.value | test("^[A-Z][A-Z0-9_]*$"))
  ] | all)
' "$contract_path" >/dev/null; then
  echo "ERROR: invalid web build contract: ${contract_path}" >&2
  exit 1
fi

if ! jq -e '
  .version == 1 and
  (.targetEnvironment == "production" or .targetEnvironment == "staging") and
  (.variables | type == "object") and
  ([.variables | to_entries[] |
    (.key | test("^VITE_[A-Z0-9_]+$")) and
    (.value | type == "string") and
    (.value | test("[\\r\\n]") | not)
  ] | all)
' "$configuration_path" >/dev/null; then
  echo "ERROR: invalid web build configuration: ${configuration_path}" >&2
  exit 1
fi

unknown_variables="$(
  jq -nr \
    --slurpfile configured "$configuration_path" \
    --slurpfile contract "$contract_path" '
      $configured[0].variables
      | keys[]
      | select($contract[0].variables[.] == null)
    '
)"
if [[ -n "$unknown_variables" ]]; then
  echo "ERROR: configured web variables are absent from Stella's build contract:" >&2
  while IFS= read -r name; do
    echo "  ${name}" >&2
  done <<<"$unknown_variables"
  exit 1
fi

if [[ -n "$omitted_variable" ]] &&
  ! jq -e --arg name "$omitted_variable" '.variables[$name] | type == "string"' \
    "$contract_path" >/dev/null; then
  echo "ERROR: omitted web variable is not declared by the contract: ${omitted_variable}" >&2
  exit 1
fi

jq -nr \
  --arg omitted "$omitted_variable" \
  --slurpfile configured "$configuration_path" \
  --slurpfile contract "$contract_path" '
    $contract[0].variables
    | to_entries
    | sort_by(.key)
    | .[]
    | select(.key != $omitted)
    | ($configured[0].variables[.key] // "") as $value
    | "\(.value)=\($value)"
  '
