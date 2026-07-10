<p align="center">
  <img src=".github/assets/banner.png" alt="stll/mcp" width="100%" />
</p>

# stella MCP server

stella MCP turns a stella workspace into something AI tools can work with
directly. Instead of copying files, pasting matter context, or wiring custom
API calls by hand, MCP-compatible clients can search, read and act through a
single permission-aware gateway.

Use it to give agents structured access to stella matters, documents, contacts,
case law, skills and connected tools. The same gateway can expose anonymized
read/search surfaces for clients that should not receive raw legal or personal
data.

The server exposes two MCP resources:

- `/mcp`: the default stella MCP. It includes first-party stella tools,
  OpenAI-compatible `search` / `fetch` tools, user-managed skills, and enabled
  external MCP connectors.
- `/mcp-anonymized`: the anonymized MCP mode. It exposes the full first-party
  read/search surface (matters, matter overviews, cross-matter search and
  content, contacts, templates, case law, plus the OpenAI-compatible
  `search`/`fetch` tools) for clients that should receive anonymized results.
  Tenant and personal text is redacted on egress; mutating tools and the dynamic
  gateway are not exposed.

OAuth protected-resource discovery is served from:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-protected-resource/mcp-anonymized`

## Single registry, derived anonymized projection

There is one curated tool registry (`DEFAULT_MCP_TOOL_DEFINITIONS` in
`static-tool-definitions.ts`, composed from `compat-tools.ts`, `stella-tools.ts`
and `template-tools.ts`). Every `McpToolDefinition` carries a required
`anonymized` policy, a closed discriminated union:

- `{ exposure: "anonymize", textFields, description? }`: available in anonymized
  mode; the listed output text fields are redacted on egress. An optional
  `description` overrides the tool text on the anonymized surface.
- `{ exposure: "passthrough" }`: available as-is (the output carries no
  tenant/personal text, e.g. the shared case-law corpus).
- `{ exposure: "excluded", reason }`: kept off the anonymized surface. `reason`
  is a closed union (`write`, `dynamic_gateway`).

The anonymized tool list and its `stella:*_anonymized` scopes are a pure
projection of this registry (`ANONYMIZED_MCP_TOOL_DEFINITIONS`): excluded tools
are dropped, and every other tool keeps its schema while its scope is remapped
to the paired anonymized scope. Adding a tool without an anonymization decision
is therefore a compile error, and the two surfaces cannot silently diverge.

## Handlers never see the mode; the egress pipeline is central

`McpToolHandler` has no `mode` parameter. A handler returns either a finished
`CallToolResult` or an egress plan (`McpEgressPlan`) carrying the full,
pre-window, un-anonymized payload. `handleMcpToolCall` (in `tools.ts`) runs the
handler and then `finalizeMcpEgress` (in `egress.ts`), which, in anonymized
mode, anonymizes the declared text fields on the whole payload, THEN windows,
THEN serializes. Anonymize-before-window keeps entity names from splitting
across a window edge and keeps placeholders stable across windows of one
document. With no mode in scope, per-mode divergence inside a handler is
structurally impossible. Tools with compound windowing (e.g.
`read_case_law_decision`) keep that logic tool-local and mode-agnostic.

Most read tools use the generic `{ egress: "structured" }` plan: the handler
builds the whole response object and declares its anonymizable text fields as
`{ workspaceId, value, apply }` descriptors (plus an optional `window` for one
field). Fields are grouped by `workspaceId` and batched into one
`anonymizeTextFields` call per workspace, so placeholders stay consistent across
a payload and multi-tenant payloads (search hits, matter lists) group correctly.
Org-scoped payloads (contacts, templates) use the organization id as the scope.
The OpenAI-compatible `search`/`fetch` tools keep their bespoke
`compatSearch`/`compatFetch` plans (workspaceId stripping, anonymization
metadata).

## Structured error envelope

This server is driven almost entirely by AI agents (and the companion CLI), so
every tool error carries a machine-readable code, not just prose. A failed tool
returns a single text content of

```json
{
  "error": { "code": "...", "message": "...", "hint": "...", "retryable": true }
}
```

with `isError` set. `hint` and `retryable` are omitted when absent. Build these
with `structuredErrorResult` (or the `notFoundResult` shorthand) in
`tool-utils.ts`; the arg parsers there already emit `validation_error`. The
`code` set is closed (`error-codes.ts`): `validation_error`, `missing_scope`,
`feature_disabled`, `not_found`, `confirmation_required`, `rate_limited`,
`unknown_tool`, `internal_error`. Agents branch on `code`; `hint` states the
next step (e.g. `missing_scope` tells the client to re-run OAuth consent). The
CLI keys its exit codes off `error.code` (e.g. `feature_disabled` -> exit 5), so
the string values are a stable contract. `internal_error` never leaks internals:
the real exception is captured for observability and the caller gets a generic
message plus the feedback-tool hint.

## Destructive-op confirm guardrail

Every tool with `annotations.destructiveHint === true` (the `delete_*` tools)
advertises a `confirm` boolean (`confirmProp()`) and is refused before dispatch
unless the call sets `confirm: true`. The gate lives in `handleMcpToolCall`,
before any DB access, and returns `confirmation_required`. This stops an agent
from deleting tenant data without an explicit, human-approved confirmation; the
handlers themselves tolerate and ignore the extra `confirm` arg.

## Feedback channel

`send_feedback` (`feedback-tools.ts`, scope `stella:feedback`) lets an agent
file a bug, feature request, or docs issue against the public repo — but never
without explicit human approval and never with private data. It is a write tool
(excluded from the anonymized surface) with no backing REST endpoint, so it is
waived in the coverage guard's `TOOLS_WITHOUT_ENUMERABLE_ENDPOINT`.

Title and body are always sanitized server-side by `feedback-sanitize.ts`: a
deterministic set of regex passes redacts emails, ids/UUIDs, JWT/secret blobs,
non-allowlisted URLs (only queryless, fragmentless `github.com/stella/stella`,
`stella.legal`, and `api.stll.app/public/feedback` URLs survive), and IP
literals. Tenant-entity-name anonymization is deliberately not run here: it is
workspace-bound and heavy, and feedback is org-scoped free text. The tool
returns a prefilled `issues/new` URL (label
`agent-feedback`) and an equivalent `gh issue create` command. Nothing is
published until the human opens the URL (or runs the command) and submits
under their own GitHub account, so approval is intrinsic and no server-side
token is needed. An oversized body is truncated in the URL with a
paste-the-rest marker; the full sanitized body is always returned separately.

## Public feedback intake

The separate public, unauthenticated `POST /public/feedback` endpoint
(`handlers/feedback/`) is not a backing endpoint for `send_feedback`. It carries
no `mcp` disposition and is mounted outside the auth macro alongside the other
public routes in `index.ts`.

The body is a strict Elysia schema (`kind`, `title` 1..200, `body` 1..8000, an
optional `source` `{ instance?, version? }`; unknown keys and oversize are
rejected). Title and body are re-sanitized here — the caller's pass is never
trusted. Delivery is email-only: the sanitized report is emailed to
`FEEDBACK_EMAIL_TO` when set (`200 { delivered: "email" }`), otherwise the
endpoint refuses with `503 feature_disabled`. Public issues are filed
exclusively through the github channel of `send_feedback`, where the human
submits under their own GitHub account, so the intake never holds a GitHub
token. Because it is an unauthenticated public write, it is abuse-bounded in
`intake-guards.ts` (Redis with an in-memory fallback): a per-IP rate limit
(5/hour) and 24h content dedup (a duplicate is rejected `409`, and a claim is
released if delivery fails so a genuine retry is not blocked). All error bodies
reuse the `{ error: { code, message, hint } }` envelope so the forwarding tool
can branch on HTTP status.

## Server instructions

`instructions.ts` supplies the MCP `instructions` string handed to clients at
connect time, per mode. It states the conventions an agent cannot read off the
tool list: pagination (`limit`/`cursor` in, `nextCursor` out), long-text
windowing, the error envelope shape, the confirm guardrail, and where static
resources live. Terse and factual, under hard character budgets asserted in
`instructions.test.ts` (the anonymized variant drops the write-only feedback
tool).

## Code map

- `constants.ts`: resource paths, scopes and discovery URLs.
- `error-codes.ts`: the closed `McpErrorCode` union for the error envelope.
- `instructions.ts`: per-mode server `instructions` strings.
- `tool-types.ts`: `McpToolDefinition`, the `anonymized` policy union, the
  egress-plan and handler types.
- `static-tool-definitions.ts`: the single registry plus the derived default
  list, anonymized projection, and anonymized scope set.
- `stella-tools.ts`: first-party stella tool definitions and handlers.
- `compat-tools.ts`: OpenAI-compatible `search` / `fetch` tools.
- `egress.ts`: the central anonymize-then-window egress pipeline.
- `gateway/`: dynamic gateway for user-managed skills and external MCP tools.
- `server.ts` and `server-core.ts`: MCP HTTP transport wiring.
- `../handlers/mcp/routes-core.ts`: Elysia routes that expose the MCP resources.
- `../handlers/mcp-connectors/`: connector management APIs used by the web app.
