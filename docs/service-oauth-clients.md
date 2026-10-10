# Service OAuth clients

Service clients use the existing OAuth token endpoint with the
`client_credentials` grant. They are bound to one organization and the
`mcp-law` resource, with `stella:law_read` as their only scope. They have no user
identity and cannot open user sessions or MCP tools. Resolve requests check the
organization's public-law access state and the live client record.

The operator provisions the organization and its access state separately, then
runs the following command against the intended database from an interactive
terminal:

```sh
bun run --filter @stll/api oauth:service-client create \
  --organization-id '<organization-id>' --name '<client-name>' \
  --requests-per-minute 60 --daily-budget 1000
```

The command displays the client ID and secret once, after committing the client
and audit event. Only the secret hash is stored. Put the displayed secret into
the calling backend's secret store; it does not belong in a browser or add-in.
The command refuses redirected secret output. It never seeds clients.

Exchange credentials at `/api/auth/oauth2/token`, using form fields
`grant_type=client_credentials`, `client_id`, `client_secret`,
`scope=stella:law_read`, and `resource=<API issuer origin>/mcp-law`. Use the
server's OAuth discovery metadata for its token endpoint and protected-resource
metadata for the resource identifier. Token requests cannot widen the client's
scope or resource.

```sh
bun run --filter @stll/api oauth:service-client rotate --client-id '<client-id>'
bun run --filter @stll/api oauth:service-client disable --client-id '<client-id>'
```

Rotation displays a new secret once and invalidates the old secret and
outstanding tokens. Disabling a client refuses its next token request and
outstanding tokens on their next resolve request. There is no re-enable command.
Lifecycle operations record the operating-system operator UID transactionally.

Each client has a per-route minute limit (1–600 requests) and a shared
24-hour budget (1–100,000 requests), with windows starting at the first request.
Both resolve routes use the existing
distributed rate-limit context, returning `429` and `Retry-After` when limited.
If the shared counter is unavailable, requests are refused. Resolve audit events
carry the client ID, route, normalized country and response outcome; they exclude
query text, secrets and tokens.
