#!/usr/bin/env bash
# Repository-scoped installation credentials shared by dispatch actions.

base64url() {
  openssl base64 -A | tr '/+' '_-' | tr -d '='
}

mint_app_token() {
  local now issued_at expires_at header payload unsigned signature jwt
  local installation_id repository_name request_body
  now="$(date +%s)"
  issued_at="$((now - 60))"
  expires_at="$((now + 600))"
  header="$(printf '%s' '{"typ":"JWT","alg":"RS256"}' | base64url)"
  payload="$(
    printf '{"iat":%s,"exp":%s,"iss":"%s"}' \
      "$issued_at" "$expires_at" "$APP_CLIENT_ID" | base64url
  )"
  unsigned="${header}.${payload}"
  signature="$(
    openssl dgst -sha256 -sign <(printf '%s\n' "$APP_PRIVATE_KEY") \
      <(printf '%s' "$unsigned") | base64url
  )"
  jwt="${unsigned}.${signature}"
  echo "::add-mask::${jwt}" >&2

  installation_id="$(
    GH_TOKEN="$jwt" bash "${BASH_SOURCE[0]%/*}/gh-retry.sh" api -H "Authorization: Bearer ${jwt}" \
      "/repos/${INFRA_REPO}/installation" --jq '.id'
  )"
  repository_name="${INFRA_REPO#*/}"
  request_body="$(
    jq -cn --arg repository "$repository_name" \
      '{repositories: [$repository], permissions: {actions: "write"}}'
  )"
  GH_TOKEN="$jwt" bash "${BASH_SOURCE[0]%/*}/gh-retry.sh" api -H "Authorization: Bearer ${jwt}" \
    --method POST \
    "/app/installations/${installation_id}/access_tokens" \
    --input - --jq '.token' <<<"$request_body"
}
